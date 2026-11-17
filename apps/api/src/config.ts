import { z } from 'zod';
import { DEFAULT_POOL_SETTINGS } from './db.js';
import type { PoolSettings } from './db.js';

// Compose hands an optional variable that the env file leaves out to the container as an empty
// string (`${DB_POOL_MAX:-}`), so empty means "not set" rather than 0.
const emptyAsUnset = (value: unknown): unknown => (value === '' ? undefined : value);

// 0 would mean "no limit" to pg for every one of these, which is never what an operator wants.
const MAX_TIMEOUT_MS = 600_000;
const intSetting = (fallback: number, max: number) =>
  z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(max).default(fallback));

const databaseConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Postgres's max_connections must stay comfortably above this (compose.prod.yml).
  DB_POOL_MAX: intSetting(DEFAULT_POOL_SETTINGS.max, 100),
  DB_CONNECTION_TIMEOUT_MS: intSetting(DEFAULT_POOL_SETTINGS.connectionTimeoutMs, MAX_TIMEOUT_MS),
  DB_STATEMENT_TIMEOUT_MS: intSetting(DEFAULT_POOL_SETTINGS.statementTimeoutMs, MAX_TIMEOUT_MS),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: intSetting(
    DEFAULT_POOL_SETTINGS.idleInTransactionTimeoutMs,
    MAX_TIMEOUT_MS,
  ),
});

const configSchema = databaseConfigSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TRUST_PROXY: z.stringbool().default(false),
  // HS256 is only as strong as its key; 32 characters of randomness is the floor.
  JWT_SECRET: z.string().min(32),
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type Config = z.infer<typeof configSchema>;

const parseEnv = <T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv): T => {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Only field names are reported: values may hold secrets such as the DB password.
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment variables: ${fields}`);
  }
  return result.data;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseEnv(configSchema, env);

// CLI tools such as migrate and create-admin only touch the database, so they must not demand
// server-only secrets like JWT_SECRET.
export const loadDatabaseConfig = (env: NodeJS.ProcessEnv = process.env): DatabaseConfig =>
  parseEnv(databaseConfigSchema, env);

export const poolSettingsFrom = (config: DatabaseConfig): PoolSettings => ({
  max: config.DB_POOL_MAX,
  connectionTimeoutMs: config.DB_CONNECTION_TIMEOUT_MS,
  statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  idleInTransactionTimeoutMs: config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
});
