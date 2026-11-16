import { parseArgs } from 'node:util';
import { loginIdSchema } from '@club-registration/shared';
import { createAdmin } from './auth/service.js';
import { loadDatabaseConfig } from './config.js';
import { createPool } from './db.js';

const USAGE = 'Usage: pnpm --filter api create-admin <login_id>';

const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true });
const parsedLoginId = loginIdSchema.safeParse(positionals[0]);

if (positionals.length !== 1 || !parsedLoginId.success) {
  console.error(USAGE);
  console.error('login_id: 1-64 characters of a-z 0-9 . _ -');
  process.exitCode = 2;
} else {
  const loginId = parsedLoginId.data;
  const pool = createPool(loadDatabaseConfig().DATABASE_URL);
  try {
    const result = await createAdmin(pool, loginId);
    if (result.status === 'created') {
      // stdout only, never a log or file: this is the single time the password is visible.
      console.log(`Created admin "${loginId}". It must change this password at first login.`);
      console.log(`Initial password (shown once, not stored): ${result.initialPassword}`);
    } else if (result.status === 'exists') {
      console.log(`Admin "${loginId}" already exists; nothing changed.`);
    } else {
      console.error(`"${loginId}" already exists as a ${result.existingRole}; nothing changed.`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}
