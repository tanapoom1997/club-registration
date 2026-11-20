import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { APP_DB_ROLE, enableAppRoleLogin } from '../../src/db-role.js';
import { runMigrations } from '../../src/run-migrations.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

// Random per run, like every test secret.
const TEST_APP_DB_PASSWORD = randomBytes(24).toString('hex');

// Migrated as the container's superuser (the owner, like migrate in production), with club_app
// given its login the same way migrate.ts does.
export const startMigratedPostgres = async (): Promise<StartedPostgreSqlContainer> => {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  await runMigrations(container.getConnectionUri());
  await enableAppRoleLogin(container.getConnectionUri(), TEST_APP_DB_PASSWORD);
  return container;
};

// What the api connects with in production. Tests build the app and their fixtures on it, so a
// statement the migrations do not grant fails here, not on the server. Fixture work the api never
// does (TRUNCATE between tests) uses container.getConnectionUri(), the owner.
export const appConnectionUri = (container: StartedPostgreSqlContainer): string => {
  const url = new URL(container.getConnectionUri());
  url.username = APP_DB_ROLE;
  url.password = TEST_APP_DB_PASSWORD;
  return url.toString();
};

// TRUNCATE between tests is fixture work the api never does, so club_app has no grant for it.
export const truncateAsOwner = async (
  container: StartedPostgreSqlContainer,
  tables: readonly string[],
): Promise<void> => {
  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  try {
    await client.query(
      `TRUNCATE ${tables.map((table) => client.escapeIdentifier(table)).join(', ')} CASCADE`,
    );
  } finally {
    await client.end();
  }
};

// pool.end() resolves once the pool has let go of its clients, while their connections may still
// be closing. Stopping the container in that gap makes Postgres terminate them (57P01), which the
// pool re-emits as an 'error' nobody listens to, failing the run as an uncaught exception. The
// pool emits 'remove' only after a client's connection has closed, so waiting for one per open
// client closes the gap.
export const endPoolFully = async (pool: pg.Pool): Promise<void> => {
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
};

export const stopPostgres = async (
  pool: pg.Pool,
  container: StartedPostgreSqlContainer,
): Promise<void> => {
  await endPoolFully(pool);
  await container.stop();
};
