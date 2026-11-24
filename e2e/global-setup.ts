import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { hashPassword } from '../apps/api/src/auth/password.js';
import {
  ADMIN,
  ADMIN_FROM_CLUB,
  ADMIN_TO_CLUB,
  ADMIN_WAITLIST_CLUB,
  ADVISOR_NAME,
  API_PORT,
  CHANGE_FROM_CLUB,
  CHANGE_TO_CLUB,
  DATABASE_URL_ENV,
  EVENT_LOG_CLUB,
  NOTICE_FROM_CLUB,
  NOTICE_TO_CLUB,
  NOT_ACCEPTING_CLUB,
  FULL_CLUB,
  GRADE,
  ONE_SEAT_CLUB,
  OPEN_CLUB,
  QUEUE_ADMIN_CLUB,
  QUEUE_ADMIN_GRADE,
  QUEUE_ADMIN_MAX_ACTIVE,
  QUEUE_ADMIN_STUDENTS,
  QUEUE_CLUB,
  QUEUE_GRADE,
  QUEUE_MAX_ACTIVE,
  QUEUE_STUDENTS,
  STUDENTS,
  TERM,
  WEB_PORT,
  WEB_URL,
} from './fixtures.js';

// The same image as the api's tests (Testcontainers), and the same major as production.
const POSTGRES_IMAGE = 'postgres:18-alpine';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOG_DIR = fileURLToPath(new URL('./test-results/servers/', import.meta.url));
const STARTUP_TIMEOUT_MS = 60_000;
const SOURCE_CONDITION = '--conditions=@club-registration/source';

const randomHex = (bytes: number): string => randomBytes(bytes).toString('hex');

type Service = { name: string; child: ChildProcess };

// Its own process group, so teardown stops pnpm and the tsx/vite process it started together.
// Output goes to test-results/servers/<name>.log (fictional data only), not to the test report.
const startService = (name: string, args: string[], extraEnv: Record<string, string>): Service => {
  const log = createWriteStream(`${LOG_DIR}${name}.log`);
  const child = spawn('pnpm', args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return { name, child };
};

const stopService = ({ child }: Service): void => {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    // ESRCH: the group already exited between the check and the kill.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

const runToCompletion = async (name: string, args: string[], extraEnv: Record<string, string>) => {
  const { child } = startService(name, args, extraEnv);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0)
    throw new Error(`${name} exited with ${code}; see test-results/servers/${name}.log`);
};

const waitForOk = async (url: string, service: Service): Promise<void> => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (service.child.exitCode !== null) {
      throw new Error(`${service.name} exited early; see test-results/servers/${service.name}.log`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet: retried below until the deadline.
    }
    if (Date.now() > deadline) throw new Error(`${service.name} did not answer ${url} in time`);
    await sleep(250);
  }
};

