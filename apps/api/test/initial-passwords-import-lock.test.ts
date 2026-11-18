import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UNISSUED_PASSWORD_HASH } from '../src/auth/password.js';
import { createPool } from '../src/db.js';
import { parseImportWorkbook } from '../src/import/parse.js';
import { commitImport } from '../src/services/import-commit.js';
import { commitPasswords } from '../src/services/initial-passwords.js';
import type { IssueScope, PreparedPassword } from '../src/services/initial-passwords.js';
import { lockImport } from '../src/services/round-lock.js';
import { createTestUser } from './support/app.js';
import { uniqueStudentId, uniqueTerm } from './support/import-db.js';
import { buildImportWorkbook, studentRow } from './support/import.js';
import { waitForLockWaiter } from './support/lock-waiter.js';
import { appConnectionUri, startMigratedPostgres, stopPostgres } from './support/postgres.js';
import { registrationInvariantViolations } from './support/registration.js';

// Issuing initial passwords against an import commit (README "รายการที่ยังเปิดอยู่" item 9). Both
// lock many users and student_profiles rows in no common order, so the issuance takes the import
// lock before its row locks and the two never hold row locks at the same time. Waits are made
// deterministic by holding a lock on a separate connection and watching pg_stat_activity. Every
// value is made up.

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

const settle = async <T>(work: Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error };
  }
};

const GRADE = 2;
// Hashing is not what these tests are about: the commit writes whatever hash it is given.
const FAKE_HASH = 'not-a-real-hash';
const IMPORT_LOCK_QUERY = 'SELECT pg_advisory_xact_lock($1, $2)';

type Student = { id: number; loginId: string; seatNo: number };

