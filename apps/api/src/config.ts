import { z } from 'zod';

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TRUST_PROXY: z.stringbool().default(false),
});

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    // Only field names are reported: values may hold secrets such as the DB password.
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment variables: ${fields}`);
  }
  return result.data;
};
