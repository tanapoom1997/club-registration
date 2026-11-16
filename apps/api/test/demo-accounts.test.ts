import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { DEMO_ACCOUNTS, seedDemoAccounts } from '../src/dev/demo-accounts.js';
import { buildTestApp } from './support/app.js';
import { startMigratedPostgres, stopPostgres } from './support/postgres.js';

describe('seedDemoAccounts', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  const demoRows = async () => {
    const { rows } = await pool.query<{
      login_id: string;
      role: string;
      password_hash: string;
      must_change_password: boolean;
      grade: number | null;
    }>(
      `SELECT u.login_id, u.role, u.password_hash, u.must_change_password, p.grade
       FROM users u LEFT JOIN student_profiles p ON p.user_id = u.id
       WHERE u.login_id LIKE 'demo%' ORDER BY u.login_id`,
    );
    return rows;
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(container.getConnectionUri());
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  // Each test starts from a database without demo accounts, so order never matters.
  beforeEach(async () => {
    await pool.query(
      `DELETE FROM student_profiles WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'demo%')`,
    );
    await pool.query(`DELETE FROM users WHERE login_id LIKE 'demo%'`);
  });

  it('creates every demo account without a forced password change', async () => {
    const result = await seedDemoAccounts(pool);

    expect(result.issued.map(({ loginId }) => loginId)).toEqual(
      DEMO_ACCOUNTS.map(({ loginId }) => loginId),
    );
    const rows = await demoRows();
    expect(rows).toHaveLength(DEMO_ACCOUNTS.length);
    expect(rows.every((row) => !row.must_change_password)).toBe(true);
  });

  it('gives students a profile and the admin none', async () => {
    await seedDemoAccounts(pool);

    const rows = await demoRows();

    expect(rows.find((row) => row.login_id === 'demo-admin')).toMatchObject({
      role: 'admin',
      grade: null,
    });
    expect(rows.find((row) => row.login_id === 'demo2001')).toMatchObject({
      role: 'student',
      grade: 2,
    });
  });

  it('issues passwords that log straight in to the home page', async () => {
    const { issued } = await seedDemoAccounts(pool);
    const admin = issued.find(({ loginId }) => loginId === 'demo-admin')!;
    const app = await buildTestApp(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { loginId: admin.loginId, password: admin.password },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { role: 'admin', mustChangePassword: false } });
    await app.close();
  });

  it('leaves existing accounts and their passwords alone on a rerun', async () => {
    await seedDemoAccounts(pool);
    const before = await demoRows();

    const rerun = await seedDemoAccounts(pool);

    expect(rerun.issued).toEqual([]);
    expect(rerun.unchanged).toHaveLength(DEMO_ACCOUNTS.length);
    expect(await demoRows()).toEqual(before);
  });

  it('replaces every demo password when reset is asked for', async () => {
    await seedDemoAccounts(pool);
    const before = await demoRows();

    const reset = await seedDemoAccounts(pool, { reset: true });

    expect(reset.issued).toHaveLength(DEMO_ACCOUNTS.length);
    const after = await demoRows();
    expect(after.map((row) => row.password_hash)).not.toContain(before[0]!.password_hash);
    expect(after).toHaveLength(before.length);
  });
});
