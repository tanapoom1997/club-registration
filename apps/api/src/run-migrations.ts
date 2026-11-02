import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

// Resolved from this file so it holds for both src/ under tsx and dist/ in production.
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export const runMigrations = async (databaseUrl: string): Promise<void> => {
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
};
