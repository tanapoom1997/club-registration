import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  clubWaitlistResponseSchema,
  errorResponseSchema,
  importPreviewResponseSchema,
} from '@club-registration/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { DEFAULT_POOL_SETTINGS, createPool } from '../src/db.js';
import { TEST_JWT_SECRET } from './support/app.js';
import { buildImportWorkbook, multipartBody, studentRow } from './support/import.js';
import { createClub, createStudent, uniqueCode } from './support/import-db.js';
import {
  appConnectionUri,
  startMigratedPostgres,
  stopPostgres,
  truncateAsOwner,
} from './support/postgres.js';
import {
  STUDENT_NAME,
  addWaitingDirectly,
  createAdminId,
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
  waitForAdvisoryLockWaiter,
} from './support/registration.js';
import { takeTurnFor } from './support/queue.js';

// An admin listing a club's waitlist and taking students off it (README Phase 2, PR 3b), through
// the whole app against a real Postgres. Every value is made up.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const CLUB_NAME = 'ชุมนุมสมมติ รายชื่อรอ';
const UNKNOWN_ID = 2_000_000_000;
const HOUR = 3_600;

type EventRow = {
  event_type: string;
  round_id: number;
  student_id: number;
  club_id: number | null;
  from_club_id: number | null;
  actor_id: number;
  idempotency_key: string | null;
};

const codeOf = (response: InjectResponse) =>
  response.statusCode === 200 ? 'ok' : errorResponseSchema.parse(response.json()).code;
const listOf = (response: InjectResponse) => clubWaitlistResponseSchema.parse(response.json());

const countBy = (responses: InjectResponse[]) =>
  responses.reduce<Record<string, number>>((counts, response) => {
    const code = codeOf(response);
    return { ...counts, [code]: (counts[code] ?? 0) + 1 };
  }, {});