describe('initial password issuance and the import lock', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let adminId: number;

  // Students as the import creates them, in a classroom of their own: no password yet.
  const createImportedStudents = async (count: number, classroom: string): Promise<Student[]> => {
    const { rows } = await pool.query<{ id: number; login_id: string; seat_no: number }>(
      `WITH new_users AS (
         INSERT INTO users (login_id, full_name, role, password_hash, must_change_password)
         SELECT login_id, 'นักเรียนสมมติ ก่อนนำเข้า', 'student', $2, true
         FROM unnest($1::text[]) AS v(login_id)
         RETURNING id, login_id
       ), profiles AS (
         INSERT INTO student_profiles (user_id, grade, classroom, seat_no)
         SELECT id, $3, $4, row_number() OVER (ORDER BY id) FROM new_users
         RETURNING user_id, seat_no
       )
       SELECT u.id, u.login_id, p.seat_no
       FROM new_users u JOIN profiles p ON p.user_id = u.id
       ORDER BY u.id`,
      [
        Array.from({ length: count }, () => uniqueStudentId()),
        UNISSUED_PASSWORD_HASH,
        GRADE,
        classroom,
      ],
    );
    return rows.map(({ id, login_id: loginId, seat_no: seatNo }) => ({ id, loginId, seatNo }));
  };

  const prepare = (students: readonly Student[]): PreparedPassword[] =>
    students.map(({ id }) => ({ userId: id, password: 'fake-password', passwordHash: FAKE_HASH }));

  const issue = async (scope: IssueScope, students: readonly Student[]) =>
    await commitPasswords(pool, {
      adminId,
      idempotencyKey: randomUUID(),
      scope,
      prepared: prepare(students),
    });

  // The same students in the same classroom and seats, renamed, listed in descending id: the
  // opposite of the order the issuance locks them in.
  const renameImport = async (students: readonly Student[], classroom: string, label: string) =>
    await parseImportWorkbook(
      await buildImportWorkbook({
        students: students
          .toSorted((a, b) => b.id - a.id)
          .map(({ loginId, seatNo }) =>
            studentRow({
              loginId,
              fullName: `นักเรียนสมมติ ${label}`,
              grade: GRADE,
              classroom,
              seatNo,
            }),
          ),
      }),
    );

  const backendPid = async (client: pg.PoolClient): Promise<number> => {
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error('pg_backend_pid() returned no row');
    return pid;
  };

  const sessionVersions = async (students: readonly Student[]) => {
    const { rows } = await pool.query<{ session_version: number }>(
      'SELECT session_version FROM users WHERE id = ANY($1::int[]) ORDER BY id',
      [students.map(({ id }) => id)],
    );
    return rows.map(({ session_version: version }) => version);
  };

  const namesOf = async (students: readonly Student[]) => {
    const { rows } = await pool.query<{ full_name: string }>(
      'SELECT DISTINCT full_name FROM users WHERE id = ANY($1::int[])',
      [students.map(({ id }) => id)],
    );
    return rows.map(({ full_name: name }) => name);
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(appConnectionUri(container));
    adminId = (await createTestUser(pool, { role: 'admin' })).id;
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  afterEach(async () => {
    expect(await registrationInvariantViolations(pool)).toEqual([]);
  });

  it('waits for the import lock before locking any row, then issues', async () => {
    const classroom = `r${randomBytes(3).toString('hex')}`;
    const students = await createImportedStudents(5, classroom);
    const holder = await pool.connect();
    let released = false;
    try {
      await holder.query('BEGIN');
      const holderPid = await backendPid(holder);
      // Stands in for an import commit in progress.
      await lockImport(holder);

      const issuing = settle(issue({ grade: GRADE, classroom, onlyUnissued: false }, students));
      const waiter = await waitForLockWaiter(pool, ({ pid }) => pid !== holderPid);
      // While it waits it holds no row: another transaction can lock every student at once.
      const { rowCount } = await holder.query(
        'SELECT 1 FROM users WHERE id = ANY($1::int[]) FOR UPDATE NOWAIT',
        [students.map(({ id }) => id)],
      );
      await holder.query('ROLLBACK');
      released = true;
      const issued = await issuing;

      expect(waiter).toMatchObject({ waitEvent: 'advisory', query: IMPORT_LOCK_QUERY });
      expect(rowCount).toBe(students.length);
      expect(issued.ok && issued.value.map(({ loginId }) => loginId).sort()).toEqual(
        students.map(({ loginId }) => loginId).sort(),
      );
      expect(await sessionVersions(students)).toEqual(students.map(() => 1));
    } finally {
      if (!released) await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('makes an import commit wait while an issuance holds the import lock', async () => {
    const classroom = `r${randomBytes(3).toString('hex')}`;
    const students = await createImportedStudents(5, classroom);
    const parsed = await renameImport(students, classroom, 'หลังนำเข้า');
    const blocker = await pool.connect();
    let released = false;
    try {
      await blocker.query('BEGIN');
      const blockerPid = await backendPid(blocker);
      // Holds one student's row, so the issuance stops after taking the import lock.
      await blocker.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [students[2]!.id]);

      const issuing = settle(issue({ grade: GRADE, classroom, onlyUnissued: false }, students));
      const issueWaiter = await waitForLockWaiter(pool, ({ pid }) => pid !== blockerPid);
      expect(issueWaiter.query).toContain('FOR NO KEY UPDATE OF u');
      const importing = settle(commitImport(pool, uniqueTerm(), parsed));
      const importWaiter = await waitForLockWaiter(
        pool,
        ({ pid }) => pid !== blockerPid && pid !== issueWaiter.pid,
      );
      await blocker.query('ROLLBACK');
      released = true;
      const [issued, imported] = [await issuing, await importing];

      expect(importWaiter).toMatchObject({ waitEvent: 'advisory', query: IMPORT_LOCK_QUERY });
      expect(issued.ok && issued.value).toHaveLength(students.length);
      expect(imported.ok && imported.value.status).toBe('committed');
      expect(await namesOf(students)).toEqual(['นักเรียนสมมติ หลังนำเข้า']);
      expect(await sessionVersions(students)).toEqual(students.map(() => 1));
    } finally {
      if (!released) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('runs issuances and imports of the same students side by side without deadlock', async () => {
    const ITERATIONS = 20;
    const classroom = `r${randomBytes(3).toString('hex')}`;
    const students = await createImportedStudents(30, classroom);
    const scope: IssueScope = { grade: GRADE, classroom, onlyUnissued: false };
    const parsedFiles = await Promise.all(
      Array.from(
        { length: ITERATIONS },
        async (_, iteration) => await renameImport(students, classroom, `รอบ${iteration + 1}`),
      ),
    );

    // Every pair starts together; a small random delay varies which of the two reaches its rows
    // first, so their row locking overlaps in as many ways as possible.
    const results = await Promise.all(
      parsedFiles.flatMap((parsed) => [
        settle(
          (async () => {
            await sleep(Math.floor(Math.random() * 6));
            return await issue(scope, students);
          })(),
        ),
        settle(
          (async () => {
            await sleep(Math.floor(Math.random() * 6));
            return await commitImport(pool, uniqueTerm(), parsed);
          })(),
        ),
      ]),
    );

    const failures = results.flatMap((result) => (result.ok ? [] : [result.error]));
    const deadlocks = failures.filter(
      (error) => error instanceof pg.DatabaseError && error.code === '40P01',
    );
    expect(deadlocks).toEqual([]);
    expect(failures).toEqual([]);
    // Every issuance wrote every student once; every import committed.
    expect(await sessionVersions(students)).toEqual(students.map(() => ITERATIONS));
    expect(
      results.filter(
        (result) => result.ok && 'status' in result.value && result.value.status === 'committed',
      ),
    ).toHaveLength(ITERATIONS);
  }, 60_000);
});
