import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { errorResponseSchema, healthResponseSchema } from '@club-registration/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { buildTestApp } from './support/app.js';
import { appConnectionUri, startMigratedPostgres, stopPostgres } from './support/postgres.js';

describe('GET /api/health', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(appConnectionUri(container));
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  it('reports ok when the database answers', async () => {
    const app = await buildTestApp(pool);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toEqual({ status: 'ok', database: 'up' });
    await app.close();
  });

  it('reports 503 when the database cannot be reached', async () => {
    // Port 1 is reserved and never has Postgres listening, so the connection really fails.
    const unreachablePool = createPool('postgres://nobody:nothing@127.0.0.1:1/none');
    const app = await buildTestApp(unreachablePool);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(503);
    expect(healthResponseSchema.parse(response.json())).toEqual({
      status: 'degraded',
      database: 'down',
    });
    await app.close();
    await unreachablePool.end();
  });

  it('answers unknown routes with the shared error shape', async () => {
    const app = await buildTestApp(pool);

    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).code).toBe('not_found');
    await app.close();
  });
});
