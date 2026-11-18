import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { TEST_JWT_SECRET } from './support/app.js';
import { appConnectionUri, startMigratedPostgres, stopPostgres } from './support/postgres.js';

// Documentation ranges (RFC 5737): never a real client.
const SOCKET_IP = '203.0.113.7';
const FORWARDED_IP = '198.51.100.23';

type LogEntry = { msg?: string; req?: Record<string, unknown>; err?: Record<string, unknown> };

describe('logging', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: FastifyInstance;
  let logLines: string[];

  const entries = (): LogEntry[] => logLines.map((line) => JSON.parse(line) as LogEntry);

  const unhandledErrorEntry = (): Record<string, unknown> => {
    const entry = entries().find(({ msg }) => msg === 'unhandled error');
    if (!entry?.err) throw new Error('No "unhandled error" line was logged');
    return entry.err;
  };

  // Test-only routes are added before the first inject, while the app can still take routes.
  const failingRoute = (work: () => Promise<unknown>): void => {
    app.get('/api/test-only/fail', async () => await work());
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
      // As in production behind Caddy, so request.ip is the forwarded client address.
      trustProxy: true,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('logs requests without the client IP address', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: SOCKET_IP,
      headers: { 'x-forwarded-for': FORWARDED_IP },
    });

    const requestEntry = entries().find(({ req }) => req !== undefined);
    expect(requestEntry?.req).toMatchObject({ method: 'GET', url: '/api/health' });
    const output = logLines.join('\n');
    expect(output).not.toContain(SOCKET_IP);
    expect(output).not.toContain(FORWARDED_IP);
  });

  it('logs a unique violation by code and constraint without the duplicated value', async () => {
    const loginId = 'fictional-duplicate-login';
    failingRoute(
      async () =>
        await pool.query(
          `INSERT INTO users (login_id, full_name, role, password_hash)
           VALUES ($1, 'Fictional Person', 'student', 'x'), ($1, 'Fictional Person', 'student', 'x')`,
          [loginId],
        ),
    );

    const response = await app.inject({ method: 'GET', url: '/api/test-only/fail' });

    expect(response.statusCode).toBe(500);
    expect(unhandledErrorEntry()).toMatchObject({
      code: '23505',
      constraint: 'users_login_id_key',
      table: 'users',
    });
    expect(logLines.join('\n')).not.toContain(loginId);
  });

  it('logs a data exception without the input value Postgres quotes in its message', async () => {
    const value = 'fictional-not-a-number';
    failingRoute(async () => await pool.query('SELECT $1::int', [value]));

    const response = await app.inject({ method: 'GET', url: '/api/test-only/fail' });

    expect(response.statusCode).toBe(500);
    expect(unhandledErrorEntry()).toMatchObject({ code: '22P02' });
    expect(logLines.join('\n')).not.toContain(value);
  });

  it('keeps the message and stack of errors that do not come from Postgres', async () => {
    failingRoute(async () => {
      await Promise.resolve();
      throw new Error('fictional failure in app code');
    });

    await app.inject({ method: 'GET', url: '/api/test-only/fail' });

    const err = unhandledErrorEntry();
    expect(err).toMatchObject({ type: 'Error', message: 'fictional failure in app code' });
    expect(err.stack).toEqual(expect.stringContaining('logging.test.ts'));
  });

  it('keeps a stack whose message holds $ replacement patterns as it was', async () => {
    const error = new Error("fictional price $' and $& in a message");
    failingRoute(async () => {
      await Promise.resolve();
      throw error;
    });

    await app.inject({ method: 'GET', url: '/api/test-only/fail' });

    expect(unhandledErrorEntry().stack).toBe(error.stack);
  });
});
