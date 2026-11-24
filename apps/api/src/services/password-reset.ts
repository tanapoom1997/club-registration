import { ERROR_CODES } from '@club-registration/shared';
import type { PasswordResetResponse } from '@club-registration/shared';
import type pg from 'pg';
import { generatePassword, hashPassword } from '../auth/password.js';
import type { ConcurrencyLimit } from '../concurrency-limit.js';
import { isPgError, PG_ERROR_CODES, withTransaction } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import { INITIAL_PASSWORD_LENGTH } from './initial-passwords.js';
import { lockImport } from './round-lock.js';

// An admin resetting one student's password: the way back for a student who forgot it, including
// one who already replaced their initial password (the bulk issuance never touches those). The
// steps mirror the issuance (initial-passwords.ts), for the same reasons:
//
// 1. Outside any transaction: refuse a key already used, and find the student (role student with
//    a student_profiles row; anything else, an admin's login ID included, is 404 not_found, so the
//    answer does not say which). A typo costs one query, not an Argon2 hash.
// 2. Generate and hash the password, still outside any transaction (Argon2 is slow), under the
//    server-wide hash limit the issuance uses, so resets and issuances together keep threads free
//    for logins.
// 3. One short transaction: the import lock, then the student's users row FOR NO KEY UPDATE (and
//    the profile FOR SHARE, so the classroom and seat answered are the ones committed), re-checked
//    as in step 1; then an unconditional write of the hash, must_change_password = true,
//    password_issued_at and session_version + 1, and the password_resets row with the key.
//
// Unlike the issuance, the UPDATE has no must_change_password filter and no compare-and-set: the
// admin asked for this student's password to be replaced whatever it is now, and the row lock is
// what orders it against every other writer of that row.
//
// Races this settles:
// - The student's own password change (auth/service.ts) verifies and hashes first, then writes
//   with a compare-and-set on session_version. If the reset commits first (before the change's
//   guard reads the session, or before or while its UPDATE waits for our row lock), the guard or
//   the compare-and-set finds the bumped version and the change answers 401 having changed
//   nothing. If the change commits first, the reset locks the row after it and overwrites it.
//   Either way the student ends with the reset password and must change it at the next login;
//   never their new hash beside must_change_password = true, or the reverse.
// - The bulk issuance and the import commit: all three take the import lock before any row lock
//   (round-lock.ts step 1), so they run one after the other and never deadlock. A reset leaves the
//   student issued and unchanged, so an issuance committed after it (without onlyUnissued)
//   replaces the reset password like any other issued one; whichever committed last holds.
// - Two resets of the same student: the import lock runs them one after the other, and the later
//   one's password is the valid one. The same request twice (same key) commits once: the UNIQUE
//   (admin_id, idempotency_key) violation of the second is turned into idempotency_key_reused.

export type ResetInput = { adminId: number; loginId: string; idempotencyKey: string };

export type PreparedReset = { studentId: number; password: string; passwordHash: string };

const RESET_KEY_UNIQUE = 'password_resets_admin_id_idempotency_key_key';

export const assertResetKeyUnused = async (
  db: Queryable,
  adminId: number,
  idempotencyKey: string,
): Promise<void> => {
  const { rowCount } = await db.query(
    'SELECT 1 FROM password_resets WHERE admin_id = $1 AND idempotency_key = $2',
    [adminId, idempotencyKey],
  );
  if (rowCount !== 0) throw new AppError(ERROR_CODES.idempotencyKeyReused);
};

// Step 1 (the lookup) and 2. The plaintext exists only in the returned value, in memory.
export const prepareReset = async (
  db: Queryable,
  loginId: string,
  limit: ConcurrencyLimit,
): Promise<PreparedReset> => {
  const { rows } = await db.query<{ id: number }>(
    `SELECT u.id
     FROM users u JOIN student_profiles sp ON sp.user_id = u.id
     WHERE u.login_id = $1 AND u.role = 'student'`,
    [loginId],
  );
  const studentId = rows[0]?.id;
  if (studentId === undefined) throw new AppError(ERROR_CODES.notFound, 'Student not found');
  return await limit(async () => {
    const password = generatePassword(INITIAL_PASSWORD_LENGTH);
    return { studentId, password, passwordHash: await hashPassword(password) };
  });
};

type LockedStudent = {
  login_id: string;
  full_name: string;
  grade: number;
  classroom: string;
  seat_no: number;
};

// Step 3.
export const commitReset = async (
  pool: pg.Pool,
  { adminId, idempotencyKey, prepared }: Omit<ResetInput, 'loginId'> & { prepared: PreparedReset },
): Promise<PasswordResetResponse> =>
  await withTransaction(pool, async (client) => {
    await lockImport(client);
    const { rows } = await client.query<LockedStudent>(
      `SELECT u.login_id, u.full_name, sp.grade, sp.classroom, sp.seat_no
       FROM users u JOIN student_profiles sp ON sp.user_id = u.id
       WHERE u.id = $1 AND u.role = 'student'
       FOR NO KEY UPDATE OF u
       FOR SHARE OF sp`,
      [prepared.studentId],
    );
    const student = rows[0];
    if (!student) throw new AppError(ERROR_CODES.notFound, 'Student not found');

    await client.query(
      `UPDATE users
       SET password_hash = $2,
           must_change_password = true,
           password_issued_at = now(),
           session_version = session_version + 1
       WHERE id = $1`,
      [prepared.studentId, prepared.passwordHash],
    );

    try {
      await client.query(
        `INSERT INTO password_resets (admin_id, student_id, idempotency_key)
         VALUES ($1, $2, $3)`,
        [adminId, prepared.studentId, idempotencyKey],
      );
    } catch (error) {
      // The same key committed by a concurrent duplicate of this request: undo this one.
      if (isPgError(error, PG_ERROR_CODES.uniqueViolation, RESET_KEY_UNIQUE)) {
        throw new AppError(ERROR_CODES.idempotencyKeyReused);
      }
      throw error;
    }

    return {
      student: {
        loginId: student.login_id,
        fullName: student.full_name,
        grade: student.grade,
        classroom: student.classroom,
        seatNo: student.seat_no,
      },
      password: prepared.password,
    };
  });
