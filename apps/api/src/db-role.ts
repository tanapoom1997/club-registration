import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

// The role the api connects as in production. The migration that creates it
// (migrations/20261119000000_app-role.sql) grants it only the statements the api runs, so a bug
// or an injection in the api cannot change the schema, rewrite registration_events, read the
// migration table, or reach superuser-only functions such as COPY ... TO PROGRAM. Fixed rather
// than configurable: the migrations grant to it by name.
export const APP_DB_ROLE = 'club_app';

// Embedded in DATABASE_URL by the env file, so only characters a URL keeps as they are.
export const APP_DB_PASSWORD_PATTERN = /^[0-9a-f]{32,}$/;

const SCRAM_ITERATIONS = 4096;
const SCRAM_SALT_BYTES = 16;
const VERIFIER_PATTERN = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

// The SCRAM-SHA-256 verifier Postgres stores for a password (RFC 5802/7677, the format of
// pg_authid.rolpassword), computed here as psql's \password does. ALTER ROLE then carries the
// verifier, never the password, so a server log of the statement (an error, log_statement) cannot
// leak it. SASLprep is the identity for the hex passwords APP_DB_PASSWORD_PATTERN allows.
export const scramSha256Verifier = (
  password: string,
  salt: Buffer = randomBytes(SCRAM_SALT_BYTES),
  iterations: number = SCRAM_ITERATIONS,
): string => {
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
};

// Run by migrate (as the database owner) after the migrations: the migration creates the role
// NOLOGIN because a password is a deployment secret, not schema. Running it again replaces the
// password, so rotating it is: change APP_DB_PASSWORD in the env file, then `up` again.
export const enableAppRoleLogin = async (databaseUrl: string, password: string): Promise<void> => {
  if (!APP_DB_PASSWORD_PATTERN.test(password)) {
    throw new Error('APP_DB_PASSWORD must be at least 32 lower-case hex characters');
  }
  const verifier = scramSha256Verifier(password);
  // ALTER ROLE takes no bind parameters. The verifier is built above from base64 and fixed text,
  // and checked again here, so it can be quoted as it is.
  if (!VERIFIER_PATTERN.test(verifier)) throw new Error('Unexpected SCRAM verifier format');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`ALTER ROLE ${APP_DB_ROLE} WITH LOGIN PASSWORD '${verifier}'`);
  } finally {
    await client.end();
  }
};

// A wrong DATABASE_URL, as opposed to a database that is not reachable yet.
export class UnsafeDatabaseRoleError extends Error {
  override name = 'UnsafeDatabaseRoleError';
}

// The api refuses to start in production with a connection that could change the schema: a
// superuser, a table owner, or a role allowed to create in public. That is what an env file still
// pointing DATABASE_URL at the owner (the setup before club_app) would give it.
export const assertLeastPrivilege = async (pool: pg.Pool): Promise<void> => {
  const { rows } = await pool.query<{ role: string; superuser: boolean; owner: boolean }>(
    `SELECT current_user AS role,
            r.rolsuper AS superuser,
            has_schema_privilege('public', 'CREATE')
              OR EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public'
                         AND tableowner = current_user) AS owner
     FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const [current] = rows;
  if (current === undefined) throw new Error('Could not read the database role of DATABASE_URL');
  if (current.superuser || current.owner) {
    throw new UnsafeDatabaseRoleError(
      `DATABASE_URL connects as "${current.role}", which can change the schema; ` +
        `the api must connect as ${APP_DB_ROLE} (deploy/production.env.example)`,
    );
  }
};

const UNREACHABLE_RETRY_MS = 2000;

// After a reboot Docker starts the api without waiting for Postgres (restart policies ignore
// depends_on), so an unreachable database is retried rather than ending the process; only a role
// that is wrong ends it. Resolves once the role is checked, rejects with UnsafeDatabaseRoleError,
// or with the signal's AbortError when the process is told to stop while waiting.
export const waitForLeastPrivilege = async (
  pool: pg.Pool,
  { signal, onUnreachable }: { signal: AbortSignal; onUnreachable: (error: unknown) => void },
): Promise<void> => {
  for (;;) {
    signal.throwIfAborted();
    try {
      await assertLeastPrivilege(pool);
      return;
    } catch (error) {
      if (error instanceof UnsafeDatabaseRoleError) throw error;
      onUnreachable(error);
    }
    await sleep(UNREACHABLE_RETRY_MS, undefined, { signal });
  }
};
