import { describe, expect, it } from 'vitest';
import { loadConfig, loadDatabaseConfig, poolSettingsFrom } from '../src/config.js';
import { createPool, DEFAULT_POOL_SETTINGS } from '../src/db.js';

const VALID_ENV = {
  DATABASE_URL: 'postgres://fictional:fictional@127.0.0.1:5432/fictional',
  JWT_SECRET: 'x'.repeat(32),
};

const POOL_ENV = {
  DB_POOL_MAX: '35',
  DB_CONNECTION_TIMEOUT_MS: '8000',
  DB_STATEMENT_TIMEOUT_MS: '15000',
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '12000',
};

describe('config', () => {
  it('fails fast without JWT_SECRET, naming the field but not any value', () => {
    expect(() => loadConfig({ DATABASE_URL: VALID_ENV.DATABASE_URL })).toThrow(
      'Invalid environment variables: JWT_SECRET',
    );
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    expect(() => loadConfig({ ...VALID_ENV, JWT_SECRET: 'too-short' })).toThrow('JWT_SECRET');
  });

  it('accepts a complete environment', () => {
    expect(loadConfig(VALID_ENV).JWT_SECRET).toBe(VALID_ENV.JWT_SECRET);
  });

  it('lets database-only tools run without JWT_SECRET', () => {
    expect(loadDatabaseConfig({ DATABASE_URL: VALID_ENV.DATABASE_URL }).DATABASE_URL).toBe(
      VALID_ENV.DATABASE_URL,
    );
  });
});

describe('database pool settings', () => {
  it('defaults to the values the pool used before they were configurable', () => {
    const settings = poolSettingsFrom(loadConfig(VALID_ENV));

    expect(settings).toEqual({
      max: 20,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 10_000,
      idleInTransactionTimeoutMs: 10_000,
    });
    expect(settings).toEqual(DEFAULT_POOL_SETTINGS);
  });

  it('reads every setting from the environment', () => {
    expect(poolSettingsFrom(loadConfig({ ...VALID_ENV, ...POOL_ENV }))).toEqual({
      max: 35,
      connectionTimeoutMs: 8_000,
      statementTimeoutMs: 15_000,
      idleInTransactionTimeoutMs: 12_000,
    });
  });

  it('gives database-only tools the same settings as the server', () => {
    expect(poolSettingsFrom(loadDatabaseConfig({ ...VALID_ENV, ...POOL_ENV }))).toEqual(
      poolSettingsFrom(loadConfig({ ...VALID_ENV, ...POOL_ENV })),
    );
  });

  it('treats an empty value, as compose passes for an unset variable, as the default', () => {
    const emptyEnv = Object.fromEntries(Object.keys(POOL_ENV).map((name) => [name, '']));

    expect(poolSettingsFrom(loadConfig({ ...VALID_ENV, ...emptyEnv }))).toEqual(
      DEFAULT_POOL_SETTINGS,
    );
  });

  it.each([
    ['DB_POOL_MAX', '0'],
    ['DB_POOL_MAX', '101'],
    ['DB_POOL_MAX', '2.5'],
    ['DB_CONNECTION_TIMEOUT_MS', '0'],
    ['DB_STATEMENT_TIMEOUT_MS', 'ten seconds'],
    ['DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', '-1'],
    ['DB_STATEMENT_TIMEOUT_MS', '600001'],
  ])('fails fast on %s=%s, naming the field', (name, value) => {
    expect(() => loadConfig({ ...VALID_ENV, [name]: value })).toThrow(
      `Invalid environment variables: ${name}`,
    );
  });

  it('passes the settings to the pg pool', async () => {
    const settings = poolSettingsFrom(loadConfig({ ...VALID_ENV, ...POOL_ENV }));
    // Never connects: pg opens connections lazily, on the first query.
    const pool = createPool(VALID_ENV.DATABASE_URL, settings);
    try {
      expect(pool.options).toMatchObject({
        max: 35,
        connectionTimeoutMillis: 8_000,
        statement_timeout: 15_000,
        idle_in_transaction_session_timeout: 12_000,
      });
    } finally {
      await pool.end();
    }
  });
});
