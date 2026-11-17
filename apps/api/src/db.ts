import pg from 'pg';

export type PoolSettings = Readonly<{
  max: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}>;

// Starting points, not measurements: the load test on the real host (O5) decides the production
// values, which come from env (DB_* in config.ts) so they can change without a rebuild.
export const DEFAULT_POOL_SETTINGS: PoolSettings = Object.freeze({
  max: 20,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 10_000,
});

export const createPool = (
  connectionString: string,
  settings: PoolSettings = DEFAULT_POOL_SETTINGS,
): pg.Pool =>
  new pg.Pool({
    connectionString,
    max: settings.max,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    statement_timeout: settings.statementTimeoutMs,
    idle_in_transaction_session_timeout: settings.idleInTransactionTimeoutMs,
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

// A client whose ROLLBACK failed may be mid-transaction, so it is destroyed, not pooled.
const runTransaction = async <T>(
  pool: pg.Pool,
  begin: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query(begin);
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

// Runs reads against one consistent snapshot. READ ONLY makes Postgres itself refuse any write,
// so a dry run cannot change data even through a bug.
export const withReadOnlySnapshot = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> =>
  await runTransaction(pool, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', work);

// READ COMMITTED (the default): each statement sees what committed before it started, which is
// what a transaction that first waits on an advisory lock needs. Commits when work returns,
// rolls back when it throws.
export const withTransaction = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> => await runTransaction(pool, 'BEGIN', work);
