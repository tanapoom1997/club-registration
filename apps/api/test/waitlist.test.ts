import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  errorResponseSchema,
  studentClubsResponseSchema,
  studentRegistrationResponseSchema,
  studentRoundResponseSchema,
  studentWaitlistResponseSchema,
} from '@club-registration/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool, withTransaction } from '../src/db.js';
import { joinWaitlist } from '../src/services/waitlist.js';
import { promoteWaitlist } from '../src/services/waitlist-promote.js';
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
  moveWindow,
  newKey,
  registrationInvariantViolations,
  seatStudent,
  sessionCookie,
  storedSeats,
} from './support/registration.js';

// The waitlist (README Phase 2): joining and leaving through the API, and the promote engine run
// by a cancel or a change. Every value is made up.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const WAITLIST_URL = '/api/student/waitlist';
const LEAVE_URL = '/api/student/waitlist/leave';
const REGISTRATION_URL = '/api/student/registration';
const CANCEL_URL = '/api/student/registration/cancel';
const UNKNOWN_ID = 2_000_000_000;
const CLUB_NAME = 'ชุมนุมสมมติ รอคิว';
const OTHER_NAME = 'ชุมนุมสมมติ อีกชุมนุม';

const errorOf = (response: InjectResponse) => errorResponseSchema.parse(response.json());
const waitlistOf = (response: InjectResponse) =>
  studentWaitlistResponseSchema.parse(response.json()).waitlist;
const registrationOf = (response: InjectResponse) =>
  studentRegistrationResponseSchema.parse(response.json()).registration;

type EventRow = {
  event_type: string;
  student_id: number;
  club_id: number | null;
  from_club_id: number | null;
  actor_id: number;
  idempotency_key: string | null;
};

