import { describe, expect, it } from 'vitest';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';

const VALID_ENV = {
  DATABASE_URL: 'postgres://fictional:fictional@127.0.0.1:5432/fictional',
  JWT_SECRET: 'x'.repeat(32),
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
    expect(loadDatabaseConfig({ DATABASE_URL: VALID_ENV.DATABASE_URL })).toEqual({
      DATABASE_URL: VALID_ENV.DATABASE_URL,
    });
  });
});
