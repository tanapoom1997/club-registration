import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  errorResponseSchema,
  studentClubsResponseSchema,
  studentRegistrationResponseSchema,
  studentRoundResponseSchema,
  studentWaitlistResponseSchema,
} from '@club-registration/shared';
import type { StudentAdminChange } from '@club-registration/shared';
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
import { takeTurn, takeTurnFor } from './support/queue.js';
import {
  createAdminId,
  createClosedRound,
  createOpenRound,
  createStudentId,
  newKey,
  registrationInvariantViolations,
  seatStudent,
  sessionCookie,
} from './support/registration.js';

// What an admin last did to a student's seat or waitlist place, as the student's own answers tell
// it (README Phase 4, P3): through the real admin and student endpoints, against a real Postgres.
// Every value is made up.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const ADMIN_NAME = 'ผู้ดูแลสมมติ';
const ROUND_URL = '/api/student/round';
const CLUBS_URL = '/api/student/clubs';
const REGISTER_URL = '/api/student/registration';
const CANCEL_URL = '/api/student/registration/cancel';
const WAITLIST_URL = '/api/student/waitlist';
const LEAVE_URL = '/api/student/waitlist/leave';

type Club = { id: number; clubCode: string; name: string };

const codeOf = (response: InjectResponse) =>
  response.statusCode === 200 ? 'ok' : errorResponseSchema.parse(response.json()).code;
const roundOf = (response: InjectResponse) => studentRoundResponseSchema.parse(response.json());
const clubsOf = (response: InjectResponse) => studentClubsResponseSchema.parse(response.json());
const registrationOf = (response: InjectResponse) =>
  studentRegistrationResponseSchema.parse(response.json());
const waitlistOf = (response: InjectResponse) =>
  studentWaitlistResponseSchema.parse(response.json());

