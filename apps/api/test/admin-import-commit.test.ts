import { createHash, randomUUID } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  IMPORT_COLUMNS,
  errorResponseSchema,
  importCommitResponseSchema,
  importInvalidResponseSchema,
} from '@club-registration/shared';
import type { ImportCommitResponse } from '@club-registration/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UNISSUED_PASSWORD_HASH } from '../src/auth/password.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool, withReadOnlySnapshot, withTransaction } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { parseImportWorkbook } from '../src/import/parse.js';
import { applyImportPlan } from '../src/services/import-commit.js';
import { planImport } from '../src/services/import-plan.js';
import { buildTestApp, createTestUser } from './support/app.js';
import type { TestUser } from './support/app.js';
import {
  addAdvisor,
  createClub,
  createRound,
  createStudent,
  register,
  snapshotDatabase,
  uniqueCode,
  uniqueStudentId,
  uniqueTerm,
} from './support/import-db.js';
import {
  advisorRow,
  buildImportWorkbook,
  clubRow,
  multipartBody,
  studentRow,
} from './support/import.js';
import type { MultipartFile } from './support/import.js';
import { appConnectionUri, startMigratedPostgres, stopPostgres } from './support/postgres.js';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const errorOf = (response: InjectResponse) => errorResponseSchema.parse(response.json());
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const COMMIT_URL = '/api/admin/import/commit';
const PREVIEW_URL = '/api/admin/import/preview';
const APP_HOST = 'club-registration.example.test';

type StoredUser = {
  id: number;
  full_name: string;
  role: string;
  password_hash: string;
  must_change_password: boolean;
  session_version: number;
  grade: number | null;
  classroom: string | null;
  seat_no: number | null;
};

type StoredClub = {
  id: number;
  name: string;
  description: string;
  capacity: number;
  registered: number;
};

