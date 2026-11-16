import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { hashPassword } from '../../src/auth/password.js';
import { buildApp } from '../../src/app.js';
import type { Role } from '@club-registration/shared';

// Random per run: tests must never depend on a secret that could look like a real one.
export const TEST_JWT_SECRET = randomBytes(48).toString('base64url');

export const buildTestApp = async (pool: pg.Pool) =>
  await buildApp({ pool, jwtSecret: TEST_JWT_SECRET });

export type TestUser = { id: number; loginId: string; password: string };

let userCounter = 0;

export const createTestUser = async (
  pool: pg.Pool,
  {
    role = 'student',
    mustChangePassword = false,
  }: { role?: Role; mustChangePassword?: boolean } = {},
): Promise<TestUser> => {
  userCounter += 1;
  const loginId = `${role}-${userCounter}-${randomBytes(3).toString('hex')}`;
  const password = `pw-${randomBytes(8).toString('hex')}`;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (login_id, full_name, role, password_hash, must_change_password)
     VALUES ($1, 'Fictional User', $2, $3, $4) RETURNING id`,
    [loginId, role, await hashPassword(password), mustChangePassword],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('Test user insert returned no row');
  return { id, loginId, password };
};
