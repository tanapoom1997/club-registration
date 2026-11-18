import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { errorResponseSchema, studentRegistrationResponseSchema } from '@club-registration/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool } from '../src/db.js';
import { buildTestApp } from './support/app.js';
import { createClub, uniqueCode } from './support/import-db.js';
import {
  appConnectionUri,
  startMigratedPostgres,
  stopPostgres,
  truncateAsOwner,
} from './support/postgres.js';
import {
  createOpenRound,
  createStudentId,
  createStudents,
  eventsOf,
  newKey,
  registrationInvariantViolations,
  seatStudent,
  sessionCookie,
  storedSeats,
} from './support/registration.js';

// The point of the system (README "Testing"): many students pressing the button at once against
// a real Postgres. Requests go through the whole app (guard, validation, transaction) with
// app.inject, all started before any is awaited, so they contend for the pool, the round
// advisory lock and the club row exactly as concurrent HTTP requests would.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const REGISTER_URL = '/api/student/registration';
const CANCEL_URL = '/api/student/registration/cancel';

const codeOf = (response: InjectResponse) =>
  response.statusCode === 200 ? 'ok' : errorResponseSchema.parse(response.json()).code;

const countBy = (responses: InjectResponse[]) =>
  responses.reduce<Record<string, number>>((counts, response) => {
    const code = codeOf(response);
    return { ...counts, [code]: (counts[code] ?? 0) + 1 };
  }, {});

