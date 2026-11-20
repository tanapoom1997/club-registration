import { loadMigrateConfig } from './config.js';
import { enableAppRoleLogin } from './db-role.js';
import { serializeError } from './log.js';
import { migrateWithReport } from './run-migrations.js';
import type { MigrationLogEntry } from './run-migrations.js';

// One JSON line per entry, like the api's log, so `docker compose logs migrate` reads the same
// way. Errors go to stderr.
const log = (entry: MigrationLogEntry): void => {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  if (entry.level === 'error') console.error(line);
  else console.log(line);
};

const { DATABASE_URL, APP_DB_PASSWORD } = loadMigrateConfig();

if (!(await migrateWithReport({ databaseUrl: DATABASE_URL, log }))) {
  process.exitCode = 1;
} else if (APP_DB_PASSWORD !== undefined) {
  // After the migrations, which create club_app. Without APP_DB_PASSWORD (development) the role
  // keeps whatever login it had, and the api keeps connecting with DATABASE_URL as before.
  try {
    await enableAppRoleLogin(DATABASE_URL, APP_DB_PASSWORD);
    log({ level: 'info', msg: 'club_app login set from APP_DB_PASSWORD' });
  } catch (error) {
    log({ level: 'error', msg: 'setting the club_app login failed', err: serializeError(error) });
    process.exitCode = 1;
  }
}
