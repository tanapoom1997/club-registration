import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { studentQueueResponseSchema } from '@club-registration/shared';
import type { QueueTicket } from '@club-registration/shared';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { DEFAULT_POOL_SETTINGS, createPool } from '../src/db.js';
import { buildTestApp } from './support/app.js';
import {
  appConnectionUri,
  startMigratedPostgres,
  stopPostgres,
  truncateAsOwner,
} from './support/postgres.js';
import { queueInvariantViolations, setMaxActive, statusCounts } from './support/queue.js';
import { createOpenRound, createStudents, sessionCookie } from './support/registration.js';

// The queue's promise (README Phase 3): however many students press at once, no more than
// max_active of a round are admitted, in join order, with one live ticket each. Requests go
// through the whole app with app.inject, all started before any is awaited, so they contend for
// the pool and the queue lock as concurrent HTTP requests would. A second connection samples the
// committed admitted count the whole time, so a moment above max_active fails the test even if
// the end state looks right.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const MAX_ACTIVE = 30;
const STUDENTS = 500;

const ticketOf = (response: InjectResponse): QueueTicket | null => {
  expect(response.statusCode).toBe(200);
  return studentQueueResponseSchema.parse(response.json()).ticket;
};

describe('queue under concurrency', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let sampler: pg.Client;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  const post = async (url: string, studentId: number) =>
    await app.inject({
      method: 'POST',
      url,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      payload: {},
    });
  const join = async (studentId: number) => await post('/api/student/queue/join', studentId);
  const heartbeat = async (studentId: number) =>
    await post('/api/student/queue/heartbeat', studentId);
  const done = async (studentId: number) => await post('/api/student/queue/done', studentId);
  const read = async (studentId: number) =>
    await app.inject({
      method: 'GET',
      url: '/api/student/queue',
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
    });

  // Runs the work while polling the round's committed admitted count; returns the work's result
  // and the highest count seen.
  const sampling = async <T>(roundId: number, work: () => Promise<T>) => {
    let running = true;
    let highest = 0;
    const poll = async () => {
      while (running) {
        const { rows } = await sampler.query<{ admitted: number }>(
          `SELECT count(*)::int AS admitted FROM queue_tickets
           WHERE round_id = $1 AND status = 'admitted'`,
          [roundId],
        );
        highest = Math.max(highest, rows[0]?.admitted ?? 0);
      }
    };
    const polling = poll();
    try {
      return { result: await work(), highest };
    } finally {
      running = false;
      await polling;
    }
  };

  // Every waiting student's place, read back through the API: 1..k, each once.
  const waitingPositions = async (studentIds: readonly number[]) => {
    const tickets = await Promise.all(studentIds.map(async (id) => ticketOf(await read(id))));
    return tickets
      .flatMap((ticket) => (ticket?.status === 'waiting' ? [ticket.position] : []))
      .sort((a, b) => a - b);
  };

  const oneTo = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

  // Students in the order their tickets stand in the queue.
  const queueOrder = async (roundId: number, status: string) => {
    const { rows } = await pool.query<{ student_id: number }>(
      `SELECT student_id FROM queue_tickets WHERE round_id = $1 AND status = $2
       ORDER BY created_at, id`,
      [roundId, status],
    );
    return rows.map(({ student_id: id }) => id);
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    // As in registration-concurrency.test.ts: these tests prove what the queue lock and the DB
    // decide, not how long a request may wait for a connection, which is an O5 question.
    pool = createPool(appConnectionUri(container), {
      ...DEFAULT_POOL_SETTINGS,
      connectionTimeoutMs: 120_000,
    });
    sampler = new pg.Client({ connectionString: appConnectionUri(container) });
    await sampler.connect();
  });

  afterAll(async () => {
    await sampler.end();
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    await truncateAsOwner(container, ['rounds']);
    app = await buildTestApp(pool);
  });

  afterEach(async () => {
    await app.close();
    expect(await queueInvariantViolations(pool)).toEqual([]);
  });

  it('admits exactly max_active of 500 students joining at once, the rest in order', async () => {
    const roundId = await createOpenRound(pool);
    await setMaxActive(pool, roundId, MAX_ACTIVE);
    const students = await createStudents(pool, STUDENTS);

    const { result: responses, highest } = await sampling(
      roundId,
      async () => await Promise.all(students.map(async (id) => await join(id))),
    );

    expect(responses.map((response) => response.statusCode)).toEqual(students.map(() => 200));
    // Equal, not just at most: the first admissions commit long before the last join, so a
    // sampler that never read anything (and would pass any bound) fails here too.
    expect(highest).toBe(MAX_ACTIVE);
    expect(await statusCounts(pool, roundId)).toEqual({
      admitted: MAX_ACTIVE,
      waiting: STUDENTS - MAX_ACTIVE,
    });
    expect(await waitingPositions(students)).toEqual(oneTo(STUDENTS - MAX_ACTIVE));
    // Each join's own answer was its place at its moment: the admitted ones said so.
    const admittedNow = responses.filter((r) => ticketOf(r)?.status === 'admitted').length;
    expect(admittedNow).toBe(MAX_ACTIVE);
  });

  it('admits everyone when fewer students than max_active join at once', async () => {
    const roundId = await createOpenRound(pool);
    await setMaxActive(pool, roundId, MAX_ACTIVE);
    const students = await createStudents(pool, MAX_ACTIVE - 10);

    await Promise.all(students.map(async (id) => await join(id)));

    expect(await statusCounts(pool, roundId)).toEqual({ admitted: MAX_ACTIVE - 10 });
  });

  it('fills only the freed slots, in queue order, while dones and heartbeats race', async () => {
    const roundId = await createOpenRound(pool);
    await setMaxActive(pool, roundId, MAX_ACTIVE);
    const students = await createStudents(pool, STUDENTS);
    for (const id of students) await join(id);
    const admitted = await queueOrder(roundId, 'admitted');
    const waitingBefore = await queueOrder(roundId, 'waiting');
    const leaving = admitted.slice(0, 10);

    const { result: responses, highest } = await sampling(
      roundId,
      async () =>
        await Promise.all([
          ...leaving.map(async (id) => await done(id)),
          ...waitingBefore.map(async (id) => await heartbeat(id)),
          ...admitted.slice(10).map(async (id) => await heartbeat(id)),
        ]),
    );
    // A done that committed after the last heartbeat leaves its slot for the next one.
    await heartbeat(waitingBefore.at(-1)!);

    expect(responses.map((response) => response.statusCode)).toEqual(responses.map(() => 200));
    expect(highest).toBeLessThanOrEqual(MAX_ACTIVE);
    expect(await statusCounts(pool, roundId)).toEqual({
      admitted: MAX_ACTIVE,
      done: 10,
      waiting: STUDENTS - MAX_ACTIVE - 10,
    });
    expect(await queueOrder(roundId, 'admitted')).toEqual([
      ...admitted.slice(10),
      ...waitingBefore.slice(0, 10),
    ]);
    expect(await waitingPositions(students)).toEqual(oneTo(STUDENTS - MAX_ACTIVE - 10));
  });

  it('gives a student who presses join many times at once one ticket', async () => {
    const roundId = await createOpenRound(pool);
    await setMaxActive(pool, roundId, 1);
    const [first, second] = await createStudents(pool, 2);
    await join(first!);

    const responses = await Promise.all(
      Array.from({ length: 20 }, async () => await join(second!)),
    );

    expect(responses.map(ticketOf)).toEqual(
      responses.map(() => ({ status: 'waiting', position: 1 })),
    );
    expect(await statusCounts(pool, roundId)).toEqual({ admitted: 1, waiting: 1 });
  });
});
