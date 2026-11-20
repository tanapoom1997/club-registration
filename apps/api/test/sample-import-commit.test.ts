import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, withReadOnlySnapshot } from '../src/db.js';
import { DEMO_ACCOUNTS, seedDemoAccounts } from '../src/dev/demo-accounts.js';
import { buildSampleImportWorkbooks } from '../src/dev/sample-import.js';
import { parseImportWorkbook } from '../src/import/parse.js';
import type { ParsedImport } from '../src/import/parse.js';
import { commitImport } from '../src/services/import-commit.js';
import { planImport, summarizeImportPlan } from '../src/services/import-plan.js';
import type { ImportPlan } from '../src/services/import-plan.js';
import { createRound, uniqueTerm } from './support/import-db.js';
import {
  appConnectionUri,
  startMigratedPostgres,
  stopPostgres,
  truncateAsOwner,
} from './support/postgres.js';

const ALL = 'import-all-fictional.xlsx';
const DEMO_IDS = DEMO_ACCOUNTS.map(({ loginId }) => loginId);

type DemoRow = {
  login_id: string;
  full_name: string;
  role: string;
  password_hash: string;
  must_change_password: boolean;
  session_version: number;
  grade: number | null;
  classroom: string | null;
  seat_no: number | null;
};

const summary = (plan: ImportPlan, term: string) =>
  summarizeImportPlan(plan, { fileSha256: '0'.repeat(64), term, maxErrors: 1_000 });

describe('fictional sample import against a database with the demo accounts', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let parsed: ParsedImport;
  let term: string;
  // The demo admin commits, as after `pnpm dev`.
  let adminId: number;

  const demoRows = async () => {
    const { rows } = await pool.query<DemoRow>(
      `SELECT u.login_id, u.full_name, u.role, u.password_hash, u.must_change_password,
              u.session_version, p.grade, p.classroom, p.seat_no
       FROM users u LEFT JOIN student_profiles p ON p.user_id = u.id
       WHERE u.login_id = ANY($1) ORDER BY u.login_id`,
      [DEMO_IDS],
    );
    return rows;
  };

  const dryRun = async () =>
    await withReadOnlySnapshot(pool, async (client) => await planImport(client, term, parsed));

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(appConnectionUri(container));
    const all = (await buildSampleImportWorkbooks()).find(({ filename }) => filename === ALL);
    if (!all) throw new Error(`No sample named ${ALL}`);
    parsed = await parseImportWorkbook(all.bytes);
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  // Every test starts from the state after `pnpm dev`: demo accounts only, plus the rounds the
  // sample's grades need in a fresh term.
  beforeEach(async () => {
    await truncateAsOwner(container, ['rounds', 'users']);
    await seedDemoAccounts(pool);
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM users WHERE login_id = 'demo-admin'",
    );
    adminId = rows[0]!.id;
    term = uniqueTerm();
    await createRound(pool, term, 1);
    await createRound(pool, term, 2);
  });

  it('dry-runs with no errors, matching the demo students as unchanged', async () => {
    const plan = await dryRun();

    expect(summary(plan, term)).toMatchObject({
      errorCount: 0,
      students: { create: 77, update: 0, unchanged: 3 },
      clubs: { create: 9, update: 0, unchanged: 0 },
      // C300 is in two rounds, so seven codes with advisors name eight clubs.
      advisors: { clubsReplaced: 8, clubsUnchanged: 0, rows: 8 },
    });
  });

  it('commits', async () => {
    const result = await commitImport(pool, { term, parsed, actorId: adminId });

    expect(result.status).toBe('committed');
    const { rows } = await pool.query<{ students: number; clubs: number; advisors: number }>(
      `SELECT (SELECT count(*)::int FROM student_profiles) AS students,
              (SELECT count(*)::int FROM clubs) AS clubs,
              (SELECT count(*)::int FROM club_advisors) AS advisors`,
    );
    expect(rows[0]).toEqual({ students: 80, clubs: 9, advisors: 9 });
  });

  it('leaves every demo account exactly as it was', async () => {
    const before = await demoRows();

    await commitImport(pool, { term, parsed, actorId: adminId });

    expect(await demoRows()).toEqual(before);
  });

  it('reports everything unchanged when the same file is imported again', async () => {
    await commitImport(pool, { term, parsed, actorId: adminId });

    const again = await commitImport(pool, { term, parsed, actorId: adminId });

    expect(again.status).toBe('committed');
    expect(summary(again.plan, term)).toMatchObject({
      errorCount: 0,
      students: { create: 0, update: 0, unchanged: 80 },
      clubs: { create: 0, update: 0, unchanged: 9 },
      advisors: { clubsReplaced: 0, clubsUnchanged: 8, rows: 8 },
    });
  });
});
