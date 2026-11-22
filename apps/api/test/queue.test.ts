import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  errorResponseSchema,
  studentQueueResponseSchema,
  studentRoundResponseSchema,
} from '@club-registration/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool } from '../src/db.js';
import { DEFAULT_QUEUE_SETTINGS, hasAdmittedTicket } from '../src/services/queue.js';
import { TEST_JWT_SECRET, createTestUser } from './support/app.js';
import { createClub, uniqueCode } from './support/import-db.js';
import {
  appConnectionUri,
  startMigratedPostgres,
  stopPostgres,
  truncateAsOwner,
} from './support/postgres.js';
import {
  queueInvariantViolations,
  rewindTickets,
  setMaxActive,
  statusCounts,
  ticketsOf,
} from './support/queue.js';
import {
  STUDENT_NAME,
  createAdminId,
  createClosedRound,
  createOpenRound,
  createStudentId,
  createStudents,
  createUpcomingRound,
  moveWindow,
  newKey,
  sessionCookie,
} from './support/registration.js';

// The queue in front of a round (README Phase 3 Q1): join, heartbeat, done and the read, through
// the whole app. Time is the DB clock, so tests rewind ticket rows instead of waiting.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const QUEUE_URL = '/api/student/queue';
const JOIN_URL = `${QUEUE_URL}/join`;
const HEARTBEAT_URL = `${QUEUE_URL}/heartbeat`;
const DONE_URL = `${QUEUE_URL}/done`;
const WRITE_URLS = [JOIN_URL, HEARTBEAT_URL, DONE_URL] as const;
const IDLE = DEFAULT_QUEUE_SETTINGS.idleTimeoutSeconds;
const TTL = DEFAULT_QUEUE_SETTINGS.admissionTtlSeconds;

// An admission's end, where the test cares that the ticket is admitted, not until when.
const ANY_TIME = expect.any(String) as string;

const errorOf = (response: InjectResponse) => errorResponseSchema.parse(response.json());
const queueOf = (response: InjectResponse) => {
  expect(response.statusCode).toBe(200);
  return studentQueueResponseSchema.parse(response.json());
};
const ticketOf = (response: InjectResponse) => queueOf(response).ticket;