describe('admin club waitlist', () => {
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

  const waitlistUrl = (clubId: number) => `/api/admin/clubs/${clubId}/waitlist`;
  const listWaitlist = async (clubId: number) =>
    await asAdmin({ method: 'GET', url: waitlistUrl(clubId) });
  const removeEntry = async (
    clubId: number,
    loginId: string,
    idempotencyKey = newKey(),
    actorId = adminId,
  ) =>
    await asAdmin(
      {
        method: 'POST',
        url: `${waitlistUrl(clubId)}/remove`,
        payload: { loginId, idempotencyKey },
      },
      actorId,
    );
  const memberWrite = async (path: '' | '/remove', clubId: number, loginId: string, key: string) =>
    await asAdmin({
      method: 'POST',
      url: `/api/admin/clubs/${clubId}/members${path}`,
      payload: { loginId, idempotencyKey: key },
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
  const cancel = async (studentId: number) =>
    await asStudent(studentId, '/api/student/registration/cancel', { idempotencyKey: newKey() });
  const join = async (studentId: number, clubId: number) =>
    await asStudent(studentId, '/api/student/waitlist', { clubId, idempotencyKey: newKey() });
  const leave = async (studentId: number) =>
    await asStudent(studentId, '/api/student/waitlist/leave', { idempotencyKey: newKey() });

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
      'SELECT club_id FROM waitlist_entries WHERE student_id = $1 ORDER BY club_id',
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
      `SELECT event_type, round_id, student_id, club_id, from_club_id, actor_id, idempotency_key
       FROM registration_events WHERE event_type = ANY($1::text[]) ORDER BY id`,
      [types],
    );
    return rows;
  };
  const eventCount = async () => {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM registration_events',
    );
    return rows[0]!.n;
  };

  const auditLines = (action: string) =>
    logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(({ audit }) => audit === action);

  const clubWith = async ({
    roundId,
    capacity = 3,
    holders = 0,
  }: { roundId?: number; capacity?: number; holders?: number } = {}) => {
    const round = roundId ?? (await createOpenRound(pool));
    const clubId = await createClub(pool, round, uniqueCode(), { name: CLUB_NAME, capacity });
    const seated = await createStudents(pool, holders);
    for (const holder of seated) await seatStudent(pool, holder, clubId);
    return { roundId: round, clubId, holders: seated };
  };

  // A full club in an open round and students queued for it through the API, in join order.
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
    // Same reason as admin-members.test.ts: the races queue dozens of requests on one round lock.
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

  describe('GET /api/admin/clubs/:id/waitlist', () => {
    it('lists the waiters in queue order with positions from 1', async () => {
      const { clubId, queue } = await fullClubWithWaiters({ waiters: 4 });

      const { entries } = listOf(await listWaitlist(clubId));

      expect(entries.map(({ position, studentId }) => ({ position, studentId }))).toEqual(
        queue.map((studentId, index) => ({ position: index + 1, studentId })),
      );
    });

    it('answers each waiter with their details, the club they hold and the club counts', async () => {
      const { roundId, clubId: fullClub } = await clubWith({ capacity: 1, holders: 1 });
      const { clubId: heldClub } = await clubWith({ roundId });
      const holder = await createStudent(pool, {
        fullName: STUDENT_NAME,
        classroom: '3',
        seatNo: 12,
      });
      // Made with the import fixture, which leaves the first-login password change pending.
      await pool.query('UPDATE users SET must_change_password = false WHERE id = $1', [holder.id]);
      const plain = await createStudentId(pool);
      await seatStudent(pool, holder.id, heldClub);
      expect(codeOf(await join(holder.id, fullClub))).toBe('ok');
      expect(codeOf(await join(plain, fullClub))).toBe('ok');
      const { rows } = await pool.query<{ created_at: Date; club_code: string }>(
        `SELECT w.created_at, c.club_code FROM waitlist_entries w
         JOIN clubs c ON c.id = $2 WHERE w.student_id = $1`,
        [holder.id, heldClub],
      );

      const response = await listWaitlist(fullClub);

      expect(response.statusCode).toBe(200);
      const { club, entries } = listOf(response);
      expect(club).toEqual({
        id: fullClub,
        roundId,
        clubCode: expect.any(String) as string,
        name: CLUB_NAME,
        capacity: 1,
        registered: 1,
        remaining: 0,
      });
      expect(entries).toEqual([
        {
          position: 1,
          studentId: holder.id,
          loginId: holder.loginId,
          fullName: STUDENT_NAME,
          classroom: '3',
          seatNo: 12,
          joinedAt: rows[0]!.created_at.toISOString(),
          heldClub: { id: heldClub, clubCode: rows[0]!.club_code, name: CLUB_NAME },
        },
        expect.objectContaining({ position: 2, studentId: plain, heldClub: null }),
      ]);
    });

    it('lists only this club: other clubs of the round and other rounds are left out', async () => {
      const { roundId, clubId, queue } = await fullClubWithWaiters({ waiters: 2 });
      const { clubId: otherClub, queue: otherQueue } = await fullClubWithWaiters({
        roundId,
        waiters: 2,
      });
      const { roundId: laterRound, clubId: laterClub } = await clubWith({
        roundId: await createUpcomingRound(pool),
        capacity: 0,
      });
      await addWaitingDirectly(pool, {
        roundId: laterRound,
        clubId: laterClub,
        studentId: queue[0]!,
      });

      const { entries } = listOf(await listWaitlist(clubId));

      expect(entries.map(({ studentId }) => studentId)).toEqual(queue);
      expect(await queueOf(otherClub)).toEqual(otherQueue);
    });

    it('lists a club nobody waits for as an empty queue', async () => {
      const { clubId } = await clubWith();

      const response = await listWaitlist(clubId);

      expect(response.statusCode).toBe(200);
      expect(listOf(response).entries).toEqual([]);
    });

    it('writes nothing', async () => {
      const { clubId } = await fullClubWithWaiters({ waiters: 2 });
      const before = await eventCount();

      await listWaitlist(clubId);

      expect(await eventCount()).toBe(before);
      expect(await queueOf(clubId)).toHaveLength(2);
    });

    it('answers 404 for an unknown club', async () => {
      const response = await listWaitlist(UNKNOWN_ID);

      expect(response.statusCode).toBe(404);
      expect(codeOf(response)).toBe('not_found');
    });

    it('is for admins only', async () => {
      const { clubId, queue } = await fullClubWithWaiters();

      const asStudentResponse = await app.inject({
        method: 'GET',
        url: waitlistUrl(clubId),
        cookies: { [SESSION_COOKIE]: sessionCookie(app, queue[0]!) },
      });
      const anonymous = await app.inject({ method: 'GET', url: waitlistUrl(clubId) });

      expect(asStudentResponse.statusCode).toBe(403);
      expect(anonymous.statusCode).toBe(401);
    });
  });

  describe('POST /api/admin/clubs/:id/waitlist/remove', () => {
    it('removes the entry, shifts the others up and logs a waitlist_leave by the admin', async () => {
      const { roundId, clubId, queue } = await fullClubWithWaiters({ waiters: 3 });
      const [first, second, third] = queue;
      const key = newKey();

      const response = await removeEntry(clubId, await loginOf(second!), key);

      expect(response.statusCode).toBe(200);
      const { club, entries } = listOf(response);
      expect(club).toMatchObject({ id: clubId, registered: 1, capacity: 1 });
      expect(entries.map(({ position, studentId }) => ({ position, studentId }))).toEqual([
        { position: 1, studentId: first },
        { position: 2, studentId: third },
      ]);
      expect(await queueOf(clubId)).toEqual([first, third]);
      expect(await eventsOfType('waitlist_leave')).toEqual([
        {
          event_type: 'waitlist_leave',
          round_id: roundId,
          student_id: second,
          club_id: clubId,
          from_club_id: null,
          actor_id: adminId,
          idempotency_key: key,
        },
      ]);
    });

    it('frees no seat and promotes nobody', async () => {
      const { clubId, queue } = await fullClubWithWaiters({ waiters: 2 });

      expect(codeOf(await removeEntry(clubId, await loginOf(queue[0]!)))).toBe('ok');

      expect(await storedSeats(pool, clubId)).toEqual({ registered: 1, capacity: 1, rows: 1 });
      expect(await eventsOfType('waitlist_promote')).toEqual([]);
      expect(await heldClubs(queue[1]!)).toEqual([]);
    });

    it('refuses a student waiting for another club of the round, and leaves that entry', async () => {
      const { roundId, clubId: waited, queue } = await fullClubWithWaiters();
      const { clubId: other } = await clubWith({ roundId, capacity: 1, holders: 1 });
      const [waiter] = queue;
      const before = await eventCount();

      const response = await removeEntry(other, await loginOf(waiter!));

      expect(response.statusCode).toBe(409);
      expect(codeOf(response)).toBe('not_waitlisted');
      expect(await waitingFor(waiter!)).toEqual([waited]);
      expect(await eventCount()).toBe(before);
    });

    it("leaves the student's entry in another round alone", async () => {
      // A club with no seats is always full, so an entry there keeps every invariant.
      const { clubId, queue } = await fullClubWithWaiters();
      const [waiter] = queue;
      const { roundId: laterRound, clubId: laterClub } = await clubWith({
        roundId: await createUpcomingRound(pool),
        capacity: 0,
      });
      await addWaitingDirectly(pool, {
        roundId: laterRound,
        clubId: laterClub,
        studentId: waiter!,
      });

      expect(codeOf(await removeEntry(clubId, await loginOf(waiter!)))).toBe('ok');

      expect(await waitingFor(waiter!)).toEqual([laterClub]);
    });

    it('refuses a student who waits for nothing with not_waitlisted', async () => {
      const { clubId } = await fullClubWithWaiters();
      const before = await eventCount();

      const response = await removeEntry(clubId, await loginOf(await createStudentId(pool)));

      expect(response.statusCode).toBe(409);
      expect(codeOf(response)).toBe('not_waitlisted');
      expect(await eventCount()).toBe(before);
    });

    it('answers 404 for an unknown login, an admin and a student with no profile', async () => {
      const { clubId } = await fullClubWithWaiters();
      const { rows } = await pool.query<{ login_id: string }>(
        `INSERT INTO users (login_id, full_name, role, password_hash)
         VALUES ('fictional-noprofile', 'ไม่มีโปรไฟล์', 'student', 'not-a-real-hash')
         RETURNING login_id`,
      );
      const { rows: admins } = await pool.query<{ login_id: string }>(
        'SELECT login_id FROM users WHERE id = $1',
        [adminId],
      );

      const responses = [
        await removeEntry(clubId, 'nobody-here'),
        await removeEntry(clubId, admins[0]!.login_id),
        await removeEntry(clubId, rows[0]!.login_id),
      ];

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([404, 404, 404]);
    });

    it('answers 404 for an unknown club', async () => {
      const response = await removeEntry(UNKNOWN_ID, 'nobody-here');

      expect(response.statusCode).toBe(404);
      expect(codeOf(response)).toBe('not_found');
    });

    it('removes an entry left in a closed round', async () => {
      const { roundId, clubId, queue } = await fullClubWithWaiters({ waiters: 2 });
      await closeRound(roundId);
      expect(codeOf(await leave(queue[0]!))).toBe('round_not_open');

      const response = await removeEntry(clubId, await loginOf(queue[0]!));

      expect(response.statusCode).toBe(200);
      expect(listOf(response).entries.map(({ studentId }) => studentId)).toEqual([queue[1]]);
    });

    it('removes an entry in an upcoming round', async () => {
      const { roundId, clubId } = await clubWith({
        roundId: await createUpcomingRound(pool),
        capacity: 0,
      });
      const studentId = await createStudentId(pool);
      await addWaitingDirectly(pool, { roundId, clubId, studentId });

      const response = await removeEntry(clubId, await loginOf(studentId));

      expect(response.statusCode).toBe(200);
      expect(await waitingFor(studentId)).toEqual([]);
    });

    it('lets an import change the grade once the stale entry of a closed round is removed', async () => {
      // README open item 19: after the round closed the student can no longer leave, and an
      // import of the same term refuses to move a student with an entry in it.
      const { roundId, clubId, queue } = await fullClubWithWaiters();
      const [waiter] = queue;
      await closeRound(roundId);
      const { rows } = await pool.query<{ term: string }>('SELECT term FROM rounds WHERE id = $1', [
        roundId,
      ]);
      const term = rows[0]!.term;
      const login = await loginOf(waiter!);
      const preview = async () => {
        const bytes = await buildImportWorkbook({
          students: [studentRow({ loginId: login, fullName: STUDENT_NAME, grade: 2 })],
        });
        const response = await asAdmin({
          method: 'POST',
          url: '/api/admin/import/preview',
          ...(await multipartBody({ term }, [{ name: 'import.xlsx', bytes }])),
        });
        expect(response.statusCode).toBe(200);
        return importPreviewResponseSchema.parse(response.json());
      };
      expect((await preview()).errors).toEqual([
        expect.objectContaining({
          message: `นักเรียนอยู่ในรายชื่อรอชุมนุมของ ม.1 ในภาคเรียน ${term} จึงเปลี่ยนชั้นไม่ได้`,
        }),
      ]);

      expect(codeOf(await removeEntry(clubId, login))).toBe('ok');
      const after = await preview();

      expect(after.errors).toEqual([]);
      expect(after.students.update).toBe(1);
    });

    it('removes the entry of a student an import has since moved up a grade', async () => {
      const { roundId, clubId, queue } = await fullClubWithWaiters();
      const [waiter] = queue;
      await closeRound(roundId);
      await pool.query('UPDATE student_profiles SET grade = 2 WHERE user_id = $1', [waiter]);

      const response = await removeEntry(clubId, await loginOf(waiter!));

      expect(response.statusCode).toBe(200);
      expect(await waitingFor(waiter!)).toEqual([]);
    });

    it('lets a student whose entry was removed join the queue again, at the back', async () => {
      const { clubId, queue } = await fullClubWithWaiters({ waiters: 2 });
      const [first, second] = queue;
      expect(codeOf(await removeEntry(clubId, await loginOf(first!)))).toBe('ok');

      const rejoined = await join(first!, clubId);

      expect(codeOf(rejoined)).toBe('ok');
      expect(await queueOf(clubId)).toEqual([second, first]);
      const joins = (await eventsOfType('waitlist_join')).filter(
        ({ student_id: studentId }) => studentId === first,
      );
      expect(joins.map(({ from_club_id: fromClubId }) => fromClubId)).toEqual([null, null]);
    });
  });

  describe('idempotency', () => {
    it('answers a replayed key with the list now and writes nothing more', async () => {
      const { clubId, queue } = await fullClubWithWaiters({ waiters: 2 });
      const [first, second] = queue;
      const login = await loginOf(first!);
      const key = newKey();
      expect(codeOf(await removeEntry(clubId, login, key))).toBe('ok');
      // The student queues again: the replay must not take them off a second time.
      expect(codeOf(await join(first!, clubId))).toBe('ok');
      const before = await eventCount();

      const replayed = await removeEntry(clubId, login, key);

      expect(replayed.statusCode).toBe(200);
      expect(listOf(replayed).entries.map(({ studentId }) => studentId)).toEqual([second, first]);
      expect(await eventCount()).toBe(before);
      expect(auditLines('club.waitlist_remove').at(-1)).toMatchObject({
        outcome: 'replayed',
        studentId: first,
      });
    });

    it('refuses a key reused for another student or another club', async () => {
      const { roundId, clubId, queue } = await fullClubWithWaiters({ waiters: 2 });
      const { clubId: otherClub, queue: otherQueue } = await fullClubWithWaiters({ roundId });
      const [first, second] = queue;
      const key = newKey();
      expect(codeOf(await removeEntry(clubId, await loginOf(first!), key))).toBe('ok');
      const before = await eventCount();

      const responses = [
        await removeEntry(clubId, await loginOf(second!), key),
        await removeEntry(otherClub, await loginOf(otherQueue[0]!), key),
      ];

      expect(responses.map(codeOf)).toEqual(['idempotency_key_reused', 'idempotency_key_reused']);
      expect(await eventCount()).toBe(before);
      expect(await queueOf(clubId)).toEqual([second]);
      expect(await queueOf(otherClub)).toEqual(otherQueue);
    });

    it("refuses a member write's key here, and this request's key for a member write", async () => {
      const { roundId, clubId, queue, holders } = await fullClubWithWaiters({ waiters: 2 });
      const { clubId: freeClub } = await clubWith({ roundId });
      const [first, second] = queue;
      const memberKey = newKey();
      const waitlistKey = newKey();
      expect(codeOf(await memberWrite('', freeClub, await loginOf(first!), memberKey))).toBe('ok');
      expect(codeOf(await removeEntry(clubId, await loginOf(second!), waitlistKey))).toBe('ok');
      const before = await eventCount();

      const responses = [
        await removeEntry(clubId, await loginOf(first!), memberKey),
        await memberWrite('', freeClub, await loginOf(second!), waitlistKey),
        await memberWrite('/remove', clubId, await loginOf(holders[0]!), waitlistKey),
      ];

      expect(responses.map(codeOf)).toEqual([
        'idempotency_key_reused',
        'idempotency_key_reused',
        'idempotency_key_reused',
      ]);
      expect(await eventCount()).toBe(before);
      expect(await waitingFor(first!)).toEqual([clubId]);
    });

    it('refuses a key of a member write on the same student and club, and the other way round', async () => {
      // Same club and student, other type: only the type tells these requests apart.
      const { clubId, holders, queue } = await fullClubWithWaiters();
      const [holder] = holders;
      const [waiter] = queue;
      const waitlistKey = newKey();
      const memberKey = newKey();
      expect(codeOf(await removeEntry(clubId, await loginOf(waiter!), waitlistKey))).toBe('ok');
      expect(codeOf(await memberWrite('/remove', clubId, await loginOf(holder!), memberKey))).toBe(
        'ok',
      );
      const before = await eventCount();

      const responses = [
        await memberWrite('', clubId, await loginOf(waiter!), waitlistKey),
        await removeEntry(clubId, await loginOf(holder!), memberKey),
      ];

      expect(responses.map(codeOf)).toEqual(['idempotency_key_reused', 'idempotency_key_reused']);
      expect(await eventCount()).toBe(before);
      expect(await heldClubs(waiter!)).toEqual([]);
    });

    it("never takes a student's own leave key for the admin's", async () => {
      // Keys are per actor (UNIQUE (actor_id, idempotency_key)): the student's key is no replay.
      const { clubId, queue } = await fullClubWithWaiters({ waiters: 2 });
      const [first, second] = queue;
      const key = newKey();
      expect(
        codeOf(await asStudent(first!, '/api/student/waitlist/leave', { idempotencyKey: key })),
      ).toBe('ok');

      const response = await removeEntry(clubId, await loginOf(second!), key);

      expect(codeOf(response)).toBe('ok');
      expect(await queueOf(clubId)).toEqual([]);
    });

    it('lets a refused request be retried with its key', async () => {
      const { clubId } = await fullClubWithWaiters();
      const studentId = await createStudentId(pool);
      const login = await loginOf(studentId);
      const key = newKey();
      expect(codeOf(await removeEntry(clubId, login, key))).toBe('not_waitlisted');
      expect(codeOf(await join(studentId, clubId))).toBe('ok');

      const retried = await removeEntry(clubId, login, key);

      expect(codeOf(retried)).toBe('ok');
      expect(await waitingFor(studentId)).toEqual([]);
    });

    it('carries out a request sent many times at once with one key exactly once', async () => {
      const { clubId, queue } = await fullClubWithWaiters({ waiters: 2 });
      const login = await loginOf(queue[0]!);
      const key = newKey();

      const responses = await Promise.all(
        Array.from({ length: 10 }, async () => await removeEntry(clubId, login, key)),
      );

      expect(countBy(responses)).toEqual({ ok: 10 });
      expect(await eventsOfType('waitlist_leave')).toHaveLength(1);
      expect(await queueOf(clubId)).toEqual([queue[1]]);
    });
  });

  describe('invariant check', () => {
    // The event log is append-only; the owner's truncate is the one way to undo a bogus event.
    const leaveBy = async (actorId: number, idempotencyKey: string | null) => {
      const { roundId, clubId, queue } = await fullClubWithWaiters();
      const [waiter] = queue;
      await pool.query('DELETE FROM waitlist_entries WHERE student_id = $1', [waiter]);
      await pool.query(
        `INSERT INTO registration_events
           (round_id, student_id, club_id, event_type, actor_id, idempotency_key)
         VALUES ($1, $2, $3, 'waitlist_leave', $4, $5)`,
        [roundId, waiter, clubId, actorId, idempotencyKey],
      );
      const violations = await registrationInvariantViolations(pool);
      await truncateAsOwner(container, ['rounds']);
      return violations.join('\n');
    };

    it("reports a waitlist_leave by another student's account", async () => {
      const violations = await leaveBy(await createStudentId(pool), newKey());

      expect(violations).toContain('students act for themselves with a key');
    });

    it("reports an admin's waitlist_leave without a key", async () => {
      const violations = await leaveBy(adminId, null);

      expect(violations).toContain('students act for themselves with a key');
    });

    it("accepts an admin's keyed waitlist_leave", async () => {
      const violations = await leaveBy(adminId, newKey());

      expect(violations).toBe('');
    });
  });

  describe('under concurrency', () => {
    it('waits for the round lock before it reads or deletes anything', async () => {
      // CLAUDE.md rule 3: without the lock, a removal could take the row the promote engine has
      // just picked, and the engine would stop with a free seat beside a queue.
      const { roundId, clubId, queue } = await fullClubWithWaiters({ waiters: 2 });
      const blocker = await pool.connect();
      let removal: Promise<InjectResponse> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)', [roundId]);
        removal = removeEntry(clubId, await loginOf(queue[0]!));
        await waitForAdvisoryLockWaiter(pool);

        expect(await queueOf(clubId)).toEqual(queue);
      } finally {
        await blocker.query('COMMIT');
        blocker.release();
      }

      expect(codeOf(await removal)).toBe('ok');
      expect(await queueOf(clubId)).toEqual([queue[1]]);
    });

    it('takes each entry off once when the admin and the waiter remove it together', async () => {
      const { clubId, queue } = await fullClubWithWaiters({ waiters: 10 });
      const logins = await Promise.all(queue.map(loginOf));

      const responses = await Promise.all([
        ...logins.map(async (login) => await removeEntry(clubId, login)),
        ...queue.map(async (studentId) => await leave(studentId)),
      ]);

      expect(countBy(responses)).toEqual({ ok: 10, not_waitlisted: 10 });
      expect(await queueOf(clubId)).toEqual([]);
      expect(await eventsOfType('waitlist_leave')).toHaveLength(10);
    });

    it('keeps the queue in order through removals racing cancels, promotions and joins', async () => {
      const { clubId, holders, queue } = await fullClubWithWaiters({ capacity: 3, waiters: 8 });
      const newcomers = await createStudents(pool, 4);
      const removed = queue.slice(0, 4);
      const removedLogins = await Promise.all(removed.map(loginOf));

      const responses = await Promise.all([
        ...removedLogins.map(async (login) => await removeEntry(clubId, login)),
        ...holders.map(async (studentId) => await cancel(studentId)),
        ...newcomers.map(async (studentId) => await join(studentId, clubId)),
      ]);
      const removals = responses.slice(0, removed.length).map(codeOf);

      expect(responses.slice(removed.length).map(codeOf)).toEqual(
        Array.from({ length: holders.length + newcomers.length }, () => 'ok'),
      );
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 3, capacity: 3, rows: 3 });
      // A removal either took the entry off first (the student holds nothing) or found it already
      // promoted (not_waitlisted, and the student holds the seat).
      const held = await Promise.all(removed.map(heldClubs));
      removals.forEach((code, index) => {
        expect(code === 'ok' ? [] : [clubId]).toEqual(held[index]);
        expect(['ok', 'not_waitlisted']).toContain(code);
      });
      // The seats went to the oldest waiters not removed, in queue order, and everyone else still
      // waiting keeps the order they joined in, newcomers behind.
      const seatedFromQueue = queue.filter((_, index) => index >= 4 || removals[index] !== 'ok');
      const promotedCount = 3;
      const seated = await Promise.all(seatedFromQueue.slice(0, promotedCount).map(heldClubs));
      expect(seated).toEqual(Array.from({ length: promotedCount }, () => [clubId]));
      const after = await queueOf(clubId);
      const stillQueued = seatedFromQueue.slice(promotedCount);
      expect(after.slice(0, stillQueued.length)).toEqual(stillQueued);
      expect([...after.slice(stillQueued.length)].sort((a, b) => a - b)).toEqual(
        [...newcomers].sort((a, b) => a - b),
      );
    });
  });

  describe('requests', () => {
    it.each([
      ['naming a student id', { studentId: 7 }],
      ['naming a round', { roundId: 1 }],
      ['naming a club', { clubId: 2 }],
    ])('refuses a body %s with 400', async (_case, extra) => {
      const { clubId, queue } = await fullClubWithWaiters();

      const response = await asAdmin({
        method: 'POST',
        url: `${waitlistUrl(clubId)}/remove`,
        payload: { loginId: await loginOf(queue[0]!), idempotencyKey: newKey(), ...extra },
      });

      expect(response.statusCode).toBe(400);
      expect(codeOf(response)).toBe('validation_error');
      expect(await queueOf(clubId)).toEqual(queue);
    });

    it.each([
      ['without a key', { loginId: 'fictional01' }],
      ['without a login', { idempotencyKey: newKey() }],
    ])('refuses a body %s with 400', async (_case, payload) => {
      const { clubId } = await fullClubWithWaiters();

      const response = await asAdmin({
        method: 'POST',
        url: `${waitlistUrl(clubId)}/remove`,
        payload,
      });

      expect(response.statusCode).toBe(400);
    });

    it('accepts JSON only', async () => {
      const { clubId, queue } = await fullClubWithWaiters();

      const response = await asAdmin({
        method: 'POST',
        url: `${waitlistUrl(clubId)}/remove`,
        payload: `loginId=${await loginOf(queue[0]!)}&idempotencyKey=${newKey()}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

      expect(response.statusCode).toBe(415);
      expect(await queueOf(clubId)).toEqual(queue);
    });

    it('refuses students and requests with no session', async () => {
      const { clubId, queue } = await fullClubWithWaiters();
      const payload = { loginId: await loginOf(queue[0]!), idempotencyKey: newKey() };
      const url = `${waitlistUrl(clubId)}/remove`;

      const asStudentResponse = await asStudent(queue[0]!, url, payload);
      const anonymous = await app.inject({ method: 'POST', url, payload });

      expect(asStudentResponse.statusCode).toBe(403);
      expect(anonymous.statusCode).toBe(401);
      expect(await queueOf(clubId)).toEqual(queue);
    });

    it('shares the per-admin seat-write limit with member writes', async () => {
      const { clubId } = await fullClubWithWaiters();
      const login = await loginOf(await createStudentId(pool));
      const attempts = await Promise.all([
        ...Array.from({ length: 60 }, async () => await removeEntry(clubId, login)),
        ...Array.from(
          { length: 60 },
          async () => await memberWrite('/remove', clubId, login, newKey()),
        ),
      ]);
      expect(countBy(attempts)).toEqual({ not_waitlisted: 60, not_registered: 60 });

      const limited = [
        await removeEntry(clubId, login),
        await memberWrite('/remove', clubId, login, newKey()),
      ];
      const otherAdmin = await removeEntry(clubId, login, newKey(), await createAdminId(pool));

      expect(limited.map(codeOf)).toEqual(['rate_limited', 'rate_limited']);
      expect(limited[0]!.headers['retry-after']).toBeDefined();
      expect(codeOf(otherAdmin)).toBe('not_waitlisted');
    });

    it('logs ids and outcomes, never a name, a login ID or a club name', async () => {
      const { clubId, queue } = await fullClubWithWaiters({ waiters: 2 });
      const loginIds = await Promise.all(queue.map(loginOf));
      const key = newKey();
      await listWaitlist(clubId);
      await removeEntry(clubId, loginIds[0]!, key);
      await removeEntry(clubId, loginIds[0]!, key);
      await removeEntry(clubId, loginIds[0]!);
      await removeEntry(clubId, 'nobody-here');

      const log = logLines.join('\n');
      expect(auditLines('club.waitlist_remove')).toEqual([
        expect.objectContaining({ clubId, studentId: queue[0], outcome: 'removed' }),
        expect.objectContaining({ clubId, studentId: queue[0], outcome: 'replayed' }),
      ]);
      expect(Object.keys(auditLines('club.waitlist_remove')[0]!)).toEqual(
        expect.arrayContaining(['adminId', 'clubId', 'roundId', 'studentId', 'outcome']),
      );
      expect(log).not.toContain(STUDENT_NAME);
      expect(log).not.toContain(CLUB_NAME);
      loginIds.forEach((loginId) => expect(log).not.toContain(loginId));
    });
  });
});
