import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { runMigrations } from '../../src/run-migrations.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

export const startMigratedPostgres = async (): Promise<StartedPostgreSqlContainer> => {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  await runMigrations(container.getConnectionUri());
  return container;
};

// pool.end() resolves once the pool has let go of its clients, while their connections may still
// be closing. Stopping the container in that gap makes Postgres terminate them (57P01), which the
// pool re-emits as an 'error' nobody listens to, failing the run as an uncaught exception. The
// pool emits 'remove' only after a client's connection has closed, so waiting for one per open
// client closes the gap.
export const stopPostgres = async (
  pool: pg.Pool,
  container: StartedPostgreSqlContainer,
): Promise<void> => {
  const open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    let removed = 0;
    pool.on('remove', () => {
      removed += 1;
      if (removed >= open) resolve();
    });
    if (open === 0) resolve();
  });
  await pool.end();
  await closed;
  await container.stop();
};