describe('student waitlist', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let logLines: string[];

  const send = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    studentId: number,
    payload?: NonNullable<InjectOptions['payload']>,
    headers: NonNullable<InjectOptions['headers']> = {},
  ): Promise<InjectResponse> =>
    await app.inject({
      method,
      url,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      ...(payload === undefined ? {} : { payload }),
      headers,
    });

  const join = async (studentId: number, clubId: number, idempotencyKey = newKey()) =>
    await send('POST', WAITLIST_URL, studentId, { clubId, idempotencyKey });
  const leave = async (studentId: number, idempotencyKey = newKey()) =>
    await send('POST', LEAVE_URL, studentId, { idempotencyKey });
  const register = async (studentId: number, clubId: number, idempotencyKey = newKey()) =>
    await send('POST', REGISTRATION_URL, studentId, { clubId, idempotencyKey });
  const change = async (studentId: number, clubId: number, idempotencyKey = newKey()) =>
    await send('PUT', REGISTRATION_URL, studentId, { clubId, idempotencyKey });
  const cancel = async (studentId: number, idempotencyKey = newKey()) =>
    await send('POST', CANCEL_URL, studentId, { idempotencyKey });
  const readRound = async (studentId: number) =>
    studentRoundResponseSchema.parse((await send('GET', '/api/student/round', studentId)).json());
  const readClubs = async (studentId: number) =>
    studentClubsResponseSchema.parse((await send('GET', '/api/student/clubs', studentId)).json());

  const joinAll = async (studentIds: number[], clubId: number) => {
    for (const studentId of studentIds)
      expect((await join(studentId, clubId)).statusCode).toBe(200);
  };

  // The club's queue, front first.
  const queueOf = async (clubId: number) => {
    const { rows } = await pool.query<{ student_id: number }>(
      `SELECT student_id FROM waitlist_entries WHERE club_id = $1 ORDER BY created_at, id`,
      [clubId],
    );
    return rows.map(({ student_id: studentId }) => studentId);
  };

  const heldClubs = async (studentId: number) => {
    const { rows } = await pool.query<{ club_id: number }>(
      'SELECT club_id FROM registrations WHERE student_id = $1',
      [studentId],
    );
    return rows.map(({ club_id: clubId }) => clubId);
  };

  const eventsOfType = async (eventType: string) => {
    const { rows } = await pool.query<EventRow>(
      `SELECT event_type, student_id, club_id, from_club_id, actor_id, idempotency_key
       FROM registration_events WHERE event_type = $1 ORDER BY id`,
      [eventType],
    );
    return rows;
  };

  const clubCodeOf = async (clubId: number) => {
    const { rows } = await pool.query<{ club_code: string }>(
      'SELECT club_code FROM clubs WHERE id = $1',
      [clubId],
    );
    return rows[0]!.club_code;
  };

  // An open round (grade 1 unless given) with a club whose seats are all taken by other students.
  const fullClub = async ({
    capacity = 1,
    roundId,
    grade = 1,
  }: { capacity?: number; roundId?: number; grade?: number } = {}) => {
    const round = roundId ?? (await createOpenRound(pool, grade));
    const clubId = await createClub(pool, round, uniqueCode(), { name: CLUB_NAME, capacity });
    const holders = await createStudents(pool, capacity, { grade });
    for (const holder of holders) await seatStudent(pool, holder, clubId);
    return { roundId: round, clubId, holders };
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

  describe('POST /api/student/waitlist', () => {
    it('puts the student on the queue of a full club, logs one event and answers with the place', async () => {
      const { roundId, clubId } = await fullClub();
      const studentId = await createStudentId(pool);
      const key = newKey();

      const response = await join(studentId, clubId, key);

      expect(response.statusCode).toBe(200);
      const { rows } = await pool.query<{ created_at: Date }>(
        'SELECT created_at FROM waitlist_entries WHERE student_id = $1',
        [studentId],
      );
      expect(response.json()).toEqual({
        waitlist: {
          club: { id: clubId, clubCode: await clubCodeOf(clubId), name: CLUB_NAME },
          position: 1,
          joinedAt: rows[0]!.created_at.toISOString(),
        },
      });
      expect(await eventsOfType('waitlist_join')).toEqual([
        {
          event_type: 'waitlist_join',
          student_id: studentId,
          club_id: clubId,
          from_club_id: null,
          actor_id: studentId,
          idempotency_key: key,
        },
      ]);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 1, capacity: 1 });
      const { rows: roundRows } = await pool.query<{ round_id: number }>(
        'SELECT round_id FROM waitlist_entries WHERE student_id = $1',
        [studentId],
      );
      expect(roundRows).toEqual([{ round_id: roundId }]);
    });

    it('queues students in the order they joined', async () => {
      const { clubId } = await fullClub();
      const students = await createStudents(pool, 3);

      const positions = [];
      for (const studentId of students) {
        positions.push(waitlistOf(await join(studentId, clubId))?.position);
      }

      expect(positions).toEqual([1, 2, 3]);
      expect(await queueOf(clubId)).toEqual(students);
    });

    it('lets a student who holds another club join, and keeps their seat meanwhile', async () => {
      const { roundId, clubId } = await fullClub();
      const otherClub = await createClub(pool, roundId, uniqueCode());
      const studentId = await createStudentId(pool);
      await seatStudent(pool, studentId, otherClub);

      const response = await join(studentId, clubId);

      expect(response.statusCode).toBe(200);
      expect(await heldClubs(studentId)).toEqual([otherClub]);
      expect(await queueOf(clubId)).toEqual([studentId]);
    });

    it('answers a join of the club already waited for with 200 and writes nothing', async () => {
      const { clubId } = await fullClub();
      const [first, studentId] = await createStudents(pool, 2);
      await join(first!, clubId);
      const firstAnswer = waitlistOf(await join(studentId!, clubId));

      const again = await join(studentId!, clubId);

      expect(again.statusCode).toBe(200);
      expect(waitlistOf(again)).toEqual(firstAnswer);
      expect(await eventsOfType('waitlist_join')).toHaveLength(2);
    });

    it('answers the club already waited for with 200 even after the round closed', async () => {
      const { roundId, clubId } = await fullClub();
      const studentId = await createStudentId(pool);
      await join(studentId, clubId);
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      const response = await join(studentId, clubId);

      expect(response.statusCode).toBe(200);
      expect(waitlistOf(response)).toMatchObject({ club: { id: clubId }, position: 1 });
    });

    it('moves a student to the back of another queue, giving up the old place, in one event', async () => {
      const { roundId, clubId } = await fullClub();
      const { clubId: otherClub } = await fullClub({ roundId });
      const [mover, behind, ahead] = await createStudents(pool, 3);
      await join(mover!, clubId);
      await join(behind!, clubId);
      await join(ahead!, otherClub);
      const key = newKey();

      const response = await join(mover!, otherClub, key);

      expect(waitlistOf(response)).toMatchObject({ club: { id: otherClub }, position: 2 });
      expect(await queueOf(clubId)).toEqual([behind]);
      expect(await queueOf(otherClub)).toEqual([ahead, mover]);
      const moves = (await eventsOfType('waitlist_join')).filter(
        ({ student_id: studentId }) => studentId === mover,
      );
      expect(moves).toEqual([
        expect.objectContaining({ club_id: clubId, from_club_id: null }),
        expect.objectContaining({ club_id: otherClub, from_club_id: clubId, idempotency_key: key }),
      ]);
    });

    it('sends a student who comes back to a queue they gave up to its back', async () => {
      const { roundId, clubId } = await fullClub();
      const { clubId: otherClub } = await fullClub({ roundId });
      const [studentId, other] = await createStudents(pool, 2);
      await join(studentId!, clubId);
      await join(other!, clubId);
      await join(studentId!, otherClub);

      const back = await join(studentId!, clubId);

      expect(waitlistOf(back)?.position).toBe(2);
      expect(await queueOf(clubId)).toEqual([other, studentId]);
    });

    it('answers 409 round_not_open after the round closed', async () => {
      const { roundId, clubId } = await fullClub();
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });
      const studentId = await createStudentId(pool);

      const response = await join(studentId, clubId);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_not_open');
      expect(await queueOf(clubId)).toEqual([]);
    });

    it('answers 409 round_not_open before the round opens, ahead of waitlist_not_needed', async () => {
      const roundId = await createUpcomingRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode());

      const response = await join(await createStudentId(pool), clubId);

      expect(errorOf(response).code).toBe('round_not_open');
    });

    it('answers 409 round_not_open to a closed round ahead of already_in_club', async () => {
      const { roundId, clubId, holders } = await fullClub();
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      expect(errorOf(await join(holders[0]!, clubId)).code).toBe('round_not_open');
    });

    it('keeps the old entry when moving to another queue fails because the round closed', async () => {
      const { roundId, clubId } = await fullClub();
      const { clubId: otherClub } = await fullClub({ roundId });
      const studentId = await createStudentId(pool);
      await join(studentId, clubId);
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      expect(errorOf(await join(studentId, otherClub)).code).toBe('round_not_open');
      expect(await queueOf(clubId)).toEqual([studentId]);
    });

    it('answers 409 already_in_club to a student who holds the club, ahead of waitlist_not_needed', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode());
      const studentId = await createStudentId(pool);
      await seatStudent(pool, studentId, clubId);

      const response = await join(studentId, clubId);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('already_in_club');
      expect(await queueOf(clubId)).toEqual([]);
    });

    it('answers 409 waitlist_not_needed for a club with a free seat', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode());
      const studentId = await createStudentId(pool);

      const response = await join(studentId, clubId);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('waitlist_not_needed');
      expect(await queueOf(clubId)).toEqual([]);
      expect(await eventsOfType('waitlist_join')).toEqual([]);
    });

    it('lets a student join a club with a free seat that others already wait for', async () => {
      const { roundId, clubId } = await fullClub({ capacity: 2 });
      const [waiting, studentId] = await createStudents(pool, 2);
      // A free seat with a queue: what an admin raising the capacity leaves until it promotes.
      await pool.query('UPDATE clubs SET capacity = 3 WHERE id = $1', [clubId]);
      await addWaitingDirectly(pool, { roundId, clubId, studentId: waiting! });

      const response = await join(studentId!, clubId);

      expect(waitlistOf(response)?.position).toBe(2);
      expect((await leave(waiting!)).statusCode).toBe(200);
      expect((await leave(studentId!)).statusCode).toBe(200);
    });

    it('answers 404 for an unknown club', async () => {
      const response = await join(await createStudentId(pool), UNKNOWN_ID);

      expect(response.statusCode).toBe(404);
      expect(errorOf(response)).toEqual({ code: 'not_found', message: 'Club not found' });
    });

    it('answers 404 for a club of another grade, as if it did not exist', async () => {
      const { clubId } = await fullClub({ grade: 2 });

      const response = await join(await createStudentId(pool), clubId);

      expect(response.statusCode).toBe(404);
      expect(errorOf(response)).toEqual({ code: 'not_found', message: 'Club not found' });
    });

    it('answers 404 for a club of an own-grade round other than the one shown', async () => {
      const oldRound = await createClosedRound(pool, 1, 7_200);
      const oldClub = await createClub(pool, oldRound, uniqueCode(), { capacity: 0 });
      await createOpenRound(pool);

      const response = await join(await createStudentId(pool), oldClub);

      expect(response.statusCode).toBe(404);
      expect(await queueOf(oldClub)).toEqual([]);
    });

    // clock_timestamp() after the lock, not now(): a transaction that began earlier but took the
    // lock later queues behind the one that took it first.
    it('queues by the moment the round lock was taken, not when the transaction began', async () => {
      const { clubId } = await fullClub();
      const [early, late] = await createStudents(pool, 2);
      const client = await pool.connect();
      let committed = false;
      try {
        await client.query('BEGIN');
        await client.query('SELECT now()');
        expect((await join(late!, clubId)).statusCode).toBe(200);

        const result = await joinWaitlist(client, {
          studentId: early!,
          clubId,
          idempotencyKey: newKey(),
        });
        await client.query('COMMIT');
        committed = true;

        expect(result.waitlist?.position).toBe(2);
      } finally {
        if (!committed) await client.query('ROLLBACK');
        client.release();
      }
      expect(await queueOf(clubId)).toEqual([late, early]);
    });
  });

  describe('POST /api/student/waitlist/leave', () => {
    it('removes the entry, logs one event and moves everyone behind up', async () => {
      const { clubId } = await fullClub();
      const [studentId, behind] = await createStudents(pool, 2);
      await joinAll([studentId!, behind!], clubId);
      const key = newKey();

      const response = await leave(studentId!, key);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ waitlist: null });
      expect(await queueOf(clubId)).toEqual([behind]);
      expect((await readRound(behind!)).waitlist?.position).toBe(1);
      expect(await eventsOfType('waitlist_leave')).toEqual([
        {
          event_type: 'waitlist_leave',
          student_id: studentId,
          club_id: clubId,
          from_club_id: null,
          actor_id: studentId,
          idempotency_key: key,
        },
      ]);
    });

    it('answers 409 not_waitlisted to a student with no entry', async () => {
      await fullClub();

      const response = await leave(await createStudentId(pool));

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('not_waitlisted');
      expect(await eventsOfType('waitlist_leave')).toEqual([]);
    });

    it('answers 409 round_not_open after the round closed and keeps the entry', async () => {
      const { roundId, clubId } = await fullClub();
      const studentId = await createStudentId(pool);
      await join(studentId, clubId);
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      const response = await leave(studentId);

      expect(errorOf(response).code).toBe('round_not_open');
      expect(await queueOf(clubId)).toEqual([studentId]);
    });

    it('answers 409 round_not_open when the grade has no round at all', async () => {
      const response = await leave(await createStudentId(pool, 6));

      expect(errorOf(response).code).toBe('round_not_open');
    });

    it('answers 403 student_profile_missing without a profile', async () => {
      const user = await createTestUser(pool);

      const response = await leave(user.id);

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('student_profile_missing');
    });
  });

  describe('idempotency', () => {
    it('replays a join sent again with its key: 200, same body, no second event', async () => {
      const { clubId } = await fullClub();
      const studentId = await createStudentId(pool);
      const key = newKey();
      const first = await join(studentId, clubId, key);

      const replay = await join(studentId, clubId, key);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await eventsOfType('waitlist_join')).toHaveLength(1);
    });

    it('answers a replayed join with the entry now, after the student left', async () => {
      const { clubId } = await fullClub();
      const studentId = await createStudentId(pool);
      const key = newKey();
      await join(studentId, clubId, key);
      await leave(studentId);

      const replay = await join(studentId, clubId, key);

      expect(replay.statusCode).toBe(200);
      expect(waitlistOf(replay)).toBeNull();
      expect(await queueOf(clubId)).toEqual([]);
    });

    it('replays a leave sent again with its key, even after the round closed', async () => {
      const { roundId, clubId } = await fullClub();
      const studentId = await createStudentId(pool);
      await join(studentId, clubId);
      const key = newKey();
      await leave(studentId, key);
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });

      const replay = await leave(studentId, key);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ waitlist: null });
      expect(await eventsOfType('waitlist_leave')).toHaveLength(1);
    });

    it('answers 409 idempotency_key_reused for the key of a join sent for another club', async () => {
      const { roundId, clubId } = await fullClub();
      const { clubId: otherClub } = await fullClub({ roundId });
      const studentId = await createStudentId(pool);
      const key = newKey();
      await join(studentId, clubId, key);

      const response = await join(studentId, otherClub, key);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('idempotency_key_reused');
      expect(await queueOf(clubId)).toEqual([studentId]);
    });

    it.each([
      ['a register', 'register'],
      ['a change', 'change'],
      ['a cancel', 'cancel'],
      ['a leave', 'leave'],
    ] as const)(
      'answers 409 idempotency_key_reused to %s that reuses a join key',
      async (_l, action) => {
        const { roundId, clubId } = await fullClub();
        const freeClub = await createClub(pool, roundId, uniqueCode());
        const studentId = await createStudentId(pool);
        const key = newKey();
        await join(studentId, clubId, key);

        const requests = {
          register: async () => await register(studentId, freeClub, key),
          change: async () => await change(studentId, freeClub, key),
          cancel: async () => await cancel(studentId, key),
          leave: async () => await leave(studentId, key),
        };
        const response = await requests[action]();

        expect(errorOf(response).code).toBe('idempotency_key_reused');
        expect(await queueOf(clubId)).toEqual([studentId]);
      },
    );

    it.each([
      ['a register', 'register'],
      ['a leave', 'leave'],
    ] as const)(
      'answers 409 idempotency_key_reused to a join that reuses %s key',
      async (_l, action) => {
        const { roundId, clubId } = await fullClub();
        const studentId = await createStudentId(pool);
        const key = newKey();
        if (action === 'register') {
          await register(studentId, await createClub(pool, roundId, uniqueCode()), key);
        } else {
          await join(studentId, clubId);
          await leave(studentId, key);
        }

        const response = await join(studentId, clubId, key);

        expect(errorOf(response).code).toBe('idempotency_key_reused');
        expect(await queueOf(clubId)).toEqual([]);
      },
    );

    it('records nothing for a refused join, so its key can be retried', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode(), {
        name: CLUB_NAME,
        capacity: 1,
      });
      const studentId = await createStudentId(pool);
      const key = newKey();
      expect(errorOf(await join(studentId, clubId, key)).code).toBe('waitlist_not_needed');
      await seatStudent(pool, await createStudentId(pool), clubId);

      const retry = await join(studentId, clubId, key);

      expect(retry.statusCode).toBe(200);
      expect(await queueOf(clubId)).toEqual([studentId]);
    });
  });

  describe('promotion', () => {
    it('gives a freed seat to the oldest waiter, logged as the canceller with no key', async () => {
      const { roundId, clubId, holders } = await fullClub();
      const [first, second] = await createStudents(pool, 2);
      await joinAll([first!, second!], clubId);
      const canceller = holders[0]!;

      const response = await cancel(canceller);

      expect(registrationOf(response)).toBeNull();
      expect(await heldClubs(first!)).toEqual([clubId]);
      expect(await queueOf(clubId)).toEqual([second]);
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 1, capacity: 1, rows: 1 });
      expect(await eventsOfType('waitlist_promote')).toEqual([
        {
          event_type: 'waitlist_promote',
          student_id: first,
          club_id: clubId,
          from_club_id: null,
          actor_id: canceller,
          idempotency_key: null,
        },
      ]);
      const { rows } = await pool.query<{ round_id: number }>(
        `SELECT round_id FROM registration_events WHERE event_type = 'waitlist_promote'`,
      );
      expect(rows).toEqual([{ round_id: roundId }]);
    });

    it('moves a waiter who holds another club atomically and frees that seat', async () => {
      const { roundId, clubId, holders } = await fullClub();
      const otherClub = await createClub(pool, roundId, uniqueCode(), { capacity: 5 });
      const studentId = await createStudentId(pool);
      await seatStudent(pool, studentId, otherClub);
      await join(studentId, clubId);

      await cancel(holders[0]!);

      expect(await heldClubs(studentId)).toEqual([clubId]);
      expect(await storedSeats(pool, otherClub)).toMatchObject({ registered: 0, rows: 0 });
      expect(await eventsOfType('waitlist_promote')).toEqual([
        expect.objectContaining({
          student_id: studentId,
          club_id: clubId,
          from_club_id: otherClub,
        }),
      ]);
    });

    // README Phase 2 required test 3.
    it('cascades: B frees, its oldest waiter moves over from C, and C goes to its own waiter', async () => {
      const { roundId, clubId: clubB, holders } = await fullClub();
      const { clubId: clubC, holders: cHolders } = await fullClub({ roundId });
      const fromC = cHolders[0]!;
      const waitingForC = await createStudentId(pool);
      await join(fromC, clubB);
      await join(waitingForC, clubC);
      const canceller = holders[0]!;

      await cancel(canceller);

      expect(await eventsOfType('waitlist_promote')).toEqual([
        {
          event_type: 'waitlist_promote',
          student_id: fromC,
          club_id: clubB,
          from_club_id: clubC,
          actor_id: canceller,
          idempotency_key: null,
        },
        {
          event_type: 'waitlist_promote',
          student_id: waitingForC,
          club_id: clubC,
          from_club_id: null,
          actor_id: canceller,
          idempotency_key: null,
        },
      ]);
      expect(await heldClubs(fromC)).toEqual([clubB]);
      expect(await heldClubs(waitingForC)).toEqual([clubC]);
      expect(await storedSeats(pool, clubB)).toEqual({ registered: 1, capacity: 1, rows: 1 });
      expect(await storedSeats(pool, clubC)).toEqual({ registered: 1, capacity: 1, rows: 1 });
      expect(await queueOf(clubB)).toEqual([]);
      expect(await queueOf(clubC)).toEqual([]);
    });

    it('promotes the waiters of the club a student changed out of', async () => {
      const { roundId, clubId, holders } = await fullClub();
      const freeClub = await createClub(pool, roundId, uniqueCode());
      const waiting = await createStudentId(pool);
      await join(waiting, clubId);
      const mover = holders[0]!;

      const response = await change(mover, freeClub);

      expect(registrationOf(response)).toMatchObject({
        club: { id: freeClub },
        promotedFromWaitlist: false,
      });
      expect(await heldClubs(waiting)).toEqual([clubId]);
      expect(await eventsOfType('waitlist_promote')).toEqual([
        expect.objectContaining({ student_id: waiting, actor_id: mover, idempotency_key: null }),
      ]);
    });

    it('answers a cancel with the club its own cascade gave the canceller', async () => {
      const roundId = await createOpenRound(pool);
      const [clubY, clubW] = await Promise.all([
        createClub(pool, roundId, uniqueCode(), { capacity: 1 }),
        createClub(pool, roundId, uniqueCode(), { name: OTHER_NAME, capacity: 1 }),
      ]);
      const [actor, partner] = await createStudents(pool, 2);
      await seatStudent(pool, actor!, clubY);
      await seatStudent(pool, partner!, clubW);
      await join(actor!, clubW);
      await join(partner!, clubY);

      const response = await cancel(actor!);

      expect(response.statusCode).toBe(200);
      expect(registrationOf(response)).toMatchObject({
        club: { id: clubW, name: OTHER_NAME },
        promotedFromWaitlist: true,
      });
      expect(await heldClubs(partner!)).toEqual([clubY]);
      expect(await heldClubs(actor!)).toEqual([clubW]);
    });

    it('answers a change with the club its own cascade gave the student', async () => {
      const roundId = await createOpenRound(pool);
      const [clubY, clubW, clubZ] = await Promise.all([
        createClub(pool, roundId, uniqueCode(), { capacity: 1 }),
        createClub(pool, roundId, uniqueCode(), { capacity: 1 }),
        createClub(pool, roundId, uniqueCode(), { capacity: 1 }),
      ]);
      const [actor, partner] = await createStudents(pool, 2);
      await seatStudent(pool, actor!, clubY);
      await seatStudent(pool, partner!, clubW);
      await join(actor!, clubW);
      await join(partner!, clubY);

      const response = await change(actor!, clubZ);

      expect(registrationOf(response)).toMatchObject({
        club: { id: clubW },
        promotedFromWaitlist: true,
      });
      expect(await storedSeats(pool, clubZ)).toMatchObject({ registered: 0, rows: 0 });
      expect(await eventsOfType('waitlist_promote')).toEqual([
        expect.objectContaining({ student_id: partner, club_id: clubY, from_club_id: clubW }),
        expect.objectContaining({ student_id: actor, club_id: clubW, from_club_id: clubZ }),
      ]);
    });

    it("ends a cycle of two holders each waiting for the other's club", async () => {
      const roundId = await createOpenRound(pool);
      const [clubX, clubY] = await Promise.all([
        createClub(pool, roundId, uniqueCode(), { capacity: 2 }),
        createClub(pool, roundId, uniqueCode(), { capacity: 1 }),
      ]);
      const [inX, inY, canceller] = await createStudents(pool, 3);
      await seatStudent(pool, inX!, clubX);
      await seatStudent(pool, canceller!, clubX);
      await seatStudent(pool, inY!, clubY);
      await join(inX!, clubY);
      await join(inY!, clubX);

      await cancel(canceller!);

      expect(await heldClubs(inY!)).toEqual([clubX]);
      expect(await heldClubs(inX!)).toEqual([clubY]);
      expect(await storedSeats(pool, clubX)).toEqual({ registered: 1, capacity: 2, rows: 1 });
      expect(await storedSeats(pool, clubY)).toEqual({ registered: 1, capacity: 1, rows: 1 });
      expect(await eventsOfType('waitlist_promote')).toHaveLength(2);
    });

    it('moves the rest of the queue up when the head is promoted', async () => {
      const { clubId, holders } = await fullClub();
      const waiters = await createStudents(pool, 3);
      await joinAll(waiters, clubId);

      await cancel(holders[0]!);

      const positions = await Promise.all(
        waiters.map(async (studentId) => (await readRound(studentId)).waitlist?.position),
      );
      expect(positions).toEqual([undefined, 1, 2]);
    });

    it('promotes nobody once the round has closed', async () => {
      const { roundId, clubId, holders } = await fullClub();
      const waiting = await createStudentId(pool);
      await join(waiting, clubId);
      await moveWindow(pool, roundId, { opensInSeconds: -7_200, closesInSeconds: -60 });
      await pool.query('UPDATE clubs SET capacity = 2 WHERE id = $1', [clubId]);

      const promotions = await withTransaction(
        pool,
        async (client) => await promoteWaitlist(client, { roundId, actorId: holders[0]! }),
      );

      expect(promotions).toEqual([]);
      expect(await queueOf(clubId)).toEqual([waiting]);
      expect(await heldClubs(waiting)).toEqual([]);
    });

    it('promotes into a club that has room by the same engine while the round is open', async () => {
      const { roundId, clubId, holders } = await fullClub();
      const waiting = await createStudentId(pool);
      await join(waiting, clubId);
      await pool.query('UPDATE clubs SET capacity = 2 WHERE id = $1', [clubId]);

      const promotions = await withTransaction(
        pool,
        async (client) => await promoteWaitlist(client, { roundId, actorId: holders[0]! }),
      );

      expect(promotions).toEqual([{ studentId: waiting, clubId, fromClubId: null }]);
      expect(await heldClubs(waiting)).toEqual([clubId]);
    });

    it('promotes across clubs in the order the waiters joined', async () => {
      const { roundId, clubId: clubX, holders } = await fullClub();
      const { clubId: clubY } = await fullClub({ roundId });
      const [first, second] = await createStudents(pool, 2);
      await join(first!, clubY);
      await join(second!, clubX);
      await pool.query('UPDATE clubs SET capacity = 2 WHERE id = ANY($1)', [[clubX, clubY]]);

      const promotions = await withTransaction(
        pool,
        async (client) => await promoteWaitlist(client, { roundId, actorId: holders[0]! }),
      );

      expect(promotions).toEqual([
        { studentId: first, clubId: clubY, fromClubId: null },
        { studentId: second, clubId: clubX, fromClubId: null },
      ]);
    });

    it('does not promote on a refused cancel', async () => {
      const { clubId } = await fullClub();
      const waiting = await createStudentId(pool);
      await join(waiting, clubId);

      expect(errorOf(await cancel(await createStudentId(pool))).code).toBe('not_registered');
      expect(await queueOf(clubId)).toEqual([waiting]);
    });
  });

  describe('no jumping the queue', () => {
    it('answers 409 club_full to a register for a club with a free seat and a waitlist', async () => {
      const { roundId, clubId } = await fullClub();
      await pool.query('UPDATE clubs SET capacity = 2 WHERE id = $1', [clubId]);
      const waiting = await createStudentId(pool);
      await addWaitingDirectly(pool, { roundId, clubId, studentId: waiting });
      const studentId = await createStudentId(pool);

      const response = await register(studentId, clubId);

      expect(errorOf(response).code).toBe('club_full');
      expect(await heldClubs(studentId)).toEqual([]);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 1, capacity: 2 });
      expect((await leave(waiting)).statusCode).toBe(200);
    });

    it('answers 409 club_full to a change into a club with a free seat and a waitlist', async () => {
      const { roundId, clubId } = await fullClub();
      await pool.query('UPDATE clubs SET capacity = 2 WHERE id = $1', [clubId]);
      const fromClub = await createClub(pool, roundId, uniqueCode());
      const [waiting, studentId] = await createStudents(pool, 2);
      await addWaitingDirectly(pool, { roundId, clubId, studentId: waiting! });
      await seatStudent(pool, studentId!, fromClub);

      const response = await change(studentId!, clubId);

      expect(errorOf(response).code).toBe('club_full');
      expect(await heldClubs(studentId!)).toEqual([fromClub]);
      expect((await leave(waiting!)).statusCode).toBe(200);
    });
  });

  describe('reads', () => {
    it("shows the student's entry with its place in GET /api/student/round and /clubs", async () => {
      const { clubId } = await fullClub();
      const [ahead, studentId] = await createStudents(pool, 2);
      await join(ahead!, clubId);
      const joined = waitlistOf(await join(studentId!, clubId));

      const round = await readRound(studentId!);
      const clubs = await readClubs(studentId!);

      expect(round.waitlist).toEqual(joined);
      expect(round.waitlist).toMatchObject({ club: { id: clubId, name: CLUB_NAME }, position: 2 });
      expect(clubs.waitlist).toEqual(joined);
    });

    it('counts the queue of every club, without saying who is on it', async () => {
      const { roundId, clubId } = await fullClub();
      const freeClub = await createClub(pool, roundId, uniqueCode());
      await joinAll(await createStudents(pool, 3), clubId);

      const { clubs, waitlist } = await readClubs(await createStudentId(pool));

      expect(waitlist).toBeNull();
      expect(clubs.map(({ id, waitlistCount }) => ({ id, waitlistCount }))).toEqual(
        expect.arrayContaining([
          { id: clubId, waitlistCount: 3 },
          { id: freeClub, waitlistCount: 0 },
        ]),
      );
    });

    it('marks a seat obtained by promotion until the student moves it themselves', async () => {
      const { roundId, clubId, holders } = await fullClub();
      const freeClub = await createClub(pool, roundId, uniqueCode());
      const studentId = await createStudentId(pool);
      await join(studentId, clubId);
      await cancel(holders[0]!);

      const promoted = await readRound(studentId);
      const changed = registrationOf(await change(studentId, freeClub));

      expect(promoted.registration).toMatchObject({
        club: { id: clubId },
        promotedFromWaitlist: true,
      });
      expect(promoted.waitlist).toBeNull();
      expect(changed).toMatchObject({ club: { id: freeClub }, promotedFromWaitlist: false });
      expect((await readRound(studentId)).registration?.promotedFromWaitlist).toBe(false);
    });

    it('keeps the promotion mark through a later waitlist join', async () => {
      const { roundId, clubId, holders } = await fullClub();
      const { clubId: otherFull } = await fullClub({ roundId });
      const studentId = await createStudentId(pool);
      await join(studentId, clubId);
      await cancel(holders[0]!);

      await join(studentId, otherFull);

      expect((await readRound(studentId)).registration?.promotedFromWaitlist).toBe(true);
    });
  });

  describe('access control and validation', () => {
    it.each([WAITLIST_URL, LEAVE_URL])('%s requires a session', async (url) => {
      const response = await app.inject({
        method: 'POST',
        url,
        payload: { clubId: 1, idempotencyKey: newKey() },
      });

      expect(response.statusCode).toBe(401);
      expect(errorOf(response).code).toBe('unauthorized');
    });

    it.each([WAITLIST_URL, LEAVE_URL])('%s forbids an admin', async (url) => {
      const admin = await createTestUser(pool, { role: 'admin' });

      const response = await app.inject({
        method: 'POST',
        url,
        cookies: { [SESSION_COOKIE]: sessionCookie(app, admin.id, 'admin') },
        payload: { unexpected: true },
      });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('forbidden');
    });

    it('stays closed until the first password change', async () => {
      const { clubId } = await fullClub();
      const [pending] = await createStudents(pool, 1, { mustChangePassword: true });

      const response = await join(pending!, clubId);

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('password_change_required');
    });

    it('answers 403 student_profile_missing to a join without a profile', async () => {
      const { clubId } = await fullClub();
      const user = await createTestUser(pool);

      const response = await join(user.id, clubId);

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('student_profile_missing');
    });

    it.each([
      ['a studentId', { studentId: 1 }],
      ['a roundId', { roundId: 1 }],
      ['no key', { idempotencyKey: undefined }],
      ['no clubId', { clubId: undefined }],
      ['a clubId as text', { clubId: '1' }],
    ])('rejects a join with %s with 400 and writes nothing', async (_label, body) => {
      const { clubId } = await fullClub();
      const studentId = await createStudentId(pool);

      const response = await send('POST', WAITLIST_URL, studentId, {
        clubId,
        idempotencyKey: newKey(),
        ...body,
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
      expect(await queueOf(clubId)).toEqual([]);
    });

    it.each([
      ['a clubId', { clubId: 1 }],
      ['a studentId', { studentId: 1 }],
      ['no key', { idempotencyKey: undefined }],
    ])('rejects a leave with %s with 400', async (_label, body) => {
      const { clubId } = await fullClub();
      const studentId = await createStudentId(pool);
      await join(studentId, clubId);

      const response = await send('POST', LEAVE_URL, studentId, {
        idempotencyKey: newKey(),
        ...body,
      });

      expect(response.statusCode).toBe(400);
      expect(await queueOf(clubId)).toEqual([studentId]);
    });

    it.each([WAITLIST_URL, LEAVE_URL])('%s accepts JSON only', async (url) => {
      const { clubId } = await fullClub();
      const studentId = await createStudentId(pool);

      const response = await send(
        'POST',
        url,
        studentId,
        `clubId=${clubId}&idempotencyKey=${newKey()}`,
        { 'content-type': 'application/x-www-form-urlencoded' },
      );

      expect(response.statusCode).toBe(415);
      expect(await queueOf(clubId)).toEqual([]);
    });

    it('shares the rate limit with register, change and cancel', async () => {
      const { clubId } = await fullClub();
      const studentId = await createStudentId(pool);
      const attempts = await Promise.all(
        Array.from({ length: 30 }, async () => await register(studentId, UNKNOWN_ID)),
      );
      expect(attempts.every(({ statusCode }) => statusCode === 404)).toBe(true);

      const limited = await join(studentId, clubId);
      const limitedLeave = await leave(studentId);

      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited).code).toBe('rate_limited');
      expect(limitedLeave.statusCode).toBe(429);
      expect(await queueOf(clubId)).toEqual([]);
    });
  });

  it('logs ids and outcomes, never a student or club name', async () => {
    const { roundId, clubId, holders } = await fullClub();
    const { clubId: otherClub } = await fullClub({ roundId });
    const [studentId, refused] = await createStudents(pool, 2);
    await join(studentId!, clubId);
    await join(studentId!, otherClub);
    await join(studentId!, otherClub);
    await leave(refused!);
    await join(refused!, clubId);
    await cancel(holders[0]!);
    await leave(studentId!);

    const entries = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'student waitlist join',
        studentId,
        roundId,
        clubId: otherClub,
        fromClubId: clubId,
        outcome: 'waitlisted',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ msg: 'student waitlist join', outcome: 'already_waiting' }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'student waitlist leave refused',
        studentId: refused,
        outcome: 'not_waitlisted',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'student cancel',
        studentId: holders[0],
        outcome: 'cancelled',
        promoted: 1,
        promotions: [{ studentId: refused, clubId, fromClubId: null }],
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'student waitlist leave',
        studentId,
        clubId: otherClub,
        outcome: 'left_waitlist',
      }),
    );
    const log = logLines.join('\n');
    [STUDENT_NAME, CLUB_NAME].forEach((value) => expect(log).not.toContain(value));
  });
});