describe('admin import commit', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let adminToken: string;

  const postLogin = async (loginId: string, password: string) =>
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { loginId, password } });

  const loginAs = async (user: TestUser): Promise<string> => {
    const response = await postLogin(user.loginId, user.password);
    expect(response.statusCode).toBe(200);
    return response.cookies.find((cookie) => cookie.name === SESSION_COOKIE)!.value;
  };

  const postForm = async (
    url: string,
    fields: Record<string, string>,
    files: MultipartFile[],
    { token = adminToken, headers = {} }: { token?: string; headers?: Record<string, string> } = {},
  ) => {
    const body = await multipartBody(fields, files);
    const options: InjectOptions = {
      method: 'POST',
      url,
      payload: body.payload,
      headers: { ...body.headers, ...headers },
      cookies: { [SESSION_COOKIE]: token },
    };
    return await app.inject(options);
  };

  const commit = async (
    term: string,
    bytes: Buffer,
    {
      fileSha256 = sha256(bytes),
      idempotencyKey = randomUUID(),
      token,
      headers,
    }: {
      fileSha256?: string;
      idempotencyKey?: string;
      token?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    await postForm(
      COMMIT_URL,
      { term, fileSha256, idempotencyKey },
      [{ name: 'import.xlsx', bytes }],
      { ...(token === undefined ? {} : { token }), ...(headers === undefined ? {} : { headers }) },
    );

  const commitOk = async (term: string, bytes: Buffer): Promise<ImportCommitResponse> => {
    const response = await commit(term, bytes);
    expect(response.statusCode).toBe(200);
    return importCommitResponseSchema.parse(response.json());
  };

  const findUser = async (loginId: string): Promise<StoredUser | undefined> => {
    const { rows } = await pool.query<StoredUser>(
      `SELECT u.id, u.full_name, u.role, u.password_hash, u.must_change_password,
              u.session_version, sp.grade, sp.classroom, sp.seat_no
       FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id
       WHERE u.login_id = $1`,
      [loginId],
    );
    return rows[0];
  };

  const findClub = async (term: string, grade: number, clubCode: string) => {
    const { rows } = await pool.query<StoredClub>(
      `SELECT c.id, c.name, c.description, c.capacity, c.registered
       FROM clubs c JOIN rounds r ON r.id = c.round_id
       WHERE r.term = $1 AND r.grade = $2 AND c.club_code = $3`,
      [term, grade, clubCode],
    );
    return rows[0];
  };

  const advisorsOf = async (clubId: number) => {
    const { rows } = await pool.query<{
      id: number;
      full_name: string;
      phone: string | null;
      email: string | null;
      line_id: string | null;
    }>(
      'SELECT id, full_name, phone, email, line_id FROM club_advisors WHERE club_id = $1 ORDER BY id',
      [clubId],
    );
    return rows;
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(appConnectionUri(container));
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    app = await buildTestApp(pool);
    adminToken = await loginAs(await createTestUser(pool, { role: 'admin' }));
  });

  afterEach(async () => {
    await app.close();
  });

  describe('writing the file', () => {
    it('creates students who cannot sign in until a password is issued', async () => {
      const [first, second] = [uniqueStudentId(), uniqueStudentId()];
      const workbook = await buildImportWorkbook({
        students: [
          studentRow({
            loginId: first,
            fullName: 'หนึ่ง สมมติ',
            grade: 2,
            classroom: '3',
            seatNo: 4,
          }),
          studentRow({ loginId: second.toUpperCase(), fullName: 'สอง สมมติ' }),
        ],
      });

      const result = await commitOk(uniqueTerm(), workbook);

      expect(result.students).toEqual({ create: 2, update: 0, unchanged: 0 });
      expect(result.errors).toEqual([]);
      expect(await findUser(first)).toMatchObject({
        full_name: 'หนึ่ง สมมติ',
        role: 'student',
        password_hash: UNISSUED_PASSWORD_HASH,
        must_change_password: true,
        session_version: 0,
        grade: 2,
        classroom: '3',
        seat_no: 4,
      });
      expect(await findUser(second)).toMatchObject({ password_hash: UNISSUED_PASSWORD_HASH });
      const logins = await Promise.all(
        [UNISSUED_PASSWORD_HASH, first].map(async (password) => await postLogin(first, password)),
      );
      expect(logins.map(({ statusCode }) => statusCode)).toEqual([401, 401]);
    });

    it('creates clubs per grade with their advisors in file order and no seats taken', async () => {
      const term = uniqueTerm();
      await createRound(pool, term, 1);
      await createRound(pool, term, 2);
      const code = uniqueCode();
      const workbook = await buildImportWorkbook({
        clubs: [
          clubRow({
            clubCode: code,
            name: 'ดนตรี',
            grade: 1,
            capacity: 20,
            description: 'ร้อง\nเล่น',
          }),
          clubRow({ clubCode: code.toLowerCase(), name: 'ดนตรี', grade: 2, capacity: 15 }),
        ],
        advisors: [
          advisorRow({ clubCode: code, fullName: 'ครูหนึ่ง', phone: '081-234-5678' }),
          advisorRow({ clubCode: code, fullName: 'ครูสอง', email: 'teacher@example.com' }),
        ],
      });

      const result = await commitOk(term, workbook);

      expect(result.clubs).toEqual({ create: 2, update: 0, unchanged: 0 });
      expect(result.advisors).toEqual({ clubsReplaced: 2, clubsUnchanged: 0, rows: 2 });
      const grade1 = await findClub(term, 1, code);
      const grade2 = await findClub(term, 2, code);
      expect(grade1).toMatchObject({
        name: 'ดนตรี',
        description: 'ร้อง\nเล่น',
        capacity: 20,
        registered: 0,
      });
      expect(grade2).toMatchObject({ capacity: 15, registered: 0 });
      for (const club of [grade1!, grade2!]) {
        expect(
          (await advisorsOf(club.id)).map(({ full_name, phone, email, line_id }) => [
            full_name,
            phone,
            email,
            line_id,
          ]),
        ).toEqual([
          ['ครูหนึ่ง', '081-234-5678', null, null],
          ['ครูสอง', null, 'teacher@example.com', null],
        ]);
      }
    });

    it('updates existing students and clubs and reports what changed', async () => {
      const term = uniqueTerm();
      const roundId = await createRound(pool, term, 1);
      const [same, renamed] = [uniqueCode(), uniqueCode()];
      await createClub(pool, roundId, same, { name: 'คงเดิม', capacity: 10 });
      await createClub(pool, roundId, renamed, { name: 'ชื่อเก่า', capacity: 10 });
      const kept = await createStudent(pool, { fullName: 'คงเดิม สมมติ' });
      const moved = await createStudent(pool, { classroom: '1' });
      const workbook = await buildImportWorkbook({
        students: [
          studentRow({ loginId: kept.loginId, fullName: 'คงเดิม สมมติ' }),
          studentRow({ loginId: moved.loginId, classroom: '5', seatNo: 9 }),
          studentRow({ loginId: uniqueStudentId() }),
        ],
        clubs: [
          clubRow({ clubCode: same, name: 'คงเดิม', capacity: 10 }),
          clubRow({ clubCode: renamed, name: 'ชื่อใหม่', capacity: 12, description: 'ใหม่' }),
        ],
      });

      const result = await commitOk(term, workbook);

      expect(result.students).toEqual({ create: 1, update: 1, unchanged: 1 });
      expect(result.clubs).toEqual({ create: 0, update: 1, unchanged: 1 });
      expect(await findUser(moved.loginId)).toMatchObject({ classroom: '5', seat_no: 9 });
      expect(await findClub(term, 1, renamed)).toMatchObject({
        name: 'ชื่อใหม่',
        description: 'ใหม่',
        capacity: 12,
      });
    });

    it('never deletes students or clubs that are missing from the file', async () => {
      const term = uniqueTerm();
      const roundId = await createRound(pool, term, 1);
      const absentCode = uniqueCode();
      await createClub(pool, roundId, absentCode);
      const absent = await createStudent(pool);
      const workbook = await buildImportWorkbook({
        students: [studentRow({ loginId: uniqueStudentId() })],
        clubs: [clubRow({ clubCode: uniqueCode() })],
      });

      await commitOk(term, workbook);

      expect(await findUser(absent.loginId)).toBeDefined();
      expect(await findClub(term, 1, absentCode)).toBeDefined();
    });
  });

  describe('re-import', () => {
    it('reports everything unchanged and leaves the DB as it was, whatever the key', async () => {
      const term = uniqueTerm();
      await createRound(pool, term, 1);
      const code = uniqueCode();
      const workbook = await buildImportWorkbook({
        students: [
          studentRow({ loginId: uniqueStudentId() }),
          studentRow({ loginId: uniqueStudentId() }),
        ],
        clubs: [clubRow({ clubCode: code })],
        advisors: [advisorRow({ clubCode: code, fullName: 'ครูหนึ่ง' })],
      });
      const idempotencyKey = randomUUID();
      const first = await commit(term, workbook, { idempotencyKey });
      expect(first.statusCode).toBe(200);
      const afterFirst = await snapshotDatabase(pool);

      const responses = [
        await commit(term, workbook, { idempotencyKey }),
        await commit(term, workbook),
      ];

      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(importCommitResponseSchema.parse(response.json())).toMatchObject({
          students: { create: 0, update: 0, unchanged: 2 },
          clubs: { create: 0, update: 0, unchanged: 1 },
          advisors: { clubsReplaced: 0, clubsUnchanged: 1, rows: 1 },
        });
      }
      expect(await snapshotDatabase(pool)).toEqual(afterFirst);
    });

    it("never touches an existing student's password, forced-change flag or sessions", async () => {
      const student = await createTestUser(pool);
      // A session token is issued and the version moved on, as after a logout.
      await pool.query('UPDATE users SET session_version = 3 WHERE id = $1', [student.id]);
      const before = await findUser(student.loginId);
      const workbook = await buildImportWorkbook({
        students: [studentRow({ loginId: student.loginId, fullName: 'ชื่อใหม่ สมมติ', grade: 3 })],
      });

      const result = await commitOk(uniqueTerm(), workbook);

      expect(result.students).toEqual({ create: 0, update: 1, unchanged: 0 });
      expect(await findUser(student.loginId)).toEqual({
        ...before,
        full_name: 'ชื่อใหม่ สมมติ',
        grade: 3,
        classroom: '1',
        seat_no: 1,
      });
      expect((await postLogin(student.loginId, student.password)).statusCode).toBe(200);
    });

    it('replaces the advisors of clubs in the file and keeps those of other clubs', async () => {
      const term = uniqueTerm();
      const roundId = await createRound(pool, term, 1);
      const [listed, other] = [uniqueCode(), uniqueCode()];
      const listedId = await createClub(pool, roundId, listed);
      const otherId = await createClub(pool, roundId, other);
      await addAdvisor(pool, listedId, 'ครูเก่าหนึ่ง');
      await addAdvisor(pool, listedId, 'ครูเก่าสอง');
      const otherAdvisors = [
        await addAdvisor(pool, otherId, 'ครูชุมนุมอื่น'),
        await addAdvisor(pool, otherId, 'ครูชุมนุมอื่นสอง'),
      ];
      // other is in the clubs sheet too: only the advisors sheet decides whose list is replaced.
      const workbook = await buildImportWorkbook({
        clubs: [clubRow({ clubCode: other })],
        advisors: [advisorRow({ clubCode: listed, fullName: 'ครูใหม่' })],
      });

      const result = await commitOk(term, workbook);

      expect(result.advisors).toEqual({ clubsReplaced: 1, clubsUnchanged: 0, rows: 1 });
      expect((await advisorsOf(listedId)).map(({ full_name }) => full_name)).toEqual(['ครูใหม่']);
      expect((await advisorsOf(otherId)).map(({ id }) => id)).toEqual(otherAdvisors);
    });

    it('never changes registered, even when name and capacity change', async () => {
      const term = uniqueTerm();
      const roundId = await createRound(pool, term, 1);
      const code = uniqueCode();
      const clubId = await createClub(pool, roundId, code, { capacity: 5 });
      await register(pool, roundId, (await createStudent(pool)).id, clubId);
      await register(pool, roundId, (await createStudent(pool)).id, clubId);
      const workbook = await buildImportWorkbook({
        clubs: [clubRow({ clubCode: code, name: 'ชื่อใหม่', capacity: 2 })],
      });

      await commitOk(term, workbook);
      await commitOk(term, workbook);

      expect(await findClub(term, 1, code)).toMatchObject({ capacity: 2, registered: 2 });
      const { rows } = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM registrations WHERE club_id = $1',
        [clubId],
      );
      expect(rows[0]!.count).toBe(2);
    });
  });

  describe('all or nothing', () => {
    it('answers 422 import_invalid for one bad row and writes none of the good ones', async () => {
      const term = uniqueTerm();
      await createRound(pool, term, 1);
      const existing = await createStudent(pool, { fullName: 'ชื่อเก่า สมมติ' });
      const before = await snapshotDatabase(pool);
      const workbook = await buildImportWorkbook({
        students: [
          studentRow({ loginId: existing.loginId, fullName: 'ชื่อใหม่ สมมติ' }),
          studentRow({ loginId: uniqueStudentId() }),
          studentRow({ loginId: uniqueStudentId(), seatNo: 0 }),
        ],
        clubs: [clubRow({ clubCode: uniqueCode() })],
      });

      const response = await commit(term, workbook);

      expect(response.statusCode).toBe(422);
      const body = importInvalidResponseSchema.parse(response.json());
      expect(body.code).toBe('import_invalid');
      expect(body.errorCount).toBe(1);
      expect(body.errors).toEqual([
        expect.objectContaining({
          sheet: 'students',
          row: 4,
          column: IMPORT_COLUMNS.students.seatNo,
        }),
      ]);
      expect(await snapshotDatabase(pool)).toEqual(before);
    });

    it('refuses a capacity below the seats already taken and writes nothing', async () => {
      const term = uniqueTerm();
      const roundId = await createRound(pool, term, 1);
      const code = uniqueCode();
      const clubId = await createClub(pool, roundId, code, { capacity: 5 });
      await register(pool, roundId, (await createStudent(pool)).id, clubId);
      await register(pool, roundId, (await createStudent(pool)).id, clubId);
      const before = await snapshotDatabase(pool);
      const workbook = await buildImportWorkbook({
        students: [studentRow({ loginId: uniqueStudentId() })],
        clubs: [clubRow({ clubCode: code, capacity: 1 })],
      });

      const response = await commit(term, workbook);

      expect(response.statusCode).toBe(422);
      expect(importInvalidResponseSchema.parse(response.json()).errors).toEqual([
        expect.objectContaining({ sheet: 'clubs', column: IMPORT_COLUMNS.clubs.capacity }),
      ]);
      expect(await snapshotDatabase(pool)).toEqual(before);
    });

    it('rolls back everything when the DB CHECK catches seats taken after planning', async () => {
      const term = uniqueTerm();
      const roundId = await createRound(pool, term, 1);
      const code = uniqueCode();
      const clubId = await createClub(pool, roundId, code, { capacity: 5 });
      await register(pool, roundId, (await createStudent(pool)).id, clubId);
      const workbook = await buildImportWorkbook({
        students: [studentRow({ loginId: uniqueStudentId() })],
        clubs: [clubRow({ clubCode: code, capacity: 1 })],
      });
      const parsed = await parseImportWorkbook(workbook);
      const plan = await withReadOnlySnapshot(
        pool,
        async (client) => await planImport(client, term, parsed),
      );
      expect(plan.errors).toEqual([]);
      // A registration lands between planning and writing.
      await register(pool, roundId, (await createStudent(pool)).id, clubId);
      const before = await snapshotDatabase(pool);

      const attempt = withTransaction(pool, async (client) => {
        await applyImportPlan(client, plan);
      });

      await expect(attempt).rejects.toThrow(AppError);
      await expect(attempt).rejects.toMatchObject({ code: 'import_conflict', statusCode: 409 });
      expect(await snapshotDatabase(pool)).toEqual(before);
    });

    it('answers 409 import_file_mismatch when the file is not the previewed one', async () => {
      const term = uniqueTerm();
      const before = await snapshotDatabase(pool);
      const previewed = await buildImportWorkbook({
        students: [studentRow({ loginId: uniqueStudentId() })],
      });
      const sent = await buildImportWorkbook({
        students: [studentRow({ loginId: uniqueStudentId() })],
      });

      const response = await commit(term, sent, { fileSha256: sha256(previewed) });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('import_file_mismatch');
      expect(await snapshotDatabase(pool)).toEqual(before);
    });

    it('serialises two concurrent commits of the same file without duplicates', async () => {
      const term = uniqueTerm();
      await createRound(pool, term, 1);
      await createRound(pool, term, 2);
      const codes = [uniqueCode(), uniqueCode()];
      const loginIds = Array.from({ length: 40 }, () => uniqueStudentId());
      const workbook = await buildImportWorkbook({
        students: loginIds.map((loginId, index) => studentRow({ loginId, seatNo: index + 1 })),
        clubs: codes.flatMap((clubCode) => [
          clubRow({ clubCode, grade: 1 }),
          clubRow({ clubCode, grade: 2 }),
        ]),
        advisors: codes.flatMap((clubCode) => [
          advisorRow({ clubCode, fullName: 'ครูหนึ่ง' }),
          advisorRow({ clubCode, fullName: 'ครูสอง' }),
        ]),
      });

      const responses = await Promise.all([commit(term, workbook), commit(term, workbook)]);

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
      const results = responses.map((response) =>
        importCommitResponseSchema.parse(response.json()),
      );
      // One of them ran first and created everything; the other found it all in place.
      expect(results.map(({ students }) => students.create).toSorted((a, b) => a - b)).toEqual([
        0, 40,
      ]);
      expect(results.map(({ clubs }) => clubs.create).toSorted((a, b) => a - b)).toEqual([0, 4]);
      expect(
        results.map(({ advisors }) => advisors.clubsReplaced).toSorted((a, b) => a - b),
      ).toEqual([0, 4]);
      const { rows: users } = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM users WHERE login_id = ANY($1::text[])',
        [loginIds],
      );
      expect(users[0]!.count).toBe(40);
      const { rows: advisors } = await pool.query<{ club_code: string; count: number }>(
        `SELECT c.club_code, count(a.id)::int AS count
         FROM clubs c JOIN rounds r ON r.id = c.round_id
         LEFT JOIN club_advisors a ON a.club_id = c.id
         WHERE r.term = $1 GROUP BY c.id, c.club_code`,
        [term],
      );
      expect(advisors.map(({ count }) => count)).toEqual([2, 2, 2, 2]);
    });
  });

  describe('request checks', () => {
    it.each([
      ['a missing idempotencyKey', { idempotencyKey: undefined }],
      ['a malformed idempotencyKey', { idempotencyKey: 'short' }],
      ['a malformed fileSha256', { fileSha256: 'abc' }],
    ])('answers 400 validation_error for %s', async (_label, overrides) => {
      const bytes = await buildImportWorkbook({ students: [] });
      const fields = Object.fromEntries(
        Object.entries({
          term: uniqueTerm(),
          fileSha256: sha256(bytes),
          idempotencyKey: randomUUID(),
          ...overrides,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );

      const response = await postForm(COMMIT_URL, fields, [{ name: 'import.xlsx', bytes }]);

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
    });

    it('answers 415 for a matching hash of a file that is not a workbook', async () => {
      const bytes = Buffer.from('รหัสนักเรียน,ชื่อ\n1,a\n');

      const response = await commit(uniqueTerm(), bytes);

      expect(response.statusCode).toBe(415);
      expect(errorOf(response).code).toBe('unsupported_file');
    });
  });

  describe('cross-site requests', () => {
    it.each([
      ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
      ['Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
      ['a foreign Origin', { origin: 'https://attacker.example.test' }],
      ['Origin: null', { origin: 'null' }],
    ])('refuses a commit with %s and writes nothing', async (_label, headers) => {
      const before = await snapshotDatabase(pool);
      const workbook = await buildImportWorkbook({
        students: [studentRow({ loginId: uniqueStudentId() })],
      });

      const response = await commit(uniqueTerm(), workbook, {
        headers: { host: APP_HOST, ...headers },
      });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('forbidden');
      expect(await snapshotDatabase(pool)).toEqual(before);
    });

    it('refuses a cross-site preview too', async () => {
      const bytes = await buildImportWorkbook({ students: [] });

      const response = await postForm(
        PREVIEW_URL,
        { term: uniqueTerm() },
        [{ name: 'import.xlsx', bytes }],
        {
          headers: { 'sec-fetch-site': 'cross-site' },
        },
      );

      expect(response.statusCode).toBe(403);
    });

    it.each([
      ['Sec-Fetch-Site: same-origin', { 'sec-fetch-site': 'same-origin' }],
      ['an Origin on this host', { origin: `https://${APP_HOST}` }],
    ])('accepts a commit with %s', async (_label, headers) => {
      const loginId = uniqueStudentId();
      const workbook = await buildImportWorkbook({ students: [studentRow({ loginId })] });

      const response = await commit(uniqueTerm(), workbook, {
        headers: { host: APP_HOST, ...headers },
      });

      expect(response.statusCode).toBe(200);
      expect(await findUser(loginId)).toBeDefined();
    });
  });

  describe('access control', () => {
    it('forbids a student and writes nothing', async () => {
      const studentToken = await loginAs(await createTestUser(pool));
      const before = await snapshotDatabase(pool);
      const workbook = await buildImportWorkbook({
        students: [studentRow({ loginId: uniqueStudentId() })],
      });

      const response = await commit(uniqueTerm(), workbook, { token: studentToken });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('forbidden');
      expect(await snapshotDatabase(pool)).toEqual(before);
    });

    it('requires a session', async () => {
      const response = await app.inject({ method: 'POST', url: COMMIT_URL });

      expect(response.statusCode).toBe(401);
    });
  });
});
