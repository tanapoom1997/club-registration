import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { serializeError } from './log.js';

// Resolved from this file so it holds for both src/ under tsx and dist/ in production.
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATIONS_TABLE = 'pgmigrations';
const MIGRATION_EXTENSION = '.sql';

// node-pg-migrate's own logger stays silent: it prints every migration's whole SQL, and on an
// error the failing statement and the database's message, which can quote row values. What a
// deploy needs (which migrations ran, which one failed and why) is reported by
// migrateWithReport instead, through the same error allowlist as the api's log (log.ts).
export const runMigrations = async (
  databaseUrl: string,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> => {
  const applied = await runner({
    databaseUrl,
    dir,
    direction: 'up',
    migrationsTable: MIGRATIONS_TABLE,
    log: () => undefined,
  });
  return applied.map(({ name }) => name);
};

export type MigrationLogEntry = { level: 'info' | 'error'; msg: string; [field: string]: unknown };

const migrationNames = async (dir: string): Promise<string[]> =>
  (await readdir(dir))
    .filter((file) => file.endsWith(MIGRATION_EXTENSION))
    .map((file) => file.slice(0, -MIGRATION_EXTENSION.length))
    .sort();

const appliedNames = async (databaseUrl: string): Promise<Set<string>> => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [MIGRATIONS_TABLE],
    );
    if (rows[0]?.exists !== true) return new Set();
    const applied = await client.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
    return new Set(applied.rows.map(({ name }) => name));
  } finally {
    await client.end();
  }
};

// The first migration on disk that is still not applied after a failed run: normally the one that
// failed (the run may also have stopped earlier, e.g. on a connection or lock error, which the
// entry's err tells). A lookup that fails itself is reported next to the run's error.
const firstNotApplied = async (databaseUrl: string, dir: string) => {
  try {
    const applied = await appliedNames(databaseUrl);
    const name = (await migrationNames(dir)).find((migration) => !applied.has(migration));
    return name === undefined ? {} : { firstNotApplied: name };
  } catch (lookupError) {
    return { firstNotAppliedUnknown: serializeError(lookupError) };
  }
};

// Runs the migrations and writes one entry: what was applied, or where it stopped and the
// error (code, constraint, table, never Postgres's detail with row values). Resolves to whether
// it succeeded, so the caller decides the exit code; it never throws.
export const migrateWithReport = async ({
  databaseUrl,
  dir = MIGRATIONS_DIR,
  log,
}: {
  databaseUrl: string;
  dir?: string;
  log: (entry: MigrationLogEntry) => void;
}): Promise<boolean> => {
  try {
    const applied = await runMigrations(databaseUrl, dir);
    log({
      level: 'info',
      msg: applied.length === 0 ? 'no pending migrations' : 'migrations applied',
      applied,
    });
    return true;
  } catch (error) {
    log({
      level: 'error',
      msg: 'migration failed',
      ...(await firstNotApplied(databaseUrl, dir)),
      err: serializeError(error),
    });
    return false;
  }
};
