import { buildApp } from './app.js';
import { loadConfig, poolSettingsFrom } from './config.js';
import { waitForLeastPrivilege } from './db-role.js';
import { createPool } from './db.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL, poolSettingsFrom(config));
const app = await buildApp({
  pool,
  jwtSecret: config.JWT_SECRET,
  logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
  trustProxy: config.TRUST_PROXY,
});

// Without a listener, an idle client losing its connection would crash the process.
pool.on('error', (error) => {
  app.log.error({ err: error }, 'idle database client error');
});

// Aborted by a stop signal, so a start still waiting for the database ends instead of listening.
const starting = new AbortController();

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  starting.abort();
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
};

const handleSignal = (signal: NodeJS.Signals): void => {
  shutdown(signal).catch((error: unknown) => {
    app.log.error({ err: error }, 'shutdown failed');
    process.exitCode = 1;
  });
};

process.once('SIGTERM', handleSignal);
process.once('SIGINT', handleSignal);

// Development runs the api as the database owner (one DATABASE_URL in .env), so only production
// insists on club_app. Checked before listening: an api that could rewrite the schema never serves.
const roleChecked = async (): Promise<boolean> => {
  if (config.NODE_ENV !== 'production') return true;
  try {
    await waitForLeastPrivilege(pool, {
      signal: starting.signal,
      onUnreachable: (error) => {
        app.log.warn({ err: error }, 'database not reachable yet; checking its role again');
      },
    });
    return true;
  } catch (error) {
    if (starting.signal.aborted) return false;
    app.log.fatal({ err: error }, 'refusing to start');
    process.exitCode = 1;
    await app.close();
    await pool.end();
    return false;
  }
};

if (await roleChecked()) {
  await app.listen({ host: '0.0.0.0', port: config.PORT });
}
