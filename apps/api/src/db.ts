import pg from 'pg';

const POOL_SIZE = 20;
const CONNECTION_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 10_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

export const createPool = (connectionString: string): pg.Pool =>
  new pg.Pool({
    connectionString,
    max: POOL_SIZE,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });

export const pingDatabase = async (pool: pg.Pool): Promise<void> => {
  await pool.query('SELECT 1');
};

export type Queryable = pg.Pool | pg.PoolClient;

export const PG_ERROR_CODES = Object.freeze({
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const);

type PgErrorCode = (typeof PG_ERROR_CODES)[keyof typeof PG_ERROR_CODES];

// Matching on the constraint name keeps an unrelated violation from being reported as this one.
export const isPgError = (
  error: unknown,
  code: PgErrorCode,
  constraint?: string,
): error is pg.DatabaseError =>
  error instanceof pg.DatabaseError &&
  error.code === code &&
  (constraint === undefined || error.constraint === constraint);

// Runs reads against one consistent snapshot. READ ONLY makes Postgres itself refuse any write,
// so a dry run cannot change data even through a bug.
export const withReadOnlySnapshot = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  // A client whose ROLLBACK failed may be mid-transaction, so it is destroyed, not pooled.
  let broken = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
};
