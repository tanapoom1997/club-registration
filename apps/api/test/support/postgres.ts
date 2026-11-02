import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/run-migrations.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

export const startMigratedPostgres = async (): Promise<StartedPostgreSqlContainer> => {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  await runMigrations(container.getConnectionUri());
  return container;
};
