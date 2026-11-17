import { ERROR_CODES } from '@club-registration/shared';
import type { ClassroomPasswordStatus } from '@club-registration/shared';
import type pg from 'pg';
import { generatePassword, hashPassword } from '../auth/password.js';
import type { ConcurrencyLimit } from '../concurrency-limit.js';
import { isPgError, PG_ERROR_CODES, withTransaction } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import { compareClassrooms } from './classroom-order.js';
import { lockImport } from './round-lock.js';

// How an admin hands out initial passwords:
//
// 1. Read (outside any transaction) which students in the scope may get one: role student,
//    must_change_password still true, and, with onlyUnissued, never issued before.
// 2. Generate and hash a password for each, still outside any transaction. Argon2 takes tens of
//    milliseconds per hash, so a grade takes seconds; a transaction held open that long would hit
//    idle_in_transaction_session_timeout and keep rows locked against the students' own logins.
//    The caller's limit bounds how many hashes run at once, so the libuv threadpool keeps free
//    threads for logins and other requests.
// 3. One short transaction: take the import lock, then lock the rows that are *still* eligible
//    (SELECT … FOR NO KEY UPDATE re-checks the WHERE clause against the latest committed row once
//    a lock is granted), write the hashes to exactly those, bump session_version (so sessions
//    under an older issued password end) and record the issuance. Only students whose row was
//    updated go into the file.
//
// Races this settles:
// - A student who changes their password between steps 1 and 3 has must_change_password = false
//   by step 3 and is skipped, never overwritten. If the change is still in flight, its UPDATE
//   (compare-and-set on session_version) waits for our lock and then finds a new version, so the
//   student is told to sign in again with the issued password instead of half-succeeding.
// - Two admins issuing the same scope: the import lock below runs their transactions one after
//   the other (each also locks its rows in id order), so the second waits, then re-checks and
//   overwrites (or, with onlyUnissued, skips them because they are now issued). Each student ends
//   with exactly one valid password, the one in the file of whichever request committed last;
//   the other file's password is dead.
// - An import commit at the same time: both lock many users (and student_profiles) rows, in no
//   common order (the import in file order, this in id order), so without more they could
//   deadlock and Postgres would abort one with 40P01, a 500 for the admin. Taking the import lock
//   pg_advisory_xact_lock(1, 1) first, before any row lock, makes them never hold row locks at the
//   same time: whichever comes second waits for the other to commit, then reads what it wrote
//   (an issuance after an import sees new students and classrooms; an import after an issuance
//   leaves passwords alone anyway). Only this short transaction waits, never the hashing. The
//   full lock order, and why it stays deadlock-free with registrations, is in round-lock.ts.
//
// FOR NO KEY UPDATE rather than FOR UPDATE: foreign-key checks (e.g. a registration insert) take
// FOR KEY SHARE on users, which this does not block. FOR SHARE on student_profiles keeps the
// classroom and seat printed in the file from changing under us, again without blocking FK checks.

export const INITIAL_PASSWORD_LENGTH = 10;

export type IssueScope = {
  grade: number;
  // undefined = the whole grade.
  classroom: string | undefined;
  onlyUnissued: boolean;
};

export type PreparedPassword = { userId: number; password: string; passwordHash: string };

export type IssuedStudent = {
  loginId: string;
  fullName: string;
  grade: number;
  classroom: string;
  seatNo: number;
  password: string;
};

// $1 grade, $2 classroom (NULL = all), $3 onlyUnissued. Identical in steps 1 and 3 so a student
// that left the scope in between (e.g. moved classroom by an import) is skipped too.
const ELIGIBLE = `
  u.role = 'student'
  AND u.must_change_password
  AND sp.grade = $1
  AND ($2::text IS NULL OR sp.classroom = $2)
  AND (NOT $3::boolean OR u.password_issued_at IS NULL)`;

const scopeParams = ({ grade, classroom, onlyUnissued }: IssueScope) => [
  grade,
  classroom ?? null,
  onlyUnissued,
];

const compareStudents = (a: IssuedStudent, b: IssuedStudent): number =>
  a.grade - b.grade ||
  compareClassrooms(a.classroom, b.classroom) ||
  a.seatNo - b.seatNo ||
  a.loginId.localeCompare(b.loginId);

export const assertIdempotencyKeyUnused = async (
  db: Queryable,
  adminId: number,
  idempotencyKey: string,
): Promise<void> => {
  const { rowCount } = await db.query(
    'SELECT 1 FROM password_issuances WHERE admin_id = $1 AND idempotency_key = $2',
    [adminId, idempotencyKey],
  );
  if (rowCount !== 0) throw new AppError(ERROR_CODES.idempotencyKeyReused);
};

