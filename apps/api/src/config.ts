import { z } from 'zod';

const databaseConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
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
