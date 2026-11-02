import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = await buildApp({
  pool,
  logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
  trustProxy: config.TRUST_PROXY,
});

// Without a listener, an idle client losing its connection would crash the process.
pool.on('error', (error) => {
  app.log.error({ err: error }, 'idle database client error');
});

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
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

await app.listen({ host: '0.0.0.0', port: config.PORT });
