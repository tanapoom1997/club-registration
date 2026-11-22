import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { errorResponseSchema, studentRegistrationResponseSchema } from '@club-registration/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool } from '../src/db.js';
import { DEFAULT_QUEUE_SETTINGS } from '../src/services/queue.js';
import { TEST_JWT_SECRET } from './support/app.js';
import { createClub, uniqueCode } from './support/import-db.js';
import {
  appConnectionUri,
  startMigratedPostgres,
  stopPostgres,
  truncateAsOwner,
} from './support/postgres.js';
import { queueInvariantViolations, rewindTickets, setMaxActive } from './support/queue.js';
import {
  STUDENT_NAME,
  createAdminId,
  createClosedRound,
  createOpenRound,
  createStudentId,
  createUpcomingRound,
  eventsOf,
  moveWindow,
  newKey,
  registrationInvariantViolations,
  seatStudent,
  sessionCookie,
} from './support/registration.js';

// The queue gate (README Phase 3, Q2): in an open round, the club list and a student's own
// register, change and waitlist join need a live admitted queue ticket; everything else does not.
// Tickets are made through the real queue endpoints, and time is the DB clock, rewound in rows.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const CLUBS_URL = '/api/student/clubs';
const REGISTRATION_URL = '/api/student/registration';
const WAITLIST_URL = '/api/student/waitlist';
const QUEUE_URL = '/api/student/queue';
const IDLE = DEFAULT_QUEUE_SETTINGS.idleTimeoutSeconds;
const TTL = DEFAULT_QUEUE_SETTINGS.admissionTtlSeconds;
// Every value is made up.
const CLUB_NAME = 'ชุมนุมสมมติ คิวเลือก';

const codeOf = (response: InjectResponse) =>
  response.statusCode === 200 ? 'ok' : errorResponseSchema.parse(response.json()).code;

type GatedRoute = 'clubs' | 'register' | 'change' | 'join';
const GATED_ROUTES: readonly GatedRoute[] = ['clubs', 'register', 'change', 'join'];
const GATED_WRITES: readonly Exclude<GatedRoute, 'clubs'>[] = ['register', 'change', 'join'];

