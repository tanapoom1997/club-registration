import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  errorResponseSchema,
  passwordResetResponseSchema,
  sessionResponseSchema,
} from '@club-registration/shared';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { UNISSUED_PASSWORD_HASH, hashPassword, verifyPassword } from '../src/auth/password.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool } from '../src/db.js';
import { parseImportWorkbook } from '../src/import/parse.js';
import { commitImport } from '../src/services/import-commit.js';
import { commitPasswords } from '../src/services/initial-passwords.js';
import { commitReset } from '../src/services/password-reset.js';
import { TEST_JWT_SECRET, createTestUser } from './support/app.js';
import type { TestUser } from './support/app.js';
import { uniqueStudentId, uniqueTerm } from './support/import-db.js';
import { buildImportWorkbook, studentRow } from './support/import.js';
import { waitForLockWaiter } from './support/lock-waiter.js';
import { appConnectionUri, startMigratedPostgres, stopPostgres } from './support/postgres.js';

// An admin resetting one student's password (services/password-reset.ts). Every value is made up.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const RESET_URL = '/api/admin/students/password-reset';
const APP_HOST = 'club-registration.example.test';
const GRADE = 3;
const RESET_LOCK_QUERY = 'FOR NO KEY UPDATE OF u';
const CHANGE_UPDATE_QUERY = 'session_version = $3';

const uniqueClassroom = () => `r${randomBytes(3).toString('hex')}`;
const errorCodeOf = (response: InjectResponse) => errorResponseSchema.parse(response.json()).code;

type Student = {
  id: number;
  loginId: string;
  fullName: string;
  classroom: string;
  seatNo: number;
  // undefined = imported, no usable password yet.
  password: string | undefined;
};

type StoredUser = {
  password_hash: string;
  must_change_password: boolean;
  session_version: number;
  password_issued_at: Date | null;
};

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

const settle = async <T>(work: Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error };
  }
};

