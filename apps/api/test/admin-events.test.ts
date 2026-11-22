import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  EVENT_TYPES,
  errorResponseSchema,
  eventLogResponseSchema,
} from '@club-registration/shared';
import type { EventLogResponse, RegistrationEvent } from '@club-registration/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool } from '../src/db.js';
import { TEST_JWT_SECRET } from './support/app.js';
import { createClub, uniqueCode } from './support/import-db.js';
import {
  appConnectionUri,
  startMigratedPostgres,
  stopPostgres,
  truncateAsOwner,
} from './support/postgres.js';
import {
  STUDENT_NAME,
  createAdminId,
  createOpenRound,
  createStudentId,
  createStudents,
  newKey,
  registrationInvariantViolations,
  seatStudent,
  sessionCookie,
} from './support/registration.js';
import { takeTurnFor } from './support/queue.js';

// The admin event log (README Phase 2, PR 3b) through the whole app against a real Postgres.
// Every event is written through the API or the services, so the invariant check after each test
// covers the seeded log too. Every value is made up.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const CLUB_NAME = 'ชุมนุมสมมติ บันทึกเหตุการณ์';
const ADMIN_NAME = 'ผู้ดูแลสมมติ';
const UNKNOWN_ID = 2_000_000_000;

const codeOf = (response: InjectResponse) =>
  response.statusCode === 200 ? 'ok' : errorResponseSchema.parse(response.json()).code;
const pageOf = (response: InjectResponse): EventLogResponse => {
  expect(response.statusCode).toBe(200);
  return eventLogResponseSchema.parse(response.json());
};
const idsOf = ({ events }: EventLogResponse) => events.map(({ id }) => id);

