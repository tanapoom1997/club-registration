import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  clubMembersResponseSchema,
  clubMemberWriteResponseSchema,
  errorResponseSchema,
} from '@club-registration/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { DEFAULT_POOL_SETTINGS, createPool } from '../src/db.js';
import { TEST_JWT_SECRET } from './support/app.js';
import { createClub, createStudent, uniqueCode } from './support/import-db.js';
import { waitForLockWaiter } from './support/lock-waiter.js';
import {
  appConnectionUri,
  startMigratedPostgres,
  stopPostgres,
  truncateAsOwner,
} from './support/postgres.js';
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
  registrationInvariantViolations,
  seatStudent,
  sessionCookie,
  storedSeats,
} from './support/registration.js';
import { takeTurnFor } from './support/queue.js';

// An admin listing a club's members and seating, moving or removing students in their place
// (README Phase 2, PR 3a), through the whole app against a real Postgres. Every value is made up.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const CLUB_NAME = 'ชุมนุมสมมติ แก้รายชื่อ';
const ADVISOR_PHONE = '080-000-0099';
const ADVISOR_EMAIL = 'fictional.advisor@example.com';
const UNKNOWN_ID = 2_000_000_000;
const HOUR = 3_600;

type EventRow = {
  event_type: string;
  student_id: number;
  club_id: number | null;
  from_club_id: number | null;
  actor_id: number;
  idempotency_key: string | null;
};

const codeOf = (response: InjectResponse) =>
  response.statusCode === 200 ? 'ok' : errorResponseSchema.parse(response.json()).code;
const writeOf = (response: InjectResponse) => clubMemberWriteResponseSchema.parse(response.json());
const listOf = (response: InjectResponse) => clubMembersResponseSchema.parse(response.json());

const countBy = (responses: InjectResponse[]) =>
  responses.reduce<Record<string, number>>((counts, response) => {
    const code = codeOf(response);
    return { ...counts, [code]: (counts[code] ?? 0) + 1 };
  }, {});

