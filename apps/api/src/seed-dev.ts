import { chmod, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadDatabaseConfig, poolSettingsFrom } from './config.js';
import { createPool } from './db.js';
import { DEMO_ACCOUNTS, seedDemoAccounts } from './dev/demo-accounts.js';
import type { DemoCredential } from './dev/demo-accounts.js';

// Repo root from both src/ (tsx) and dist/ (node); the name is gitignored.
const CREDENTIALS_FILE = fileURLToPath(new URL('../../../.dev-credentials.txt', import.meta.url));
const OWNER_ONLY = 0o600;
const HEADER = '# Fictional local demo accounts written by seed-dev. Never commit this file.';

type KnownPasswords = Map<string, string>;

const readKnownPasswords = async (): Promise<KnownPasswords> => {
  try {
    const text = await readFile(CREDENTIALS_FILE, 'utf8');
    const entries = text
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => line.split(/\s+/))
      .flatMap(([loginId, , password]) =>
        loginId && password ? [[loginId, password] as const] : [],
      );
    return new Map(entries);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Map();
    throw error;
  }
};

const writeKnownPasswords = async (known: KnownPasswords): Promise<void> => {
  const lines = DEMO_ACCOUNTS.flatMap(({ loginId, role }) => {
    const password = known.get(loginId);
    return password ? [`${loginId.padEnd(12)} ${role.padEnd(8)} ${password}`] : [];
  });
  await writeFile(CREDENTIALS_FILE, `${HEADER}\n${lines.join('\n')}\n`, { mode: OWNER_ONLY });
  // mode only applies when the file is created; tighten an existing file too.
  await chmod(CREDENTIALS_FILE, OWNER_ONLY);
};

const mergeIssued = (known: KnownPasswords, issued: readonly DemoCredential[]): KnownPasswords =>
  new Map([...known, ...issued.map(({ loginId, password }) => [loginId, password] as const)]);

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { reset: { type: 'boolean', default: false } },
});

if (process.env.NODE_ENV === 'production') {
  console.error('seed-dev refuses to run with NODE_ENV=production');
  process.exitCode = 1;
} else {
  const databaseConfig = loadDatabaseConfig();
  const pool = createPool(databaseConfig.DATABASE_URL, poolSettingsFrom(databaseConfig));
  try {
    const { issued, unchanged } = await seedDemoAccounts(pool, { reset: values.reset });
    const known = mergeIssued(await readKnownPasswords(), issued);
    await writeKnownPasswords(known);

    console.log(`Demo accounts (also in ${CREDENTIALS_FILE}):`);
    for (const { loginId, role } of DEMO_ACCOUNTS) {
      console.log(`  ${loginId.padEnd(12)} ${role.padEnd(8)} ${known.get(loginId) ?? '(unknown)'}`);
    }
    const lost = unchanged.filter((loginId) => !known.has(loginId));
    if (lost.length > 0) {
      console.log(`Password unknown for ${lost.join(', ')}: pnpm --filter api seed-dev --reset`);
    }
  } finally {
    await pool.end();
  }
}
