import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  errorResponseSchema,
  studentClubsResponseSchema,
  studentRoundResponseSchema,
} from '@club-registration/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool } from '../src/db.js';
import { TEST_JWT_SECRET, createTestUser } from './support/app.js';
import type { TestUser } from './support/app.js';
import {
  createClub,
  createStudent,
  register,
  uniqueCode,
  uniqueTerm,
} from './support/import-db.js';
import {
  appConnectionUri,
  startMigratedPostgres,
  stopPostgres,
  truncateAsOwner,
} from './support/postgres.js';
import { takeTurn } from './support/queue.js';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

type AdvisorFields = {
  fullName: string;
  phone: string | null;
  email: string | null;
  lineId: string | null;
};

// Every value below is made up.
const STUDENT_NAME = 'นักเรียนสมมติ ทดสอบอ่าน';
const ADVISOR: Readonly<AdvisorFields> = Object.freeze({
  fullName: 'ครูสมมติ ที่ปรึกษา',
  phone: '080-000-0002',
  email: 'fictional.advisor@example.com',
  lineId: 'fictional.advisor.line',
});

const ROUND_URL = '/api/student/round';
const CLUBS_URL = '/api/student/clubs';
const STUDENT_URLS = [ROUND_URL, CLUBS_URL] as const;

const errorOf = (response: InjectResponse) => errorResponseSchema.parse(response.json());
const roundOf = (response: InjectResponse) => studentRoundResponseSchema.parse(response.json());
const clubsOf = (response: InjectResponse) => studentClubsResponseSchema.parse(response.json());

