import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { errorResponseSchema, studentRegistrationResponseSchema } from '@club-registration/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool, withTransaction } from '../src/db.js';
import { changeRegistration, registerForClub } from '../src/services/registrations.js';
import { TEST_JWT_SECRET, createTestUser } from './support/app.js';
import { createClub, uniqueCode } from './support/import-db.js';
import {
  appConnectionUri,
  startMigratedPostgres,
  stopPostgres,
  truncateAsOwner,
} from './support/postgres.js';
import {
  STUDENT_NAME,
  addWaitingDirectly,
  createClosedRound,
  createOpenRound,
  createStudentId,
  createStudents,
  createUpcomingRound,
  eventsOf,
  moveWindow,
  newKey,
  registrationInvariantViolations,
  seatStudent,
  sessionCookie,
  storedSeats,
  waitForAdvisoryLockWaiter,
} from './support/registration.js';

// PUT /api/student/registration: moving a seat to another club in one transaction (README
// Phase 2). Every value is made up.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const REGISTRATION_URL = '/api/student/registration';
const CANCEL_URL = '/api/student/registration/cancel';
const UNKNOWN_ID = 2_000_000_000;
const FROM_NAME = 'ชุมนุมสมมติ ต้นทาง';
const TO_NAME = 'ชุมนุมสมมติ ปลายทาง';

const errorOf = (response: InjectResponse) => errorResponseSchema.parse(response.json());
const registrationOf = (response: InjectResponse) =>
  studentRegistrationResponseSchema.parse(response.json()).registration;