describe('adminChange in the student answers', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminId: number;
  let adminLoginId: string;

  const asAdmin = async (options: InjectOptions) =>
    await app.inject({
      ...options,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, adminId, 'admin') },
    });

  const loginOf = async (userId: number) => {
    const { rows } = await pool.query<{ login_id: string }>(
      'SELECT login_id FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]!.login_id;
  };

  const adminWrite = async (url: string, studentId: number) => {
    const response = await asAdmin({
      method: 'POST',
      url,
      payload: { loginId: await loginOf(studentId), idempotencyKey: newKey() },
    });
    expect(codeOf(response)).toBe('ok');
  };
  const adminAssign = async (club: Club, studentId: number) =>
    await adminWrite(`/api/admin/clubs/${club.id}/members`, studentId);
  const adminRemove = async (club: Club, studentId: number) =>
    await adminWrite(`/api/admin/clubs/${club.id}/members/remove`, studentId);
  const adminRemoveFromWaitlist = async (club: Club, studentId: number) =>
    await adminWrite(`/api/admin/clubs/${club.id}/waitlist/remove`, studentId);

  // As the page sends them: a queue turn first for the gated paths (Q2).
  const asStudent = async (
    studentId: number,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: Record<string, unknown>,
  ) => {
    await takeTurnFor(pool, studentId, url);
    return await app.inject({
      method,
      url,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      ...(payload === undefined ? {} : { payload }),
    });
  };
  const readRound = async (studentId: number) => await asStudent(studentId, 'GET', ROUND_URL);
  const readClubs = async (studentId: number) => await asStudent(studentId, 'GET', CLUBS_URL);
  const register = async (studentId: number, club: Club, idempotencyKey = newKey()) =>
    await asStudent(studentId, 'POST', REGISTER_URL, { clubId: club.id, idempotencyKey });
  const change = async (studentId: number, club: Club) =>
    await asStudent(studentId, 'PUT', REGISTER_URL, { clubId: club.id, idempotencyKey: newKey() });
  const cancel = async (studentId: number) =>
    await asStudent(studentId, 'POST', CANCEL_URL, { idempotencyKey: newKey() });
  const join = async (studentId: number, club: Club) =>
    await asStudent(studentId, 'POST', WAITLIST_URL, { clubId: club.id, idempotencyKey: newKey() });
  const leave = async (studentId: number) =>
    await asStudent(studentId, 'POST', LEAVE_URL, { idempotencyKey: newKey() });

  // The adminChange of both reads, which must always agree (one snapshot each, same rule).
  const adminChangeOf = async (studentId: number): Promise<StudentAdminChange | null> => {
    const fromRound = roundOf(await readRound(studentId)).adminChange;
    const fromClubs = clubsOf(await readClubs(studentId)).adminChange;
    expect(fromClubs).toEqual(fromRound);
    return fromRound;
  };

  // When the student's latest event of this type was written, as the answer's `at` must say.
  const latestEventAt = async (studentId: number, eventType: string) => {
    const { rows } = await pool.query<{ created_at: Date }>(
      `SELECT created_at FROM registration_events
       WHERE student_id = $1 AND event_type = $2 ORDER BY id DESC LIMIT 1`,
      [studentId, eventType],
    );
    return rows[0]!.created_at.toISOString();
  };

  const clubIn = async (roundId: number, { capacity = 3 }: { capacity?: number } = {}) => {
    const clubCode = uniqueCode();
    const name = `ชุมนุมสมมติ ${clubCode}`;
    const id = await createClub(pool, roundId, clubCode, { name, capacity });
    return { id, clubCode, name };
  };

  // A club with one seat, taken by someone else, so the student can only wait for it.
  const fullClubIn = async (roundId: number) => {
    const club = await clubIn(roundId, { capacity: 1 });
    await seatStudent(pool, await createStudentId(pool), club.id);
    return club;
  };

  // One open round with two roomy clubs, a full one, and a student with nothing in it yet.
  const setup = async () => {
    const roundId = await createOpenRound(pool);
    const [x, y, full] = [await clubIn(roundId), await clubIn(roundId), await fullClubIn(roundId)];
    return { roundId, x, y, full, studentId: await createStudentId(pool) };
  };

  type Setup = Awaited<ReturnType<typeof setup>>;

  // Each admin action on a student, and what the student is then told.
  const ADMIN_ACTIONS: Readonly<
    Record<
      StudentAdminChange['kind'],
      {
        event: string;
        act: (s: Setup) => Promise<void>;
        expected: (s: Setup) => Omit<StudentAdminChange, 'at'>;
      }
    >
  > = Object.freeze({
    assigned: {
      event: 'admin_assign',
      act: async ({ x, studentId }) => await adminAssign(x, studentId),
      expected: ({ x }) => ({ kind: 'assigned', club: x }),
    },
    moved: {
      event: 'admin_assign',
      act: async ({ x, y, studentId }) => {
        expect(codeOf(await register(studentId, y))).toBe('ok');
        await adminAssign(x, studentId);
      },
      expected: ({ x, y }) => ({ kind: 'moved', club: x, fromClub: y }),
    },
    removed: {
      event: 'admin_remove',
      act: async ({ x, studentId }) => {
        expect(codeOf(await register(studentId, x))).toBe('ok');
        await adminRemove(x, studentId);
      },
      expected: ({ x }) => ({ kind: 'removed', club: x }),
    },
    waitlist_removed: {
      event: 'waitlist_leave',
      act: async ({ full, studentId }) => {
        expect(codeOf(await join(studentId, full))).toBe('ok');
        await adminRemoveFromWaitlist(full, studentId);
      },
      expected: ({ full }) => ({ kind: 'waitlist_removed', club: full }),
    },
  });
  const KINDS = Object.keys(ADMIN_ACTIONS) as StudentAdminChange['kind'][];

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(appConnectionUri(container));
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    await truncateAsOwner(container, ['rounds']);
    app = await buildApp({ pool, jwtSecret: TEST_JWT_SECRET, logger: false });
    adminId = await createAdminId(pool);
    adminLoginId = await loginOf(adminId);
  });

  afterEach(async () => {
    await app.close();
    expect(await registrationInvariantViolations(pool)).toEqual([]);
  });

  describe('reads', () => {
    it.each(KINDS)('tells the student when an admin action left them %s', async (kind) => {
      const s = await setup();
      const action = ADMIN_ACTIONS[kind];
      await action.act(s);

      const adminChange = await adminChangeOf(s.studentId);

      expect(adminChange).toEqual({
        ...action.expected(s),
        at: await latestEventAt(s.studentId, action.event),
      });
    });

    it('shows the state the change left beside it', async () => {
      const s = await setup();
      await ADMIN_ACTIONS.moved.act(s);

      const answer = roundOf(await readRound(s.studentId));

      expect(answer.registration).toMatchObject({ club: s.x, promotedFromWaitlist: false });
      expect(answer.adminChange?.kind).toBe('moved');
    });

    it.each(KINDS)('never names the admin who left the student %s', async (kind) => {
      const s = await setup();
      await ADMIN_ACTIONS[kind].act(s);

      const responses = [await readRound(s.studentId), await readClubs(s.studentId)];

      for (const response of responses) {
        expect(response.body).not.toContain(adminLoginId);
        expect(response.body).not.toContain(ADMIN_NAME);
        const raw = response.json<{ adminChange: Record<string, unknown> }>().adminChange;
        expect(Object.keys(raw).sort()).toEqual(
          kind === 'moved' ? ['at', 'club', 'fromClub', 'kind'] : ['at', 'club', 'kind'],
        );
        // Clubs as the student sees them elsewhere: id, code and name only.
        expect(Object.keys(raw.club as object).sort()).toEqual(['clubCode', 'id', 'name']);
      }
    });

    // Whatever the student does next, they then know their state.
    const NEXT_STUDENT_ACTION: Readonly<
      Record<StudentAdminChange['kind'], (s: Setup) => Promise<InjectResponse>>
    > = Object.freeze({
      assigned: async ({ studentId }) => await cancel(studentId),
      moved: async ({ y, studentId }) => await change(studentId, y),
      removed: async ({ y, studentId }) => await register(studentId, y),
      waitlist_removed: async ({ full, studentId }) => await join(studentId, full),
    });

    it.each(KINDS)('forgets %s once the student acts themselves', async (kind) => {
      const s = await setup();
      await ADMIN_ACTIONS[kind].act(s);
      expect(await adminChangeOf(s.studentId)).not.toBeNull();

      const response = await NEXT_STUDENT_ACTION[kind](s);

      expect(codeOf(response)).toBe('ok');
      expect(response.json<{ adminChange: unknown }>().adminChange).toBeNull();
      expect(await adminChangeOf(s.studentId)).toBeNull();
    });

    it('stays null through the student own register, change, join, leave and cancel', async () => {
      const { x, y, full, studentId } = await setup();
      const steps = [
        async () => await register(studentId, x),
        async () => await change(studentId, y),
        async () => await join(studentId, full),
        async () => await leave(studentId),
        async () => await cancel(studentId),
      ];

      for (const step of steps) {
        const response = await step();
        expect(codeOf(response)).toBe('ok');
        expect(response.json<{ adminChange: unknown }>().adminChange).toBeNull();
        expect(await adminChangeOf(studentId)).toBeNull();
      }
    });

    it('leaves a promotion that an admin removal caused to promotedFromWaitlist', async () => {
      const { full, studentId } = await setup();
      const { rows } = await pool.query<{ student_id: number }>(
        'SELECT student_id FROM registrations WHERE club_id = $1',
        [full.id],
      );
      const holder = rows[0]!.student_id;
      expect(codeOf(await join(studentId, full))).toBe('ok');

      // The freed seat promotes the waiter under the admin's id.
      await adminRemove(full, holder);

      const answer = roundOf(await readRound(studentId));
      expect(answer.registration).toMatchObject({ club: full, promotedFromWaitlist: true });
      expect(answer.adminChange).toBeNull();
      expect(await adminChangeOf(studentId)).toBeNull();
      expect((await adminChangeOf(holder))?.kind).toBe('removed');
    });

    it('lets a promotion after an admin move replace the move notice', async () => {
      const { x, full, studentId } = await setup();
      const { rows } = await pool.query<{ student_id: number }>(
        'SELECT student_id FROM registrations WHERE club_id = $1',
        [full.id],
      );
      expect(codeOf(await join(studentId, full))).toBe('ok');
      await adminAssign(x, studentId);
      expect((await adminChangeOf(studentId))?.kind).toBe('assigned');

      await adminRemove(full, rows[0]!.student_id);

      const answer = roundOf(await readRound(studentId));
      expect(answer.registration).toMatchObject({ club: full, promotedFromWaitlist: true });
      expect(answer.waitlist).toBeNull();
      expect(answer.adminChange).toBeNull();
    });

    it('says nothing of an admin change in another round', async () => {
      const closedRoundId = await createClosedRound(pool);
      const oldClub = await clubIn(closedRoundId);
      const studentId = await createStudentId(pool);
      // Admins may fix a closed round (PR 3a); the student is shown the open one.
      await adminAssign(oldClub, studentId);
      const openRoundId = await createOpenRound(pool);
      const club = await clubIn(openRoundId);
      expect(codeOf(await register(studentId, club))).toBe('ok');
      await adminRemove(oldClub, studentId);

      const answer = roundOf(await readRound(studentId));

      expect(answer.round?.id).toBe(openRoundId);
      expect(answer.adminChange).toBeNull();
      expect(await adminChangeOf(studentId)).toBeNull();
    });

    it('is shown for a closed round the student is still shown', async () => {
      const roundId = await createClosedRound(pool);
      const club = await clubIn(roundId);
      const studentId = await createStudentId(pool);

      await adminAssign(club, studentId);

      const answer = roundOf(await readRound(studentId));
      expect(answer.round).toMatchObject({ id: roundId, status: 'closed' });
      expect(answer.adminChange).toMatchObject({ kind: 'assigned', club });
    });

    it('is null when the grade has no round', async () => {
      const studentId = await createStudentId(pool);

      expect(roundOf(await readRound(studentId))).toEqual({
        round: null,
        registration: null,
        waitlist: null,
        adminChange: null,
      });
    });
  });

  describe('write answers', () => {
    it('answers a replayed register with the admin change since', async () => {
      const { x, studentId } = await setup();
      const key = newKey();
      expect(codeOf(await register(studentId, x, key))).toBe('ok');
      await adminRemove(x, studentId);

      const replay = registrationOf(await register(studentId, x, key));

      expect(replay.registration).toBeNull();
      expect(replay.adminChange).toEqual(await adminChangeOf(studentId));
      expect(replay.adminChange).toMatchObject({ kind: 'removed', club: x });
    });

    it('answers a register for the club an admin gave the student with that change', async () => {
      const { x, studentId } = await setup();
      await adminAssign(x, studentId);

      const answer = registrationOf(await register(studentId, x));

      expect(answer.registration?.club).toEqual(x);
      expect(answer.adminChange).toEqual(await adminChangeOf(studentId));
      expect(answer.adminChange?.kind).toBe('assigned');
    });

    it('answers a change to the club an admin moved the student to with that move', async () => {
      const s = await setup();
      await ADMIN_ACTIONS.moved.act(s);

      const answer = registrationOf(await change(s.studentId, s.x));

      expect(answer.registration?.club).toEqual(s.x);
      expect(answer.adminChange).toEqual({
        kind: 'moved',
        club: s.x,
        fromClub: s.y,
        at: await latestEventAt(s.studentId, 'admin_assign'),
      });
    });

    it('answers a join of the waitlist the student is on with the admin change since', async () => {
      const { x, full, studentId } = await setup();
      expect(codeOf(await join(studentId, full))).toBe('ok');
      await adminAssign(x, studentId);

      const answer = waitlistOf(await join(studentId, full));

      expect(answer.waitlist?.club).toEqual(full);
      expect(answer.adminChange).toEqual(await adminChangeOf(studentId));
      expect(answer.adminChange).toMatchObject({ kind: 'assigned', club: x });
    });

    it('answers a cancel of a seat an admin gave with null: the student acted', async () => {
      const { x, studentId } = await setup();
      await adminAssign(x, studentId);

      const answer = registrationOf(await cancel(studentId));

      expect(answer).toEqual({ registration: null, adminChange: null });
    });

    it('carries no admin identity in a write answer', async () => {
      const { x, studentId } = await setup();
      await adminAssign(x, studentId);

      const response = await register(studentId, x);

      expect(response.body).not.toContain(adminLoginId);
      expect(response.body).not.toContain(ADMIN_NAME);
    });
  });
  // Not a change to how anything is written: each answer reads adminChange in the same snapshot
  // or transaction as the registration beside it, so while admins move and remove the student,
  // the two must never contradict each other (CLAUDE.md rule 4: the round's invariants hold too).
  describe('while admins change the student concurrently', () => {
    type Answer = {
      registration: { club: { id: number } } | null;
      adminChange: StudentAdminChange | null;
    };

    const contradiction = ({ registration, adminChange }: Answer): string | undefined => {
      if (adminChange === null || adminChange.kind === 'waitlist_removed') return undefined;
      if (adminChange.kind === 'removed') {
        return registration === null ? undefined : 'removed but holding a seat';
      }
      return registration?.club.id === adminChange.club.id ? undefined : 'seated elsewhere';
    };

    it('answers every student request with an adminChange that matches its registration', async () => {
      const { x, y, studentId } = await setup();
      const key = newKey();
      expect(codeOf(await register(studentId, x, key))).toBe('ok');
      await takeTurn(pool, studentId);
      const loginId = await loginOf(studentId);
      const student = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
        await app.inject({
          method,
          url,
          cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
          ...(payload === undefined ? {} : { payload }),
        });
      const admin = async (url: string) =>
        await asAdmin({ method: 'POST', url, payload: { loginId, idempotencyKey: newKey() } });

      const requests = Array.from({ length: 10 }, () => [
        admin(`/api/admin/clubs/${y.id}/members`),
        admin(`/api/admin/clubs/${x.id}/members`),
        admin(`/api/admin/clubs/${x.id}/members/remove`),
        admin(`/api/admin/clubs/${y.id}/members/remove`),
        student('POST', REGISTER_URL, { clubId: x.id, idempotencyKey: key }),
        student('POST', REGISTER_URL, { clubId: y.id, idempotencyKey: newKey() }),
        student('PUT', REGISTER_URL, { clubId: x.id, idempotencyKey: newKey() }),
        student('GET', ROUND_URL),
        student('GET', CLUBS_URL),
      ]).flat();
      const responses = await Promise.all(requests);

      const answers = responses
        .filter((response) => response.statusCode === 200 && response.json<object>() !== null)
        .map((response) => response.json<Partial<Answer>>())
        .filter((answer): answer is Answer => 'registration' in answer && 'adminChange' in answer);
      expect(answers.length).toBeGreaterThanOrEqual(30);
      // Some answers came after an admin's write, or the check would prove nothing.
      expect(answers.some(({ adminChange }) => adminChange !== null)).toBe(true);
      expect(answers.map(contradiction).filter((problem) => problem !== undefined)).toEqual([]);
      responses.forEach((response) => expect(response.statusCode).toBeLessThan(500));
      expect(contradiction(roundOf(await readRound(studentId)))).toBeUndefined();
    });
  });
});
