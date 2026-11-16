import type { Role } from '@club-registration/shared';
import type pg from 'pg';
import { generatePassword, hashPassword } from '../auth/password.js';
import { createUserIfMissing } from '../auth/users.js';

type DemoAccount = {
  loginId: string;
  fullName: string;
  role: Role;
  profile?: { grade: number; classroom: string; seatNo: number };
};

// Fictional accounts for local development only. The repo is public, so names and IDs here must
// never resemble real people.
export const DEMO_ACCOUNTS: readonly DemoAccount[] = Object.freeze([
  { loginId: 'demo-admin', fullName: 'ผู้ดูแลสมมติ', role: 'admin' },
  {
    loginId: 'demo1001',
    fullName: 'นักเรียนสมมติ หนึ่ง',
    role: 'student',
    profile: { grade: 1, classroom: '1', seatNo: 1 },
  },
  {
    loginId: 'demo1002',
    fullName: 'นักเรียนสมมติ สอง',
    role: 'student',
    profile: { grade: 1, classroom: '1', seatNo: 2 },
  },
  {
    loginId: 'demo2001',
    fullName: 'นักเรียนสมมติ สาม',
    role: 'student',
    profile: { grade: 2, classroom: '1', seatNo: 1 },
  },
]);

const DEMO_PASSWORD_LENGTH = 10;

export type DemoCredential = { loginId: string; role: Role; password: string };

export type SeedResult = {
  // Passwords exist only here; the caller decides where they are shown or saved.
  issued: DemoCredential[];
  unchanged: string[];
};

const insertAccount = async (client: pg.PoolClient, account: DemoAccount, passwordHash: string) => {
  const result = await createUserIfMissing(client, {
    loginId: account.loginId,
    fullName: account.fullName,
    role: account.role,
    passwordHash,
    // Demo accounts exist to click around immediately; the forced-change flow is still testable
    // with an account from create-admin.
    mustChangePassword: false,
  });
  if (!result.created) {
    if (result.existingRole !== account.role) {
      throw new Error(`${account.loginId} exists with role ${result.existingRole}`);
    }
    return false;
  }
  if (account.profile) {
    await client.query(
      `INSERT INTO student_profiles (user_id, grade, classroom, seat_no) VALUES ($1, $2, $3, $4)`,
      [result.user.id, account.profile.grade, account.profile.classroom, account.profile.seatNo],
    );
  }
  return true;
};

// Bumping session_version also logs out anyone still holding the old demo password's session.
const resetPassword = async (client: pg.PoolClient, account: DemoAccount, passwordHash: string) => {
  const { rowCount } = await client.query(
    `UPDATE users
     SET password_hash = $2, must_change_password = false, session_version = session_version + 1
     WHERE login_id = $1 AND role = $3`,
    [account.loginId, passwordHash, account.role],
  );
  if (rowCount !== 1) throw new Error(`${account.loginId} is missing or has another role`);
};

// Existing accounts keep their password unless reset is asked for, so a password changed in the
// UI survives the next `pnpm dev`.
export const seedDemoAccounts = async (
  pool: pg.Pool,
  { reset = false }: { reset?: boolean } = {},
): Promise<SeedResult> => {
  const issued: DemoCredential[] = [];
  const unchanged: string[] = [];

  for (const account of DEMO_ACCOUNTS) {
    const password = generatePassword(DEMO_PASSWORD_LENGTH);
    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await insertAccount(client, account, passwordHash);
      if (!created && reset) await resetPassword(client, account, passwordHash);
      await client.query('COMMIT');
      if (created || reset) issued.push({ loginId: account.loginId, role: account.role, password });
      else unchanged.push(account.loginId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return { issued, unchanged };
};
