import { randomBytes, randomUUID } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  INITIAL_PASSWORD_COLUMNS,
  ISSUED_COUNT_HEADER,
  errorResponseSchema,
  passwordStatusResponseSchema,
  sessionResponseSchema,
} from '@club-registration/shared';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { UNISSUED_PASSWORD_HASH, hashPassword, verifyPassword } from '../src/auth/password.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createConcurrencyLimit } from '../src/concurrency-limit.js';
import { createPool } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { commitPasswords, preparePasswords } from '../src/services/initial-passwords.js';
import type { IssueScope } from '../src/services/initial-passwords.js';
import { TEST_JWT_SECRET, createTestUser } from './support/app.js';
import type { TestUser } from './support/app.js';
import { uniqueStudentId } from './support/import-db.js';
import { startMigratedPostgres, stopPostgres } from './support/postgres.js';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const ISSUE_URL = '/api/admin/students/initial-passwords';
const STATUS_URL = '/api/admin/students/password-status';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const APP_HOST = 'club-registration.example.test';

// Grades 4 and 5 are reserved for the tests that issue a whole grade; every other test works in
// a classroom of its own, so no test sees another's students.
const SHARED_GRADE = 1;
const WHOLE_GRADE_TEST_GRADE = 4;
const TIMING_TEST_GRADE = 5;

const uniqueClassroom = () => `r${randomBytes(3).toString('hex')}`;
const errorCodeOf = (response: InjectResponse) => errorResponseSchema.parse(response.json()).code;

type FileRow = {
  sheet: string;
  loginId: string;
  fullName: string;
  grade: number;
  classroom: string;
  seatNo: number;
  password: string;
};

const textOf = (value: ExcelJS.CellValue): string => {
  if (typeof value !== 'string')
    throw new Error(`Expected a text cell, got ${JSON.stringify(value)}`);
  return value;
};

const numberOf = (value: ExcelJS.CellValue): number => {
  if (typeof value !== 'number')
    throw new Error(`Expected a number cell, got ${JSON.stringify(value)}`);
  return value;
};

const readWorkbook = async (bytes: Buffer): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(bytes).buffer);
  return workbook;
};

const readIssuedFile = async (bytes: Buffer): Promise<FileRow[]> => {
  const workbook = await readWorkbook(bytes);
  return workbook.worksheets.flatMap((worksheet) => {
    const rows: FileRow[] = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const cell = (column: number) => row.getCell(column).value;
      rows.push({
        sheet: worksheet.name,
        loginId: textOf(cell(1)),
        fullName: textOf(cell(2)),
        grade: numberOf(cell(3)),
        classroom: textOf(cell(4)),
        seatNo: numberOf(cell(5)),
        password: textOf(cell(6)),
      });
    });
    return rows;
  });
};

type Student = { id: number; loginId: string; fullName: string };

type StoredUser = {
  password_hash: string;
  must_change_password: boolean;
  session_version: number;
  password_issued_at: Date | null;
};

