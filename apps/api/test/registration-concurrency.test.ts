import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  errorResponseSchema,
  studentRegistrationResponseSchema,
  studentRoundResponseSchema,
  studentWaitlistResponseSchema,
} from '@club-registration/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { DEFAULT_POOL_SETTINGS, createPool } from '../src/db.js';
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

  const change = async (studentId: number, clubId: number, idempotencyKey = newKey()) =>
    await app.inject({
      method: 'PUT',
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

  const changeEventCount = async (clubId: number) => {
    const { rows } = await pool.query<{ events: number }>(
      `SELECT count(*)::int AS events FROM registration_events
       WHERE club_id = $1 AND event_type = 'change'`,
      [clubId],
    );
    return rows[0]?.events;
  };

  const registrationOf = async (studentId: number) => {
    const { rows } = await pool.query<{ club_id: number }>(
      'SELECT club_id FROM registrations WHERE student_id = $1',
      [studentId],
    );
    return rows.map(({ club_id: clubId }) => clubId);
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    // These tests prove what the round lock and the DB decide, not how long a request may wait
    // for a connection: 500 requests on 20 connections, serialized by the round lock, take ~2.5 s
    // on an idle machine but past the 5 s production wait while other test files share the CPU,
    // and the late ones fail with internal_error. Same pool size, a wait no machine reaches. The
    // production wait is an O5 load-test question (README "Testing").
    pool = createPool(appConnectionUri(container), {
      ...DEFAULT_POOL_SETTINGS,
      connectionTimeoutMs: 120_000,
    });
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

  describe('changing club', () => {
    it('moves exactly as many students as there are free seats; the rest stay put', async () => {
      const roundId = await createOpenRound(pool);
      const [from, to] = await Promise.all([
        createClub(pool, roundId, uniqueCode(), { capacity: 40 }),
        createClub(pool, roundId, uniqueCode(), { capacity: 10 }),
      ]);
      const holders = await createStudents(pool, 5);
      for (const studentId of holders) await seatStudent(pool, studentId, to);
      const movers = await createStudents(pool, 40);
      for (const studentId of movers) await seatStudent(pool, studentId, from);

      const responses = await Promise.all(
        movers.map(async (studentId) => await change(studentId, to)),
      );

      expect(countBy(responses)).toEqual({ ok: 5, club_full: 35 });
      for (const [i, studentId] of movers.entries()) {
        expect(await registrationOf(studentId)).toEqual([
          responses[i]!.statusCode === 200 ? to : from,
        ]);
      }
      expect(await storedSeats(pool, to)).toEqual({ registered: 10, capacity: 10, rows: 10 });
      expect(await storedSeats(pool, from)).toMatchObject({ registered: 35, rows: 35 });
      expect(await changeEventCount(to)).toBe(5);
    }, 60_000);

    it('never overfills a club when changes race registrations and cancellations for it', async () => {
      const roundId = await createOpenRound(pool);
      const [from, to] = await Promise.all([
        createClub(pool, roundId, uniqueCode(), { capacity: 30 }),
        createClub(pool, roundId, uniqueCode(), { capacity: 10 }),
      ]);
      const holders = await createStudents(pool, 8);
      for (const studentId of holders) await seatStudent(pool, studentId, to);
      const leaving = holders.slice(0, 4);
      const movers = await createStudents(pool, 20);
      for (const studentId of movers) await seatStudent(pool, studentId, from);
      const newcomers = await createStudents(pool, 20);

      const [cancels, changes, registers] = await Promise.all([
        Promise.all(leaving.map(async (studentId) => await cancel(studentId))),
        Promise.all(movers.map(async (studentId) => await change(studentId, to))),
        Promise.all(newcomers.map(async (studentId) => await register(studentId, to))),
      ]);

      expect(countBy(cancels)).toEqual({ ok: 4 });
      const moved = changes.filter(({ statusCode }) => statusCode === 200).length;
      const seated = registers.filter(({ statusCode }) => statusCode === 200).length;
      // 2 seats free at the start, 4 more freed by the cancels: at most 6 can be handed out.
      expect(moved + seated).toBeLessThanOrEqual(6);
      expect(moved + seated).toBeGreaterThanOrEqual(2);
      expect([...changes, ...registers].every((r) => ['ok', 'club_full'].includes(codeOf(r)))).toBe(
        true,
      );
      expect(await storedSeats(pool, to)).toEqual({
        registered: 4 + moved + seated,
        capacity: 10,
        rows: 4 + moved + seated,
      });
      expect(await storedSeats(pool, from)).toMatchObject({
        registered: 20 - moved,
        rows: 20 - moved,
      });
    }, 60_000);

    // The new seat is taken before the old one is given back, so neither seat is ever free when
    // the other student asks: a swap between two full clubs is refused both ways, whichever
    // request runs first (README Phase 2).
    it('refuses both students who try to swap between two full clubs', async () => {
      const roundId = await createOpenRound(pool);
      const [first, second] = await Promise.all([
        createClub(pool, roundId, uniqueCode(), { capacity: 1 }),
        createClub(pool, roundId, uniqueCode(), { capacity: 1 }),
      ]);
      const [inFirst, inSecond] = await createStudents(pool, 2);
      await seatStudent(pool, inFirst!, first);
      await seatStudent(pool, inSecond!, second);

      const responses = await Promise.all([change(inFirst!, second), change(inSecond!, first)]);

      expect(responses.map(codeOf)).toEqual(['club_full', 'club_full']);
      expect(await registrationOf(inFirst!)).toEqual([first]);
      expect(await registrationOf(inSecond!)).toEqual([second]);
    });

    it('carries out a change once when it is sent many times at once with one key', async () => {
      const roundId = await createOpenRound(pool);
      const [from, to] = await Promise.all([
        createClub(pool, roundId, uniqueCode()),
        createClub(pool, roundId, uniqueCode()),
      ]);
      const studentId = await createStudentId(pool);
      await seatStudent(pool, studentId, from);
      const key = newKey();

      const responses = await Promise.all(
        Array.from({ length: 20 }, async () => await change(studentId, to, key)),
      );

      expect(countBy(responses)).toEqual({ ok: 20 });
      const bodies = responses.map((response) => response.json<unknown>());
      expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
      expect((await eventsOf(pool, studentId)).map(({ event_type: type }) => type)).toEqual([
        'register',
        'change',
      ]);
      expect(await storedSeats(pool, from)).toMatchObject({ registered: 0, rows: 0 });
      expect(await storedSeats(pool, to)).toMatchObject({ registered: 1, rows: 1 });
    });

    it('keeps one seat when a student asks for several clubs at once', async () => {
      const roundId = await createOpenRound(pool);
      const [from, ...targets] = await Promise.all(
        Array.from({ length: 11 }, async () => await createClub(pool, roundId, uniqueCode())),
      );
      const studentId = await createStudentId(pool);
      await seatStudent(pool, studentId, from!);

      const responses = await Promise.all(
        targets.map(async (clubId) => await change(studentId, clubId)),
      );

      // Each runs alone under the round lock and moves the seat on from wherever it is.
      expect(countBy(responses)).toEqual({ ok: 10 });
      const held = await registrationOf(studentId);
      expect(held).toHaveLength(1);
      expect(targets).toContain(held[0]);
      expect(await changeEventCount(held[0]!)).toBe(1);
    });
  });

  // The waitlist under load (README Phase 2 "Test ที่ต้องมี"), on this file's pool with its long
  // connection wait (beforeAll above). In this file rather than its own so its 500-student test
  // never runs at the same time as the one above: each file runs in its own worker. The invariant
  // check after each test includes "no free seat with a queue in an open round" and "the waitlist
  // events replay to the entries".
  describe('waitlist', () => {
    const post = async (url: string, studentId: number, payload: Record<string, unknown>) =>
      await app.inject({
        method: 'POST',
        url,
        cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
        payload,
      });

    const registerOnce = async (studentId: number, clubId: number) =>
      await post(REGISTER_URL, studentId, { clubId, idempotencyKey: newKey() });
    const join = async (studentId: number, clubId: number, idempotencyKey = newKey()) =>
      await post('/api/student/waitlist', studentId, { clubId, idempotencyKey });
    const leave = async (studentId: number, idempotencyKey = newKey()) =>
      await post('/api/student/waitlist/leave', studentId, { idempotencyKey });
    const cancelOnce = async (studentId: number) =>
      await post(CANCEL_URL, studentId, { idempotencyKey: newKey() });

    // What a student's page does: register, and on club_full offer the waitlist.
    const registerOrWait = async (studentId: number, clubId: number): Promise<string> => {
      const registered = await registerOnce(studentId, clubId);
      if (codeOf(registered) !== 'club_full') return codeOf(registered);
      const joined = await join(studentId, clubId);
      return codeOf(joined) === 'ok' ? 'waitlisted' : codeOf(joined);
    };

    const queueOf = async (clubId: number) => {
      const { rows } = await pool.query<{ student_id: number }>(
        'SELECT student_id FROM waitlist_entries WHERE club_id = $1 ORDER BY created_at, id',
        [clubId],
      );
      return rows.map(({ student_id: studentId }) => studentId);
    };

    const positionOf = async (studentId: number) => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/student/round',
        cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      });
      return studentRoundResponseSchema.parse(response.json()).waitlist?.position;
    };

    const promotedInto = async (clubId: number) => {
      const { rows } = await pool.query<{ student_id: number }>(
        `SELECT student_id FROM registration_events
         WHERE event_type = 'waitlist_promote' AND club_id = $1 ORDER BY id`,
        [clubId],
      );
      return rows.map(({ student_id: studentId }) => studentId);
    };

    const codesOf = (responses: InjectResponse[]) => countBy(responses);

    // README Phase 2 required test 1.
    it('seats exactly capacity out of 500 students and queues every other one', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 30 });
      const students = await createStudents(pool, 500);

      const startedAt = performance.now();
      const outcomes = await Promise.all(
        students.map(async (studentId) => await registerOrWait(studentId, clubId)),
      );
      const elapsedMs = performance.now() - startedAt;

      expect(
        outcomes.reduce<Record<string, number>>(
          (counts, outcome) => ({ ...counts, [outcome]: (counts[outcome] ?? 0) + 1 }),
          {},
        ),
      ).toEqual({ ok: 30, waitlisted: 470 });
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 30, capacity: 30, rows: 30 });
      const queue = await queueOf(clubId);
      expect(queue).toHaveLength(470);
      expect(new Set(queue).size).toBe(470);
      const waitlisted = students.filter((_, i) => outcomes[i] === 'waitlisted');
      expect([...queue].sort((a, b) => a - b)).toEqual([...waitlisted].sort((a, b) => a - b));
      // Printed so a number quoted anywhere comes from a real run, not an estimate.
      console.info(
        `500 students registering or joining the waitlist of 30 seats (970 requests): ` +
          `${Math.round(elapsedMs)} ms for all, pool of ${DEFAULT_POOL_SETTINGS.max}`,
      );
    }, 120_000);

    // README Phase 2 required test 2.
    it('promotes exactly the first 10 of 50 waiters when 10 holders cancel at once', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 30 });
      const holders = await createStudents(pool, 30);
      for (const studentId of holders) await seatStudent(pool, studentId, clubId);
      const waiters = await createStudents(pool, 50);
      for (const studentId of waiters) expect(codeOf(await join(studentId, clubId))).toBe('ok');

      const cancels = await Promise.all(
        holders.slice(0, 10).map(async (studentId) => await cancelOnce(studentId)),
      );

      expect(codesOf(cancels)).toEqual({ ok: 10 });
      expect(await promotedInto(clubId)).toEqual(waiters.slice(0, 10));
      expect(await queueOf(clubId)).toEqual(waiters.slice(10));
      const positions = await Promise.all(waiters.slice(10).map(positionOf));
      expect(positions).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 30, capacity: 30, rows: 30 });
    }, 60_000);

    it('carries out a join once when it is sent many times at once with one key', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 1 });
      await seatStudent(pool, await createStudentId(pool), clubId);
      const studentId = await createStudentId(pool);
      const key = newKey();

      const responses = await Promise.all(
        Array.from({ length: 20 }, async () => await join(studentId, clubId, key)),
      );

      expect(codesOf(responses)).toEqual({ ok: 20 });
      const bodies = responses.map((r) => studentWaitlistResponseSchema.parse(r.json()));
      expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
      expect((await eventsOf(pool, studentId)).map(({ event_type: type }) => type)).toEqual([
        'waitlist_join',
      ]);
    });

    it('leaves once when one leave is sent many times at once', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 1 });
      await seatStudent(pool, await createStudentId(pool), clubId);
      const studentId = await createStudentId(pool);
      await join(studentId, clubId);
      const key = newKey();

      const responses = await Promise.all(
        Array.from({ length: 20 }, async () => await leave(studentId, key)),
      );

      expect(codesOf(responses)).toEqual({ ok: 20 });
      expect((await eventsOf(pool, studentId)).map(({ event_type: type }) => type)).toEqual([
        'waitlist_join',
        'waitlist_leave',
      ]);
      expect(await queueOf(clubId)).toEqual([]);
    });

    it('hands every seat freed while joins and registers race cancels to someone', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 10 });
      const holders = await createStudents(pool, 10);
      for (const studentId of holders) await seatStudent(pool, studentId, clubId);
      const newcomers = await createStudents(pool, 40);

      const [cancels, outcomes] = await Promise.all([
        Promise.all(holders.slice(0, 5).map(async (studentId) => await cancelOnce(studentId))),
        Promise.all(newcomers.map(async (studentId) => await registerOrWait(studentId, clubId))),
      ]);

      expect(codesOf(cancels)).toEqual({ ok: 5 });
      // waitlist_not_needed: register found the club full, then a cancel freed a seat nobody
      // was queued for before the join ran.
      outcomes.forEach((outcome) =>
        expect(['ok', 'waitlisted', 'waitlist_not_needed']).toContain(outcome),
      );
      const queue = await queueOf(clubId);
      const { registered } = await storedSeats(pool, clubId);
      // Five seats were freed, 35 newcomers got no seat directly: unless every freed seat went to
      // a register, the queue's head took it, and anyone still queued waits for a full club.
      expect(queue.length === 0 || registered === 10).toBe(true);
      expect(registered).toBeGreaterThanOrEqual(5);
    }, 60_000);
  });
});
