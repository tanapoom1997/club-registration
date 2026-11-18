import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateWithReport } from '../src/run-migrations.js';
import type { MigrationLogEntry } from '../src/run-migrations.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

// Fictional row values a failing migration's error would carry (Postgres's detail field).
const DUPLICATED_NAME = 'Fictional Duplicate Person';

const MIGRATIONS = {
  '1_fictional-people.sql': `-- Up Migration
CREATE TABLE fictional_people (name text NOT NULL);
INSERT INTO fictional_people (name) VALUES ('${DUPLICATED_NAME}'), ('${DUPLICATED_NAME}');
-- Down Migration
DROP TABLE fictional_people;
`,
  // Fails with 23505 and detail "Key (name)=(Fictional Duplicate Person) is duplicated."
  '2_fictional-unique-name.sql': `-- Up Migration
CREATE UNIQUE INDEX fictional_people_name_key ON fictional_people (name);
-- Down Migration
DROP INDEX fictional_people_name_key;
`,
};

describe('migrateWithReport', () => {
  let container: StartedPostgreSqlContainer;
  let dir: string;
  let databaseCount = 0;

  // A database of its own per test, so each starts with nothing applied.
  const freshDatabaseUrl = async (): Promise<string> => {
    databaseCount += 1;
    const name = `fictional_migrate_${databaseCount}`;
    const admin = new pg.Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    const url = new URL(container.getConnectionUri());
    url.pathname = `/${name}`;
    return url.toString();
  };

  const migrationsDir = async (files: Record<string, string>): Promise<string> => {
    const target = await mkdtemp(join(dir, 'migrations-'));
    await Promise.all(
      Object.entries(files).map(
        async ([file, sql]) => await writeFile(join(target, file), sql, 'utf8'),
      ),
    );
    return target;
  };

  const run = async (databaseUrl: string, migrations: string) => {
    const entries: MigrationLogEntry[] = [];
    const succeeded = await migrateWithReport({
      databaseUrl,
      dir: migrations,
      log: (entry) => entries.push(entry),
    });
    return { succeeded, entries, output: JSON.stringify(entries) };
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    dir = await mkdtemp(join(tmpdir(), 'migrate-test-'));
  });

  afterAll(async () => {
    await container.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('names every migration it applied, in order', async () => {
    const migrations = await migrationsDir({
      '1_fictional-people.sql': MIGRATIONS['1_fictional-people.sql'],
    });
    const databaseUrl = await freshDatabaseUrl();

    const { succeeded, entries } = await run(databaseUrl, migrations);

    expect(succeeded).toBe(true);
    expect(entries).toEqual([
      { level: 'info', msg: 'migrations applied', applied: ['1_fictional-people'] },
    ]);
  });

  it('says so when there is nothing to apply', async () => {
    const migrations = await migrationsDir({
      '1_fictional-people.sql': MIGRATIONS['1_fictional-people.sql'],
    });
    const databaseUrl = await freshDatabaseUrl();
    await run(databaseUrl, migrations);

    const { succeeded, entries } = await run(databaseUrl, migrations);

    expect(succeeded).toBe(true);
    expect(entries).toEqual([{ level: 'info', msg: 'no pending migrations', applied: [] }]);
  });

  it('names the migration that failed and logs its error without the row values', async () => {
    const migrations = await migrationsDir(MIGRATIONS);
    const databaseUrl = await freshDatabaseUrl();

    const { succeeded, entries, output } = await run(databaseUrl, migrations);

    expect(succeeded).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'migration failed',
        firstNotApplied: '2_fictional-unique-name',
        err: expect.objectContaining({ code: '23505' }) as unknown,
      }),
    ]);
    expect(output).not.toContain(DUPLICATED_NAME);
  });

  it('logs a database it cannot reach as an error, without the connection string', async () => {
    const migrations = await migrationsDir({
      '1_fictional-people.sql': MIGRATIONS['1_fictional-people.sql'],
    });
    const unreachable = 'postgres://fictional_user:fictional-secret-pw@127.0.0.1:1/none';

    const { succeeded, entries, output } = await run(unreachable, migrations);

    expect(succeeded).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'migration failed',
        err: expect.objectContaining({ code: 'ECONNREFUSED' }) as unknown,
      }),
    ]);
    expect(output).not.toContain('fictional-secret-pw');
  });
});