describe('student change of club', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let logLines: string[];

  const send = async (
    method: 'PUT' | 'POST',
    url: string,
    studentId: number,
    payload: NonNullable<InjectOptions['payload']>,
    headers: NonNullable<InjectOptions['headers']> = {},
  ): Promise<InjectResponse> =>
    await app.inject({
      method,
      url,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      payload,
      headers,
    });

  const change = async (studentId: number, clubId: number, idempotencyKey = newKey()) =>
    await send('PUT', REGISTRATION_URL, studentId, { clubId, idempotencyKey });

  const register = async (studentId: number, clubId: number, idempotencyKey = newKey()) =>
    await send('POST', REGISTRATION_URL, studentId, { clubId, idempotencyKey });

  const cancel = async (studentId: number, idempotencyKey = newKey()) =>
    await send('POST', CANCEL_URL, studentId, { idempotencyKey });

  const heldClubs = async (studentId: number) => {
    const { rows } = await pool.query<{ club_id: number }>(
      'SELECT club_id FROM registrations WHERE student_id = $1',
      [studentId],
    );
    return rows.map(({ club_id: clubId }) => clubId);
  };

  const changeEventsOf = async (studentId: number) => {
    const { rows } = await pool.query<{
      round_id: number;
      club_id: number | null;
      from_club_id: number | null;
      actor_id: number;
      idempotency_key: string | null;
    }>(
      `SELECT round_id, club_id, from_club_id, actor_id, idempotency_key
       FROM registration_events WHERE student_id = $1 AND event_type = 'change' ORDER BY id`,
      [studentId],
    );
    return rows;
  };

  const registeredAtOf = async (studentId: number) => {
    const { rows } = await pool.query<{ created_at: Date }>(
      'SELECT created_at FROM registrations WHERE student_id = $1',
      [studentId],
    );
    return rows[0]!.created_at;
  };

  // An open round of grade 1 with two clubs, and a grade-1 student seated in the first.
  const changeSetup = async ({ fromCapacity = 30, toCapacity = 30 } = {}) => {
    const roundId = await createOpenRound(pool);
    const fromClub = await createClub(pool, roundId, uniqueCode(), {
      name: FROM_NAME,
      capacity: fromCapacity,
    });
    const toClub = await createClub(pool, roundId, uniqueCode(), {
      name: TO_NAME,
      capacity: toCapacity,
    });
    const studentId = await createStudentId(pool);
    await seatStudent(pool, studentId, fromClub);
    return { roundId, fromClub, toClub, studentId };
  };

  const leaveWaitlist = async (studentId: number) =>
    await send('POST', '/api/student/waitlist/leave', studentId, { idempotencyKey: newKey() });

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
    logLines = [];
    app = await buildApp({
      pool,
      jwtSecret: TEST_JWT_SECRET,
      logger: { level: 'info', stream: { write: (line) => logLines.push(line) } },
    });
  });

  afterEach(async () => {
    await app.close();
    expect(await registrationInvariantViolations(pool)).toEqual([]);
  });

  describe('PUT /api/student/registration', () => {
    it('moves the seat, logs one change event and answers with the new registration', async () => {
      const { roundId, fromClub, toClub, studentId } = await changeSetup();
      const key = newKey();

      const response = await change(studentId, toClub, key);

      expect(response.statusCode).toBe(200);
      const { rows } = await pool.query<{ club_code: string }>(
        'SELECT club_code FROM clubs WHERE id = $1',
        [toClub],
      );
      expect(response.json()).toEqual({
        registration: {
          club: { id: toClub, clubCode: rows[0]!.club_code, name: TO_NAME },
          registeredAt: (await registeredAtOf(studentId)).toISOString(),
          promotedFromWaitlist: false,
        },
      });
      expect(await heldClubs(studentId)).toEqual([toClub]);
      expect(await storedSeats(pool, fromClub)).toMatchObject({ registered: 0, rows: 0 });
      expect(await storedSeats(pool, toClub)).toMatchObject({ registered: 1, rows: 1 });
      expect(await changeEventsOf(studentId)).toEqual([
        {
          round_id: roundId,
          club_id: toClub,
          from_club_id: fromClub,
          actor_id: studentId,
          idempotency_key: key,
        },
      ]);
    });

    it('keeps the same registration row and dates it to when the new club was obtained', async () => {
      const { toClub, studentId } = await changeSetup();
      const before = await pool.query<{ id: number; created_at: Date }>(
        'SELECT id, created_at FROM registrations WHERE student_id = $1',
        [studentId],
      );

      await change(studentId, toClub);

      const after = await pool.query<{ id: number; created_at: Date }>(
        'SELECT id, created_at FROM registrations WHERE student_id = $1',
        [studentId],
      );
      expect(after.rows[0]!.id).toBe(before.rows[0]!.id);
      expect(after.rows[0]!.created_at.getTime()).toBeGreaterThan(
        before.rows[0]!.created_at.getTime(),
      );
    });

    it('answers 409 club_full and leaves the student in the old club', async () => {
      const { fromClub, toClub, studentId } = await changeSetup({ toCapacity: 1 });
      await seatStudent(pool, await createStudentId(pool), toClub);

      const response = await change(studentId, toClub);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('club_full');
      expect(await heldClubs(studentId)).toEqual([fromClub]);
      expect(await storedSeats(pool, fromClub)).toMatchObject({ registered: 1, rows: 1 });
      expect(await storedSeats(pool, toClub)).toMatchObject({ registered: 1, capacity: 1 });
      expect(await changeEventsOf(studentId)).toEqual([]);
    });

    it('answers 409 club_full for a club with no seats at all', async () => {
      const { toClub, studentId } = await changeSetup({ toCapacity: 0 });

      expect(errorOf(await change(studentId, toClub)).code).toBe('club_full');
    });

    it('answers 409 club_full for a club with free seats and a waitlist, so no one jumps it', async () => {
      const { roundId, fromClub, toClub, studentId } = await changeSetup();
      const waiting = await createStudentId(pool);
      await addWaitingDirectly(pool, { roundId, clubId: toClub, studentId: waiting });

      const response = await change(studentId, toClub);

      expect(errorOf(response).code).toBe('club_full');
      expect(await heldClubs(studentId)).toEqual([fromClub]);
      expect(await storedSeats(pool, toClub)).toMatchObject({ registered: 0 });
      expect((await leaveWaitlist(waiting)).statusCode).toBe(200);
    });

    it('gives the old seat back to whoever asks next', async () => {
      const { fromClub, toClub, studentId } = await changeSetup({ fromCapacity: 1 });
      const next = await createStudentId(pool);
      expect(errorOf(await register(next, fromClub)).code).toBe('club_full');

      await change(studentId, toClub);

      expect((await register(next, fromClub)).statusCode).toBe(200);
      expect(await storedSeats(pool, fromClub)).toMatchObject({ registered: 1, capacity: 1 });
    });

    it('answers 409 not_registered to a student without a club', async () => {
      const { toClub } = await changeSetup();
      const studentId = await createStudentId(pool);

      const response = await change(studentId, toClub);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('not_registered');
      expect(await heldClubs(studentId)).toEqual([]);
      expect(await storedSeats(pool, toClub)).toMatchObject({ registered: 0 });
      expect(await eventsOf(pool, studentId)).toEqual([]);
    });

    it('reports not_registered before club_full', async () => {
      const { toClub } = await changeSetup({ toCapacity: 0 });

      expect(errorOf(await change(await createStudentId(pool), toClub)).code).toBe(
        'not_registered',
      );
    });

    it('answers a change to the club already held with 200 and writes nothing', async () => {
      const { fromClub, studentId } = await changeSetup();
      const registeredAt = await registeredAtOf(studentId);

      const response = await change(studentId, fromClub);

      expect(response.statusCode).toBe(200);
      expect(registrationOf(response)).toMatchObject({
        club: { id: fromClub, name: FROM_NAME },
        registeredAt: registeredAt.toISOString(),
      });
      expect(await eventsOf(pool, studentId)).toHaveLength(1);
      expect(await storedSeats(pool, fromClub)).toMatchObject({ registered: 1 });
    });

    it('answers the club already held with 200 even after the round closed', async () => {
      const { roundId, fromClub, studentId } = await changeSetup();
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      const response = await change(studentId, fromClub);

      expect(response.statusCode).toBe(200);
      expect(registrationOf(response)?.club.id).toBe(fromClub);
    });

    it('answers 409 round_not_open after the round closed and keeps the old seat', async () => {
      const { roundId, fromClub, toClub, studentId } = await changeSetup();
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      const response = await change(studentId, toClub);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_not_open');
      expect(await heldClubs(studentId)).toEqual([fromClub]);
      expect(await storedSeats(pool, toClub)).toMatchObject({ registered: 0 });
    });

    it('answers 409 round_not_open before the round opens, ahead of not_registered', async () => {
      const roundId = await createUpcomingRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode());

      const response = await change(await createStudentId(pool), clubId);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_not_open');
    });

    it('answers 409 round_not_open to a closed round ahead of club_full', async () => {
      const { roundId, toClub, studentId } = await changeSetup({ toCapacity: 0 });
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      expect(errorOf(await change(studentId, toClub)).code).toBe('round_not_open');
    });

    it('answers 404 for a club of another grade, as if it did not exist', async () => {
      const { fromClub, studentId } = await changeSetup();
      const otherGrade = await createOpenRound(pool, 2);
      const clubId = await createClub(pool, otherGrade, uniqueCode());

      const response = await change(studentId, clubId);

      expect(response.statusCode).toBe(404);
      expect(errorOf(response)).toEqual({ code: 'not_found', message: 'Club not found' });
      expect(await heldClubs(studentId)).toEqual([fromClub]);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 0 });
    });

    it('answers 404 for an unknown club', async () => {
      const { studentId } = await changeSetup();

      const response = await change(studentId, UNKNOWN_ID);

      expect(response.statusCode).toBe(404);
      expect(errorOf(response)).toEqual({ code: 'not_found', message: 'Club not found' });
    });

    it('answers 404 for a club of an own-grade round other than the one shown', async () => {
      const oldRound = await createClosedRound(pool, 1, 7_200);
      const oldClub = await createClub(pool, oldRound, uniqueCode());
      const { fromClub, studentId } = await changeSetup();

      const response = await change(studentId, oldClub);

      expect(response.statusCode).toBe(404);
      expect(await heldClubs(studentId)).toEqual([fromClub]);
      expect(await storedSeats(pool, oldClub)).toMatchObject({ registered: 0 });
    });

    it('waits for a round lock held by another writer', async () => {
      const { roundId, fromClub, toClub, studentId } = await changeSetup();
      const holder = await pool.connect();
      let released = false;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [roundId]);

        const pending = change(studentId, toClub);
        await waitForAdvisoryLockWaiter(pool);
        expect(await heldClubs(studentId)).toEqual([fromClub]);
        await holder.query('COMMIT');
        released = true;

        expect((await pending).statusCode).toBe(200);
      } finally {
        if (!released) await holder.query('ROLLBACK');
        holder.release();
      }
    });
  });

  describe('idempotency', () => {
    it('replays a change sent again with its key: 200, same body, no second event', async () => {
      const { toClub, studentId } = await changeSetup();
      const key = newKey();
      const first = await change(studentId, toClub, key);

      const replay = await change(studentId, toClub, key);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await changeEventsOf(studentId)).toHaveLength(1);
      expect(await storedSeats(pool, toClub)).toMatchObject({ registered: 1 });
    });

    it('answers a replayed change with the state now, after a later cancel', async () => {
      const { toClub, studentId } = await changeSetup();
      const key = newKey();
      await change(studentId, toClub, key);
      await cancel(studentId);

      const replay = await change(studentId, toClub, key);

      expect(replay.statusCode).toBe(200);
      expect(registrationOf(replay)).toBeNull();
      expect(await heldClubs(studentId)).toEqual([]);
    });

    it('replays a change after the round closed instead of answering round_not_open', async () => {
      const { roundId, toClub, studentId } = await changeSetup();
      const key = newKey();
      await change(studentId, toClub, key);
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      const replay = await change(studentId, toClub, key);

      expect(replay.statusCode).toBe(200);
      expect(registrationOf(replay)?.club.id).toBe(toClub);
    });

    it('answers 409 idempotency_key_reused for the key of a change sent for another club', async () => {
      const { roundId, toClub, studentId } = await changeSetup();
      const third = await createClub(pool, roundId, uniqueCode());
      const key = newKey();
      await change(studentId, toClub, key);

      const response = await change(studentId, third, key);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('idempotency_key_reused');
      expect(await heldClubs(studentId)).toEqual([toClub]);
      expect(await storedSeats(pool, third)).toMatchObject({ registered: 0 });
    });

    it('answers 409 idempotency_key_reused for a change that reuses a register key', async () => {
      const { roundId } = await changeSetup();
      const studentId = await createStudentId(pool);
      const [first, second] = await Promise.all([
        createClub(pool, roundId, uniqueCode()),
        createClub(pool, roundId, uniqueCode()),
      ]);
      const key = newKey();
      await register(studentId, first, key);

      const response = await change(studentId, second, key);

      expect(errorOf(response).code).toBe('idempotency_key_reused');
      expect(await heldClubs(studentId)).toEqual([first]);
    });

    it('answers 409 idempotency_key_reused for a change to the same club as a register key', async () => {
      const { roundId } = await changeSetup();
      const clubId = await createClub(pool, roundId, uniqueCode());
      const studentId = await createStudentId(pool);
      const key = newKey();
      await register(studentId, clubId, key);

      // Another request type with the same club is still another request.
      expect(errorOf(await change(studentId, clubId, key)).code).toBe('idempotency_key_reused');
    });

    it.each([
      ['a register', 'register'],
      ['a cancel', 'cancel'],
    ] as const)(
      'answers 409 idempotency_key_reused to %s that reuses a change key',
      async (_label, action) => {
        const { roundId, toClub, studentId } = await changeSetup();
        const third = await createClub(pool, roundId, uniqueCode());
        const key = newKey();
        await change(studentId, toClub, key);

        const response =
          action === 'register'
            ? await register(studentId, third, key)
            : await cancel(studentId, key);

        expect(errorOf(response).code).toBe('idempotency_key_reused');
        expect(await heldClubs(studentId)).toEqual([toClub]);
      },
    );

    it('records nothing for a refused change, so its key can be retried', async () => {
      const { toClub, studentId } = await changeSetup({ toCapacity: 1 });
      const holder = await createStudentId(pool);
      await seatStudent(pool, holder, toClub);
      const key = newKey();
      expect(errorOf(await change(studentId, toClub, key)).code).toBe('club_full');
      await cancel(holder);

      const retry = await change(studentId, toClub, key);

      expect(retry.statusCode).toBe(200);
      expect(await heldClubs(studentId)).toEqual([toClub]);
    });
  });

  it('composes in one transaction: register then change leaves one seat in the new club', async () => {
    const roundId = await createOpenRound(pool);
    const [first, second] = await Promise.all([
      createClub(pool, roundId, uniqueCode()),
      createClub(pool, roundId, uniqueCode()),
    ]);
    const studentId = await createStudentId(pool);

    const results = await withTransaction(pool, async (client) => [
      await registerForClub(client, { studentId, clubId: first, idempotencyKey: newKey() }),
      await changeRegistration(client, { studentId, clubId: second, idempotencyKey: newKey() }),
    ]);

    expect(results.map(({ outcome }) => outcome)).toEqual(['registered', 'changed']);
    expect(results[1]).toMatchObject({ roundId, clubId: second, fromClubId: first });
    expect(await storedSeats(pool, first)).toMatchObject({ registered: 0, rows: 0 });
    expect(await storedSeats(pool, second)).toMatchObject({ registered: 1, rows: 1 });
  });

  it('the invariant check reports a change event that moved no seat', async () => {
    const { roundId, fromClub, toClub, studentId } = await changeSetup();
    await pool.query(
      `INSERT INTO registration_events
         (round_id, student_id, club_id, from_club_id, event_type, actor_id, idempotency_key)
       VALUES ($1, $2, $3, $4, 'change', $2, $5)`,
      [roundId, studentId, toClub, fromClub, newKey()],
    );

    const violations = await registrationInvariantViolations(pool);

    // The event log is append-only; the owner's truncate is the one way to undo the bogus event.
    await truncateAsOwner(container, ['rounds']);
    expect(violations.join('\n')).toContain('per club equals clubs.registered');
    expect(violations.join('\n')).toContain('latest seat event gave them the club they hold');
  });

  describe('access control and validation', () => {
    it('requires a session', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: REGISTRATION_URL,
        payload: { clubId: 1, idempotencyKey: newKey() },
      });

      expect(response.statusCode).toBe(401);
      expect(errorOf(response).code).toBe('unauthorized');
    });

    it('forbids an admin', async () => {
      const admin = await createTestUser(pool, { role: 'admin' });

      const response = await app.inject({
        method: 'PUT',
        url: REGISTRATION_URL,
        cookies: { [SESSION_COOKIE]: sessionCookie(app, admin.id, 'admin') },
        // Invalid on purpose: the role is checked before the body.
        payload: { unexpected: true },
      });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('forbidden');
    });

    it('stays closed until the first password change', async () => {
      const { toClub } = await changeSetup();
      const [pending] = await createStudents(pool, 1, { mustChangePassword: true });

      const response = await change(pending!, toClub);

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('password_change_required');
    });

    it('answers 403 student_profile_missing without a profile', async () => {
      const { toClub } = await changeSetup();
      const user = await createTestUser(pool);

      const response = await change(user.id, toClub);

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('student_profile_missing');
    });

    it.each([
      ['a studentId', { studentId: 1 }],
      ['a fromClubId', { fromClubId: 1 }],
      ['a roundId', { roundId: 1 }],
      ['no key', { idempotencyKey: undefined }],
      ['a short key', { idempotencyKey: 'short' }],
      ['no clubId', { clubId: undefined }],
      ['a clubId as text', { clubId: '1' }],
      ['a zero clubId', { clubId: 0 }],
    ])('rejects a body with %s with 400 and writes nothing', async (_label, body) => {
      const { fromClub, toClub, studentId } = await changeSetup();

      const response = await send('PUT', REGISTRATION_URL, studentId, {
        clubId: toClub,
        idempotencyKey: newKey(),
        ...body,
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
      expect(await heldClubs(studentId)).toEqual([fromClub]);
    });

    it('acts for the session student, never for a studentId sent in the body', async () => {
      const { roundId, toClub, studentId } = await changeSetup();
      const victim = await createStudentId(pool);
      const victimClub = await createClub(pool, roundId, uniqueCode());
      await seatStudent(pool, victim, victimClub);

      const response = await send('PUT', REGISTRATION_URL, studentId, {
        clubId: toClub,
        idempotencyKey: newKey(),
        studentId: victim,
      });

      expect(response.statusCode).toBe(400);
      expect(await heldClubs(victim)).toEqual([victimClub]);
    });

    it('accepts JSON only', async () => {
      const { fromClub, toClub, studentId } = await changeSetup();

      const response = await send(
        'PUT',
        REGISTRATION_URL,
        studentId,
        `clubId=${toClub}&idempotencyKey=${newKey()}`,
        { 'content-type': 'application/x-www-form-urlencoded' },
      );

      expect(response.statusCode).toBe(415);
      expect(await heldClubs(studentId)).toEqual([fromClub]);
    });

    it('shares the rate limit with register and cancel', async () => {
      const { fromClub, toClub, studentId } = await changeSetup();
      const attempts = await Promise.all(
        Array.from({ length: 30 }, async () => await register(studentId, UNKNOWN_ID)),
      );
      expect(attempts.every(({ statusCode }) => statusCode === 404)).toBe(true);

      const limited = await change(studentId, toClub);

      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited).code).toBe('rate_limited');
      expect(await heldClubs(studentId)).toEqual([fromClub]);
    });
  });

  it('logs ids and outcomes, never a student or club name', async () => {
    const { roundId, fromClub, toClub, studentId } = await changeSetup({ toCapacity: 1 });
    const late = await createStudentId(pool);
    const lateClub = await createClub(pool, roundId, uniqueCode(), { name: FROM_NAME });
    await seatStudent(pool, late, lateClub);

    await change(studentId, toClub);
    await change(late, toClub);

    const entries = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'student change',
        studentId,
        roundId,
        clubId: toClub,
        fromClubId: fromClub,
        outcome: 'changed',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'student change refused',
        studentId: late,
        clubId: toClub,
        outcome: 'club_full',
      }),
    );
    const log = logLines.join('\n');
    [STUDENT_NAME, FROM_NAME, TO_NAME].forEach((value) => expect(log).not.toContain(value));
  });
});
