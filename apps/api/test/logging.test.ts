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

const PINO_OWN_NUMBERS = new Set(['time', 'pid', 'responseTime']);

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

  // No route takes personal data in its query, but a client can still send it there: a form that
  // falls back to GET, or a script that puts the login in the URL. The line is written before
  // validation could reject the request, so only the path and the parameter names are kept.
  it('logs the path and query parameter names, never query values', async () => {
    const values = ['fictional-secret-pw', 'fictional-student-login', '6599999'];
    const query = [
      `password=${values[0]}`,
      `loginId=${values[1]}`,
      `studentNo=${values[2]}`,
      // Names that are data themselves: a number and Thai text are counted, not logged.
      '6512345=x',
      `${encodeURIComponent('ชื่อสมมติ')}=y`,
    ].join('&');

    await app.inject({ method: 'GET', url: `/api/health?${query}` });

    const requestEntry = entries().find(({ req }) => req !== undefined);
    expect(requestEntry?.req).toEqual({
      method: 'GET',
      url: '/api/health',
      host: 'localhost:80',
      queryKeys: ['loginId', 'password', 'studentNo'],
      queryKeysOmitted: 2,
    });
    // Without the numbers pino adds by itself: a responseTime such as 4.463165999999546 contains
    // the digits of a student number by chance, which made this test fail on a slow run.
    const output = logLines
      .map((line) =>
        JSON.stringify(JSON.parse(line), (key, value: unknown) =>
          PINO_OWN_NUMBERS.has(key) ? undefined : value,
        ),
      )
      .join('\n');
    for (const leaked of [...values, '6512345', 'ชื่อสมมติ', encodeURIComponent('ชื่อสมมติ')]) {
      expect(output).not.toContain(leaked);
    }
  });

  it('logs a request without a query string with no query fields', async () => {
    await app.inject({ method: 'GET', url: '/api/health' });

    expect(entries().find(({ req }) => req !== undefined)?.req).toEqual({
      method: 'GET',
      url: '/api/health',
      host: 'localhost:80',
    });
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