const seed = async (databaseUrl: string): Promise<void> => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const insertUser = async (
      { loginId, password, fullName }: { loginId: string; password: string; fullName: string },
      role: 'admin' | 'student',
      mustChangePassword: boolean,
    ): Promise<number> => {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO users (login_id, full_name, role, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [loginId, fullName, role, await hashPassword(password), mustChangePassword],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error(`No id for ${loginId}`);
      return id;
    };

    await insertUser(ADMIN, 'admin', false);
    const students = [
      { account: STUDENTS.registers, mustChange: false, seatNo: 1 },
      { account: STUDENTS.firstLogin, mustChange: true, seatNo: 2 },
      { account: STUDENTS.browses, mustChange: false, seatNo: 3 },
      { account: STUDENTS.waits, mustChange: false, seatNo: 4 },
      { account: STUDENTS.holdsSeat, mustChange: false, seatNo: 5 },
      { account: STUDENTS.changes, mustChange: false, seatNo: 6 },
      { account: STUDENTS.seatedByAdmin, mustChange: false, seatNo: 7 },
      { account: STUDENTS.removedFromWaitlist, mustChange: false, seatNo: 8 },
      { account: STUDENTS.inEventLog, mustChange: false, seatNo: 9 },
      { account: STUDENTS.movedByAdmin, mustChange: false, seatNo: 10 },
    ];
    for (const { account, mustChange, seatNo } of students) {
      const id = await insertUser(account, 'student', mustChange);
      await client.query(
        'INSERT INTO student_profiles (user_id, grade, classroom, seat_no) VALUES ($1, $2, $3, $4)',
        [id, GRADE, `${GRADE}/1`, seatNo],
      );
    }

    // Open from an hour ago for a week, so the round is open whenever the suite runs.
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO rounds (term, grade, opens_at, closes_at)
       VALUES ($1, $2, now() - interval '1 hour', now() + interval '7 days') RETURNING id`,
      [TERM, GRADE],
    );
    const roundId = rows[0]?.id;
    for (const club of [
      OPEN_CLUB,
      FULL_CLUB,
      ONE_SEAT_CLUB,
      CHANGE_FROM_CLUB,
      CHANGE_TO_CLUB,
      ADMIN_FROM_CLUB,
      ADMIN_TO_CLUB,
      ADMIN_WAITLIST_CLUB,
      EVENT_LOG_CLUB,
      NOTICE_FROM_CLUB,
      NOTICE_TO_CLUB,
      NOT_ACCEPTING_CLUB,
    ]) {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO clubs (round_id, club_code, name, capacity) VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [roundId, club.code, club.name, club.capacity],
      );
      const clubId = inserted.rows[0]?.id;
      await client.query('INSERT INTO club_advisors (club_id, full_name) VALUES ($1, $2)', [
        clubId,
        ADVISOR_NAME,
      ]);
      // A full club's seats go to fictional students who never log in, so the club stays full.
      const seated = 'seated' in club ? club.seated : 0;
      for (let seat = 1; seat <= seated; seat += 1) {
        const fillerId = await insertUser(
          {
            loginId: `e2e-filler-${club.code.toLowerCase()}-${seat}`,
            password: randomHex(16),
            fullName: `ด.ช.สมมติ เต็มที่ ${club.code}`,
          },
          'student',
          false,
        );
        await client.query(
          'INSERT INTO student_profiles (user_id, grade, classroom, seat_no) VALUES ($1, $2, $3, $4)',
          [fillerId, GRADE, `${GRADE}/2`, seat],
        );
        await client.query(
          'INSERT INTO registrations (round_id, student_id, club_id) VALUES ($1, $2, $3)',
          [roundId, fillerId, clubId],
        );
        await client.query('UPDATE clubs SET registered = registered + 1 WHERE id = $1', [clubId]);
      }
    }

    const queueStudents = [QUEUE_STUDENTS.first, QUEUE_STUDENTS.second];
    for (const [index, account] of queueStudents.entries()) {
      const id = await insertUser(account, 'student', false);
      await client.query(
        'INSERT INTO student_profiles (user_id, grade, classroom, seat_no) VALUES ($1, $2, $3, $4)',
        [id, QUEUE_GRADE, `${QUEUE_GRADE}/1`, index + 1],
      );
    }
    const queueRound = await client.query<{ id: number }>(
      `INSERT INTO rounds (term, grade, opens_at, closes_at, max_active)
       VALUES ($1, $2, now() - interval '1 hour', now() + interval '7 days', $3) RETURNING id`,
      [TERM, QUEUE_GRADE, QUEUE_MAX_ACTIVE],
    );
    await client.query(
      'INSERT INTO clubs (round_id, club_code, name, capacity) VALUES ($1, $2, $3, $4)',
      [queueRound.rows[0]?.id, QUEUE_CLUB.code, QUEUE_CLUB.name, QUEUE_CLUB.capacity],
    );

    for (const [index, account] of Object.values(QUEUE_ADMIN_STUDENTS).entries()) {
      const id = await insertUser(account, 'student', false);
      await client.query(
        'INSERT INTO student_profiles (user_id, grade, classroom, seat_no) VALUES ($1, $2, $3, $4)',
        [id, QUEUE_ADMIN_GRADE, `${QUEUE_ADMIN_GRADE}/1`, index + 1],
      );
    }
    // Closes a day after the others: the admin's edit form sends the window back cut to the
    // minute, and /admin/clubs picks the open round that closes first, which must stay grade 4's.
    const queueAdminRound = await client.query<{ id: number }>(
      `INSERT INTO rounds (term, grade, opens_at, closes_at, max_active)
       VALUES ($1, $2, now() - interval '1 hour', now() + interval '8 days', $3) RETURNING id`,
      [TERM, QUEUE_ADMIN_GRADE, QUEUE_ADMIN_MAX_ACTIVE],
    );
    await client.query(
      'INSERT INTO clubs (round_id, club_code, name, capacity) VALUES ($1, $2, $3, $4)',
      [
        queueAdminRound.rows[0]?.id,
        QUEUE_ADMIN_CLUB.code,
        QUEUE_ADMIN_CLUB.name,
        QUEUE_ADMIN_CLUB.capacity,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
};

// Postgres in a container, migrated by the api's own migrate CLI, then the api from source as in
// production (NODE_ENV=production, connecting as club_app) and the web dev server proxying /api
// to it. Returns the teardown, which stops all three.
export default async function globalSetup(): Promise<() => Promise<void>> {
  await mkdir(LOG_DIR, { recursive: true });
  const services: Service[] = [];
  let container: StartedPostgreSqlContainer | undefined;

  const teardown = async (): Promise<void> => {
    services.forEach(stopService);
    await container?.stop();
  };

  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    const ownerUrl = container.getConnectionUri();
    const appPassword = randomHex(24);

    await runToCompletion(
      'migrate',
      ['--filter', 'api', 'exec', 'tsx', SOURCE_CONDITION, 'src/migrate.ts'],
      { DATABASE_URL: ownerUrl, APP_DB_PASSWORD: appPassword },
    );
    await seed(ownerUrl);

    const appUrl = new URL(ownerUrl);
    appUrl.username = 'club_app';
    appUrl.password = appPassword;

    const api = startService(
      'api',
      ['--filter', 'api', 'exec', 'tsx', SOURCE_CONDITION, 'src/server.ts'],
      {
        DATABASE_URL: appUrl.toString(),
        JWT_SECRET: randomHex(32),
        PORT: String(API_PORT),
        NODE_ENV: 'production',
        TRUST_PROXY: 'false',
      },
    );
    services.push(api);
    await waitForOk(`http://127.0.0.1:${API_PORT}/api/health`, api);

    const web = startService(
      'web',
      [
        '--filter',
        'web',
        'exec',
        'vite',
        '--host',
        '127.0.0.1',
        '--port',
        String(WEB_PORT),
        '--strictPort',
      ],
      { API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    );
    services.push(web);
    await waitForOk(`${WEB_URL}/api/health`, web);

    process.env[DATABASE_URL_ENV] = ownerUrl;
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