describe('student queue', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let logLines: string[];
  // Rounds whose max_active a test lowers under the admitted count on purpose.
  let lowered: number[];

  const send = async (
    method: 'GET' | 'POST',
    url: string,
    userId: number,
    {
      payload,
      role = 'student',
      headers = {},
    }: {
      payload?: NonNullable<InjectOptions['payload']> | undefined;
      role?: 'student' | 'admin';
      headers?: NonNullable<InjectOptions['headers']>;
    } = {},
  ): Promise<InjectResponse> =>
    await app.inject({
      method,
      url,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, userId, role) },
      ...(payload === undefined ? {} : { payload }),
      headers,
    });

  const post = async (url: string, studentId: number) =>
    await send('POST', url, studentId, { payload: {} });
  const join = async (studentId: number) => await post(JOIN_URL, studentId);
  const heartbeat = async (studentId: number) => await post(HEARTBEAT_URL, studentId);
  const done = async (studentId: number) => await post(DONE_URL, studentId);
  const read = async (studentId: number) => await send('GET', QUEUE_URL, studentId);

  // An open round of grade 1 with the given max_active and students who joined in this order.
  const queueOfStudents = async (count: number, maxActive: number) => {
    const roundId = await createOpenRound(pool);
    await setMaxActive(pool, roundId, maxActive);
    const students = await createStudents(pool, count);
    for (const studentId of students) expect((await join(studentId)).statusCode).toBe(200);
    return { roundId, students };
  };

  const storedRow = async (studentId: number) => {
    const { rows } = await pool.query<{ status: string; last_seen_at: Date; admitted_at: Date }>(
      `SELECT status, last_seen_at, admitted_at FROM queue_tickets
       WHERE student_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [studentId],
    );
    return rows[0]!;
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(appConnectionUri(container));
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    await truncateAsOwner(container, ['rounds']);
    logLines = [];
    lowered = [];
    app = await buildApp({
      pool,
      jwtSecret: TEST_JWT_SECRET,
      logger: { level: 'info', stream: { write: (line) => logLines.push(line) } },
    });
  });

  afterEach(async () => {
    await app.close();
    expect(await queueInvariantViolations(pool, { lowered })).toEqual([]);
  });

  describe('POST /api/student/queue/join', () => {
    it('admits the student at once when the round has room, until the admission TTL', async () => {
      const roundId = await createOpenRound(pool);
      const studentId = await createStudentId(pool);

      const response = await join(studentId);

      const stored = await storedRow(studentId);
      expect(stored.status).toBe('admitted');
      expect(queueOf(response)).toEqual({
        round: expect.objectContaining({ id: roundId, status: 'open' }) as unknown,
        ticket: {
          status: 'admitted',
          admittedUntil: new Date(stored.admitted_at.getTime() + TTL * 1_000).toISOString(),
        },
      });
    });

    it('queues the students beyond max_active in join order, positions counting from 1', async () => {
      const { students } = await queueOfStudents(5, 2);

      const tickets = await Promise.all(students.map(async (id) => ticketOf(await read(id))));

      expect(tickets).toEqual([
        { status: 'admitted', admittedUntil: ANY_TIME },
        { status: 'admitted', admittedUntil: ANY_TIME },
        { status: 'waiting', position: 1 },
        { status: 'waiting', position: 2 },
        { status: 'waiting', position: 3 },
      ]);
    });

    it('answers a repeated join with the live ticket and writes no second one', async () => {
      const { students } = await queueOfStudents(2, 1);
      const [, waiting] = students;

      const response = await join(waiting!);

      expect(ticketOf(response)).toEqual({ status: 'waiting', position: 1 });
      expect(await ticketsOf(pool, waiting!)).toHaveLength(1);
    });

    it('answers a repeated join with the live ticket even after the round closed', async () => {
      const { roundId, students } = await queueOfStudents(1, 1);
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      const response = await join(students[0]!);

      expect(ticketOf(response)).toEqual({ status: 'admitted', admittedUntil: ANY_TIME });
      expect(await ticketsOf(pool, students[0]!)).toHaveLength(1);
    });

    it.each([
      ['upcoming', createUpcomingRound],
      ['closed', createClosedRound],
    ])('refuses to queue for an %s round', async (_state, createRound) => {
      await createRound(pool);
      const studentId = await createStudentId(pool);

      const response = await join(studentId);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_not_open');
      expect(await ticketsOf(pool, studentId)).toEqual([]);
    });

    it('refuses to queue when the grade has no round at all', async () => {
      await createOpenRound(pool, 2);
      const studentId = await createStudentId(pool, 1);

      const response = await join(studentId);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_not_open');
    });

    it('queues for the round the student is shown, never another grade or round', async () => {
      await createOpenRound(pool, 2);
      await createUpcomingRound(pool, 1);
      const open = await createOpenRound(pool, 1);
      const studentId = await createStudentId(pool, 1);

      await join(studentId);

      expect((await ticketsOf(pool, studentId)).map(({ round_id: id }) => id)).toEqual([open]);
    });

    it('sends a student whose ticket expired to the back with a new ticket', async () => {
      const { students } = await queueOfStudents(3, 1);
      const [, second, third] = students;
      await rewindTickets(container, [second!], { lastSeenSeconds: IDLE + 1 });

      const response = await join(second!);

      expect(ticketOf(response)).toEqual({ status: 'waiting', position: 2 });
      expect(ticketOf(await read(third!))).toEqual({ status: 'waiting', position: 1 });
      expect((await ticketsOf(pool, second!)).map(({ status }) => status)).toEqual([
        'expired',
        'waiting',
      ]);
    });

    it('gives a student who released their ticket a new one when they join again', async () => {
      const { students } = await queueOfStudents(1, 1);
      await done(students[0]!);

      const response = await join(students[0]!);

      expect(ticketOf(response)).toEqual({ status: 'admitted', admittedUntil: ANY_TIME });
      expect((await ticketsOf(pool, students[0]!)).map(({ status }) => status)).toEqual([
        'done',
        'admitted',
      ]);
    });
  });

  describe('POST /api/student/queue/heartbeat', () => {
    it('keeps a ticket seen within the idle timeout and records the heartbeat', async () => {
      const { students } = await queueOfStudents(2, 1);
      const waiting = students[1]!;
      await rewindTickets(container, [waiting], { lastSeenSeconds: IDLE - 10 });
      const before = await storedRow(waiting);

      const response = await heartbeat(waiting);

      expect(ticketOf(response)).toEqual({ status: 'waiting', position: 1 });
      expect((await storedRow(waiting)).last_seen_at.getTime()).toBeGreaterThan(
        before.last_seen_at.getTime(),
      );
    });

    it('expires a ticket idle past the timeout and hands its slot to the next student', async () => {
      const { students } = await queueOfStudents(2, 1);
      const [first, second] = students;
      await rewindTickets(container, [first!], { lastSeenSeconds: IDLE + 1 });

      const response = await heartbeat(second!);

      expect(ticketOf(response)).toEqual({ status: 'admitted', admittedUntil: ANY_TIME });
      expect((await storedRow(first!)).status).toBe('expired');
      expect(ticketOf(await read(first!))).toEqual({ status: 'expired' });
    });

    it('expires an admitted ticket at the admission TTL even while it keeps polling', async () => {
      const { students } = await queueOfStudents(2, 1);
      const [first, second] = students;
      await rewindTickets(container, [first!], { admittedSeconds: TTL + 1 });

      const own = await heartbeat(first!);
      const next = await heartbeat(second!);

      expect(own.statusCode).toBe(409);
      expect(errorOf(own).code).toBe('not_in_queue');
      expect(ticketOf(next)).toEqual({ status: 'admitted', admittedUntil: ANY_TIME });
      expect((await storedRow(first!)).status).toBe('expired');
    });

    it('refuses the late heartbeat of a stale ticket even when nobody else wrote since', async () => {
      const { roundId, students } = await queueOfStudents(1, 1);
      await rewindTickets(container, students, { lastSeenSeconds: IDLE + 1 });

      const response = await heartbeat(students[0]!);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('not_in_queue');
      expect(ticketOf(await read(students[0]!))).toEqual({ status: 'expired' });
      expect(
        await hasAdmittedTicket(pool, { roundId, studentId: students[0]! }, DEFAULT_QUEUE_SETTINGS),
      ).toBe(false);
    });

    it('answers 409 not_in_queue to a student who never joined or released their ticket', async () => {
      const { students } = await queueOfStudents(1, 1);
      const never = await createStudentId(pool);
      await done(students[0]!);

      const responses = [await heartbeat(never), await heartbeat(students[0]!)];

      responses.forEach((response) => {
        expect(response.statusCode).toBe(409);
        expect(errorOf(response).code).toBe('not_in_queue');
      });
      expect(await ticketsOf(pool, never)).toEqual([]);
    });

    it('answers 409 not_in_queue when the grade has no round', async () => {
      const response = await heartbeat(await createStudentId(pool));

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('not_in_queue');
    });

    it('admits nobody once the round has closed', async () => {
      const { roundId, students } = await queueOfStudents(2, 1);
      const [first, second] = students;
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });
      await done(first!);

      const response = await heartbeat(second!);

      expect(ticketOf(response)).toEqual({ status: 'waiting', position: 1 });
    });

    it('keeps admitted students when an admin lowers max_active, and admits nobody until below', async () => {
      const { roundId, students } = await queueOfStudents(5, 3);
      lowered = [roundId];
      const [a, b, c, d] = students;
      await setMaxActive(pool, roundId, 1);

      const tickets = [];
      for (const id of students) tickets.push(ticketOf(await heartbeat(id)));
      expect(tickets.map((ticket) => ticket?.status)).toEqual([
        'admitted',
        'admitted',
        'admitted',
        'waiting',
        'waiting',
      ]);

      await done(a!);
      await done(b!);
      expect(ticketOf(await heartbeat(d!))).toEqual({ status: 'waiting', position: 1 });
      expect(await statusCounts(pool, roundId)).toEqual({ admitted: 1, done: 2, waiting: 2 });

      await done(c!);
      const response = await heartbeat(d!);
      expect(ticketOf(response)).toEqual({ status: 'admitted', admittedUntil: ANY_TIME });
      expect(await statusCounts(pool, roundId)).toEqual({ admitted: 1, done: 3, waiting: 1 });
    });
  });

  describe('POST /api/student/queue/done', () => {
    it('releases an admitted ticket; the next student is admitted on their next heartbeat', async () => {
      const { students } = await queueOfStudents(2, 1);
      const [first, second] = students;

      const response = await done(first!);

      expect(ticketOf(response)).toEqual({ status: 'done' });
      expect(ticketOf(await read(second!))).toEqual({ status: 'waiting', position: 1 });
      expect(ticketOf(await heartbeat(second!))).toEqual({
        status: 'admitted',
        admittedUntil: ANY_TIME,
      });
    });

    it('releases a waiting ticket, moving the students behind it up', async () => {
      const { students } = await queueOfStudents(3, 1);
      const [, second, third] = students;

      await done(second!);

      expect(ticketOf(await read(third!))).toEqual({ status: 'waiting', position: 1 });
    });

    it('answers a repeated done with the state as it is, not an error', async () => {
      const { students } = await queueOfStudents(1, 1);
      await done(students[0]!);

      const response = await done(students[0]!);

      expect(ticketOf(response)).toEqual({ status: 'done' });
      expect(await ticketsOf(pool, students[0]!)).toHaveLength(1);
    });

    it('answers a student with no ticket, or no round, with their state', async () => {
      const roundId = await createOpenRound(pool, 1);
      const never = await createStudentId(pool, 1);
      const noRound = await createStudentId(pool, 2);

      expect(queueOf(await done(never))).toEqual({
        round: expect.objectContaining({ id: roundId }) as unknown,
        ticket: null,
      });
      expect(queueOf(await done(noRound))).toEqual({ round: null, ticket: null });
    });
  });

  describe('GET /api/student/queue', () => {
    it('neither expires, admits nor records a heartbeat', async () => {
      const { students } = await queueOfStudents(2, 1);
      const [first, second] = students;
      await rewindTickets(container, [first!], { lastSeenSeconds: IDLE + 1 });
      const before = await Promise.all([storedRow(first!), storedRow(second!)]);
      const never = await createStudentId(pool);

      const answers = [await read(first!), await read(second!), await read(never)];

      expect(answers.map(ticketOf)).toEqual([
        { status: 'expired' },
        { status: 'waiting', position: 1 },
        null,
      ]);
      expect(await Promise.all([storedRow(first!), storedRow(second!)])).toEqual(before);
      expect(await ticketsOf(pool, never)).toEqual([]);
    });

    it('shows the round exactly as GET /api/student/round does', async () => {
      await createOpenRound(pool);
      const studentId = await createStudentId(pool);

      const queue = queueOf(await read(studentId));
      const round = studentRoundResponseSchema.parse(
        (await send('GET', '/api/student/round', studentId)).json(),
      ).round;

      expect(queue).toEqual({ round, ticket: null });
    });

    it('answers round null when the grade has no round', async () => {
      expect(queueOf(await read(await createStudentId(pool)))).toEqual({
        round: null,
        ticket: null,
      });
    });

    it('rejects a query parameter with 400', async () => {
      const response = await send('GET', `${QUEUE_URL}?roundId=1`, await createStudentId(pool));

      expect(response.statusCode).toBe(400);
    });
  });

  describe('hasAdmittedTicket', () => {
    it('is true only for a live admitted ticket of that student in that round', async () => {
      const { roundId, students } = await queueOfStudents(3, 2);
      const [admitted, stale, waiting] = students;
      await rewindTickets(container, [stale!], { lastSeenSeconds: IDLE + 1 });
      const otherRound = await createOpenRound(pool, 2);
      const has = async (studentId: number, round = roundId) =>
        await hasAdmittedTicket(pool, { roundId: round, studentId }, DEFAULT_QUEUE_SETTINGS);

      expect(await has(admitted!)).toBe(true);
      expect(await has(stale!)).toBe(false);
      expect(await has(waiting!)).toBe(false);
      expect(await has(admitted!, otherRound)).toBe(false);
      await done(admitted!);
      expect(await has(admitted!)).toBe(false);
    });
  });

  describe('the ticket table', () => {
    it('never lets an ended ticket come back, even for the api role', async () => {
      const { students } = await queueOfStudents(1, 1);
      await done(students[0]!);

      await expect(
        pool.query(`UPDATE queue_tickets SET status = 'admitted' WHERE student_id = $1`, students),
      ).rejects.toThrow('cannot go from done to admitted');
    });

    it('never lets an admission time move once admitted', async () => {
      const { students } = await queueOfStudents(1, 1);

      await expect(
        pool.query(
          `UPDATE queue_tickets SET admitted_at = admitted_at + interval '1 hour'
           WHERE student_id = $1`,
          students,
        ),
      ).rejects.toThrow('keeps its admission time');
    });

    it('never admits a ticket without its admission time', async () => {
      const { students } = await queueOfStudents(2, 1);

      await expect(
        pool.query(`UPDATE queue_tickets SET status = 'admitted' WHERE student_id = $1`, [
          students[1],
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('access control and input', () => {
    it.each(WRITE_URLS)('forbids an admin from %s', async (url) => {
      const adminId = await createAdminId(pool);

      const response = await send('POST', url, adminId, { payload: {}, role: 'admin' });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('forbidden');
    });

    it('forbids an admin from reading the queue', async () => {
      const response = await send('GET', QUEUE_URL, await createAdminId(pool), { role: 'admin' });

      expect(response.statusCode).toBe(403);
    });

    it.each([...WRITE_URLS, QUEUE_URL])('requires a session for %s', async (url) => {
      const response = await app.inject({
        method: url === QUEUE_URL ? 'GET' : 'POST',
        url,
        ...(url === QUEUE_URL ? {} : { payload: {} }),
      });

      expect(response.statusCode).toBe(401);
      expect(errorOf(response).code).toBe('unauthorized');
    });

    it.each([...WRITE_URLS, QUEUE_URL])(
      'keeps %s closed until the first password change',
      async (url) => {
        await createOpenRound(pool);
        const [studentId] = await createStudents(pool, 1, { mustChangePassword: true });

        const response = url === QUEUE_URL ? await read(studentId!) : await post(url, studentId!);

        expect(response.statusCode).toBe(403);
        expect(errorOf(response).code).toBe('password_change_required');
      },
    );

    it.each([...WRITE_URLS, QUEUE_URL])(
      'answers 403 student_profile_missing on %s for a student without a profile',
      async (url) => {
        await createOpenRound(pool);
        const { id } = await createTestUser(pool);

        const response = url === QUEUE_URL ? await read(id) : await post(url, id);

        expect(response.statusCode).toBe(403);
        expect(errorOf(response).code).toBe('student_profile_missing');
      },
    );

    it.each(
      WRITE_URLS.flatMap((url) =>
        [{ studentId: 1 }, { roundId: 1 }, { position: 1 }].map((body) => [url, body] as const),
      ),
    )('refuses %s with the body %j', async (url, body) => {
      await createOpenRound(pool);
      const studentId = await createStudentId(pool);

      const response = await send('POST', url, studentId, { payload: body });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
      expect(await ticketsOf(pool, studentId)).toEqual([]);
    });

    it.each(WRITE_URLS)('refuses %s without a JSON body', async (url) => {
      await createOpenRound(pool);
      const studentId = await createStudentId(pool);

      const missing = await send('POST', url, studentId);
      const text = await send('POST', url, studentId, {
        payload: '{}',
        headers: { 'content-type': 'text/plain' },
      });
      const form = await send('POST', url, studentId, {
        payload: 'a=1',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

      expect([missing.statusCode, text.statusCode, form.statusCode]).toEqual([400, 400, 415]);
      expect(await ticketsOf(pool, studentId)).toEqual([]);
    });
  });

  describe('rate limits', () => {
    it('limits heartbeats and reads together to 60 a minute, apart from the other budgets', async () => {
      const { roundId, students } = await queueOfStudents(1, 1);
      const studentId = students[0]!;
      const clubId = await createClub(pool, roundId, uniqueCode());
      for (let i = 0; i < 30; i += 1) expect((await heartbeat(studentId)).statusCode).toBe(200);
      for (let i = 0; i < 30; i += 1) expect((await read(studentId)).statusCode).toBe(200);

      const limited = await heartbeat(studentId);
      const reading = await read(studentId);
      // Registered while the turn is still held: a register needs it (Q2), and done gives it up.
      const registered = await send('POST', '/api/student/registration', studentId, {
        payload: { clubId, idempotencyKey: newKey() },
      });
      const released = await done(studentId);

      expect([limited.statusCode, reading.statusCode]).toEqual([429, 429]);
      expect(errorOf(limited).code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
      expect(released.statusCode).toBe(200);
      expect(registered.statusCode).toBe(200);
    });

    it('limits joins and dones together to 20 a minute', async () => {
      await createOpenRound(pool);
      const studentId = await createStudentId(pool);
      for (let i = 0; i < 10; i += 1) {
        expect((await join(studentId)).statusCode).toBe(200);
        expect((await done(studentId)).statusCode).toBe(200);
      }

      const limited = await join(studentId);

      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited).code).toBe('rate_limited');
      expect((await heartbeat(studentId)).statusCode).toBe(409);
    });
  });

  it('logs ids, counts and outcomes, never a name', async () => {
    const { roundId, students } = await queueOfStudents(2, 1);
    const [first, second] = students;
    await heartbeat(second!);
    await done(first!);
    await heartbeat(first!);
    await read(second!);

    const entries = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'student queue join',
        studentId: first,
        roundId,
        outcome: 'queued',
        ticket: 'admitted',
        admitted: 1,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ msg: 'student queue done', studentId: first, outcome: 'released' }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'student queue heartbeat refused',
        studentId: first,
        outcome: 'not_in_queue',
      }),
    );
    expect(logLines.join('\n')).not.toContain(STUDENT_NAME);
  });
});
