import { randomBytes } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_DB_ROLE,
  assertLeastPrivilege,
  enableAppRoleLogin,
  UnsafeDatabaseRoleError,
  waitForLeastPrivilege,
} from '../src/db-role.js';
import { runMigrations } from '../src/run-migrations.js';
import {
  appConnectionUri,
  endPoolFully,
  startMigratedPostgres,
  stopPostgres,
} from './support/postgres.js';

const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];

// Every table in public and what club_app may do with it: the whole list, so a new table without
// grants, or a grant nobody meant, fails here. Change it together with the migration's GRANTs.
const EXPECTED_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  club_advisors: ['SELECT', 'INSERT', 'DELETE'],
  clubs: ['SELECT', 'INSERT', 'UPDATE'],
  password_issuances: ['SELECT', 'INSERT'],
  pgmigrations: [],
  queue_tickets: [],
  registration_events: ['SELECT', 'INSERT'],
  registrations: ['SELECT', 'INSERT', 'DELETE'],
  rounds: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  student_profiles: ['SELECT', 'INSERT', 'UPDATE'],
  users: ['SELECT', 'INSERT', 'UPDATE'],
  waitlist_entries: [],
};

const PERMISSION_DENIED = '42501';
const INVALID_PASSWORD = '28P01';

const withConnection = async <T>(
  connectionString: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const withPassword = (connectionString: string, password: string): string => {
  const url = new URL(connectionString);
  url.password = password;
  return url.toString();
};

describe('club_app database role', () => {
  let container: StartedPostgreSqlContainer;
  let ownerPool: pg.Pool;
  let appPool: pg.Pool;

  const asApp = async (sql: string) => await appPool.query(sql);

  beforeAll(async () => {
    container = await startMigratedPostgres();
    ownerPool = new pg.Pool({ connectionString: container.getConnectionUri() });
    appPool = new pg.Pool({ connectionString: appConnectionUri(container) });
  });

  afterAll(async () => {
    await endPoolFully(appPool);
    await stopPostgres(ownerPool, container);
  });

  it('has exactly the table privileges the api needs', async () => {
    const { rows } = await ownerPool.query<{ table: string; privileges: string[] }>(
      `SELECT t.tablename AS table,
              array(SELECT p FROM unnest($2::text[]) WITH ORDINALITY AS u(p, n)
                    WHERE has_table_privilege($1, format('public.%I', t.tablename), p)
                    ORDER BY n) AS privileges
       FROM pg_tables t WHERE t.schemaname = 'public' ORDER BY t.tablename`,
      [APP_DB_ROLE, TABLE_PRIVILEGES],
    );

    expect(Object.fromEntries(rows.map(({ table, privileges }) => [table, privileges]))).toEqual(
      EXPECTED_PRIVILEGES,
    );
  });

  it('is no superuser and cannot create roles, databases or objects in public', async () => {
    const { rows } = await ownerPool.query(
      `SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin,
              has_schema_privilege($1, 'public', 'CREATE') AS can_create
       FROM pg_roles WHERE rolname = $1`,
      [APP_DB_ROLE],
    );

    expect(rows).toEqual([
      {
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
        rolcanlogin: true,
        can_create: false,
      },
    ]);
  });

  it.each([
    ['change the schema', 'CREATE TABLE fictional_table (id integer)'],
    ['alter a table', 'ALTER TABLE users ADD COLUMN fictional_column text'],
    ['rewrite the event log', 'UPDATE registration_events SET club_id = NULL'],
    ['delete from the event log', 'DELETE FROM registration_events'],
    ['empty a table', 'TRUNCATE registrations'],
    ['delete a user', 'DELETE FROM users'],
    ['read the migration table', 'SELECT name FROM pgmigrations'],
    ['run a program on the database server', `COPY (SELECT 1) TO PROGRAM 'true'`],
    ['read a file on the database server', `SELECT pg_read_file('postgresql.conf')`],
  ])('cannot %s', async (_action, sql) => {
    await expect(asApp(sql)).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  it('logs in only with the current password, and a rerun replaces it', async () => {
    const appUri = appConnectionUri(container);
    const nextPassword = randomBytes(24).toString('hex');

    await expect(
      withConnection(withPassword(appUri, nextPassword), async (c) => await c.query('SELECT 1')),
    ).rejects.toMatchObject({ code: INVALID_PASSWORD });

    await enableAppRoleLogin(container.getConnectionUri(), nextPassword);
    const { rows } = await withConnection(
      withPassword(appUri, nextPassword),
      async (c) => await c.query<{ role: string }>('SELECT current_user AS role'),
    );
    await endPoolFully(appPool);
    appPool = new pg.Pool({ connectionString: withPassword(appUri, nextPassword) });

    expect(rows).toEqual([{ role: APP_DB_ROLE }]);
    await expect(
      withConnection(appUri, async (c) => await c.query('SELECT 1')),
    ).rejects.toMatchObject({ code: INVALID_PASSWORD });
  });

  it('stores a SCRAM verifier, never the password', async () => {
    const { rows } = await ownerPool.query<{ stored: string }>(
      'SELECT rolpassword AS stored FROM pg_authid WHERE rolname = $1',
      [APP_DB_ROLE],
    );

    expect(rows[0]?.stored).toMatch(/^SCRAM-SHA-256\$4096:/);
  });

  it('refuses a password that would not survive in DATABASE_URL', async () => {
    await expect(
      enableAppRoleLogin(container.getConnectionUri(), 'Not-Hex@and:short'),
    ).rejects.toThrow('APP_DB_PASSWORD');
  });

  it('migrates a second database of the same server, where the role already exists', async () => {
    await ownerPool.query('CREATE DATABASE fictional_drill');
    const drillUri = new URL(container.getConnectionUri());
    drillUri.pathname = '/fictional_drill';

    await runMigrations(drillUri.toString());

    const { rows } = await withConnection(
      drillUri.toString(),
      async (c) =>
        await c.query<{ granted: boolean }>(
          `SELECT has_table_privilege($1, 'public.registration_events', 'INSERT') AS granted`,
          [APP_DB_ROLE],
        ),
    );
    expect(rows).toEqual([{ granted: true }]);
  });

  describe('assertLeastPrivilege', () => {
    it('accepts a club_app connection', async () => {
      await expect(assertLeastPrivilege(appPool)).resolves.toBeUndefined();
    });

    it('refuses the owner connection the api used before club_app', async () => {
      await expect(assertLeastPrivilege(ownerPool)).rejects.toThrow(
        /can change the schema; the api must connect as club_app/,
      );
    });
  });

  describe('waitForLeastPrivilege', () => {
    it('refuses the owner at once, without treating it as an unreachable database', async () => {
      const unreachable: unknown[] = [];

      await expect(
        waitForLeastPrivilege(ownerPool, {
          signal: new AbortController().signal,
          onUnreachable: (error) => unreachable.push(error),
        }),
      ).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
      expect(unreachable).toEqual([]);
    });

    it('keeps trying a database that does not answer until it is told to stop', async () => {
      // Port 1 on loopback: nothing listens, so every attempt fails to connect.
      const deadPool = new pg.Pool({
        connectionString: 'postgres://club_app:x@127.0.0.1:1/none',
        connectionTimeoutMillis: 500,
      });
      const stop = new AbortController();
      const unreachable: unknown[] = [];

      const waiting = waitForLeastPrivilege(deadPool, {
        signal: stop.signal,
        onUnreachable: (error) => {
          unreachable.push(error);
          stop.abort();
        },
      });

      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      expect(unreachable).toHaveLength(1);
      await deadPool.end();
    });
  });
});
