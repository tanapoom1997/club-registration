import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdmin } from '../src/auth/service.js';
import { createPool } from '../src/db.js';
import { buildTestApp, createTestUser } from './support/app.js';
import { startMigratedPostgres, stopPostgres } from './support/postgres.js';

describe('createAdmin', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let counter = 0;
  const nextLoginId = () => `admin-${(counter += 1)}`;

  const storedRow = async (loginId: string) => {
    const { rows } = await pool.query<{
      role: string;
      password_hash: string;
      must_change_password: boolean;
    }>('SELECT role, password_hash, must_change_password FROM users WHERE login_id = $1', [
      loginId,
    ]);
    return rows;
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(container.getConnectionUri());
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  it('creates an admin that must change its password and stores only a hash', async () => {
    const loginId = nextLoginId();

    const result = await createAdmin(pool, loginId);

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.initialPassword).toHaveLength(16);
    const [row] = await storedRow(loginId);
    expect(row).toMatchObject({ role: 'admin', must_change_password: true });
    expect(row!.password_hash).toMatch(/^\$argon2id\$/);
    expect(row!.password_hash).not.toContain(result.initialPassword);
  });

  it('lets the new admin log in with the shown password', async () => {
    const loginId = nextLoginId();
    const result = await createAdmin(pool, loginId);
    if (result.status !== 'created') throw new Error('expected a new admin');
    const app = await buildTestApp(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { loginId, password: result.initialPassword },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('does nothing on a rerun: no new row, no new password', async () => {
    const loginId = nextLoginId();
    await createAdmin(pool, loginId);
    const [before] = await storedRow(loginId);

    const rerun = await createAdmin(pool, loginId);

    expect(rerun).toEqual({ status: 'exists' });
    expect(await storedRow(loginId)).toEqual([before]);
  });

  it('creates exactly one admin when two runs race', async () => {
    const loginId = nextLoginId();

    const results = await Promise.all([createAdmin(pool, loginId), createAdmin(pool, loginId)]);

    expect(results.map((result) => result.status).sort()).toEqual(['created', 'exists']);
    expect(await storedRow(loginId)).toHaveLength(1);
  });

  it('refuses to turn an existing student into an admin', async () => {
    const student = await createTestUser(pool);

    const result = await createAdmin(pool, student.loginId);

    expect(result).toEqual({ status: 'conflict', existingRole: 'student' });
    expect((await storedRow(student.loginId))[0]!.role).toBe('student');
  });
});