describe('student read API', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let logLines: string[];

  const loginAs = async (user: TestUser): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { loginId: user.loginId, password: user.password },
    });
    expect(response.statusCode).toBe(200);
    return response.cookies.find((cookie) => cookie.name === SESSION_COOKIE)!.value;
  };

  const get = async (url: string, token: string) =>
    await app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: token } });

  // A student who can log in, with a profile in the given grade.
  const createStudentAccount = async ({
    grade = 1,
    mustChangePassword = false,
  }: { grade?: number; mustChangePassword?: boolean } = {}) => {
    const user = await createTestUser(pool, { mustChangePassword });
    await pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [user.id, STUDENT_NAME]);
    await pool.query(
      `INSERT INTO student_profiles (user_id, grade, classroom, seat_no)
       VALUES ($1, $2, '1', 1)`,
      [user.id, grade],
    );
    return user;
  };

  const loginStudent = async (grade = 1) => {
    const user = await createStudentAccount({ grade });
    return { user, token: await loginAs(user) };
  };

  // Window edges in hours from now; negative = in the past.
  const createRoundAt = async (grade: number, opensInHours: number, closesInHours: number) => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO rounds (term, grade, opens_at, closes_at)
       VALUES ($1, $2, now() + $3::int * interval '1 hour', now() + $4::int * interval '1 hour')
       RETURNING id`,
      [uniqueTerm(), grade, opensInHours, closesInHours],
    );
    return rows[0]!.id;
  };

  const openRound = async (grade = 1) => await createRoundAt(grade, -1, 1);
  const upcomingRound = async (grade = 1, opensInHours = 24) =>
    await createRoundAt(grade, opensInHours, opensInHours + 24);
  const closedRound = async (grade = 1, closedHoursAgo = 24) =>
    await createRoundAt(grade, -closedHoursAgo - 24, -closedHoursAgo);

  const addAdvisor = async (clubId: number, advisor: Partial<AdvisorFields> = {}) => {
    const { fullName, phone, email, lineId } = { ...ADVISOR, ...advisor };
    await pool.query(
      `INSERT INTO club_advisors (club_id, full_name, phone, email, line_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [clubId, fullName, phone, email, lineId],
    );
  };

  // Fills seats with other (non-login) students, keeping clubs.registered equal to the rows.
  const fillSeats = async (roundId: number, clubId: number, count: number, grade = 1) => {
    for (let seat = 0; seat < count; seat += 1) {
      const { id } = await createStudent(pool, { grade, seatNo: seat + 2 });
      await register(pool, roundId, id, clubId);
    }
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(appConnectionUri(container));
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    // A student sees whatever rounds their grade has, so each test starts with none at all.
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
  });

  describe('GET /api/student/round', () => {
    it('returns the open round of the student grade without admin-only fields', async () => {
      const { token } = await loginStudent(2);
      const roundId = await openRound(2);

      const response = await get(ROUND_URL, token);

      expect(response.statusCode).toBe(200);
      const { rows } = await pool.query<{ term: string; opens_at: Date; closes_at: Date }>(
        'SELECT term, opens_at, closes_at FROM rounds WHERE id = $1',
        [roundId],
      );
      const stored = rows[0]!;
      expect(response.json()).toEqual({
        round: {
          id: roundId,
          term: stored.term,
          grade: 2,
          opensAt: stored.opens_at.toISOString(),
          closesAt: stored.closes_at.toISOString(),
          status: 'open',
        },
        registration: null,
        waitlist: null,
      });
    });

    it('prefers the open round over upcoming and closed ones', async () => {
      const { token } = await loginStudent();
      await closedRound();
      await upcomingRound();
      const open = await openRound();

      const { round } = roundOf(await get(ROUND_URL, token));

      expect(round).toMatchObject({ id: open, status: 'open' });
    });

    it('prefers an upcoming round over a closed one', async () => {
      const { token } = await loginStudent();
      await closedRound(1, 1);
      const upcoming = await upcomingRound(1, 48);

      const { round } = roundOf(await get(ROUND_URL, token));

      expect(round).toMatchObject({ id: upcoming, status: 'upcoming' });
    });

    it('picks the upcoming round that opens soonest', async () => {
      const { token } = await loginStudent();
      await upcomingRound(1, 72);
      const soonest = await upcomingRound(1, 2);
      await upcomingRound(1, 24);

      const { round } = roundOf(await get(ROUND_URL, token));

      expect(round?.id).toBe(soonest);
    });

    it('picks the round that closed most recently when none is open or upcoming', async () => {
      const { token } = await loginStudent();
      await closedRound(1, 72);
      const latest = await closedRound(1, 2);
      await closedRound(1, 24);

      const { round } = roundOf(await get(ROUND_URL, token));

      expect(round).toMatchObject({ id: latest, status: 'closed' });
    });

    it("ignores other grades' rounds", async () => {
      const { token } = await loginStudent(3);
      await openRound(4);
      await upcomingRound(2);
      const own = await closedRound(3);

      const { round } = roundOf(await get(ROUND_URL, token));

      expect(round).toMatchObject({ id: own, grade: 3 });
    });

    it('answers round null, not an error, when the grade has no round', async () => {
      const { token } = await loginStudent(5);
      await openRound(4);

      const response = await get(ROUND_URL, token);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ round: null, registration: null, waitlist: null });
    });

    it("includes the student's registration in the selected round", async () => {
      const { user, token } = await loginStudent();
      const roundId = await openRound();
      const clubId = await createClub(pool, roundId, 'A100', { name: 'ชุมนุมหมากรุกสมมติ' });
      await register(pool, roundId, user.id, clubId);
      const { rows } = await pool.query<{ created_at: Date }>(
        'SELECT created_at FROM registrations WHERE student_id = $1',
        [user.id],
      );

      const { registration } = roundOf(await get(ROUND_URL, token));

      expect(registration).toEqual({
        club: { id: clubId, clubCode: 'A100', name: 'ชุมนุมหมากรุกสมมติ' },
        registeredAt: rows[0]!.created_at.toISOString(),
        promotedFromWaitlist: false,
      });
    });

    it('leaves out a registration of another round of the same grade', async () => {
      const { user, token } = await loginStudent();
      const oldRound = await closedRound();
      const oldClub = await createClub(pool, oldRound, uniqueCode());
      await register(pool, oldRound, user.id, oldClub);
      const current = await openRound();

      const response = roundOf(await get(ROUND_URL, token));

      expect(response).toMatchObject({ round: { id: current }, registration: null });
    });

    it("never shows another student's registration", async () => {
      const { token } = await loginStudent();
      const roundId = await openRound();
      const clubId = await createClub(pool, roundId, uniqueCode());
      await fillSeats(roundId, clubId, 1);

      const { registration } = roundOf(await get(ROUND_URL, token));

      expect(registration).toBeNull();
    });
  });

  describe('GET /api/student/clubs', () => {
    it('lists the round clubs by code with remaining seats and advisor names', async () => {
      const { user, token } = await loginStudent();
      const roundId = await openRound();
      await takeTurn(pool, user.id);
      const second = await createClub(pool, roundId, 'B200', {
        name: 'ชุมนุมดนตรีสมมติ',
        capacity: 5,
        description: 'บรรทัดแรก\nบรรทัดสอง',
      });
      const first = await createClub(pool, roundId, 'A100', { name: 'ชุมนุมหมากรุกสมมติ' });
      await fillSeats(roundId, second, 3);
      await addAdvisor(second);
      await addAdvisor(second, { fullName: 'ครูสมมติ คนที่สอง', phone: null, email: null });

      const response = await get(CLUBS_URL, token);

      expect(response.statusCode).toBe(200);
      expect(clubsOf(response).clubs).toEqual([
        {
          id: first,
          clubCode: 'A100',
          name: 'ชุมนุมหมากรุกสมมติ',
          description: '',
          capacity: 30,
          registered: 0,
          remaining: 30,
          advisorNames: [],
          waitlistCount: 0,
        },
        {
          id: second,
          clubCode: 'B200',
          name: 'ชุมนุมดนตรีสมมติ',
          description: 'บรรทัดแรก\nบรรทัดสอง',
          capacity: 5,
          registered: 3,
          remaining: 2,
          advisorNames: [ADVISOR.fullName, 'ครูสมมติ คนที่สอง'],
          waitlistCount: 0,
        },
      ]);
    });

    it('lists only the clubs of the selected round', async () => {
      const { user, token } = await loginStudent();
      const current = await openRound();
      await takeTurn(pool, user.id);
      const clubId = await createClub(pool, current, uniqueCode());
      await createClub(pool, await closedRound(), uniqueCode());
      await createClub(pool, await openRound(2), uniqueCode());

      const { clubs } = clubsOf(await get(CLUBS_URL, token));

      expect(clubs.map(({ id }) => id)).toEqual([clubId]);
    });

    it('carries the same round and registration as GET /api/student/round', async () => {
      const { user, token } = await loginStudent();
      const roundId = await openRound();
      const clubId = await createClub(pool, roundId, uniqueCode());
      await register(pool, roundId, user.id, clubId);
      await takeTurn(pool, user.id);

      const [clubsResponse, roundResponse] = await Promise.all([
        get(CLUBS_URL, token),
        get(ROUND_URL, token),
      ]);

      const { round, registration, waitlist, clubs } = clubsOf(clubsResponse);
      expect({ round, registration, waitlist }).toEqual(roundOf(roundResponse));
      expect(registration?.club.id).toBe(clubId);
      expect(clubs).toMatchObject([{ id: clubId, registered: 1, remaining: 29 }]);
    });

    it('answers an empty list with round null when the grade has no round', async () => {
      const { token } = await loginStudent(6);

      const response = await get(CLUBS_URL, token);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        round: null,
        registration: null,
        waitlist: null,
        clubs: [],
      });
    });

    it("never sends advisors' phone, email or LINE ID", async () => {
      const { user, token } = await loginStudent();
      const roundId = await openRound();
      await takeTurn(pool, user.id);
      await addAdvisor(await createClub(pool, roundId, uniqueCode()));

      const response = await get(CLUBS_URL, token);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(ADVISOR.fullName);
      [ADVISOR.phone, ADVISOR.email, ADVISOR.lineId, 'phone', 'email', 'lineId'].forEach((value) =>
        expect(response.body).not.toContain(value),
      );
    });
  });

  describe('access control', () => {
    it.each(STUDENT_URLS)('forbids an admin from %s', async (url) => {
      const admin = await createTestUser(pool, { role: 'admin' });
      const response = await get(url, await loginAs(admin));

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('forbidden');
    });

    it.each(STUDENT_URLS)('requires a session for %s', async (url) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(401);
      expect(errorOf(response).code).toBe('unauthorized');
    });

    it.each(STUDENT_URLS)('keeps %s closed until the first password change', async (url) => {
      const student = await createStudentAccount({ mustChangePassword: true });
      await openRound();

      const response = await get(url, await loginAs(student));

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('password_change_required');
    });

    it.each(STUDENT_URLS)(
      'answers 403 student_profile_missing on %s for a student without a profile',
      async (url) => {
        await openRound();
        const response = await get(url, await loginAs(await createTestUser(pool)));

        expect(response.statusCode).toBe(403);
        expect(errorOf(response).code).toBe('student_profile_missing');
      },
    );

    it.each(
      STUDENT_URLS.flatMap((url) =>
        ['studentId=1', 'grade=2', 'roundId=1'].map((q) => `${url}?${q}`),
      ),
    )('rejects the query parameter in %s with 400', async (url) => {
      const { token } = await loginStudent();

      const response = await get(url, token);

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
    });

    it('checks the role before the query, so an admin gets 403, not 400', async () => {
      const admin = await createTestUser(pool, { role: 'admin' });

      const response = await get(`${CLUBS_URL}?grade=1`, await loginAs(admin));

      expect(response.statusCode).toBe(403);
    });
  });

  it('never writes student, club or advisor names or contacts to the log', async () => {
    const { user, token } = await loginStudent();
    const roundId = await openRound();
    const clubId = await createClub(pool, roundId, uniqueCode(), {
      name: 'ชุมนุมลับสมมติ',
      description: 'รายละเอียดลับสมมติ',
    });
    await addAdvisor(clubId);
    await register(pool, roundId, user.id, clubId);
    await takeTurn(pool, user.id);

    await get(ROUND_URL, token);
    await get(CLUBS_URL, token);
    await get(`${CLUBS_URL}?grade=1`, token);

    const log = logLines.join('\n');
    expect(logLines.length).toBeGreaterThan(0);
    [
      STUDENT_NAME,
      'ชุมนุมลับสมมติ',
      'รายละเอียดลับสมมติ',
      ADVISOR.fullName,
      ADVISOR.phone,
      ADVISOR.email,
      ADVISOR.lineId,
    ].forEach((value) => expect(log).not.toContain(value));
  });
});