describe('admin initial passwords', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: FastifyInstance;
  let logLines: string[];
  let admin: TestUser;
  let adminToken: string;

  const postLogin = async (loginId: string, password: string) =>
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { loginId, password } });

  const tokenOf = (response: InjectResponse): string => {
    const cookie = response.cookies.find(({ name }) => name === SESSION_COOKIE);
    if (!cookie) throw new Error('No session cookie');
    return cookie.value;
  };

  const loginAs = async (user: { loginId: string; password: string }): Promise<string> => {
    const response = await postLogin(user.loginId, user.password);
    expect(response.statusCode).toBe(200);
    return tokenOf(response);
  };

  // Students as the import creates them: no usable password yet, forced change on first login.
  const createImportedStudents = async (
    count: number,
    { grade = SHARED_GRADE, classroom = uniqueClassroom() }: { grade?: number; classroom?: string },
  ): Promise<Student[]> => {
    const { rows } = await pool.query<{ id: number; login_id: string; full_name: string }>(
      `WITH new_users AS (
         INSERT INTO users (login_id, full_name, role, password_hash, must_change_password)
         SELECT v.login_id, v.full_name, 'student', $3, true
         FROM unnest($1::text[], $2::text[]) AS v(login_id, full_name)
         RETURNING id, login_id, full_name
       ), profiles AS (
         INSERT INTO student_profiles (user_id, grade, classroom, seat_no)
         SELECT id, $4, $5, row_number() OVER (ORDER BY login_id)
         FROM new_users
       )
       SELECT id, login_id, full_name FROM new_users ORDER BY login_id`,
      [
        Array.from({ length: count }, () => uniqueStudentId()),
        Array.from({ length: count }, (_, i) => `นักเรียนสมมติ ทดสอบ${i + 1}`),
        UNISSUED_PASSWORD_HASH,
        grade,
        classroom,
      ],
    );
    return rows.map((row) => ({ id: row.id, loginId: row.login_id, fullName: row.full_name }));
  };

  const findUser = async (id: number): Promise<StoredUser> => {
    const { rows } = await pool.query<StoredUser>(
      `SELECT password_hash, must_change_password, session_version, password_issued_at
       FROM users WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new Error('User not found');
    return row;
  };

  // What the student's own password change writes (see replacePassword).
  const studentSetsOwnPassword = async (id: number, password: string) => {
    await pool.query(
      `UPDATE users
       SET password_hash = $2, must_change_password = false, session_version = session_version + 1
       WHERE id = $1`,
      [id, await hashPassword(password)],
    );
  };

  const issue = async (
    body: Record<string, unknown>,
    { token = adminToken, headers = {} }: { token?: string; headers?: Record<string, string> } = {},
  ) =>
    await app.inject({
      method: 'POST',
      url: ISSUE_URL,
      payload: { onlyUnissued: false, idempotencyKey: randomUUID(), ...body },
      headers,
      cookies: { [SESSION_COOKIE]: token },
    });

  const issueOk = async (body: Record<string, unknown>) => {
    const response = await issue(body);
    expect(response.statusCode).toBe(200);
    return { response, rows: await readIssuedFile(response.rawPayload) };
  };

  const passwordFor = (rows: readonly FileRow[], loginId: string): string => {
    const row = rows.find((candidate) => candidate.loginId === loginId);
    if (!row) throw new Error(`${loginId} is not in the file`);
    return row.password;
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(container.getConnectionUri());
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    logLines = [];
    app = await buildApp({
      pool,
      jwtSecret: TEST_JWT_SECRET,
      logger: { level: 'info', stream: { write: (line) => logLines.push(line) } },
    });
    admin = await createTestUser(pool, { role: 'admin' });
    adminToken = await loginAs(admin);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('first login with an issued password', () => {
    it('refuses an imported student before any password is issued', async () => {
      const [student] = await createImportedStudents(1, {});

      const response = await postLogin(student!.loginId, UNISSUED_PASSWORD_HASH);

      expect(response.statusCode).toBe(401);
      expect(errorCodeOf(response)).toBe('invalid_credentials');
    });

    it('lets the student sign in with the password from the file, then forces a change', async () => {
      const classroom = uniqueClassroom();
      const [student] = await createImportedStudents(1, { classroom });

      const { rows } = await issueOk({ grade: SHARED_GRADE, classroom });
      const password = passwordFor(rows, student!.loginId);
      const login = await postLogin(student!.loginId, password);

      expect(login.statusCode).toBe(200);
      expect(sessionResponseSchema.parse(login.json()).user.mustChangePassword).toBe(true);
      const blocked = await app.inject({
        method: 'GET',
        url: '/api/admin/rounds',
        cookies: { [SESSION_COOKIE]: tokenOf(login) },
      });
      expect(errorCodeOf(blocked)).toBe('password_change_required');
      const changed = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: { currentPassword: password, newPassword: 'my-own-password' },
        cookies: { [SESSION_COOKIE]: tokenOf(login) },
      });
      expect(changed.statusCode).toBe(200);
      expect(sessionResponseSchema.parse(changed.json()).user.mustChangePassword).toBe(false);
    });

    it('writes exactly the students of the scope with the expected columns and fields', async () => {
      const classroom = uniqueClassroom();
      const students = await createImportedStudents(3, { classroom });

      const { response, rows } = await issueOk({ grade: SHARED_GRADE, classroom });

      expect(response.headers[ISSUED_COUNT_HEADER]).toBe('3');
      expect(
        rows.map(({ loginId, fullName, grade, classroom: room, seatNo }) => ({
          loginId,
          fullName,
          grade,
          classroom: room,
          seatNo,
        })),
      ).toEqual(
        students.map(({ loginId, fullName }, index) => ({
          loginId,
          fullName,
          grade: SHARED_GRADE,
          classroom,
          seatNo: index + 1,
        })),
      );
      expect(rows.every(({ password }) => /^[a-z2-9]{10}$/.test(password))).toBe(true);
      const workbook = await readWorkbook(response.rawPayload);
      expect(workbook.worksheets[0]!.getRow(1).values).toEqual([
        undefined,
        ...Object.values(INITIAL_PASSWORD_COLUMNS),
      ]);
    });

    it('records when the password was issued without keeping it anywhere but the hash', async () => {
      const classroom = uniqueClassroom();
      const [student] = await createImportedStudents(1, { classroom });

      const { rows } = await issueOk({ grade: SHARED_GRADE, classroom });

      const stored = await findUser(student!.id);
      expect(stored.password_issued_at).toBeInstanceOf(Date);
      expect(stored.password_hash).toMatch(/^\$argon2id\$/);
      expect(stored.password_hash).not.toContain(passwordFor(rows, student!.loginId));
      const { rows: issuances } = await pool.query<{ issued_count: number }>(
        'SELECT issued_count FROM password_issuances WHERE admin_id = $1',
        [admin.id],
      );
      expect(issuances).toEqual([{ issued_count: 1 }]);
    });
  });

  describe('issuing again', () => {
    it('kills the old password and every session opened with it', async () => {
      const classroom = uniqueClassroom();
      const [student] = await createImportedStudents(1, { classroom });
      const first = await issueOk({ grade: SHARED_GRADE, classroom });
      const oldPassword = passwordFor(first.rows, student!.loginId);
      const oldToken = await loginAs({ loginId: student!.loginId, password: oldPassword });

      const second = await issueOk({ grade: SHARED_GRADE, classroom });

      expect((await postLogin(student!.loginId, oldPassword)).statusCode).toBe(401);
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { [SESSION_COOKIE]: oldToken },
      });
      expect(me.statusCode).toBe(401);
      const newPassword = passwordFor(second.rows, student!.loginId);
      expect((await postLogin(student!.loginId, newPassword)).statusCode).toBe(200);
    });

    it('skips students who already hold an issued password when onlyUnissued is set', async () => {
      const classroom = uniqueClassroom();
      const [issuedBefore] = await createImportedStudents(1, { classroom });
      const first = await issueOk({ grade: SHARED_GRADE, classroom });
      const [newcomer] = await createImportedStudents(1, { classroom });

      const { rows } = await issueOk({ grade: SHARED_GRADE, classroom, onlyUnissued: true });

      expect(rows.map(({ loginId }) => loginId)).toEqual([newcomer!.loginId]);
      const stillValid = passwordFor(first.rows, issuedBefore!.loginId);
      expect(
        await verifyPassword((await findUser(issuedBefore!.id)).password_hash, stillValid),
      ).toBe(true);
    });
  });

  describe('students who set their own password', () => {
    it('are never overwritten and never appear in the file', async () => {
      const classroom = uniqueClassroom();
      const [active, pending] = await createImportedStudents(2, { classroom });
      await studentSetsOwnPassword(active!.id, 'chosen-by-student');
      const before = await findUser(active!.id);

      const { rows } = await issueOk({ grade: SHARED_GRADE, classroom });

      expect(rows.map(({ loginId }) => loginId)).toEqual([pending!.loginId]);
      expect(await findUser(active!.id)).toEqual(before);
    });

    it('are skipped when the change lands between hashing and the transaction', async () => {
      const classroom = uniqueClassroom();
      const [changer, other] = await createImportedStudents(2, { classroom });
      const scope: IssueScope = { grade: SHARED_GRADE, classroom, onlyUnissued: false };
      const prepared = await preparePasswords(pool, scope, createConcurrencyLimit(2));
      expect(prepared.map(({ userId }) => userId).sort()).toEqual([changer!.id, other!.id].sort());

      await studentSetsOwnPassword(changer!.id, 'chosen-by-student');
      const issued = await commitPasswords(pool, {
        adminId: admin.id,
        idempotencyKey: randomUUID(),
        scope,
        prepared,
      });

      expect(issued.map(({ loginId }) => loginId)).toEqual([other!.loginId]);
      const stored = await findUser(changer!.id);
      expect(stored.must_change_password).toBe(false);
      expect(await verifyPassword(stored.password_hash, 'chosen-by-student')).toBe(true);
    });

    it('answers 409 nothing_to_issue when every student is gone by the transaction', async () => {
      const classroom = uniqueClassroom();
      const [student] = await createImportedStudents(1, { classroom });
      const scope: IssueScope = { grade: SHARED_GRADE, classroom, onlyUnissued: false };
      const prepared = await preparePasswords(pool, scope, createConcurrencyLimit(2));
      await studentSetsOwnPassword(student!.id, 'chosen-by-student');

      const commit = commitPasswords(pool, {
        adminId: admin.id,
        idempotencyKey: randomUUID(),
        scope,
        prepared,
      });

      await expect(commit).rejects.toThrow(AppError);
      await expect(commit).rejects.toMatchObject({ code: 'nothing_to_issue' });
      const { rowCount } = await pool.query(
        'SELECT 1 FROM password_issuances WHERE admin_id = $1',
        [admin.id],
      );
      expect(rowCount).toBe(0);
    });
  });

  describe('concurrent issuance of the same scope', () => {
    // Each student must end with exactly one valid password, taken from one file, and all of
    // them from the same file: the request whose transaction committed last.
    const assertOneValidPasswordEach = async (
      students: readonly Student[],
      files: readonly FileRow[][],
    ) => {
      const winners = await Promise.all(
        students.map(async ({ id, loginId }) => {
          const { password_hash: hash } = await findUser(id);
          const matches = await Promise.all(
            files.map(async (rows) => {
              const row = rows.find((candidate) => candidate.loginId === loginId);
              return row !== undefined && (await verifyPassword(hash, row.password));
            }),
          );
          expect(matches.filter(Boolean)).toHaveLength(1);
          return matches.indexOf(true);
        }),
      );
      return winners;
    };

    it('leaves every student with the password of the request that committed last', async () => {
      const classroom = uniqueClassroom();
      const students = await createImportedStudents(8, { classroom });

      const responses = await Promise.all([
        issue({ grade: SHARED_GRADE, classroom }),
        issue({ grade: SHARED_GRADE, classroom }),
      ]);

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
      const files = await Promise.all(
        responses.map(async ({ rawPayload }) => await readIssuedFile(rawPayload)),
      );
      // Both overwrote everyone, the later one on top of the earlier.
      expect(files.map((rows) => rows.length)).toEqual([8, 8]);
      const winners = await assertOneValidPasswordEach(students, files);
      expect(new Set(winners).size).toBe(1);
      const sessionVersions = await Promise.all(
        students.map(async ({ id }) => (await findUser(id)).session_version),
      );
      expect(sessionVersions).toEqual(students.map(() => 2));
    });

    it('gives each never-issued student to exactly one request when onlyUnissued is set', async () => {
      const classroom = uniqueClassroom();
      const students = await createImportedStudents(8, { classroom });

      const responses = await Promise.all([
        issue({ grade: SHARED_GRADE, classroom, onlyUnissued: true }),
        issue({ grade: SHARED_GRADE, classroom, onlyUnissued: true }),
      ]);

      // The later request found everyone already issued: it changed nothing and said so.
      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
      const ok = responses.find(({ statusCode }) => statusCode === 200)!;
      const refused = responses.find(({ statusCode }) => statusCode === 409)!;
      expect(errorCodeOf(refused)).toBe('nothing_to_issue');
      const rows = await readIssuedFile(ok.rawPayload);
      expect(rows).toHaveLength(8);
      await assertOneValidPasswordEach(students, [rows]);
    });

    it('settles two transactions that wait on the same row locks', async () => {
      const classroom = uniqueClassroom();
      const students = await createImportedStudents(6, { classroom });
      const scope: IssueScope = { grade: SHARED_GRADE, classroom, onlyUnissued: false };
      const limit = createConcurrencyLimit(2);
      const [preparedA, preparedB] = await Promise.all([
        preparePasswords(pool, scope, limit),
        preparePasswords(pool, scope, limit),
      ]);
      // A third transaction holds the rows so both commits are queued on the same locks.
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM users WHERE id = ANY($1::int[]) FOR UPDATE', [
          students.map(({ id }) => id),
        ]);
        const commitOf = (prepared: typeof preparedA) =>
          commitPasswords(pool, {
            adminId: admin.id,
            idempotencyKey: randomUUID(),
            scope,
            prepared,
          });
        const commits = Promise.all([commitOf(preparedA), commitOf(preparedB)]);
        await vi.waitFor(
          async () => {
            const { rows } = await pool.query<{ waiting: number }>(
              `SELECT count(*)::int AS waiting FROM pg_stat_activity
               WHERE wait_event_type = 'Lock' AND query LIKE '%FOR NO KEY UPDATE OF u%'`,
            );
            expect(rows[0]?.waiting).toBe(2);
          },
          { timeout: 5_000, interval: 20 },
        );
        await holder.query('ROLLBACK');

        const issued = await commits;

        expect(issued.map((rows) => rows.length)).toEqual([6, 6]);
        const files = issued.map((rows) =>
          rows.map((row) => ({ ...row, sheet: '' }) satisfies FileRow),
        );
        const winners = await assertOneValidPasswordEach(students, files);
        expect(new Set(winners).size).toBe(1);
      } finally {
        holder.release();
      }
    });
  });

  describe('scope and file layout', () => {
    it('issues a whole grade, one sheet per classroom, sorted by classroom and seat', async () => {
      const ten = await createImportedStudents(2, {
        grade: WHOLE_GRADE_TEST_GRADE,
        classroom: '10',
      });
      const two = await createImportedStudents(2, {
        grade: WHOLE_GRADE_TEST_GRADE,
        classroom: '2',
      });
      const slash = await createImportedStudents(1, {
        grade: WHOLE_GRADE_TEST_GRADE,
        classroom: '3/1',
      });

      const { response, rows } = await issueOk({ grade: WHOLE_GRADE_TEST_GRADE });

      expect(rows.map(({ loginId }) => loginId)).toEqual(
        [...two, ...slash, ...ten].map(({ loginId }) => loginId),
      );
      const workbook = await readWorkbook(response.rawPayload);
      expect(workbook.worksheets.map(({ name }) => name)).toEqual(['ม.4-2', 'ม.4-3-1', 'ม.4-10']);
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="initial-passwords-grade-4.xlsx"',
      );
    });

    it('escapes text cells that a spreadsheet would read as a formula', async () => {
      const classroom = uniqueClassroom();
      const [student] = await createImportedStudents(1, { classroom });
      await pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [
        student!.id,
        '=HYPERLINK("http://example.test","x")',
      ]);

      const { rows } = await issueOk({ grade: SHARED_GRADE, classroom });

      expect(rows[0]!.fullName).toBe(`'=HYPERLINK("http://example.test","x")`);
    });

    it('answers 409 nothing_to_issue for a scope with no eligible student', async () => {
      const response = await issue({ grade: SHARED_GRADE, classroom: uniqueClassroom() });

      expect(response.statusCode).toBe(409);
      expect(errorCodeOf(response)).toBe('nothing_to_issue');
    });

    it.each([
      ['an unknown field', { grade: SHARED_GRADE, classRoom: '1' }],
      ['a grade outside 1–6', { grade: 7 }],
      ['an over-long classroom', { grade: SHARED_GRADE, classroom: 'x'.repeat(17) }],
      ['a malformed idempotency key', { grade: SHARED_GRADE, idempotencyKey: 'short' }],
    ])('answers 400 for %s', async (_label, body) => {
      const response = await issue(body);

      expect(response.statusCode).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_error');
    });
  });

  describe('idempotency key', () => {
    it('refuses a replayed request instead of invalidating the file already handed out', async () => {
      const classroom = uniqueClassroom();
      const [student] = await createImportedStudents(1, { classroom });
      const idempotencyKey = randomUUID();
      const first = await issueOk({ grade: SHARED_GRADE, classroom, idempotencyKey });

      const replay = await issue({ grade: SHARED_GRADE, classroom, idempotencyKey });

      expect(replay.statusCode).toBe(409);
      expect(errorCodeOf(replay)).toBe('idempotency_key_reused');
      const password = passwordFor(first.rows, student!.loginId);
      expect((await postLogin(student!.loginId, password)).statusCode).toBe(200);
    });

    it('lets only one of two concurrent duplicates commit', async () => {
      const classroom = uniqueClassroom();
      const students = await createImportedStudents(3, { classroom });
      const idempotencyKey = randomUUID();

      const responses = await Promise.all([
        issue({ grade: SHARED_GRADE, classroom, idempotencyKey }),
        issue({ grade: SHARED_GRADE, classroom, idempotencyKey }),
      ]);

      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
      const refused = responses.find(({ statusCode }) => statusCode === 409)!;
      expect(errorCodeOf(refused)).toBe('idempotency_key_reused');
      const ok = responses.find(({ statusCode }) => statusCode === 200)!;
      const rows = await readIssuedFile(ok.rawPayload);
      const valid = await Promise.all(
        students.map(async ({ id, loginId }) =>
          verifyPassword((await findUser(id)).password_hash, passwordFor(rows, loginId)),
        ),
      );
      expect(valid).toEqual([true, true, true]);
    });
  });

  describe('response and logs', () => {
    it('is an uncacheable attachment whose name carries no personal data', async () => {
      const classroom = uniqueClassroom();
      await createImportedStudents(1, { classroom });

      const { response } = await issueOk({ grade: SHARED_GRADE, classroom });

      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toBe(XLSX_MIME);
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="initial-passwords-grade-${SHARED_GRADE}-room-${classroom}.xlsx"`,
      );
    });

    it('logs the admin, scope and count, and never a password, name or student ID', async () => {
      const classroom = uniqueClassroom();
      const students = await createImportedStudents(2, { classroom });

      const { rows } = await issueOk({ grade: SHARED_GRADE, classroom });

      const log = logLines.join('');
      const secrets = [
        ...rows.map(({ password }) => password),
        ...students.flatMap(({ loginId, fullName }) => [loginId, fullName]),
      ];
      secrets.forEach((secret) => {
        expect(log).not.toContain(secret);
      });
      const entry = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(({ msg }) => msg === 'initial passwords issued');
      expect(entry).toMatchObject({
        adminId: admin.id,
        grade: SHARED_GRADE,
        classroom,
        onlyUnissued: false,
        issuedCount: 2,
        skippedCount: 0,
      });
    });
  });

  describe('access', () => {
    it('refuses a student with 403 and issues nothing', async () => {
      const classroom = uniqueClassroom();
      const [target] = await createImportedStudents(1, { classroom });
      const student = await createTestUser(pool);

      const response = await issue(
        { grade: SHARED_GRADE, classroom },
        { token: await loginAs(student) },
      );

      expect(response.statusCode).toBe(403);
      expect(errorCodeOf(response)).toBe('forbidden');
      expect((await findUser(target!.id)).password_issued_at).toBeNull();
    });

    it('refuses the status page to a student', async () => {
      const student = await createTestUser(pool);

      const response = await app.inject({
        method: 'GET',
        url: STATUS_URL,
        cookies: { [SESSION_COOKIE]: await loginAs(student) },
      });

      expect(response.statusCode).toBe(403);
    });

    it.each([
      ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
      ['a foreign Origin', { origin: 'https://attacker.example.test', host: APP_HOST }],
    ])('refuses a cross-site request (%s) with 403 and issues nothing', async (_label, headers) => {
      const classroom = uniqueClassroom();
      const [target] = await createImportedStudents(1, { classroom });

      const response = await issue({ grade: SHARED_GRADE, classroom }, { headers });

      expect(response.statusCode).toBe(403);
      expect((await findUser(target!.id)).password_issued_at).toBeNull();
    });

    it('accepts a same-origin request from the app', async () => {
      const classroom = uniqueClassroom();
      await createImportedStudents(1, { classroom });

      const response = await issue(
        { grade: SHARED_GRADE, classroom },
        { headers: { 'sec-fetch-site': 'same-origin' } },
      );

      expect(response.statusCode).toBe(200);
    });

    it('rate-limits each admin', async () => {
      const classroom = uniqueClassroom();
      const attempts = await Promise.all(
        Array.from({ length: 20 }, async () => await issue({ grade: SHARED_GRADE, classroom })),
      );
      expect(attempts.every(({ statusCode }) => statusCode === 409)).toBe(true);

      const limited = await issue({ grade: SHARED_GRADE, classroom });

      expect(limited.statusCode).toBe(429);
      expect(errorCodeOf(limited)).toBe('rate_limited');
    });
  });

  describe('GET /api/admin/students/password-status', () => {
    it('counts never issued, issued but unchanged, and changed per classroom', async () => {
      const classroom = uniqueClassroom();
      const [changer] = await createImportedStudents(4, { classroom });
      await issueOk({ grade: SHARED_GRADE, classroom });
      await studentSetsOwnPassword(changer!.id, 'chosen-by-student');
      await createImportedStudents(2, { classroom });

      const response = await app.inject({
        method: 'GET',
        url: STATUS_URL,
        cookies: { [SESSION_COOKIE]: adminToken },
      });

      expect(response.statusCode).toBe(200);
      const { classrooms } = passwordStatusResponseSchema.parse(response.json());
      const row = classrooms.find((candidate) => candidate.classroom === classroom);
      expect(row).toMatchObject({
        grade: SHARED_GRADE,
        neverIssued: 2,
        issuedPending: 3,
        changed: 1,
      });
      expect(row?.lastIssuedAt).not.toBeNull();
    });

    it('lists classrooms in grade order, numeric classrooms in number order', async () => {
      const prefix = uniqueClassroom();
      await Promise.all(
        ['10', '2', '9'].map(
          async (room) => await createImportedStudents(1, { classroom: `${prefix}-${room}` }),
        ),
      );

      const response = await app.inject({
        method: 'GET',
        url: STATUS_URL,
        cookies: { [SESSION_COOKIE]: adminToken },
      });

      const { classrooms } = passwordStatusResponseSchema.parse(response.json());
      const grades = classrooms.map(({ grade }) => grade);
      expect(grades).toEqual([...grades].sort((a, b) => a - b));
      const mine = classrooms
        .map(({ classroom }) => classroom)
        .filter((classroom) => classroom.startsWith(`${prefix}-`));
      expect(mine).toEqual([`${prefix}-2`, `${prefix}-9`, `${prefix}-10`]);
    });
  });

  describe('a realistic round', () => {
    it('issues 450 students in one request and reports how long it took', async () => {
      const classrooms = Array.from({ length: 12 }, (_, i) => String(i + 1));
      const perRoom = [38, 38, 38, 38, 38, 38, 37, 37, 37, 37, 37, 37];
      await Promise.all(
        classrooms.map(
          async (classroom, i) =>
            await createImportedStudents(perRoom[i]!, { grade: TIMING_TEST_GRADE, classroom }),
        ),
      );

      const startedAt = performance.now();
      const { response, rows } = await issueOk({ grade: TIMING_TEST_GRADE });
      const elapsedMs = performance.now() - startedAt;

      expect(rows).toHaveLength(450);
      expect((await readWorkbook(response.rawPayload)).worksheets).toHaveLength(12);
      const entry = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(({ msg }) => msg === 'initial passwords issued');
      // Printed so the number in the README/PR comes from a real run, not an estimate.
      console.info(
        `issued 450 initial passwords: request ${Math.round(elapsedMs)} ms ` +
          `(hashing ${String(entry?.hashMs)} ms, server total ${String(entry?.totalMs)} ms)`,
      );
    }, 180_000);
  });
});