describe('admin password reset', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
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

  const loginAs = async (loginId: string, password: string): Promise<string> => {
    const response = await postLogin(loginId, password);
    expect(response.statusCode).toBe(200);
    return tokenOf(response);
  };

  const me = async (token: string) =>
    await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: token } });

  // By default a student who already replaced the initial password with one of their own: the
  // case the bulk issuance cannot help with.
  const createStudent = async ({
    ownPassword = true,
    classroom = uniqueClassroom(),
  }: { ownPassword?: boolean; classroom?: string } = {}): Promise<Student> => {
    const loginId = uniqueStudentId();
    const fullName = `นักเรียนสมมติ ${randomBytes(3).toString('hex')}`;
    const password = ownPassword ? `own-${randomBytes(6).toString('hex')}` : undefined;
    const { rows } = await pool.query<{ id: number }>(
      `WITH new_user AS (
         INSERT INTO users (login_id, full_name, role, password_hash, must_change_password)
         VALUES ($1, $2, 'student', $3, $4)
         RETURNING id
       ), profile AS (
         INSERT INTO student_profiles (user_id, grade, classroom, seat_no)
         SELECT id, $5, $6, 7 FROM new_user
       )
       SELECT id FROM new_user`,
      [
        loginId,
        fullName,
        password === undefined ? UNISSUED_PASSWORD_HASH : await hashPassword(password),
        password === undefined,
        GRADE,
        classroom,
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('Student insert returned no row');
    return { id, loginId, fullName, classroom, seatNo: 7, password };
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

  const reset = async (
    body: Record<string, unknown>,
    { token = adminToken, headers = {} }: { token?: string; headers?: Record<string, string> } = {},
  ) =>
    await app.inject({
      method: 'POST',
      url: RESET_URL,
      payload: { idempotencyKey: randomUUID(), ...body },
      headers,
      cookies: { [SESSION_COOKIE]: token },
    });

  const resetOk = async (body: Record<string, unknown>) => {
    const response = await reset(body);
    expect(response.statusCode).toBe(200);
    return { response, answer: passwordResetResponseSchema.parse(response.json()) };
  };

  const changeOwnPassword = async (token: string, currentPassword: string, newPassword: string) =>
    await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword, newPassword },
      cookies: { [SESSION_COOKIE]: token },
    });

  const ownPasswordOf = (student: Student): string => {
    if (student.password === undefined) throw new Error('Student has no password of their own');
    return student.password;
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(appConnectionUri(container));
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
    adminToken = await loginAs(admin.loginId, admin.password);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('a student who forgot the password they set', () => {
    it('answers with the student and a new password that replaces the old one', async () => {
      const student = await createStudent();

      const { answer } = await resetOk({ loginId: student.loginId });

      expect(answer.student).toEqual({
        loginId: student.loginId,
        fullName: student.fullName,
        grade: GRADE,
        classroom: student.classroom,
        seatNo: student.seatNo,
      });
      expect(answer.password).toMatch(/^[a-z2-9]{10}$/);
      expect((await postLogin(student.loginId, ownPasswordOf(student))).statusCode).toBe(401);
      const login = await postLogin(student.loginId, answer.password);
      expect(login.statusCode).toBe(200);
      expect(sessionResponseSchema.parse(login.json()).user.mustChangePassword).toBe(true);
    });

    it('signs the student out of every session opened before', async () => {
      const student = await createStudent();
      const oldToken = await loginAs(student.loginId, ownPasswordOf(student));

      await resetOk({ loginId: student.loginId });

      expect((await me(oldToken)).statusCode).toBe(401);
    });

    it('makes the student set a new password at the next login', async () => {
      const student = await createStudent();
      const { answer } = await resetOk({ loginId: student.loginId });
      const token = await loginAs(student.loginId, answer.password);

      const blocked = await app.inject({
        method: 'GET',
        url: '/api/student/round',
        cookies: { [SESSION_COOKIE]: token },
      });
      const changed = await changeOwnPassword(token, answer.password, 'my-new-own-password');

      expect(errorCodeOf(blocked)).toBe('password_change_required');
      expect(changed.statusCode).toBe(200);
      expect(sessionResponseSchema.parse(changed.json()).user.mustChangePassword).toBe(false);
    });

    it('records who reset whom, keeping nothing of the password but its hash', async () => {
      const student = await createStudent();
      const before = await findUser(student.id);

      const { answer } = await resetOk({ loginId: student.loginId });

      const stored = await findUser(student.id);
      expect(stored.must_change_password).toBe(true);
      expect(stored.password_issued_at).toBeInstanceOf(Date);
      expect(stored.session_version).toBe(before.session_version + 1);
      expect(stored.password_hash).toMatch(/^\$argon2id\$/);
      expect(stored.password_hash).not.toContain(answer.password);
      const { rows } = await pool.query<{ admin_id: number; student_id: number }>(
        'SELECT admin_id, student_id FROM password_resets WHERE student_id = $1',
        [student.id],
      );
      expect(rows).toEqual([{ admin_id: admin.id, student_id: student.id }]);
    });
  });

  it('also resets an imported student who has no usable password yet', async () => {
    const student = await createStudent({ ownPassword: false });

    const { answer } = await resetOk({ loginId: student.loginId });

    expect((await postLogin(student.loginId, answer.password)).statusCode).toBe(200);
  });

  it('finds the student whatever the case and spacing of the login ID typed', async () => {
    const student = await createStudent();

    const { answer } = await resetOk({ loginId: ` ${student.loginId.toUpperCase()} ` });

    expect(answer.student.loginId).toBe(student.loginId);
  });

  describe('who can be reset', () => {
    it('answers 404 for a login ID nobody has', async () => {
      const response = await reset({ loginId: uniqueStudentId() });

      expect(response.statusCode).toBe(404);
      expect(errorCodeOf(response)).toBe('not_found');
    });

    it('answers the same 404 for an admin account and leaves its password alone', async () => {
      const other = await createTestUser(pool, { role: 'admin' });

      const response = await reset({ loginId: other.loginId });

      expect(response.statusCode).toBe(404);
      expect(errorCodeOf(response)).toBe('not_found');
      expect((await postLogin(other.loginId, other.password)).statusCode).toBe(200);
    });

    it('answers 404 for a student account with no profile (not imported)', async () => {
      const bare = await createTestUser(pool);

      const response = await reset({ loginId: bare.loginId });

      expect(response.statusCode).toBe(404);
      expect((await postLogin(bare.loginId, bare.password)).statusCode).toBe(200);
    });

    it.each([
      ['an unknown field', { loginId: 'fictional01', studentId: 1 }],
      ['a login ID of other characters', { loginId: 'นักเรียน' }],
      ['a malformed idempotency key', { loginId: 'fictional01', idempotencyKey: 'short' }],
    ])('answers 400 for %s', async (_label, body) => {
      const response = await reset(body);

      expect(response.statusCode).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_error');
    });
  });

  describe('idempotency key', () => {
    it('refuses a replay instead of killing the password already handed out', async () => {
      const student = await createStudent();
      const idempotencyKey = randomUUID();
      const { answer } = await resetOk({ loginId: student.loginId, idempotencyKey });
      const before = await findUser(student.id);

      const replay = await reset({ loginId: student.loginId, idempotencyKey });

      expect(replay.statusCode).toBe(409);
      expect(errorCodeOf(replay)).toBe('idempotency_key_reused');
      expect(await findUser(student.id)).toEqual(before);
      expect((await postLogin(student.loginId, answer.password)).statusCode).toBe(200);
    });

    it('lets only one of two concurrent duplicates commit', async () => {
      const student = await createStudent();
      const idempotencyKey = randomUUID();
      const before = await findUser(student.id);

      const responses = await Promise.all([
        reset({ loginId: student.loginId, idempotencyKey }),
        reset({ loginId: student.loginId, idempotencyKey }),
      ]);

      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
      const ok = responses.find(({ statusCode }) => statusCode === 200)!;
      const refused = responses.find(({ statusCode }) => statusCode === 409)!;
      expect(errorCodeOf(refused)).toBe('idempotency_key_reused');
      const { password } = passwordResetResponseSchema.parse(ok.json());
      expect((await postLogin(student.loginId, password)).statusCode).toBe(200);
      expect((await findUser(student.id)).session_version).toBe(before.session_version + 1);
    });
  });

  describe('response and logs', () => {
    it('may not be kept by a browser or proxy', async () => {
      const student = await createStudent();

      const { response } = await resetOk({ loginId: student.loginId });

      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('logs the admin and the student id, never the password, name or login ID', async () => {
      const student = await createStudent();

      const { answer } = await resetOk({ loginId: student.loginId });

      const log = logLines.join('');
      [answer.password, student.loginId, student.fullName, ownPasswordOf(student)].forEach(
        (secret) => {
          expect(log).not.toContain(secret);
        },
      );
      const entry = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(({ audit }) => audit === 'student.password_reset');
      expect(entry).toMatchObject({ adminId: admin.id, studentId: student.id });
    });
  });

  describe('access', () => {
    it('refuses a student with 403 and changes nothing', async () => {
      const target = await createStudent();
      const other = await createTestUser(pool);
      const before = await findUser(target.id);

      const response = await reset(
        { loginId: target.loginId },
        { token: await loginAs(other.loginId, other.password) },
      );

      expect(response.statusCode).toBe(403);
      expect(errorCodeOf(response)).toBe('forbidden');
      expect(await findUser(target.id)).toEqual(before);
    });

    it('refuses a request without a session with 401', async () => {
      const target = await createStudent();

      const response = await app.inject({
        method: 'POST',
        url: RESET_URL,
        payload: { loginId: target.loginId, idempotencyKey: randomUUID() },
      });

      expect(response.statusCode).toBe(401);
      expect((await postLogin(target.loginId, ownPasswordOf(target))).statusCode).toBe(200);
    });

    it('refuses a cross-site request with 403 and changes nothing', async () => {
      const target = await createStudent();
      const before = await findUser(target.id);

      const response = await reset(
        { loginId: target.loginId },
        { headers: { origin: 'https://attacker.example.test', host: APP_HOST } },
      );

      expect(response.statusCode).toBe(403);
      expect(await findUser(target.id)).toEqual(before);
    });

    it('rate-limits each admin, apart from the bulk issuance', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 60 }, async () => await reset({ loginId: uniqueStudentId() })),
      );
      expect(attempts.every(({ statusCode }) => statusCode === 404)).toBe(true);

      const limited = await reset({ loginId: uniqueStudentId() });
      const issue = await app.inject({
        method: 'POST',
        url: '/api/admin/students/initial-passwords',
        payload: {
          grade: GRADE,
          classroom: uniqueClassroom(),
          onlyUnissued: false,
          idempotencyKey: randomUUID(),
        },
        cookies: { [SESSION_COOKIE]: adminToken },
      });

      expect(limited.statusCode).toBe(429);
      expect(errorCodeOf(limited)).toBe('rate_limited');
      // Its own budget: the issuance still answers (nobody in that classroom to issue).
      expect(errorCodeOf(issue)).toBe('nothing_to_issue');
    });
  });

  // The student's own change-password writes with a compare-and-set on session_version, after the
  // reset's row lock (services/password-reset.ts). Whichever reaches the row first, the student
  // must end with the reset password and a forced change, never half of each. The waits are made
  // deterministic by holding the student's row on another connection.
  describe('racing the student changing their own password', () => {
    const holdRow = async (studentId: number) => {
      const holder = await pool.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [studentId]);
      return holder;
    };

    const expectResetPasswordOnly = async (student: Student, resetPassword: string) => {
      const stored = await findUser(student.id);
      expect(stored.must_change_password).toBe(true);
      expect(await verifyPassword(stored.password_hash, resetPassword)).toBe(true);
    };

    it('turns the change away with 401 when the reset locks the row first', async () => {
      const student = await createStudent();
      const token = await loginAs(student.loginId, ownPasswordOf(student));
      const holder = await holdRow(student.id);
      let released = false;
      try {
        const resetting = reset({ loginId: student.loginId });
        await waitForLockWaiter(pool, ({ query }) => query.includes(RESET_LOCK_QUERY));
        const changing = changeOwnPassword(token, ownPasswordOf(student), 'chosen-while-reset');
        await waitForLockWaiter(pool, ({ query }) => query.includes(CHANGE_UPDATE_QUERY));
        await holder.query('ROLLBACK');
        released = true;

        const [resetResponse, changeResponse] = [await resetting, await changing];

        expect(resetResponse.statusCode).toBe(200);
        expect(changeResponse.statusCode).toBe(401);
        const { password } = passwordResetResponseSchema.parse(resetResponse.json());
        await expectResetPasswordOnly(student, password);
        expect((await postLogin(student.loginId, 'chosen-while-reset')).statusCode).toBe(401);
      } finally {
        if (!released) await holder.query('ROLLBACK');
        holder.release();
      }
    });

    it('overwrites a change that reached the row first and ends its new session', async () => {
      const student = await createStudent();
      const token = await loginAs(student.loginId, ownPasswordOf(student));
      const holder = await holdRow(student.id);
      let released = false;
      try {
        const changing = changeOwnPassword(token, ownPasswordOf(student), 'chosen-before-reset');
        await waitForLockWaiter(pool, ({ query }) => query.includes(CHANGE_UPDATE_QUERY));
        const resetting = reset({ loginId: student.loginId });
        await waitForLockWaiter(pool, ({ query }) => query.includes(RESET_LOCK_QUERY));
        await holder.query('ROLLBACK');
        released = true;

        const [changeResponse, resetResponse] = [await changing, await resetting];

        expect(changeResponse.statusCode).toBe(200);
        expect(resetResponse.statusCode).toBe(200);
        const { password } = passwordResetResponseSchema.parse(resetResponse.json());
        await expectResetPasswordOnly(student, password);
        expect((await postLogin(student.loginId, 'chosen-before-reset')).statusCode).toBe(401);
        expect((await me(tokenOf(changeResponse))).statusCode).toBe(401);
      } finally {
        if (!released) await holder.query('ROLLBACK');
        holder.release();
      }
    });

    it('ends every free-running pair with the reset password and no server error', async () => {
      const students = await Promise.all(
        Array.from({ length: 12 }, async () => await createStudent()),
      );
      const tokens = await Promise.all(
        students.map(async (student) => await loginAs(student.loginId, ownPasswordOf(student))),
      );

      const pairs = await Promise.all(
        students.map(async (student, index) => {
          const [resetResponse, changeResponse] = await Promise.all([
            (async () => {
              await sleep(Math.floor(Math.random() * 40));
              return await reset({ loginId: student.loginId });
            })(),
            changeOwnPassword(tokens[index]!, ownPasswordOf(student), `chosen-${index}-x`),
          ]);
          return { student, resetResponse, changeResponse };
        }),
      );

      for (const { student, resetResponse, changeResponse } of pairs) {
        expect(resetResponse.statusCode).toBe(200);
        expect([200, 401]).toContain(changeResponse.statusCode);
        const { password } = passwordResetResponseSchema.parse(resetResponse.json());
        await expectResetPasswordOnly(student, password);
      }
    }, 30_000);
  });

  // Resets, bulk issuances and import commits of the same students all take the import lock
  // before any row lock, so they run one after the other: no deadlock (40P01) and every write
  // lands. Hashing is not what this is about, so the commits are given made-up hashes.
  it('runs beside issuances and import commits of the same students without deadlock', async () => {
    const ITERATIONS = 10;
    const classroom = uniqueClassroom();
    const students = await Promise.all(
      Array.from(
        { length: 10 },
        async () => await createStudent({ ownPassword: false, classroom }),
      ),
    );
    const target = students[4]!;
    const parsedFiles = await Promise.all(
      Array.from(
        { length: ITERATIONS },
        async (_, iteration) =>
          await parseImportWorkbook(
            await buildImportWorkbook({
              students: students
                .toSorted((a, b) => b.id - a.id)
                .map(({ loginId, seatNo }) =>
                  studentRow({
                    loginId,
                    fullName: `นักเรียนสมมติ รอบ${iteration + 1}`,
                    grade: GRADE,
                    classroom,
                    seatNo,
                  }),
                ),
            }),
          ),
      ),
    );
    const jittered = async <T>(work: () => Promise<T>) => {
      await sleep(Math.floor(Math.random() * 6));
      return await work();
    };

    const results = await Promise.all(
      parsedFiles.flatMap((parsed, iteration) => [
        settle(
          jittered(
            async () =>
              await commitReset(pool, {
                adminId: admin.id,
                idempotencyKey: randomUUID(),
                prepared: {
                  studentId: target.id,
                  password: `reset-${iteration}`,
                  passwordHash: `not-a-real-hash-reset-${iteration}`,
                },
              }),
          ),
        ),
        settle(
          jittered(
            async () =>
              await commitPasswords(pool, {
                adminId: admin.id,
                idempotencyKey: randomUUID(),
                scope: { grade: GRADE, classroom, onlyUnissued: false },
                prepared: students.map(({ id }) => ({
                  userId: id,
                  password: 'issued',
                  passwordHash: 'not-a-real-hash-issued',
                })),
              }),
          ),
        ),
        settle(
          jittered(
            async () => await commitImport(pool, { term: uniqueTerm(), parsed, actorId: admin.id }),
          ),
        ),
      ]),
    );

    const failures = results.flatMap((result) => (result.ok ? [] : [result.error]));
    expect(
      failures.filter((error) => error instanceof pg.DatabaseError && error.code === '40P01'),
    ).toEqual([]);
    expect(failures).toEqual([]);
    // Every reset and every issuance wrote the target once; every other student got each issuance.
    expect((await findUser(target.id)).session_version).toBe(2 * ITERATIONS);
    expect((await findUser(students[0]!.id)).session_version).toBe(ITERATIONS);
  }, 60_000);
});
