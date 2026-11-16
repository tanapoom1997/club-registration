import { loadDatabaseConfig } from './config.js';
import { runMigrations } from './run-migrations.js';

const { DATABASE_URL } = loadDatabaseConfig();
await runMigrations(DATABASE_URL);