describe('admin club members', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminId: number;
  let logLines: string[];

  const asAdmin = async (options: InjectOptions, actorId = adminId) =>
    await app.inject({
      ...options,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, actorId, 'admin') },
    });

  const membersUrl = (clubId: number) => `/api/admin/clubs/${clubId}/members`;
  const listMembers = async (clubId: number) =>
    await asAdmin({ method: 'GET', url: membersUrl(clubId) });
  const assign = async (clubId: number, loginId: string, idempotencyKey = newKey()) =>
    await asAdmin({
      method: 'POST',
      url: membersUrl(clubId),
      payload: { loginId, idempotencyKey },
    });
  const remove = async (clubId: number, loginId: string, idempotencyKey = newKey()) =>
    await asAdmin({
      method: 'POST',
      url: `${membersUrl(clubId)}/remove`,
      payload: { loginId, idempotencyKey },
    });

  const asStudent = async (studentId: number, url: string, payload: Record<string, unknown>) => {
    await takeTurnFor(pool, studentId, url);
    return await app.inject({
      method: 'POST',
      url,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      payload,
    });
  };
  const register = async (studentId: number, clubId: number) =>
    await asStudent(studentId, '/api/student/registration', { clubId, idempotencyKey: newKey() });
  const cancel = async (studentId: number) =>
    await asStudent(studentId, '/api/student/registration/cancel', { idempotencyKey: newKey() });
  const join = async (studentId: number, clubId: number) =>
    await asStudent(studentId, '/api/student/waitlist', { clubId, idempotencyKey: newKey() });

  const loginOf = async (studentId: number) => {
    const { rows } = await pool.query<{ login_id: string }>(
      'SELECT login_id FROM users WHERE id = $1',
      [studentId],
    );
    return rows[0]!.login_id;
  };

  const heldClubs = async (studentId: number) => {
    const { rows } = await pool.query<{ club_id: number }>(
      'SELECT club_id FROM registrations WHERE student_id = $1',
      [studentId],
    );
    return rows.map(({ club_id: clubId }) => clubId);
  };

  const waitingFor = async (studentId: number) => {
    const { rows } = await pool.query<{ club_id: number }>(
      'SELECT club_id FROM waitlist_entries WHERE student_id = $1',
      [studentId],
    );
    return rows.map(({ club_id: clubId }) => clubId);
  };

  const queueOf = async (clubId: number) => {
    const { rows } = await pool.query<{ student_id: number }>(
      'SELECT student_id FROM waitlist_entries WHERE club_id = $1 ORDER BY created_at, id',
      [clubId],
    );
    return rows.map(({ student_id: studentId }) => studentId);
  };

  const eventsOfType = async (...types: string[]) => {
    const { rows } = await pool.query<EventRow>(
      `SELECT event_type, student_id, club_id, from_club_id, actor_id, idempotency_key
       FROM registration_events WHERE event_type = ANY($1::text[]) ORDER BY id`,
      [types],
    );
    return rows;
  };
  const adminEvents = async () => await eventsOfType('admin_assign', 'admin_remove');
  const eventCount = async () => {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM registration_events',
    );
    return rows[0]!.n;
  };

  const promoted = (studentId: number, clubId: number, fromClubId: number | null = null) => ({
    event_type: 'waitlist_promote',
    student_id: studentId,
    club_id: clubId,
    from_club_id: fromClubId,
    actor_id: adminId,
    idempotency_key: null,
  });

  const auditLines = (action: string) =>
    logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(({ audit }) => audit === action);

  // A club in a round (open unless given), with `holders` seated through the real service.
  const clubWith = async ({
    roundId,
    capacity = 3,
    holders = 0,
    grade = 1,
  }: { roundId?: number; capacity?: number; holders?: number; grade?: number } = {}) => {
    const round = roundId ?? (await createOpenRound(pool, grade));
    const clubId = await createClub(pool, round, uniqueCode(), { name: CLUB_NAME, capacity });
    const seated = await createStudents(pool, holders, { grade });
    for (const holder of seated) await seatStudent(pool, holder, clubId);
    return { roundId: round, clubId, holders: seated };
  };

  // A full club in an open round and students queued for it in join order.
  const fullClubWithWaiters = async ({
    roundId,
    capacity = 1,
    waiters = 1,
  }: { roundId?: number; capacity?: number; waiters?: number } = {}) => {
    const club = await clubWith({
      ...(roundId === undefined ? {} : { roundId }),
      capacity,
      holders: capacity,
    });
    const queue = await createStudents(pool, waiters);
    for (const studentId of queue) expect(codeOf(await join(studentId, club.clubId))).toBe('ok');
    return { ...club, queue };
  };

  const closeRound = async (roundId: number) => {
    await moveWindow(pool, roundId, { opensInSeconds: -2 * HOUR, closesInSeconds: -HOUR });
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    // The races below have dozens of requests contend for one round lock; same reason as
    // registration-concurrency.test.ts for the long connection wait.
    pool = createPool(appConnectionUri(container), {
      ...DEFAULT_POOL_SETTINGS,
      connectionTimeoutMs: 120_000,
    });
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
    adminId = await createAdminId(pool);
  });

  afterEach(async () => {
    await app.close();
    expect(await registrationInvariantViolations(pool)).toEqual([]);
  });

  describe('GET /api/admin/clubs/:id/members', () => {
    it('lists members by classroom (numeric-aware) then seat number', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 10 });
      const seats = [
        { classroom: '10', seatNo: 1 },
        { classroom: '2', seatNo: 3 },
        { classroom: '1', seatNo: 5 },
        { classroom: '2', seatNo: 1 },
      ];
      for (const seat of seats) {
        await seatStudent(pool, (await createStudent(pool, seat)).id, clubId);
      }

      const { members } = listOf(await listMembers(clubId));

      expect(members.map(({ classroom, seatNo }) => ({ classroom, seatNo }))).toEqual([
        { classroom: '1', seatNo: 5 },
        { classroom: '2', seatNo: 1 },
        { classroom: '2', seatNo: 3 },
        { classroom: '10', seatNo: 1 },
      ]);
    });

    it('answers each member with their details and the club counts', async () => {
      const { clubId, roundId, holders } = await clubWith({ capacity: 3, holders: 1 });
      const [holder] = holders;

      const response = await listMembers(clubId);

      expect(response.statusCode).toBe(200);
      const { rows } = await pool.query<{ created_at: Date }>(
        'SELECT created_at FROM registrations WHERE student_id = $1',
        [holder],
      );
      expect(listOf(response)).toEqual({
        club: {
          id: clubId,
          roundId,
          clubCode: expect.any(String) as string,
          name: CLUB_NAME,
          capacity: 3,
          registered: 1,
          remaining: 2,
        },
        members: [
          {
            studentId: holder,
            loginId: await loginOf(holder!),
            fullName: STUDENT_NAME,
            classroom: '1',
            seatNo: 1,
            registeredAt: rows[0]!.created_at.toISOString(),
            source: 'student',
          },
        ],
      });
    });

    it('says how each member got the seat: their own request, the waitlist or an admin', async () => {
      const { roundId, clubId, holders, queue } = await fullClubWithWaiters();
      const [byStudent] = holders;
      const [byWaitlist] = queue;
      const { clubId: otherClub } = await clubWith({ roundId, capacity: 2 });
      const byAdmin = await createStudentId(pool);
      expect(codeOf(await assign(otherClub, await loginOf(byAdmin)))).toBe('ok');
      expect(codeOf(await cancel(byStudent!))).toBe('ok'); // byWaitlist is promoted
      expect(codeOf(await register(byStudent!, otherClub))).toBe('ok');

      const sourceOf = async (club: number) =>
        Object.fromEntries(
          listOf(await listMembers(club)).members.map(({ studentId, source }) => [
            studentId,
            source,
          ]),
        );

      expect(await sourceOf(clubId)).toEqual({ [byWaitlist!]: 'waitlist' });
      expect(await sourceOf(otherClub)).toEqual({ [byAdmin]: 'admin', [byStudent!]: 'student' });
    });

    it('lists an empty club with no members', async () => {
      const { clubId } = await clubWith();

      expect(listOf(await listMembers(clubId)).members).toEqual([]);
    });

    it('carries no advisor contact details', async () => {
      const { clubId } = await clubWith({ holders: 1 });
      await pool.query(
        `INSERT INTO club_advisors (club_id, full_name, phone, email)
         VALUES ($1, 'ครูสมมติ', $2, $3)`,
        [clubId, ADVISOR_PHONE, ADVISOR_EMAIL],
      );

      const body = (await listMembers(clubId)).body;

      expect(body).not.toContain(ADVISOR_PHONE);
      expect(body).not.toContain(ADVISOR_EMAIL);
    });

    it('answers 404 for an unknown club', async () => {
      const response = await asAdmin({ method: 'GET', url: membersUrl(UNKNOWN_ID) });

      expect(response.statusCode).toBe(404);
      expect(codeOf(response)).toBe('not_found');
    });

    it('is for admins only', async () => {
      const { clubId } = await clubWith({ holders: 1 });
      const studentId = await createStudentId(pool);

      const asStudentResponse = await app.inject({
        method: 'GET',
        url: membersUrl(clubId),
        cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      });
      const anonymous = await app.inject({ method: 'GET', url: membersUrl(clubId) });

      expect(asStudentResponse.statusCode).toBe(403);
      expect(anonymous.statusCode).toBe(401);
    });
  });

  describe('POST /api/admin/clubs/:id/members (assign and move)', () => {
    it('seats a student who holds no club and logs one admin_assign', async () => {
      const { roundId, clubId } = await clubWith({ capacity: 2 });
      const studentId = await createStudentId(pool);
      const key = newKey();

      const response = await assign(clubId, await loginOf(studentId), key);

      expect(response.statusCode).toBe(200);
      expect(writeOf(response)).toMatchObject({
        club: { id: clubId, roundId, capacity: 2, registered: 1, remaining: 1 },
        member: { studentId, source: 'admin', fullName: STUDENT_NAME },
      });
      expect(await heldClubs(studentId)).toEqual([clubId]);
      expect(await adminEvents()).toEqual([
        {
          event_type: 'admin_assign',
          student_id: studentId,
          club_id: clubId,
          from_club_id: null,
          actor_id: adminId,
          idempotency_key: key,
        },
      ]);
      expect(auditLines('club.member_assign')).toEqual([
        expect.objectContaining({
          adminId,
          clubId,
          roundId,
          studentId,
          outcome: 'assigned',
          promoted: 0,
        }),
      ]);
    });

    it('accepts the login ID in capitals, as the student code may be typed', async () => {
      const { clubId } = await clubWith();
      const studentId = await createStudentId(pool);

      const response = await assign(clubId, (await loginOf(studentId)).toUpperCase());

      expect(response.statusCode).toBe(200);
      expect(await heldClubs(studentId)).toEqual([clubId]);
    });

    it('moves a student from the club they hold, in one admin_assign naming the club left', async () => {
      const { roundId, clubId: fromClub, holders } = await clubWith({ holders: 1 });
      const { clubId: toClub } = await clubWith({ roundId });
      const [studentId] = holders;
      const key = newKey();

      const response = await assign(toClub, await loginOf(studentId!), key);

      expect(writeOf(response)).toMatchObject({
        club: { id: toClub, registered: 1 },
        member: { studentId, source: 'admin' },
      });
      expect(await heldClubs(studentId!)).toEqual([toClub]);
      expect(await storedSeats(pool, fromClub)).toMatchObject({ registered: 0, rows: 0 });
      expect(await storedSeats(pool, toClub)).toMatchObject({ registered: 1, rows: 1 });
      expect(await adminEvents()).toEqual([
        {
          event_type: 'admin_assign',
          student_id: studentId,
          club_id: toClub,
          from_club_id: fromClub,
          actor_id: adminId,
          idempotency_key: key,
        },
      ]);
      expect(auditLines('club.member_assign')).toEqual([
        expect.objectContaining({ outcome: 'moved', fromClubId: fromClub, clubId: toClub }),
      ]);
    });

    it('answers 200 and writes nothing when the student already holds the club', async () => {
      const { clubId, holders } = await clubWith({ holders: 1 });
      const [studentId] = holders;
      const before = await eventCount();

      const response = await assign(clubId, await loginOf(studentId!));

      expect(response.statusCode).toBe(200);
      expect(writeOf(response).member).toMatchObject({ studentId, source: 'student' });
      expect(await eventCount()).toBe(before);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 1, rows: 1 });
      expect(auditLines('club.member_assign')).toEqual([
        expect.objectContaining({ outcome: 'already_held' }),
      ]);
    });

    it('refuses a full club with club_full and changes nothing', async () => {
      const { clubId } = await clubWith({ capacity: 1, holders: 1 });
      const studentId = await createStudentId(pool);
      const before = await eventCount();

      const response = await assign(clubId, await loginOf(studentId));

      expect(response.statusCode).toBe(409);
      expect(codeOf(response)).toBe('club_full');
      expect(await heldClubs(studentId)).toEqual([]);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 1, rows: 1 });
      expect(await eventCount()).toBe(before);
      expect(auditLines('club.member_assign')).toEqual([]);
    });

    it('leaves a student in their club when the club they are moved to is full', async () => {
      const { roundId, clubId: fromClub, holders } = await clubWith({ holders: 1 });
      const { clubId: fullClub } = await clubWith({ roundId, capacity: 1, holders: 1 });
      const [studentId] = holders;

      const response = await assign(fullClub, await loginOf(studentId!));

      expect(codeOf(response)).toBe('club_full');
      expect(await heldClubs(studentId!)).toEqual([fromClub]);
      expect(await storedSeats(pool, fromClub)).toMatchObject({ registered: 1, rows: 1 });
    });

    it('refuses a student of another grade with student_not_in_round_grade', async () => {
      const { clubId } = await clubWith();
      const studentId = await createStudentId(pool, 2);

      const response = await assign(clubId, await loginOf(studentId));

      expect(response.statusCode).toBe(409);
      expect(codeOf(response)).toBe('student_not_in_round_grade');
      expect(await heldClubs(studentId)).toEqual([]);
    });

    it('answers 404 for an unknown login, an admin and a student with no profile', async () => {
      const { clubId } = await clubWith();
      const { rows } = await pool.query<{ login_id: string }>(
        'SELECT login_id FROM users WHERE id = $1',
        [adminId],
      );
      const noProfile = `noprofile-${uniqueCode().toLowerCase()}`;
      await pool.query(
        `INSERT INTO users (login_id, full_name, role, password_hash)
         VALUES ($1, 'นักเรียนสมมติ ไม่มีชั้น', 'student', 'not-a-real-hash')`,
        [noProfile],
      );

      const responses = [
        await assign(clubId, 'nobody-here'),
        await assign(clubId, rows[0]!.login_id),
        await assign(clubId, noProfile),
      ];

      expect(responses.map(codeOf)).toEqual(['not_found', 'not_found', 'not_found']);
      expect(responses.map(({ statusCode }) => statusCode)).toEqual([404, 404, 404]);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 0, rows: 0 });
    });

    it('answers 404 for an unknown club', async () => {
      const studentId = await createStudentId(pool);

      const response = await assign(UNKNOWN_ID, await loginOf(studentId));

      expect(response.statusCode).toBe(404);
      expect(codeOf(response)).toBe('not_found');
    });

    it.each([
      ['closed', createClosedRound],
      ['upcoming', createUpcomingRound],
    ])('seats a student in a %s round', async (_status, createRound) => {
      const roundId = await createRound(pool, 1);
      const { clubId } = await clubWith({ roundId });
      const studentId = await createStudentId(pool);

      const response = await assign(clubId, await loginOf(studentId));

      expect(response.statusCode).toBe(200);
      expect(await heldClubs(studentId)).toEqual([clubId]);
    });

    it('ends the waitlist entry of the club the student is seated in (after the round closed)', async () => {
      // Until the round closes a club with waiters is full, so this is how the entry is reached:
      // a holder is removed after closing (nobody is promoted) and the waiter is seated by hand.
      const { roundId, clubId, holders, queue } = await fullClubWithWaiters({ waiters: 2 });
      const [waiter, later] = queue;
      await closeRound(roundId);
      expect(codeOf(await remove(clubId, await loginOf(holders[0]!)))).toBe('ok');

      const response = await assign(clubId, await loginOf(waiter!));

      expect(response.statusCode).toBe(200);
      expect(await heldClubs(waiter!)).toEqual([clubId]);
      expect(await waitingFor(waiter!)).toEqual([]);
      expect(await queueOf(clubId)).toEqual([later]);
    });

    it('keeps the waitlist entry for another club', async () => {
      const { roundId, clubId: fullClub, queue } = await fullClubWithWaiters();
      const { clubId: freeClub } = await clubWith({ roundId });
      const [waiter] = queue;

      expect(codeOf(await assign(freeClub, await loginOf(waiter!)))).toBe('ok');

      expect(await heldClubs(waiter!)).toEqual([freeClub]);
      expect(await waitingFor(waiter!)).toEqual([fullClub]);
    });

    it('lets a student whose entry the seat ended join another waitlist afresh', async () => {
      const { roundId, clubId, holders, queue } = await fullClubWithWaiters();
      const { clubId: otherClub } = await clubWith({ roundId, capacity: 1, holders: 1 });
      const [waiter] = queue;
      await closeRound(roundId);
      expect(codeOf(await remove(clubId, await loginOf(holders[0]!)))).toBe('ok');
      expect(codeOf(await assign(clubId, await loginOf(waiter!)))).toBe('ok');
      await moveWindow(pool, roundId, { opensInSeconds: -HOUR, closesInSeconds: HOUR });

      const response = await join(waiter!, otherClub);

      expect(codeOf(response)).toBe('ok');
      const [joined] = (await eventsOfType('waitlist_join')).filter(
        ({ student_id: studentId, club_id: club }) => studentId === waiter && club === otherClub,
      );
      expect(joined).toMatchObject({ from_club_id: null });
    });

    it('promotes the oldest waiter of the club the move left, with the admin as actor', async () => {
      const {
        roundId,
        clubId: fromClub,
        holders,
        queue,
      } = await fullClubWithWaiters({
        waiters: 2,
      });
      const { clubId: toClub } = await clubWith({ roundId });
      const [mover] = holders;
      const [first, second] = queue;

      const response = await assign(toClub, await loginOf(mover!));

      expect(response.statusCode).toBe(200);
      expect(await eventsOfType('waitlist_promote')).toEqual([promoted(first!, fromClub)]);
      expect(await heldClubs(first!)).toEqual([fromClub]);
      expect(await queueOf(fromClub)).toEqual([second]);
      expect(auditLines('club.member_assign')).toEqual([
        expect.objectContaining({ outcome: 'moved', promoted: 1, promotedStudentIds: [first] }),
      ]);
    });

    it('answers with the state after a cascade that moved the student on', async () => {
      // S holds A and waits for W; P holds W and waits for A. Moving S from A to T frees A, P
      // moves from W to A, W frees, and S (head of W) moves from T to W.
      const roundId = await createOpenRound(pool);
      const { clubId: clubA, holders: holdersA } = await clubWith({
        roundId,
        capacity: 1,
        holders: 1,
      });
      const { clubId: clubW, holders: holdersW } = await clubWith({
        roundId,
        capacity: 1,
        holders: 1,
      });
      const { clubId: clubT } = await clubWith({ roundId, capacity: 1 });
      const [student] = holdersA;
      const [other] = holdersW;
      expect(codeOf(await join(student!, clubW))).toBe('ok');
      expect(codeOf(await join(other!, clubA))).toBe('ok');

      const response = await assign(clubT, await loginOf(student!));

      expect(writeOf(response)).toMatchObject({
        club: { id: clubT, registered: 0, remaining: 1 },
        member: null,
      });
      expect(await heldClubs(student!)).toEqual([clubW]);
      expect(await heldClubs(other!)).toEqual([clubA]);
      expect(await eventsOfType('waitlist_promote')).toEqual([
        promoted(other!, clubA, clubW),
        promoted(student!, clubW, clubT),
      ]);
    });

    it('promotes nobody when the move is in a closed round', async () => {
      const { roundId, clubId: fromClub, holders, queue } = await fullClubWithWaiters();
      const { clubId: toClub } = await clubWith({ roundId });
      await closeRound(roundId);

      expect(codeOf(await assign(toClub, await loginOf(holders[0]!)))).toBe('ok');

      expect(await eventsOfType('waitlist_promote')).toEqual([]);
      expect(await queueOf(fromClub)).toEqual(queue);
      expect(await storedSeats(pool, fromClub)).toMatchObject({ registered: 0 });
    });
  });

  describe('POST /api/admin/clubs/:id/members/remove', () => {
    it('removes the seat, logs admin_remove and promotes the oldest waiter', async () => {
      const { roundId, clubId, holders, queue } = await fullClubWithWaiters({ waiters: 2 });
      const [holder] = holders;
      const [first, second] = queue;
      const key = newKey();

      const response = await remove(clubId, await loginOf(holder!), key);

      expect(response.statusCode).toBe(200);
      expect(writeOf(response)).toMatchObject({
        club: { id: clubId, registered: 1, remaining: 0 },
        member: null,
      });
      expect(await heldClubs(holder!)).toEqual([]);
      expect(await heldClubs(first!)).toEqual([clubId]);
      expect(await queueOf(clubId)).toEqual([second]);
      expect(await eventsOfType('admin_remove', 'waitlist_promote')).toEqual([
        {
          event_type: 'admin_remove',
          student_id: holder,
          club_id: clubId,
          from_club_id: null,
          actor_id: adminId,
          idempotency_key: key,
        },
        promoted(first!, clubId),
      ]);
      expect(auditLines('club.member_remove')).toEqual([
        expect.objectContaining({
          adminId,
          clubId,
          roundId,
          studentId: holder,
          outcome: 'removed',
          promoted: 1,
          promotedStudentIds: [first],
        }),
      ]);
    });

    it('refuses a student who holds no seat in this club with not_registered', async () => {
      const { roundId, clubId } = await clubWith({ holders: 1 });
      const { holders: elsewhere } = await clubWith({ roundId, holders: 1 });
      const nowhere = await createStudentId(pool);
      const before = await eventCount();

      const responses = [
        await remove(clubId, await loginOf(elsewhere[0]!)),
        await remove(clubId, await loginOf(nowhere)),
      ];

      expect(responses.map(codeOf)).toEqual(['not_registered', 'not_registered']);
      expect(responses.map(({ statusCode }) => statusCode)).toEqual([409, 409]);
      expect(await eventCount()).toBe(before);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 1, rows: 1 });
    });

    it('answers 404 for an unknown login or club', async () => {
      const { clubId, holders } = await clubWith({ holders: 1 });

      expect(codeOf(await remove(clubId, 'nobody-here'))).toBe('not_found');
      expect(codeOf(await remove(UNKNOWN_ID, await loginOf(holders[0]!)))).toBe('not_found');
    });

    it('removes a seat in a closed round and promotes nobody', async () => {
      const { roundId, clubId, holders, queue } = await fullClubWithWaiters();
      await closeRound(roundId);

      const response = await remove(clubId, await loginOf(holders[0]!));

      expect(response.statusCode).toBe(200);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 0, rows: 0 });
      expect(await eventsOfType('waitlist_promote')).toEqual([]);
      expect(await queueOf(clubId)).toEqual(queue);
    });

    it('removes an old seat of a student an import has since moved up a grade', async () => {
      const { roundId, clubId, holders } = await clubWith({ holders: 1 });
      const [holder] = holders;
      await closeRound(roundId);
      await pool.query('UPDATE student_profiles SET grade = 2 WHERE user_id = $1', [holder]);

      expect(codeOf(await assign(clubId, await loginOf(holder!)))).toBe(
        'student_not_in_round_grade',
      );
      const response = await remove(clubId, await loginOf(holder!));

      expect(response.statusCode).toBe(200);
      expect(await heldClubs(holder!)).toEqual([]);
    });
  });

  describe('idempotency', () => {
    it('answers a replayed key with the state now and writes nothing more', async () => {
      const { clubId } = await clubWith();
      const studentId = await createStudentId(pool);
      const login = await loginOf(studentId);
      const key = newKey();
      expect(codeOf(await assign(clubId, login, key))).toBe('ok');
      const before = await eventCount();

      const replayed = await assign(clubId, login, key);

      expect(replayed.statusCode).toBe(200);
      expect(writeOf(replayed).member).toMatchObject({ studentId });
      expect(await eventCount()).toBe(before);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 1, rows: 1 });
      expect(auditLines('club.member_assign').at(-1)).toMatchObject({
        outcome: 'replayed',
        studentId,
      });
    });

    it('answers a replayed assign after a later remove with no member', async () => {
      const { clubId } = await clubWith();
      const login = await loginOf(await createStudentId(pool));
      const key = newKey();
      expect(codeOf(await assign(clubId, login, key))).toBe('ok');
      expect(codeOf(await remove(clubId, login))).toBe('ok');

      const replayed = await assign(clubId, login, key);

      expect(replayed.statusCode).toBe(200);
      expect(writeOf(replayed)).toMatchObject({ member: null, club: { registered: 0 } });
    });

    it('refuses a key reused for another student, another club or a remove', async () => {
      const { roundId, clubId } = await clubWith();
      const { clubId: otherClub } = await clubWith({ roundId });
      const [first, second] = await createStudents(pool, 2);
      const key = newKey();
      expect(codeOf(await assign(clubId, await loginOf(first!), key))).toBe('ok');
      const before = await eventCount();

      const responses = [
        await assign(clubId, await loginOf(second!), key),
        await assign(otherClub, await loginOf(first!), key),
        await remove(clubId, await loginOf(first!), key),
      ];

      expect(responses.map(codeOf)).toEqual([
        'idempotency_key_reused',
        'idempotency_key_reused',
        'idempotency_key_reused',
      ]);
      expect(await eventCount()).toBe(before);
      expect(await heldClubs(first!)).toEqual([clubId]);
      expect(await heldClubs(second!)).toEqual([]);
    });

    it('refuses a key reused in another round, where the round locks do not meet', async () => {
      const { clubId } = await clubWith();
      const { clubId: otherRoundClub } = await clubWith({
        roundId: await createUpcomingRound(pool),
      });
      const [first, second] = await createStudents(pool, 2);
      const key = newKey();
      expect(codeOf(await assign(clubId, await loginOf(first!), key))).toBe('ok');

      const response = await assign(otherRoundClub, await loginOf(second!), key);

      expect(codeOf(response)).toBe('idempotency_key_reused');
      expect(await heldClubs(second!)).toEqual([]);
    });

    it('refuses a key that a request in another round committed while this one waited', async () => {
      // Each request holds its own round's lock, so both can pass the key lookup; the UNIQUE
      // (actor_id, idempotency_key) decides. The first is held after its lookup, on the row lock
      // of its student's profile, while the second commits.
      const { clubId } = await clubWith();
      const { clubId: otherRoundClub } = await clubWith({
        roundId: await createUpcomingRound(pool),
      });
      const [held, other] = await createStudents(pool, 2);
      const key = newKey();
      const blocker = await pool.connect();
      let first: Promise<InjectResponse> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM student_profiles WHERE user_id = $1 FOR UPDATE', [held]);
        first = assign(clubId, await loginOf(held!), key);
        const waiter = await waitForLockWaiter(pool, ({ query }) => query.includes('FOR SHARE'));
        expect(waiter.waitEvent).not.toBe('advisory');

        expect(codeOf(await assign(otherRoundClub, await loginOf(other!), key))).toBe('ok');
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }

      const refused = await first;
      expect(codeOf(refused)).toBe('idempotency_key_reused');
      expect(await heldClubs(held!)).toEqual([]);
      expect(await heldClubs(other!)).toEqual([otherRoundClub]);
    });

    it('lets a refused request be retried with its key', async () => {
      const { clubId } = await clubWith({ capacity: 1, holders: 1 });
      const login = await loginOf(await createStudentId(pool));
      const key = newKey();
      expect(codeOf(await assign(clubId, login, key))).toBe('club_full');
      await asAdmin({
        method: 'PATCH',
        url: `/api/admin/clubs/${clubId}`,
        payload: { capacity: 2 },
      });

      const retried = await assign(clubId, login, key);

      expect(codeOf(retried)).toBe('ok');
      expect(writeOf(retried).member).not.toBeNull();
    });

    it('carries out a request sent many times at once with one key exactly once', async () => {
      const { roundId, clubId: fromClub, holders } = await clubWith({ holders: 1 });
      const { clubId: toClub } = await clubWith({ roundId });
      const login = await loginOf(holders[0]!);
      const key = newKey();

      const responses = await Promise.all(
        Array.from({ length: 10 }, async () => await assign(toClub, login, key)),
      );

      expect(countBy(responses)).toEqual({ ok: 10 });
      expect(await adminEvents()).toHaveLength(1);
      expect(await storedSeats(pool, toClub)).toMatchObject({ registered: 1, rows: 1 });
      expect(await storedSeats(pool, fromClub)).toMatchObject({ registered: 0, rows: 0 });
    });
  });

  describe('under concurrency', () => {
    it('never overfills a club when admin assigns race students for the last seats', async () => {
      const { clubId } = await clubWith({ capacity: 10, holders: 5 });
      const byAdmin = await createStudents(pool, 15);
      const byThemselves = await createStudents(pool, 30);
      const logins = await Promise.all(byAdmin.map(loginOf));

      const responses = await Promise.all([
        ...logins.map(async (login) => await assign(clubId, login)),
        ...byThemselves.map(async (studentId) => await register(studentId, clubId)),
      ]);

      expect(countBy(responses)).toEqual({ ok: 5, club_full: 40 });
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 10, capacity: 10, rows: 10 });
    });

    it('hands every seat freed by admin removes and cancels to the queue, in order', async () => {
      const { clubId, holders, queue } = await fullClubWithWaiters({ capacity: 6, waiters: 10 });
      const newcomers = await createStudents(pool, 6);
      const removed = await Promise.all(holders.slice(0, 3).map(loginOf));

      const responses = await Promise.all([
        ...removed.map(async (login) => await remove(clubId, login)),
        ...holders.slice(3, 6).map(async (studentId) => await cancel(studentId)),
        ...newcomers.map(async (studentId) => await join(studentId, clubId)),
      ]);

      expect(countBy(responses)).toEqual({ ok: 12 });
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 6, capacity: 6, rows: 6 });
      const seated = await Promise.all(queue.slice(0, 6).map(heldClubs));
      expect(seated).toEqual(Array.from({ length: 6 }, () => [clubId]));
      // The newcomers queue behind everyone already waiting, in the order they got the lock.
      const after = await queueOf(clubId);
      expect(after.slice(0, 4)).toEqual(queue.slice(6));
      expect([...after.slice(4)].sort((a, b) => a - b)).toEqual(
        [...newcomers].sort((a, b) => a - b),
      );
    });
  });

  describe('requests', () => {
    it.each([
      ['naming a student id', { studentId: 7 }],
      ['naming a round', { roundId: 1 }],
      ['naming the club left', { fromClubId: 2 }],
    ])('refuses a body %s with 400', async (_case, extra) => {
      const { clubId } = await clubWith();
      const login = await loginOf(await createStudentId(pool));

      const responses = [
        await asAdmin({
          method: 'POST',
          url: membersUrl(clubId),
          payload: { loginId: login, idempotencyKey: newKey(), ...extra },
        }),
        await asAdmin({
          method: 'POST',
          url: `${membersUrl(clubId)}/remove`,
          payload: { loginId: login, idempotencyKey: newKey(), ...extra },
        }),
      ];

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([400, 400]);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 0 });
    });

    it.each([
      ['without a key', { loginId: 'fictional01' }],
      ['without a login', { idempotencyKey: newKey() }],
      ['with a login of disallowed characters', { loginId: 'สมมติ', idempotencyKey: newKey() }],
      ['with a numeric login', { loginId: 1001, idempotencyKey: newKey() }],
    ])('refuses a body %s with 400', async (_case, payload) => {
      const { clubId } = await clubWith();

      const response = await asAdmin({ method: 'POST', url: membersUrl(clubId), payload });

      expect(response.statusCode).toBe(400);
      expect(codeOf(response)).toBe('validation_error');
    });

    it.each(['', '/remove'])('accepts JSON only (members%s)', async (suffix) => {
      const { clubId } = await clubWith();
      const login = await loginOf(await createStudentId(pool));

      const response = await asAdmin({
        method: 'POST',
        url: `${membersUrl(clubId)}${suffix}`,
        payload: `loginId=${login}&idempotencyKey=${newKey()}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

      expect(response.statusCode).toBe(415);
      expect(await storedSeats(pool, clubId)).toMatchObject({ registered: 0 });
    });

    it('refuses students and requests with no session', async () => {
      const { clubId } = await clubWith();
      const studentId = await createStudentId(pool);
      const payload = { loginId: await loginOf(studentId), idempotencyKey: newKey() };

      const asStudentResponse = await asStudent(studentId, membersUrl(clubId), payload);
      const anonymous = await app.inject({ method: 'POST', url: membersUrl(clubId), payload });

      expect(asStudentResponse.statusCode).toBe(403);
      expect(anonymous.statusCode).toBe(401);
      expect(await heldClubs(studentId)).toEqual([]);
    });

    it('limits seat writes per admin, assign and remove together', async () => {
      const { clubId } = await clubWith();
      const login = await loginOf(await createStudentId(pool));
      const attempts = await Promise.all(
        Array.from({ length: 120 }, async () => await remove(clubId, login)),
      );
      expect(countBy(attempts)).toEqual({ not_registered: 120 });

      const limited = await assign(clubId, login);
      const otherAdmin = await asAdmin(
        {
          method: 'POST',
          url: membersUrl(clubId),
          payload: { loginId: login, idempotencyKey: newKey() },
        },
        await createAdminId(pool),
      );

      expect(limited.statusCode).toBe(429);
      expect(codeOf(limited)).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
      expect(otherAdmin.statusCode).toBe(200);
    });

    it('logs ids and outcomes, never a name, a login ID or a club name', async () => {
      const { roundId, clubId, holders } = await fullClubWithWaiters({ waiters: 1 });
      const { clubId: otherClub } = await clubWith({ roundId });
      const loginIds = await Promise.all([...holders, await createStudentId(pool)].map(loginOf));
      const [holderLogin, freshLogin] = loginIds;
      await listMembers(clubId);
      await assign(otherClub, holderLogin!);
      await assign(otherClub, freshLogin!);
      await assign(otherClub, freshLogin!);
      await remove(otherClub, freshLogin!);
      await assign(clubId, 'nobody-here');

      const log = logLines.join('\n');
      expect(auditLines('club.member_assign')).toHaveLength(3);
      expect(auditLines('club.member_remove')).toHaveLength(1);
      expect(log).not.toContain(STUDENT_NAME);
      expect(log).not.toContain(CLUB_NAME);
      loginIds.forEach((loginId) => expect(log).not.toContain(loginId));
    });
  });
});
