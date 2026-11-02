import { loadConfig } from './config.js';
import { runMigrations } from './run-migrations.js';

const { DATABASE_URL } = loadConfig();
await runMigrations(DATABASE_URL);