describe('admin event log', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminId: number;
  let logLines: string[];

  const asAdmin = async (options: InjectOptions) =>
    await app.inject({
      ...options,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, adminId, 'admin') },
    });
  const listEvents = async (query: Record<string, string | number> = {}) =>
    await asAdmin({
      method: 'GET',
      url: '/api/admin/events',
      query: Object.fromEntries(Object.entries(query).map(([name, value]) => [name, `${value}`])),
    });
  const eventsOk = async (query: Record<string, string | number> = {}) =>
    pageOf(await listEvents(query));

  const asStudent = async (
    studentId: number,
    method: 'POST' | 'PUT',
    url: string,
    payload: Record<string, unknown>,
  ) => {
    await takeTurnFor(pool, studentId, url);
    const response = await app.inject({
      method,
      url,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      payload,
    });
    expect(codeOf(response)).toBe('ok');
  };
  const register = async (studentId: number, clubId: number) =>
    await asStudent(studentId, 'POST', '/api/student/registration', {
      clubId,
      idempotencyKey: newKey(),
    });
  const change = async (studentId: number, clubId: number) =>
    await asStudent(studentId, 'PUT', '/api/student/registration', {
      clubId,
      idempotencyKey: newKey(),
    });
  const cancel = async (studentId: number) =>
    await asStudent(studentId, 'POST', '/api/student/registration/cancel', {
      idempotencyKey: newKey(),
    });
  const join = async (studentId: number, clubId: number) =>
    await asStudent(studentId, 'POST', '/api/student/waitlist', {
      clubId,
      idempotencyKey: newKey(),
    });
  const leave = async (studentId: number) =>
    await asStudent(studentId, 'POST', '/api/student/waitlist/leave', {
      idempotencyKey: newKey(),
    });
  const adminWrite = async (url: string, studentId: number) => {
    const response = await asAdmin({
      method: 'POST',
      url,
      payload: { loginId: await loginOf(studentId), idempotencyKey: newKey() },
    });
    expect(codeOf(response)).toBe('ok');
  };

  const loginOf = async (userId: number) => {
    const { rows } = await pool.query<{ login_id: string }>(
      'SELECT login_id FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]!.login_id;
  };

  const clubCodeOf = async (clubId: number) => {
    const { rows } = await pool.query<{ club_code: string }>(
      'SELECT club_code FROM clubs WHERE id = $1',
      [clubId],
    );
    return rows[0]!.club_code;
  };

  // Every event id, newest first, matching the given SQL condition on registration_events.
  const storedIds = async (where = 'true', values: unknown[] = []) => {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM registration_events WHERE ${where} ORDER BY id DESC`,
      values,
    );
    return rows.map(({ id }) => id);
  };

  const newClub = async (roundId: number, capacity: number) =>
    await createClub(pool, roundId, uniqueCode(), { name: CLUB_NAME, capacity });

  // Every event type, both kinds of promotion actor and an admin's waitlist removal, across two
  // rounds:
  //   s1 registers A, s2 registers B, s3 joins A, s2 joins A, s3 moves to B's queue (from A);
  //   s1 cancels A: s2 is promoted into A from B (actor s1), and s3 into B (cascade, actor s1);
  //   s4 joins A; the admin removes s2 from A: s4 is promoted (actor admin);
  //   s3 changes from B to E; s1 joins A and the admin takes the entry off; s2 joins A and leaves;
  //   in round 2 the admin seats t1 in C, then moves them to D.
  const seedScenario = async () => {
    const round1 = await createOpenRound(pool, 1);
    const round2 = await createOpenRound(pool, 2);
    const [clubA, clubB, clubE, clubC, clubD] = [
      await newClub(round1, 1),
      await newClub(round1, 1),
      await newClub(round1, 5),
      await newClub(round2, 5),
      await newClub(round2, 5),
    ];
    const [s1, s2, s3, s4] = await createStudents(pool, 4, { grade: 1 });
    const [t1] = await createStudents(pool, 1, { grade: 2 });
    const membersUrl = (clubId: number) => `/api/admin/clubs/${clubId}/members`;

    await register(s1!, clubA);
    await register(s2!, clubB);
    await join(s3!, clubA);
    await join(s2!, clubA);
    await join(s3!, clubB);
    await cancel(s1!);
    await join(s4!, clubA);
    await adminWrite(`${membersUrl(clubA)}/remove`, s2!);
    await change(s3!, clubE);
    await join(s1!, clubA);
    await adminWrite(`/api/admin/clubs/${clubA}/waitlist/remove`, s1!);
    await join(s2!, clubA);
    await leave(s2!);
    await adminWrite(membersUrl(clubC), t1!);
    await adminWrite(membersUrl(clubD), t1!);

    return {
      round1,
      round2,
      clubs: { clubA, clubB, clubE, clubC, clubD },
      students: { s1: s1!, s2: s2!, s3: s3!, s4: s4!, t1: t1! },
    };
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
    adminId = await createAdminId(pool);
  });

  afterEach(async () => {
    await app.close();
    expect(await registrationInvariantViolations(pool)).toEqual([]);
  });

  describe('GET /api/admin/events', () => {
    it('lists every event newest first', async () => {
      await seedScenario();

      const page = await eventsOk();

      expect(idsOf(page)).toEqual(await storedIds());
      expect(page.nextBefore).toBeNull();
      expect(new Set(page.events.map(({ eventType }) => eventType))).toEqual(new Set(EVENT_TYPES));
    });

    it('answers each event with its round, student, clubs and actor', async () => {
      const { round1, clubs, students } = await seedScenario();
      const { rows } = await pool.query<{ term: string }>('SELECT term FROM rounds WHERE id = $1', [
        round1,
      ]);
      const { rows: stored } = await pool.query<{ created_at: Date }>(
        `SELECT created_at FROM registration_events
         WHERE event_type = 'register' AND student_id = $1`,
        [students.s1],
      );
      const { rows: admins } = await pool.query<{ login_id: string }>(
        'SELECT login_id FROM users WHERE id = $1',
        [adminId],
      );

      const { events } = await eventsOk();
      const find = (predicate: (event: RegistrationEvent) => boolean) => events.filter(predicate);

      const studentActor = {
        id: students.s1,
        loginId: await loginOf(students.s1),
        fullName: STUDENT_NAME,
        role: 'student',
      };
      const adminActor = {
        id: adminId,
        loginId: admins[0]!.login_id,
        fullName: ADMIN_NAME,
        role: 'admin',
      };
      const clubRef = async (id: number) => ({
        id,
        clubCode: await clubCodeOf(id),
        name: CLUB_NAME,
      });
      expect(find(({ eventType }) => eventType === 'register').at(-1)).toEqual({
        id: expect.any(Number) as number,
        createdAt: stored[0]!.created_at.toISOString(),
        eventType: 'register',
        round: { id: round1, term: rows[0]!.term, grade: 1 },
        student: {
          id: students.s1,
          loginId: await loginOf(students.s1),
          fullName: STUDENT_NAME,
          classroom: '1',
          seatNo: 1,
        },
        club: await clubRef(clubs.clubA),
        fromClub: null,
        actor: studentActor,
      });
      // The two promotions s1's cancel caused, newest first: the cascade into B, then s2 from B.
      expect(
        find(
          ({ eventType, actor }) => eventType === 'waitlist_promote' && actor.id === students.s1,
        ),
      ).toEqual([
        expect.objectContaining({
          student: expect.objectContaining({ id: students.s3 }) as unknown,
          club: await clubRef(clubs.clubB),
          fromClub: null,
          actor: studentActor,
        }),
        expect.objectContaining({
          student: expect.objectContaining({ id: students.s2 }) as unknown,
          club: await clubRef(clubs.clubA),
          fromClub: await clubRef(clubs.clubB),
          actor: studentActor,
        }),
      ]);
      expect(
        find(({ eventType, actor }) => eventType === 'waitlist_promote' && actor.id === adminId),
      ).toEqual([
        expect.objectContaining({
          student: expect.objectContaining({ id: students.s4 }) as unknown,
          club: await clubRef(clubs.clubA),
          actor: adminActor,
        }),
      ]);
      expect(find(({ eventType }) => eventType === 'admin_assign')).toEqual([
        expect.objectContaining({
          club: await clubRef(clubs.clubD),
          fromClub: await clubRef(clubs.clubC),
          actor: adminActor,
        }),
        expect.objectContaining({ club: await clubRef(clubs.clubC), fromClub: null }),
      ]);
      expect(find(({ eventType }) => eventType === 'waitlist_leave')).toEqual([
        expect.objectContaining({
          student: expect.objectContaining({ id: students.s2 }) as unknown,
          actor: expect.objectContaining({ id: students.s2, role: 'student' }) as unknown,
        }),
        expect.objectContaining({
          student: expect.objectContaining({ id: students.s1 }) as unknown,
          club: await clubRef(clubs.clubA),
          actor: adminActor,
        }),
      ]);
      expect(find(({ eventType }) => eventType === 'change')).toEqual([
        expect.objectContaining({
          club: await clubRef(clubs.clubE),
          fromClub: await clubRef(clubs.clubB),
        }),
      ]);
    });

    it('never answers with an idempotency key', async () => {
      await seedScenario();
      const { rows } = await pool.query<{ idempotency_key: string }>(
        'SELECT idempotency_key FROM registration_events WHERE idempotency_key IS NOT NULL',
      );

      const response = await listEvents();

      expect(rows.length).toBeGreaterThan(10);
      rows.forEach(({ idempotency_key: key }) => expect(response.body).not.toContain(key));
      expect(response.body).not.toMatch(/idempotency/i);
    });

    it('filters by round', async () => {
      const { round2 } = await seedScenario();

      const page = await eventsOk({ roundId: round2 });

      expect(idsOf(page)).toEqual(await storedIds('round_id = $1', [round2]));
      expect(page.events).toHaveLength(2);
    });

    it('filters by student', async () => {
      const { students } = await seedScenario();

      const page = await eventsOk({ studentId: students.s3 });

      expect(idsOf(page)).toEqual(await storedIds('student_id = $1', [students.s3]));
      expect(page.events.every(({ student }) => student.id === students.s3)).toBe(true);
    });

    it('filters by login ID', async () => {
      const { students } = await seedScenario();

      const page = await eventsOk({ loginId: await loginOf(students.s3) });

      expect(idsOf(page)).toEqual(await storedIds('student_id = $1', [students.s3]));
      expect(page.events.length).toBeGreaterThan(0);
    });

    it('matches a login ID typed in upper case with spaces around it', async () => {
      const { students } = await seedScenario();
      const loginId = await loginOf(students.s2);

      const page = await eventsOk({ loginId: `  ${loginId.toUpperCase()} ` });

      expect(idsOf(page)).toEqual(await storedIds('student_id = $1', [students.s2]));
      expect(page.events.every(({ student }) => student.loginId === loginId)).toBe(true);
    });

    it('answers an empty page for a login ID no student has, or an admin has', async () => {
      await seedScenario();

      const unknown = await eventsOk({ loginId: 'fictional-nobody' });
      const admin = await eventsOk({ loginId: await loginOf(adminId) });

      expect(unknown).toEqual({ events: [], nextBefore: null });
      expect(admin).toEqual({ events: [], nextBefore: null });
    });

    it('combines a login ID with a round by AND', async () => {
      const { round1, round2, students } = await seedScenario();
      const loginId = await loginOf(students.t1);

      const ownRound = await eventsOk({ loginId, roundId: round2 });
      const otherRound = await eventsOk({ loginId, roundId: round1 });

      expect(idsOf(ownRound)).toEqual(
        await storedIds('round_id = $1 AND student_id = $2', [round2, students.t1]),
      );
      expect(ownRound.events).toHaveLength(2);
      expect(otherRound.events).toEqual([]);
    });

    it('needs a login ID and a student id given together to name the same student', async () => {
      const { students } = await seedScenario();
      const loginId = await loginOf(students.s1);

      const same = await eventsOk({ loginId, studentId: students.s1 });
      const conflicting = await eventsOk({ loginId, studentId: students.s2 });

      expect(idsOf(same)).toEqual(await storedIds('student_id = $1', [students.s1]));
      expect(conflicting).toEqual({ events: [], nextBefore: null });
    });

    it('filters by club, matching the club an event left as well', async () => {
      const { clubs } = await seedScenario();

      const page = await eventsOk({ clubId: clubs.clubB });

      const expected = await storedIds('club_id = $1 OR from_club_id = $1', [clubs.clubB]);
      expect(idsOf(page)).toEqual(expected);
      // The promotion of s2 from B into A and s3's change from B to E name B only as the club left.
      expect(
        page.events
          .filter(({ club }) => club?.id !== clubs.clubB)
          .map(({ eventType }) => eventType),
      ).toEqual(['change', 'waitlist_promote']);
    });

    it('matches a waitlist join by the queue it gave up', async () => {
      const { clubs, students } = await seedScenario();

      const page = await eventsOk({ clubId: clubs.clubA, studentId: students.s3 });

      expect(
        page.events.map(({ eventType, club, fromClub }) => [eventType, club?.id, fromClub?.id]),
      ).toEqual([
        ['waitlist_join', clubs.clubB, clubs.clubA],
        ['waitlist_join', clubs.clubA, undefined],
      ]);
    });

    it('combines filters with AND', async () => {
      const { round1, round2, clubs, students } = await seedScenario();

      const roundAndStudent = await eventsOk({ roundId: round1, studentId: students.s2 });
      const roundAndClub = await eventsOk({ roundId: round1, clubId: clubs.clubE });
      const otherRoundsClub = await eventsOk({ roundId: round2, clubId: clubs.clubA });
      const allThree = await eventsOk({
        roundId: round1,
        studentId: students.s1,
        clubId: clubs.clubA,
      });

      expect(idsOf(roundAndStudent)).toEqual(
        await storedIds('round_id = $1 AND student_id = $2', [round1, students.s2]),
      );
      expect(idsOf(roundAndClub)).toEqual(
        await storedIds('round_id = $1 AND (club_id = $2 OR from_club_id = $2)', [
          round1,
          clubs.clubE,
        ]),
      );
      expect(otherRoundsClub.events).toEqual([]);
      expect(allThree.events.map(({ eventType }) => eventType)).toEqual([
        'waitlist_leave',
        'waitlist_join',
        'cancel',
        'register',
      ]);
    });

    it('answers an empty page, not 404, for ids that match nothing', async () => {
      await seedScenario();

      const pages = await Promise.all([
        eventsOk({ roundId: UNKNOWN_ID }),
        eventsOk({ studentId: UNKNOWN_ID }),
        eventsOk({ clubId: UNKNOWN_ID }),
        eventsOk({ before: 1 }),
      ]);

      expect(pages).toEqual(Array.from({ length: 4 }, () => ({ events: [], nextBefore: null })));
    });
  });

  describe('paging', () => {
    it('pages through every event once, newest first, with nextBefore', async () => {
      await seedScenario();
      const all = await storedIds();

      const pages: EventLogResponse[] = [];
      let before: number | null = null;
      do {
        const page: EventLogResponse = await eventsOk({
          limit: 4,
          ...(before === null ? {} : { before }),
        });
        pages.push(page);
        before = page.nextBefore;
      } while (before !== null);

      expect(pages.flatMap(idsOf)).toEqual(all);
      expect(pages.slice(0, -1).every(({ events }) => events.length === 4)).toBe(true);
      expect(pages.slice(0, -1).map(({ nextBefore }) => nextBefore)).toEqual(
        pages.slice(0, -1).map(({ events }) => events.at(-1)!.id),
      );
    });

    it('pages through the events of one login ID with nextBefore', async () => {
      const { students } = await seedScenario();
      const loginId = (await loginOf(students.s2)).toUpperCase();
      const all = await storedIds('student_id = $1', [students.s2]);

      const pages: EventLogResponse[] = [];
      let before: number | null = null;
      do {
        const page: EventLogResponse = await eventsOk({
          loginId,
          limit: 2,
          ...(before === null ? {} : { before }),
        });
        pages.push(page);
        before = page.nextBefore;
      } while (before !== null);

      expect(all.length).toBeGreaterThan(4);
      expect(pages.flatMap(idsOf)).toEqual(all);
      expect(pages.slice(0, -1).map(({ nextBefore }) => nextBefore)).toEqual(
        pages.slice(0, -1).map(({ events }) => events.at(-1)!.id),
      );
    });

    it('says there is no older page when the last one is exactly full', async () => {
      await seedScenario();
      const all = await storedIds();

      const exact = await eventsOk({ limit: all.length });
      const oneShort = await eventsOk({ limit: all.length - 1 });
      const rest = await eventsOk({ limit: all.length - 1, before: oneShort.nextBefore! });

      expect(exact.nextBefore).toBeNull();
      expect(oneShort.nextBefore).toBe(all.at(-2));
      expect(idsOf(rest)).toEqual([all.at(-1)]);
      expect(rest.nextBefore).toBeNull();
    });

    it('neither repeats nor skips an event when new ones are written between pages', async () => {
      const { round1 } = await seedScenario();
      const roomy = await newClub(round1, 30);
      const before = await storedIds();
      const first = await eventsOk({ limit: 5 });
      const newcomers = await createStudents(pool, 3);
      for (const studentId of newcomers) await seatStudent(pool, studentId, roomy);

      const pages: EventLogResponse[] = [first];
      for (let cursor = first.nextBefore; cursor !== null;) {
        const page = await eventsOk({ limit: 5, before: cursor });
        pages.push(page);
        cursor = page.nextBefore;
        if (cursor !== null) {
          await seatStudent(pool, await createStudentId(pool), roomy);
        }
      }
      const fresh = await eventsOk({ limit: 50, roundId: round1 });

      expect(pages.flatMap(idsOf)).toEqual(before);
      const added = (await storedIds()).filter((id) => !before.includes(id));
      expect(idsOf(fresh).slice(0, added.length)).toEqual(added);
    });

    it('lists 50 by default and up to 200', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await newClub(roundId, 205);
      const students = await createStudents(pool, 205);
      for (const studentId of students) await seatStudent(pool, studentId, clubId);
      const all = await storedIds();

      const byDefault = await eventsOk();
      const most = await eventsOk({ limit: 200 });

      expect(idsOf(byDefault)).toEqual(all.slice(0, 50));
      expect(byDefault.nextBefore).toBe(all[49]);
      expect(idsOf(most)).toEqual(all.slice(0, 200));
      expect(most.nextBefore).toBe(all[199]);
    });
  });

  describe('requests', () => {
    it.each([
      ['limit 0', { limit: '0' }],
      ['limit 201', { limit: '201' }],
      ['a fractional limit', { limit: '2.5' }],
      ['a limit that is no number', { limit: 'all' }],
      ['before 0', { before: '0' }],
      ['a round id that is no number', { roundId: 'abc' }],
      ['a negative student id', { studentId: '-1' }],
      ['an empty club id', { clubId: '' }],
      ['an unknown parameter', { actorId: '1' }],
      ['a misspelt filter', { clubid: '1' }],
      ['an event type filter, which is not offered', { eventType: 'register' }],
      ['an empty login ID', { loginId: '' }],
      ['a login ID of spaces only', { loginId: '   ' }],
      ['a login ID with a character no login has', { loginId: 'fictional student' }],
      ['a login ID over 64 characters', { loginId: 'a'.repeat(65) }],
    ])('refuses %s with 400', async (_case, query) => {
      const response = await listEvents(query);

      expect(response.statusCode).toBe(400);
      expect(codeOf(response)).toBe('validation_error');
    });

    it.each([
      ['a round', 'roundId=1&roundId=2'],
      ['a login ID', 'loginId=fictional-a&loginId=fictional-b'],
    ])('refuses %s given twice with 400', async (_case, query) => {
      const response = await asAdmin({ method: 'GET', url: `/api/admin/events?${query}` });

      expect(response.statusCode).toBe(400);
    });

    it('is for admins only', async () => {
      const studentId = await createStudentId(pool);

      const asStudentResponse = await app.inject({
        method: 'GET',
        url: '/api/admin/events',
        cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      });
      const anonymous = await app.inject({ method: 'GET', url: '/api/admin/events' });

      expect(asStudentResponse.statusCode).toBe(403);
      expect(anonymous.statusCode).toBe(401);
    });

    it('logs no name, login ID or club name, and no filter value', async () => {
      const { round1, clubs, students } = await seedScenario();
      const scenarioLogLines = logLines.length;
      const loginIds = await Promise.all([...Object.values(students), adminId].map(loginOf));

      const typedLoginId = ` ${(await loginOf(students.s4)).toUpperCase()} `;
      const malformedLoginId = 'FICTIONAL BAD!';

      await listEvents();
      await listEvents({ roundId: round1, studentId: students.s3, clubId: clubs.clubB });
      const filtered = await listEvents({ loginId: typedLoginId, roundId: round1 });
      const refused = await listEvents({ loginId: malformedLoginId });
      await listEvents({ clubid: 'fictional-text' });

      const log = logLines.slice(scenarioLogLines).join('\n');
      expect(log).toContain('/api/admin/events');
      expect(log).not.toContain(STUDENT_NAME);
      expect(log).not.toContain(ADMIN_NAME);
      expect(log).not.toContain(CLUB_NAME);
      expect(filtered.statusCode).toBe(200);
      expect(refused.statusCode).toBe(400);
      expect(log).toContain('"loginId"');
      expect(log).not.toContain('fictional-text');
      expect(log).not.toContain(typedLoginId.trim());
      expect(log).not.toContain(encodeURIComponent(typedLoginId));
      expect(log).not.toContain('FICTIONAL');
      expect(log).not.toContain('BAD!');
      expect(log).not.toContain(`"${students.s3}"`);
      loginIds.forEach((loginId) => expect(log).not.toContain(loginId));
    });

    it('knows every event type the database allows', async () => {
      const { rows } = await pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'registration_events'::regclass AND conname LIKE '%event_type%'`,
      );
      const allowed = [...(rows[0]?.definition ?? '').matchAll(/'([a-z_]+)'/g)].map(
        ([, type]) => type,
      );

      expect([...allowed].sort()).toEqual([...EVENT_TYPES].sort());
    });
  });
});
