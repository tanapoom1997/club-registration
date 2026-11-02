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
