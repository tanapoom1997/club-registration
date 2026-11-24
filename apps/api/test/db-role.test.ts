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
// has_table_privilege sees table-level grants only; column-level ones are in the next list.
const EXPECTED_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  club_advisors: ['SELECT', 'INSERT', 'DELETE'],
  clubs: ['SELECT', 'INSERT', 'UPDATE'],
  password_issuances: ['SELECT', 'INSERT'],
  password_resets: ['SELECT', 'INSERT'],
  pgmigrations: [],
  queue_tickets: ['SELECT', 'INSERT'],
  registration_events: ['SELECT', 'INSERT'],
  registrations: ['SELECT', 'INSERT', 'DELETE'],
  rounds: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  student_profiles: ['SELECT', 'INSERT', 'UPDATE'],
  users: ['SELECT', 'INSERT', 'UPDATE'],
  waitlist_entries: ['SELECT', 'INSERT', 'DELETE'],
};

const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];

// Privileges club_app holds on single columns of a table it lacks them on as a whole: the change
// of club moves a registration to another club and re-dates it, and nothing else of the row
// (round_id, student_id) may ever be rewritten by the api. The queue moves a ticket's status,
// heartbeat and admission time only: its place (created_at), student and round stay as joined.
const EXPECTED_COLUMN_PRIVILEGES: Readonly<Record<string, Record<string, readonly string[]>>> = {
  queue_tickets: { UPDATE: ['status', 'last_seen_at', 'admitted_at'] },
  registrations: { UPDATE: ['club_id', 'created_at'] },
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

  it('has exactly the column privileges the api needs beyond its table privileges', async () => {
    const { rows } = await ownerPool.query<{ table: string; privilege: string; columns: string[] }>(
      `SELECT c.relname AS table, p.privilege,
              array_agg(a.attname::text ORDER BY a.attnum) AS columns
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       CROSS JOIN unnest($2::text[]) AS p(privilege)
       WHERE c.relkind = 'r'
         AND has_column_privilege($1, c.oid, a.attnum, p.privilege)
         AND NOT has_table_privilege($1, c.oid, p.privilege)
       GROUP BY c.relname, p.privilege
       ORDER BY c.relname, p.privilege`,
      [APP_DB_ROLE, COLUMN_PRIVILEGES],
    );

    const actual = rows.reduce<Record<string, Record<string, string[]>>>(
      (byTable, { table, privilege, columns }) => ({
        ...byTable,
        [table]: { ...byTable[table], [privilege]: columns },
      }),
      {},
    );
    expect(actual).toEqual(EXPECTED_COLUMN_PRIVILEGES);
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
    ['move a registration to another student', 'UPDATE registrations SET student_id = student_id'],
    ['move a registration to another round', 'UPDATE registrations SET round_id = round_id'],
    // Moving to another waitlist is a delete and an insert, never a rewrite of a place in a queue.
    ['reorder a waitlist', 'UPDATE waitlist_entries SET created_at = created_at'],
    ['move a waitlist entry to another club', 'UPDATE waitlist_entries SET club_id = club_id'],
    // A ticket ends as expired or done and stays; rejoining is a new ticket at the back.
    ['delete a queue ticket', 'DELETE FROM queue_tickets'],
    ['move a queue ticket up the queue', 'UPDATE queue_tickets SET created_at = created_at'],
    ['hand a queue ticket to another student', 'UPDATE queue_tickets SET student_id = student_id'],
    ['move a queue ticket to another round', 'UPDATE queue_tickets SET round_id = round_id'],
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