describe('queue gate on the student routes', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let logLines: string[];

  const asStudent = async (
    studentId: number,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    await app.inject({
      method,
      url,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      ...(payload === undefined ? {} : { payload }),
    });

  const joinQueue = async (studentId: number) => {
    const response = await asStudent(studentId, 'POST', `${QUEUE_URL}/join`, {});
    expect(response.statusCode).toBe(200);
    return response.json<{ ticket: { status: string } | null }>().ticket;
  };
  const releaseTicket = async (studentId: number) => {
    expect((await asStudent(studentId, 'POST', `${QUEUE_URL}/done`, {})).statusCode).toBe(200);
  };
  const admit = async (studentId: number) => {
    expect(await joinQueue(studentId)).toMatchObject({ status: 'admitted' });
  };

  const fullClub = async (roundId: number) => {
    const clubId = await createClub(pool, roundId, uniqueCode(), { name: CLUB_NAME, capacity: 1 });
    await seatStudent(pool, await createStudentId(pool), clubId);
    return clubId;
  };

  // One student in an open round of grade 1, set up so that each gated request would succeed if
  // the gate let it through: a free club to register for, a held club to change from, a full club
  // whose waitlist to join. send() makes the request; a key may be given to send it again.
  const stage = async (route: GatedRoute) => {
    const roundId = await createOpenRound(pool);
    const studentId = await createStudentId(pool);
    const free = await createClub(pool, roundId, uniqueCode(), { name: CLUB_NAME });
    if (route === 'change') {
      await seatStudent(
        pool,
        studentId,
        await createClub(pool, roundId, uniqueCode(), { name: CLUB_NAME }),
      );
    }
    const full = route === 'join' ? await fullClub(roundId) : free;
    const send = async (idempotencyKey = newKey()): Promise<InjectResponse> => {
      switch (route) {
        case 'clubs':
          return await asStudent(studentId, 'GET', CLUBS_URL);
        case 'register':
          return await asStudent(studentId, 'POST', REGISTRATION_URL, {
            clubId: free,
            idempotencyKey,
          });
        case 'change':
          return await asStudent(studentId, 'PUT', REGISTRATION_URL, {
            clubId: free,
            idempotencyKey,
          });
        case 'join':
          return await asStudent(studentId, 'POST', WAITLIST_URL, {
            clubId: full,
            idempotencyKey,
          });
      }
    };
    return { roundId, studentId, send };
  };

  // Everything a seat write could leave behind for the student or the round.
  const footprint = async (roundId: number, studentId: number) => {
    const { rows } = await pool.query<{
      seats: number[];
      registered: number[];
      waiting: number[];
      events: number;
    }>(
      `SELECT
         ARRAY(SELECT club_id FROM registrations WHERE student_id = $2 ORDER BY club_id) AS seats,
         ARRAY(SELECT registered FROM clubs WHERE round_id = $1 ORDER BY id) AS registered,
         ARRAY(SELECT club_id FROM waitlist_entries WHERE student_id = $2) AS waiting,
         (SELECT count(*)::int FROM registration_events WHERE round_id = $1) AS events`,
      [roundId, studentId],
    );
    return rows[0]!;
  };

  // The ticket states that do not let a student choose. Each runs after stage(), in its round.
  const TICKETS_WITHOUT_TURN: readonly [string, (roundId: number, id: number) => Promise<void>][] =
    [
      ['no ticket at all', () => Promise.resolve()],
      [
        'a waiting ticket',
        async (roundId, studentId) => {
          await setMaxActive(pool, roundId, 1);
          await admit(await createStudentId(pool));
          expect(await joinQueue(studentId)).toMatchObject({ status: 'waiting', position: 1 });
        },
      ],
      [
        'an admitted ticket left idle past the timeout',
        async (_roundId, studentId) => {
          await admit(studentId);
          await rewindTickets(container, [studentId], { lastSeenSeconds: IDLE + 1 });
        },
      ],
      [
        'an admitted ticket past its admission TTL, though still polled',
        async (_roundId, studentId) => {
          await admit(studentId);
          await rewindTickets(container, [studentId], { admittedSeconds: TTL + 1 });
        },
      ],
      [
        'a ticket marked expired by a later queue write',
        async (_roundId, studentId) => {
          await admit(studentId);
          await rewindTickets(container, [studentId], { lastSeenSeconds: IDLE + 1 });
          // Another student's join runs the round's expiry, so the row itself says expired.
          await admit(await createStudentId(pool));
        },
      ],
      [
        'a released (done) ticket',
        async (_roundId, studentId) => {
          await admit(studentId);
          await releaseTicket(studentId);
        },
      ],
    ];

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
    expect(await queueInvariantViolations(pool)).toEqual([]);
  });

  describe.each(GATED_ROUTES)('%s in an open round', (route) => {
    it.each(TICKETS_WITHOUT_TURN)(
      'answers 403 queue_required with %s, and changes nothing',
      async (_case, prepare) => {
        const { roundId, studentId, send } = await stage(route);
        await prepare(roundId, studentId);
        const before = await footprint(roundId, studentId);

        const response = await send();

        expect(response.statusCode).toBe(403);
        expect(codeOf(response)).toBe('queue_required');
        expect(await footprint(roundId, studentId)).toEqual(before);
      },
    );

    it('goes through with a live admitted ticket', async () => {
      const { roundId, studentId, send } = await stage(route);
      await admit(studentId);
      const before = await footprint(roundId, studentId);

      const response = await send();

      expect(response.statusCode).toBe(200);
      if (route !== 'clubs') expect(await footprint(roundId, studentId)).not.toEqual(before);
    });
  });

  describe.each(GATED_WRITES)('%s', (route) => {
    it.each([
      ['closed', { opensInSeconds: -7_200, closesInSeconds: -3_600 }],
      ['upcoming', { opensInSeconds: 3_600, closesInSeconds: 7_200 }],
    ] as const)(
      'answers 409 round_not_open in a %s round, ticket or not',
      async (_status, window) => {
        const { roundId, send } = await stage(route);
        await moveWindow(pool, roundId, window);

        const response = await send();

        expect(codeOf(response)).toBe('round_not_open');
      },
    );

    it('replays a key that went through after the ticket ended, and writes nothing more', async () => {
      const { roundId, studentId, send } = await stage(route);
      await admit(studentId);
      const key = newKey();
      const first = await send(key);
      expect(first.statusCode).toBe(200);
      await releaseTicket(studentId);
      const after = await footprint(roundId, studentId);

      const replayed = await send(key);

      expect(replayed.statusCode).toBe(200);
      expect(replayed.json()).toEqual(first.json());
      expect(await footprint(roundId, studentId)).toEqual(after);
    });

    it('keeps no trace of a queue_required refusal, so its key works once the turn comes', async () => {
      const { roundId, studentId, send } = await stage(route);
      const key = newKey();
      expect(codeOf(await send(key))).toBe('queue_required');
      await admit(studentId);

      const retried = await send(key);

      expect(retried.statusCode).toBe(200);
      const { rows } = await pool.query<{ events: number }>(
        `SELECT count(*)::int AS events FROM registration_events
         WHERE actor_id = $1 AND idempotency_key = $2 AND round_id = $3`,
        [studentId, key, roundId],
      );
      expect(rows[0]?.events).toBe(1);
    });
  });

  describe('answers before the gate', () => {
    it('answers 404 for a club of another grade, not queue_required', async () => {
      await createOpenRound(pool);
      const other = await createClub(pool, await createOpenRound(pool, 2), uniqueCode());
      const studentId = await createStudentId(pool);

      const response = await asStudent(studentId, 'POST', REGISTRATION_URL, {
        clubId: other,
        idempotencyKey: newKey(),
      });

      expect(codeOf(response)).toBe('not_found');
    });

    it('answers a register for the club already held with 200, writing nothing', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode());
      const studentId = await createStudentId(pool);
      await seatStudent(pool, studentId, clubId);

      const response = await asStudent(studentId, 'POST', REGISTRATION_URL, {
        clubId,
        idempotencyKey: newKey(),
      });

      expect(response.statusCode).toBe(200);
      expect(studentRegistrationResponseSchema.parse(response.json()).registration?.club.id).toBe(
        clubId,
      );
      expect(await eventsOf(pool, studentId)).toHaveLength(1);
    });

    it('answers queue_required ahead of already_registered and club_full', async () => {
      const roundId = await createOpenRound(pool);
      const studentId = await createStudentId(pool);
      await seatStudent(pool, studentId, await createClub(pool, roundId, uniqueCode()));
      const full = await fullClub(roundId);

      const responses = await Promise.all([
        asStudent(studentId, 'POST', REGISTRATION_URL, { clubId: full, idempotencyKey: newKey() }),
        asStudent(studentId, 'PUT', REGISTRATION_URL, { clubId: full, idempotencyKey: newKey() }),
      ]);

      expect(responses.map(codeOf)).toEqual(['queue_required', 'queue_required']);
    });
  });

  describe('routes without a gate', () => {
    it('lets a student with no ticket cancel and leave the waitlist', async () => {
      const roundId = await createOpenRound(pool);
      const studentId = await createStudentId(pool);
      await seatStudent(pool, studentId, await createClub(pool, roundId, uniqueCode()));
      const full = await fullClub(roundId);
      await admit(studentId);
      const joined = await asStudent(studentId, 'POST', WAITLIST_URL, {
        clubId: full,
        idempotencyKey: newKey(),
      });
      expect(joined.statusCode).toBe(200);
      await releaseTicket(studentId);

      const left = await asStudent(studentId, 'POST', `${WAITLIST_URL}/leave`, {
        idempotencyKey: newKey(),
      });
      const cancelled = await asStudent(studentId, 'POST', `${REGISTRATION_URL}/cancel`, {
        idempotencyKey: newKey(),
      });

      expect([left.statusCode, cancelled.statusCode]).toEqual([200, 200]);
      expect(await footprint(roundId, studentId)).toMatchObject({ seats: [], waiting: [] });
    });

    it('answers GET /api/student/round in an open round with no ticket', async () => {
      await createOpenRound(pool);
      const studentId = await createStudentId(pool);

      const response = await asStudent(studentId, 'GET', '/api/student/round');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ round: { status: 'open' } });
    });

    it.each([
      ['upcoming', createUpcomingRound],
      ['closed', createClosedRound],
    ] as const)('lists the clubs of an %s round with no ticket', async (status, createRound) => {
      const roundId = await createRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode());
      const studentId = await createStudentId(pool);

      const response = await asStudent(studentId, 'GET', CLUBS_URL);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ round: { status }, clubs: [{ id: clubId }] });
    });

    it('lists nothing, with no error, for a grade with no round', async () => {
      const studentId = await createStudentId(pool, 6);

      const response = await asStudent(studentId, 'GET', CLUBS_URL);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ round: null, clubs: [] });
    });

    it('lets an admin seat and move a student who holds no ticket', async () => {
      const roundId = await createOpenRound(pool);
      const [first, second] = [
        await createClub(pool, roundId, uniqueCode()),
        await createClub(pool, roundId, uniqueCode()),
      ];
      const studentId = await createStudentId(pool);
      const adminId = await createAdminId(pool);
      const { rows } = await pool.query<{ login_id: string }>(
        'SELECT login_id FROM users WHERE id = $1',
        [studentId],
      );
      const assign = async (clubId: number) =>
        await app.inject({
          method: 'POST',
          url: `/api/admin/clubs/${clubId}/members`,
          cookies: { [SESSION_COOKIE]: sessionCookie(app, adminId, 'admin') },
          payload: { loginId: rows[0]!.login_id, idempotencyKey: newKey() },
        });

      expect((await assign(first)).statusCode).toBe(200);
      expect((await assign(second)).statusCode).toBe(200);
      expect(await footprint(roundId, studentId)).toMatchObject({ seats: [second] });
    });

    it('promotes a waiter whose ticket has ended when a seat is freed', async () => {
      const roundId = await createOpenRound(pool);
      const holder = await createStudentId(pool);
      const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 1 });
      await seatStudent(pool, holder, clubId);
      const waiter = await createStudentId(pool);
      await admit(waiter);
      expect(
        (await asStudent(waiter, 'POST', WAITLIST_URL, { clubId, idempotencyKey: newKey() }))
          .statusCode,
      ).toBe(200);
      await releaseTicket(waiter);

      const cancelled = await asStudent(holder, 'POST', `${REGISTRATION_URL}/cancel`, {
        idempotencyKey: newKey(),
      });

      expect(cancelled.statusCode).toBe(200);
      expect(await footprint(roundId, waiter)).toMatchObject({ seats: [clubId], waiting: [] });
    });
  });

  it('logs the refusal with ids and the code, never a name', async () => {
    const roundId = await createOpenRound(pool);
    const clubId = await createClub(pool, roundId, uniqueCode(), { name: CLUB_NAME });
    const studentId = await createStudentId(pool);

    await asStudent(studentId, 'POST', REGISTRATION_URL, { clubId, idempotencyKey: newKey() });
    await asStudent(studentId, 'GET', CLUBS_URL);

    const refusals = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(({ outcome }) => outcome === 'queue_required');
    expect(refusals).toEqual([
      expect.objectContaining({ studentId, clubId, msg: 'student register refused' }),
      expect.objectContaining({ studentId, msg: 'student clubs refused' }),
    ]);
    const log = logLines.join('\n');
    [STUDENT_NAME, CLUB_NAME].forEach((value) => expect(log).not.toContain(value));
  });
});
