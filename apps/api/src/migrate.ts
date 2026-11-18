import { loadMigrateConfig } from './config.js';
import { enableAppRoleLogin } from './db-role.js';
import { runMigrations } from './run-migrations.js';

const { DATABASE_URL, APP_DB_PASSWORD } = loadMigrateConfig();
await runMigrations(DATABASE_URL);
// After the migrations, which create club_app. Without APP_DB_PASSWORD (development) the role
// keeps whatever login it had, and the api keeps connecting with DATABASE_URL as before.
if (APP_DB_PASSWORD !== undefined) {
  await enableAppRoleLogin(DATABASE_URL, APP_DB_PASSWORD);
  console.log('club_app login set from APP_DB_PASSWORD');
}