describe('registration under concurrency', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  const register = async (studentId: number, clubId: number, idempotencyKey = newKey()) =>
    await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      payload: { clubId, idempotencyKey },
    });

  const cancel = async (studentId: number, idempotencyKey = newKey()) =>
    await app.inject({
      method: 'POST',
      url: CANCEL_URL,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      payload: { idempotencyKey },
    });

  const registrationOf = async (studentId: number) => {
    const { rows } = await pool.query<{ club_id: number }>(
      'SELECT club_id FROM registrations WHERE student_id = $1',
      [studentId],
    );
    return rows.map(({ club_id: clubId }) => clubId);
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(appConnectionUri(container));
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    // A student writes to their grade's selected round, so each test starts with no rounds.
    await truncateAsOwner(container, ['rounds']);
    app = await buildTestApp(pool);
  });

  afterEach(async () => {
    await app.close();
    expect(await registrationInvariantViolations(pool)).toEqual([]);
  });

  it('seats exactly capacity out of 500 students racing for one club', async () => {
    const roundId = await createOpenRound(pool);
    const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 30 });
    const students = await createStudents(pool, 500);

    const startedAt = performance.now();
    const responses = await Promise.all(
      students.map(async (studentId) => await register(studentId, clubId)),
    );
    const elapsedMs = performance.now() - startedAt;

    expect(countBy(responses)).toEqual({ ok: 30, club_full: 470 });
    expect(await storedSeats(pool, clubId)).toEqual({ registered: 30, capacity: 30, rows: 30 });
    const { rows } = await pool.query<{ events: number }>(
      `SELECT count(*)::int AS events FROM registration_events
       WHERE club_id = $1 AND event_type = 'register'`,
      [clubId],
    );
    expect(rows[0]?.events).toBe(30);
    // Printed so the number in the README/PR comes from a real run, not an estimate.
    console.info(
      `500 concurrent registrations for 30 seats: ${Math.round(elapsedMs)} ms for all requests ` +
        `(${(elapsedMs / 500).toFixed(1)} ms per request on average, pool of 20)`,
    );
  }, 120_000);

  it('gives one student exactly one of several clubs requested at once', async () => {
    const roundId = await createOpenRound(pool);
    const clubs = await Promise.all(
      Array.from({ length: 10 }, async () => await createClub(pool, roundId, uniqueCode())),
    );
    const studentId = await createStudentId(pool);

    const responses = await Promise.all(
      clubs.map(async (clubId) => await register(studentId, clubId)),
    );

    expect(countBy(responses)).toEqual({ ok: 1, already_registered: 9 });
    const winner = responses.find(({ statusCode }) => statusCode === 200)!;
    const held = await registrationOf(studentId);
    expect(held).toEqual([
      studentRegistrationResponseSchema.parse(winner.json()).registration?.club.id,
    ]);
    expect(await eventsOf(pool, studentId)).toHaveLength(1);
  });

  it('carries out a request once when it is sent many times at once with one key', async () => {
    const roundId = await createOpenRound(pool);
    const clubId = await createClub(pool, roundId, uniqueCode());
    const studentId = await createStudentId(pool);
    const key = newKey();

    const responses = await Promise.all(
      Array.from({ length: 20 }, async () => await register(studentId, clubId, key)),
    );

    expect(countBy(responses)).toEqual({ ok: 20 });
    const bodies = responses.map((response) => response.json<unknown>());
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(await eventsOf(pool, studentId)).toHaveLength(1);
    expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 1, rows: 1 });
  });

  it('answers 409 to the requests that reuse a key for another club, whichever wins', async () => {
    const roundId = await createOpenRound(pool);
    const [first, second] = await Promise.all([
      createClub(pool, roundId, uniqueCode()),
      createClub(pool, roundId, uniqueCode()),
    ]);
    const studentId = await createStudentId(pool);
    const key = newKey();

    const responses = await Promise.all(
      Array.from(
        { length: 20 },
        async (_, i) => await register(studentId, i % 2 === 0 ? first : second, key),
      ),
    );

    expect(countBy(responses)).toEqual({ ok: 10, idempotency_key_reused: 10 });
    const [winner] = await registrationOf(studentId);
    responses.forEach((response, i) =>
      expect(codeOf(response)).toBe(
        (i % 2 === 0 ? first : second) === winner ? 'ok' : 'idempotency_key_reused',
      ),
    );
    expect(await eventsOf(pool, studentId)).toHaveLength(1);
  });

  it('cancels once when one cancel is sent many times at once', async () => {
    const roundId = await createOpenRound(pool);
    const clubId = await createClub(pool, roundId, uniqueCode());
    const studentId = await createStudentId(pool);
    await seatStudent(pool, studentId, clubId);
    const key = newKey();

    const responses = await Promise.all(
      Array.from({ length: 20 }, async () => await cancel(studentId, key)),
    );

    expect(countBy(responses)).toEqual({ ok: 20 });
    expect(
      responses.every(
        (response) =>
          studentRegistrationResponseSchema.parse(response.json()).registration === null,
      ),
    ).toBe(true);
    expect((await eventsOf(pool, studentId)).map(({ event_type: type }) => type)).toEqual([
      'register',
      'cancel',
    ]);
    expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 0, rows: 0 });
  });

  it('keeps each student consistent when their cancel races their register elsewhere', async () => {
    const roundId = await createOpenRound(pool);
    const [from, to] = await Promise.all([
      createClub(pool, roundId, uniqueCode()),
      createClub(pool, roundId, uniqueCode()),
    ]);
    const students = await createStudents(pool, 20);
    for (const studentId of students) await seatStudent(pool, studentId, from);

    const races = await Promise.all(
      students.map(async (studentId) => {
        const [cancelled, registered] = await Promise.all([
          cancel(studentId),
          register(studentId, to),
        ]);
        return { studentId, cancelled, registered };
      }),
    );

    for (const { studentId, cancelled, registered } of races) {
      // The cancel always wins its seat back; the register only succeeds if it ran after it.
      expect(cancelled.statusCode).toBe(200);
      const outcome = codeOf(registered);
      expect(['ok', 'already_registered']).toContain(outcome);
      expect(await registrationOf(studentId)).toEqual(outcome === 'ok' ? [to] : []);
    }
    const moved = races.filter(({ registered }) => registered.statusCode === 200).length;
    expect(await storedSeats(pool, from)).toMatchObject({ registered: 0, rows: 0 });
    expect(await storedSeats(pool, to)).toMatchObject({ registered: moved, rows: moved });
  }, 60_000);

  it('hands seats freed by cancels to students racing for them, never above capacity', async () => {
    const roundId = await createOpenRound(pool);
    const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 30 });
    const holders = await createStudents(pool, 30);
    for (const studentId of holders) await seatStudent(pool, studentId, clubId);
    const leaving = holders.slice(0, 10);
    const newcomers = await createStudents(pool, 60);

    const [cancels, registers] = await Promise.all([
      Promise.all(leaving.map(async (studentId) => await cancel(studentId))),
      Promise.all(newcomers.map(async (studentId) => await register(studentId, clubId))),
    ]);

    expect(countBy(cancels)).toEqual({ ok: 10 });
    const seated = registers.filter(({ statusCode }) => statusCode === 200).length;
    expect(seated).toBeLessThanOrEqual(10);
    expect(countBy(registers)).toEqual({
      ...(seated > 0 ? { ok: seated } : {}),
      club_full: 60 - seated,
    });
    expect(await storedSeats(pool, clubId)).toEqual({
      registered: 20 + seated,
      capacity: 30,
      rows: 20 + seated,
    });
  }, 60_000);
});
