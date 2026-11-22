import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { errorResponseSchema, studentRegistrationResponseSchema } from '@club-registration/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool, withTransaction } from '../src/db.js';
import {
  EVENT_KEY_UNIQUE,
  cancelRegistration,
  registerForClub,
} from '../src/services/registrations.js';
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
  createClosedRound,
  createOpenRound,
  createRoundAt,
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
  ungated,
  waitForAdvisoryLockWaiter,
} from './support/registration.js';
import { takeTurnFor } from './support/queue.js';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const REGISTER_URL = '/api/student/registration';
const CANCEL_URL = '/api/student/registration/cancel';
const WRITE_URLS = [REGISTER_URL, CANCEL_URL] as const;
const UNKNOWN_ID = 2_000_000_000;
// Every value is made up.
const CLUB_NAME = 'ชุมนุมสมมติ ลงทะเบียน';

const errorOf = (response: InjectResponse) => errorResponseSchema.parse(response.json());
const registrationOf = (response: InjectResponse) =>
  studentRegistrationResponseSchema.parse(response.json()).registration;

describe('student register and cancel', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let logLines: string[];

  const post = async (
    url: string,
    studentId: number,
    payload: NonNullable<InjectOptions['payload']>,
    headers: NonNullable<InjectOptions['headers']> = {},
  ): Promise<InjectResponse> => {
    await takeTurnFor(pool, studentId, url);
    return await app.inject({
      method: 'POST',
      url,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      payload,
      headers,
    });
  };

  const register = async (studentId: number, clubId: number, idempotencyKey = newKey()) =>
    await post(REGISTER_URL, studentId, { clubId, idempotencyKey });

  const cancel = async (studentId: number, idempotencyKey = newKey()) =>
    await post(CANCEL_URL, studentId, { idempotencyKey });

  const heldClubs = async (studentId: number) => {
    const { rows } = await pool.query<{ club_id: number }>(
      'SELECT club_id FROM registrations WHERE student_id = $1',
      [studentId],
    );
    return rows.map(({ club_id: clubId }) => clubId);
  };

  // An open round of grade 1 with one club, and a grade-1 student.
  const openSetup = async (capacity = 30) => {
    const roundId = await createOpenRound(pool);
    const clubId = await createClub(pool, roundId, uniqueCode(), { name: CLUB_NAME, capacity });
    const studentId = await createStudentId(pool);
    return { roundId, clubId, studentId };
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

  describe('POST /api/student/registration', () => {
    it('takes a seat, logs the event and answers with the registration', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      const key = newKey();

      const response = await register(studentId, clubId, key);

      expect(response.statusCode).toBe(200);
      const { rows } = await pool.query<{ created_at: Date; club_code: string }>(
        `SELECT r.created_at, c.club_code FROM registrations r JOIN clubs c ON c.id = r.club_id
         WHERE r.student_id = $1`,
        [studentId],
      );
      expect(response.json()).toEqual({
        registration: {
          club: { id: clubId, clubCode: rows[0]!.club_code, name: CLUB_NAME },
          registeredAt: rows[0]!.created_at.toISOString(),
          promotedFromWaitlist: false,
        },
        adminChange: null,
      });
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 1, rows: 1 });
      expect(await eventsOf(pool, studentId)).toEqual([
        {
          event_type: 'register',
          round_id: roundId,
          club_id: clubId,
          actor_id: studentId,
          idempotency_key: key,
        },
      ]);
    });

    it('answers 409 club_full and leaves no registration behind', async () => {
      const { clubId, studentId } = await openSetup(1);
      await seatStudent(pool, await createStudentId(pool), clubId);

      const response = await register(studentId, clubId);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('club_full');
      expect(await heldClubs(studentId)).toEqual([]);
      expect(await eventsOf(pool, studentId)).toEqual([]);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 1, capacity: 1 });
    });

    it('answers 409 club_full for a club with no seats at all', async () => {
      const { clubId, studentId } = await openSetup(0);

      const response = await register(studentId, clubId);

      expect(errorOf(response).code).toBe('club_full');
    });

    it('answers 404 for a club of another grade, as if it did not exist', async () => {
      const otherRound = await createOpenRound(pool, 2);
      const clubId = await createClub(pool, otherRound, uniqueCode());
      await createOpenRound(pool, 1);
      const studentId = await createStudentId(pool, 1);

      const response = await register(studentId, clubId);

      expect(response.statusCode).toBe(404);
      expect(errorOf(response)).toEqual({ code: 'not_found', message: 'Club not found' });
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 0, rows: 0 });
    });

    it('answers 404 for an unknown club', async () => {
      await createOpenRound(pool);

      const response = await register(await createStudentId(pool), UNKNOWN_ID);

      expect(response.statusCode).toBe(404);
      expect(errorOf(response)).toEqual({ code: 'not_found', message: 'Club not found' });
    });

    it('answers 404 for a club of an own-grade round other than the one shown', async () => {
      const oldRound = await createClosedRound(pool);
      const oldClub = await createClub(pool, oldRound, uniqueCode());
      await createOpenRound(pool);

      const response = await register(await createStudentId(pool), oldClub);

      expect(response.statusCode).toBe(404);
      expect(await storedSeats(pool, oldClub)).toMatchObject({ registered: 0 });
    });

    it('only seats a student in the open round that closes first when two overlap', async () => {
      const later = await createRoundAt(pool, 1, { opensInSeconds: -60, closesInSeconds: 7_200 });
      const sooner = await createRoundAt(pool, 1, { opensInSeconds: -60, closesInSeconds: 3_600 });
      const laterClub = await createClub(pool, later, uniqueCode());
      const soonerClub = await createClub(pool, sooner, uniqueCode());
      const studentId = await createStudentId(pool);

      expect((await register(studentId, laterClub)).statusCode).toBe(404);
      expect((await register(studentId, soonerClub)).statusCode).toBe(200);
    });

    it('answers 409 round_not_open before the round opens', async () => {
      const roundId = await createUpcomingRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode());
      const studentId = await createStudentId(pool);

      const response = await register(studentId, clubId);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_not_open');
      expect(await heldClubs(studentId)).toEqual([]);
    });

    it('answers 409 round_not_open after the round closes', async () => {
      const roundId = await createClosedRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode());
      const studentId = await createStudentId(pool);

      const response = await register(studentId, clubId);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_not_open');
      expect(await heldClubs(studentId)).toEqual([]);
    });

    it('decides the window by the DB clock at the moment of writing', async () => {
      // Opens 1 s from now by the DB clock: refused now, accepted once the DB clock gets there.
      const roundId = await createRoundAt(pool, 1, { opensInSeconds: 1, closesInSeconds: 3_600 });
      const clubId = await createClub(pool, roundId, uniqueCode());
      const studentId = await createStudentId(pool);

      expect(errorOf(await register(studentId, clubId)).code).toBe('round_not_open');
      await pool.query('SELECT pg_sleep(1.2)');
      expect((await register(studentId, clubId)).statusCode).toBe(200);
    });

    it('answers a retry for the club already held with 200 and writes nothing', async () => {
      const { clubId, studentId } = await openSetup();
      const first = await register(studentId, clubId);

      const retry = await register(studentId, clubId);

      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(await eventsOf(pool, studentId)).toHaveLength(1);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 1 });
    });

    it('answers the club already held with 200 even after the round closed', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      await seatStudent(pool, studentId, clubId);
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      const response = await register(studentId, clubId);

      expect(response.statusCode).toBe(200);
      expect(registrationOf(response)?.club.id).toBe(clubId);
    });

    it('answers 409 already_registered for a second club and keeps the first', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      const other = await createClub(pool, roundId, uniqueCode());
      await seatStudent(pool, studentId, clubId);

      const response = await register(studentId, other);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('already_registered');
      expect(await heldClubs(studentId)).toEqual([clubId]);
      expect(await storedSeats(pool, other)).toMatchObject({ registered: 0 });
    });

    it('reports already_registered before club_full', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      const full = await createClub(pool, roundId, uniqueCode(), { capacity: 0 });
      await seatStudent(pool, studentId, clubId);

      expect(errorOf(await register(studentId, full)).code).toBe('already_registered');
    });

    it('lets a student register again after cancelling', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      const other = await createClub(pool, roundId, uniqueCode());
      await seatStudent(pool, studentId, clubId);
      expect((await cancel(studentId)).statusCode).toBe(200);

      const response = await register(studentId, other);

      expect(response.statusCode).toBe(200);
      expect(await heldClubs(studentId)).toEqual([other]);
    });

    it('waits for a round lock held by another writer', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      const holder = await pool.connect();
      let released = false;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [roundId]);

        const pending = register(studentId, clubId);
        await waitForAdvisoryLockWaiter(pool);
        expect(await heldClubs(studentId)).toEqual([]);
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
    it('replays a register sent again with its key: 200, same body, no second event', async () => {
      const { clubId, studentId } = await openSetup();
      const key = newKey();
      const first = await register(studentId, clubId, key);

      const replay = await register(studentId, clubId, key);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await eventsOf(pool, studentId)).toHaveLength(1);
    });

    it('answers a replayed register with the state now, after a later cancel', async () => {
      const { clubId, studentId } = await openSetup();
      const key = newKey();
      await register(studentId, clubId, key);
      await cancel(studentId);

      const replay = await register(studentId, clubId, key);

      // The request was carried out once, earlier; the body is the registration as it is now.
      expect(replay.statusCode).toBe(200);
      expect(registrationOf(replay)).toBeNull();
      expect(await heldClubs(studentId)).toEqual([]);
      expect(await eventsOf(pool, studentId)).toHaveLength(2);
    });

    it('replays a register after the round closed instead of answering round_not_open', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      const key = newKey();
      await register(studentId, clubId, key);
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      const replay = await register(studentId, clubId, key);

      expect(replay.statusCode).toBe(200);
      expect(registrationOf(replay)?.club.id).toBe(clubId);
    });

    it('answers 409 idempotency_key_reused for the key of a register sent for another club', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      const other = await createClub(pool, roundId, uniqueCode());
      const key = newKey();
      await register(studentId, clubId, key);

      const response = await register(studentId, other, key);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('idempotency_key_reused');
      expect(await heldClubs(studentId)).toEqual([clubId]);
    });

    it('answers 409 idempotency_key_reused for a cancel that reuses a register key', async () => {
      const { clubId, studentId } = await openSetup();
      const key = newKey();
      await register(studentId, clubId, key);

      const response = await cancel(studentId, key);

      expect(errorOf(response).code).toBe('idempotency_key_reused');
      expect(await heldClubs(studentId)).toEqual([clubId]);
    });

    it('records nothing for a refused request, so its key can be retried', async () => {
      const { clubId, studentId } = await openSetup(1);
      const holder = await createStudentId(pool);
      await seatStudent(pool, holder, clubId);
      const key = newKey();
      expect(errorOf(await register(studentId, clubId, key)).code).toBe('club_full');
      await cancel(holder);

      const retry = await register(studentId, clubId, key);

      expect(retry.statusCode).toBe(200);
      expect(await heldClubs(studentId)).toEqual([clubId]);
    });

    it('keeps keys per student: two students may send the same key', async () => {
      const { clubId, studentId } = await openSetup();
      const other = await createStudentId(pool);
      const key = newKey();

      expect((await register(studentId, clubId, key)).statusCode).toBe(200);
      expect((await register(other, clubId, key)).statusCode).toBe(200);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 2 });
    });

    it('replays a cancel sent again with its key, with the state now', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      const other = await createClub(pool, roundId, uniqueCode());
      await seatStudent(pool, studentId, clubId);
      const key = newKey();
      await cancel(studentId, key);
      await seatStudent(pool, studentId, other);

      const replay = await cancel(studentId, key);

      expect(replay.statusCode).toBe(200);
      expect(registrationOf(replay)?.club.id).toBe(other);
      expect(await heldClubs(studentId)).toEqual([other]);
    });
  });

  describe('POST /api/student/registration/cancel', () => {
    it('frees the seat, logs the event and answers registration null', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      await seatStudent(pool, studentId, clubId);
      const key = newKey();

      const response = await cancel(studentId, key);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ registration: null, adminChange: null });
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 0, rows: 0 });
      expect((await eventsOf(pool, studentId))[1]).toEqual({
        event_type: 'cancel',
        round_id: roundId,
        club_id: clubId,
        actor_id: studentId,
        idempotency_key: key,
      });
    });

    it('answers 409 not_registered without a registration', async () => {
      const { studentId } = await openSetup();

      const response = await cancel(studentId);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('not_registered');
    });

    it('answers 409 round_not_open after the round closed and keeps the seat', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      await seatStudent(pool, studentId, clubId);
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      const response = await cancel(studentId);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_not_open');
      expect(await heldClubs(studentId)).toEqual([clubId]);
    });

    it('answers 409 round_not_open before the round opens', async () => {
      await createUpcomingRound(pool);

      const response = await cancel(await createStudentId(pool));

      expect(errorOf(response).code).toBe('round_not_open');
    });

    it('answers 409 round_not_open when the grade has no round', async () => {
      await createOpenRound(pool, 2);

      const response = await cancel(await createStudentId(pool, 1));

      expect(errorOf(response).code).toBe('round_not_open');
    });

    it('cancels only in the round shown, not a seat held in an older round', async () => {
      const { roundId, clubId, studentId } = await openSetup();
      await seatStudent(pool, studentId, clubId);
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -3_600 });
      await createOpenRound(pool);

      const response = await cancel(studentId);

      expect(errorOf(response).code).toBe('not_registered');
      expect(await heldClubs(studentId)).toEqual([clubId]);
    });
  });

  it('composes in one transaction: register then cancel leaves the seat free', async () => {
    const { clubId, studentId } = await openSetup();

    const results = await withTransaction(pool, async (client) => [
      await registerForClub(client, { studentId, clubId, idempotencyKey: newKey() }, ungated),
      await cancelRegistration(client, { studentId, idempotencyKey: newKey() }),
    ]);

    expect(results.map(({ outcome }) => outcome)).toEqual(['registered', 'cancelled']);
    expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 0, rows: 0 });
  });

  it('maps the idempotency constraint by a name the schema really has', async () => {
    const { rows } = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'registration_events'::regclass AND contype = 'u'`,
    );

    expect(rows.map(({ conname }) => conname)).toContain(EVENT_KEY_UNIQUE);
  });

  it('the invariant check reports a counter that drifted from the registrations', async () => {
    const { clubId, studentId } = await openSetup();
    await seatStudent(pool, studentId, clubId);
    await pool.query('UPDATE clubs SET registered = 0 WHERE id = $1', [clubId]);

    const violations = await registrationInvariantViolations(pool);

    await pool.query('UPDATE clubs SET registered = 1 WHERE id = $1', [clubId]);
    expect(violations.join('\n')).toContain('clubs.registered equals the registrations');
  });

  describe('access control and validation', () => {
    it.each(WRITE_URLS)('requires a session for %s', async (url) => {
      const response = await app.inject({
        method: 'POST',
        url,
        payload: { clubId: 1, idempotencyKey: newKey() },
      });

      expect(response.statusCode).toBe(401);
      expect(errorOf(response).code).toBe('unauthorized');
    });

    it.each(WRITE_URLS)('forbids an admin from %s', async (url) => {
      const admin = await createTestUser(pool, { role: 'admin' });

      const response = await app.inject({
        method: 'POST',
        url,
        cookies: { [SESSION_COOKIE]: sessionCookie(app, admin.id, 'admin') },
        // Invalid on purpose: the role is checked before the body.
        payload: { unexpected: true },
      });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('forbidden');
    });

    it.each(WRITE_URLS)('keeps %s closed until the first password change', async (url) => {
      const { clubId } = await openSetup();
      const [pending] = await createStudents(pool, 1, { mustChangePassword: true });

      const response = await post(url, pending!, { clubId, idempotencyKey: newKey() });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('password_change_required');
      expect(await heldClubs(pending!)).toEqual([]);
    });

    it.each([
      ['register', REGISTER_URL],
      ['cancel', CANCEL_URL],
    ])('answers 403 student_profile_missing to %s without a profile', async (_label, url) => {
      const { clubId } = await openSetup();
      const user = await createTestUser(pool);
      const payload =
        url === REGISTER_URL ? { clubId, idempotencyKey: newKey() } : { idempotencyKey: newKey() };

      const response = await post(url, user.id, payload);

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('student_profile_missing');
    });

    it.each([
      ['a studentId', { studentId: 1 }],
      ['a roundId', { roundId: 1 }],
      ['an unknown field', { extra: 'x' }],
      ['no key', { idempotencyKey: undefined }],
      ['a short key', { idempotencyKey: 'short' }],
      ['a key with spaces', { idempotencyKey: 'not a valid key at all' }],
      ['no clubId', { clubId: undefined }],
      ['a clubId as text', { clubId: '1' }],
      ['a zero clubId', { clubId: 0 }],
      ['a fractional clubId', { clubId: 1.5 }],
      ['a clubId above the integer range', { clubId: 2_147_483_648 }],
    ])('rejects a register body with %s with 400 and writes nothing', async (_label, change) => {
      const { clubId, studentId } = await openSetup();

      const response = await post(REGISTER_URL, studentId, {
        clubId,
        idempotencyKey: newKey(),
        ...change,
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
      expect(await heldClubs(studentId)).toEqual([]);
    });

    it.each([
      ['a studentId', { studentId: 1 }],
      ['a clubId', { clubId: 1 }],
      ['no key', { idempotencyKey: undefined }],
    ])('rejects a cancel body with %s with 400 and writes nothing', async (_label, change) => {
      const { clubId, studentId } = await openSetup();
      await seatStudent(pool, studentId, clubId);

      const response = await post(CANCEL_URL, studentId, { idempotencyKey: newKey(), ...change });

      expect(response.statusCode).toBe(400);
      expect(await heldClubs(studentId)).toEqual([clubId]);
    });

    it('acts for the session student, never for a studentId sent in the body', async () => {
      const { clubId, studentId } = await openSetup();
      const victim = await createStudentId(pool);

      const response = await post(REGISTER_URL, studentId, {
        clubId,
        idempotencyKey: newKey(),
        studentId: victim,
      });

      expect(response.statusCode).toBe(400);
      expect(await heldClubs(victim)).toEqual([]);
    });

    it('accepts JSON only', async () => {
      const { clubId, studentId } = await openSetup();

      const response = await post(
        REGISTER_URL,
        studentId,
        `clubId=${clubId}&idempotencyKey=${newKey()}`,
        { 'content-type': 'application/x-www-form-urlencoded' },
      );

      expect(response.statusCode).toBe(415);
      expect(await heldClubs(studentId)).toEqual([]);
    });

    it('rate-limits each student across register and cancel', async () => {
      const { studentId } = await openSetup();
      const other = await createStudentId(pool);
      const attempts = await Promise.all(
        Array.from({ length: 30 }, async () => await cancel(studentId)),
      );
      expect(attempts.every(({ statusCode }) => statusCode === 409)).toBe(true);

      const limited = await register(studentId, UNKNOWN_ID);

      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited).code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
      // Another student keeps their own budget.
      expect((await cancel(other)).statusCode).toBe(409);
    });
  });

  it('logs ids and outcomes, never a student or club name', async () => {
    const { roundId, clubId, studentId } = await openSetup(1);
    const late = await createStudentId(pool);

    await register(studentId, clubId);
    await register(late, clubId);
    await cancel(studentId);

    const entries = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'student register',
        studentId,
        roundId,
        clubId,
        outcome: 'registered',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'student register refused',
        studentId: late,
        clubId,
        outcome: 'club_full',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ msg: 'student cancel', studentId, outcome: 'cancelled' }),
    );
    const log = logLines.join('\n');
    [STUDENT_NAME, CLUB_NAME].forEach((value) => expect(log).not.toContain(value));
  });
});