// Step 1 + 2. Plaintext passwords exist only in the returned array, in memory.
export const preparePasswords = async (
  db: Queryable,
  scope: IssueScope,
  limit: ConcurrencyLimit,
): Promise<PreparedPassword[]> => {
  const { rows } = await db.query<{ id: number }>(
    `SELECT u.id
     FROM users u JOIN student_profiles sp ON sp.user_id = u.id
     WHERE ${ELIGIBLE}
     ORDER BY u.id`,
    scopeParams(scope),
  );
  if (rows.length === 0) throw new AppError(ERROR_CODES.nothingToIssue);
  return await Promise.all(
    rows.map(
      async ({ id }) =>
        await limit(async () => {
          const password = generatePassword(INITIAL_PASSWORD_LENGTH);
          return { userId: id, password, passwordHash: await hashPassword(password) };
        }),
    ),
  );
};

type LockedRow = {
  id: number;
  login_id: string;
  full_name: string;
  grade: number;
  classroom: string;
  seat_no: number;
};

type CommitInput = {
  adminId: number;
  idempotencyKey: string;
  scope: IssueScope;
  prepared: readonly PreparedPassword[];
};

const ISSUANCE_KEY_UNIQUE = 'password_issuances_admin_id_idempotency_key_key';

// Step 3. Returns the students who really got a new password, sorted for printing.
export const commitPasswords = async (
  pool: pg.Pool,
  { adminId, idempotencyKey, scope, prepared }: CommitInput,
): Promise<IssuedStudent[]> =>
  await withTransaction(pool, async (client) => {
    await lockImport(client);
    const { rows: locked } = await client.query<LockedRow>(
      `SELECT u.id, u.login_id, u.full_name, sp.grade, sp.classroom, sp.seat_no
       FROM users u JOIN student_profiles sp ON sp.user_id = u.id
       WHERE ${ELIGIBLE} AND u.id = ANY($4::int[])
       ORDER BY u.id
       FOR NO KEY UPDATE OF u
       FOR SHARE OF sp`,
      [...scopeParams(scope), prepared.map(({ userId }) => userId)],
    );
    const lockedIds = new Set(locked.map(({ id }) => id));
    const toWrite = prepared.filter(({ userId }) => lockedIds.has(userId));

    // must_change_password is checked again only as a backstop; the lock above already holds it.
    const { rows: updated } = await client.query<{ id: number }>(
      `UPDATE users u
       SET password_hash = v.password_hash,
           password_issued_at = now(),
           session_version = u.session_version + 1
       FROM unnest($1::int[], $2::text[]) AS v(id, password_hash)
       WHERE u.id = v.id AND u.must_change_password
       RETURNING u.id`,
      [toWrite.map(({ userId }) => userId), toWrite.map(({ passwordHash }) => passwordHash)],
    );
    // Throwing rolls back, so a request that changed nothing leaves no issuance record behind.
    if (updated.length === 0) throw new AppError(ERROR_CODES.nothingToIssue);

    try {
      await client.query(
        `INSERT INTO password_issuances
           (admin_id, idempotency_key, grade, classroom, only_unissued, issued_count)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [adminId, idempotencyKey, ...scopeParams(scope), updated.length],
      );
    } catch (error) {
      // The same key committed by a concurrent duplicate of this request: undo this one.
      if (isPgError(error, PG_ERROR_CODES.uniqueViolation, ISSUANCE_KEY_UNIQUE)) {
        throw new AppError(ERROR_CODES.idempotencyKeyReused);
      }
      throw error;
    }

    const updatedIds = new Set(updated.map(({ id }) => id));
    const passwords = new Map(toWrite.map(({ userId, password }) => [userId, password]));
    return locked
      .filter(({ id }) => updatedIds.has(id))
      .map((row) => {
        const password = passwords.get(row.id);
        // Only prepared ids are locked, so this is a bug, never a client error.
        if (password === undefined) throw new Error('Updated a student with no prepared password');
        return {
          loginId: row.login_id,
          fullName: row.full_name,
          grade: row.grade,
          classroom: row.classroom,
          seatNo: row.seat_no,
          password,
        };
      })
      .sort(compareStudents);
  });

type StatusRow = {
  grade: number;
  classroom: string;
  never_issued: number;
  issued_pending: number;
  changed: number;
  last_issued_at: Date | null;
};

export const getPasswordStatus = async (db: Queryable): Promise<ClassroomPasswordStatus[]> => {
  const { rows } = await db.query<StatusRow>(
    `SELECT sp.grade, sp.classroom,
            count(*) FILTER (WHERE u.must_change_password AND u.password_issued_at IS NULL)::int
              AS never_issued,
            count(*) FILTER (WHERE u.must_change_password AND u.password_issued_at IS NOT NULL)::int
              AS issued_pending,
            count(*) FILTER (WHERE NOT u.must_change_password)::int AS changed,
            max(u.password_issued_at) AS last_issued_at
     FROM users u JOIN student_profiles sp ON sp.user_id = u.id
     WHERE u.role = 'student'
     GROUP BY sp.grade, sp.classroom`,
  );
  return rows
    .map((row) => ({
      grade: row.grade,
      classroom: row.classroom,
      neverIssued: row.never_issued,
      issuedPending: row.issued_pending,
      changed: row.changed,
      lastIssuedAt: row.last_issued_at?.toISOString() ?? null,
    }))
    .sort((a, b) => a.grade - b.grade || compareClassrooms(a.classroom, b.classroom));
};
