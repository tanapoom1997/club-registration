import { setTimeout as sleep } from 'node:timers/promises';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  CAPACITY_MAX,
  adminClubResponseSchema,
  errorResponseSchema,
  roundClubsResponseSchema,
} from '@club-registration/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool } from '../src/db.js';
import { TEST_JWT_SECRET, createTestUser } from './support/app.js';
import type { TestUser } from './support/app.js';
import { createClub, createRound, uniqueCode, uniqueTerm } from './support/import-db.js';
import { appConnectionUri, startMigratedPostgres, stopPostgres } from './support/postgres.js';
import {
  addWaitingDirectly,
  createStudents,
  waitForAdvisoryLockWaiter,
} from './support/registration.js';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

type Advisor = {
  fullName: string;
  phone: string | null;
  email: string | null;
  lineId: string | null;
};

// Every value below is made up.
const ADVISOR: Readonly<Advisor> = Object.freeze({
  fullName: 'ครูสมมติ ใจดี',
  phone: '080-000-0001',
  email: 'fictional.teacher@example.com',
  lineId: 'fictional.line',
});

const UNKNOWN_ID = 2_000_000_000;

const errorOf = (response: InjectResponse) => errorResponseSchema.parse(response.json());
const clubOf = (response: InjectResponse) => adminClubResponseSchema.parse(response.json()).club;
const listOf = (response: InjectResponse) => roundClubsResponseSchema.parse(response.json());

describe('admin clubs', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminId: number;
  let adminToken: string;
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

  const request = async (options: InjectOptions, token = adminToken) =>
    await app.inject({ ...options, cookies: { [SESSION_COOKIE]: token } });

  const getClubs = async (roundId: number | string) =>
    await request({ method: 'GET', url: `/api/admin/rounds/${roundId}/clubs` });

  const patchClub = async (id: number | string, payload: Record<string, unknown>) =>
    await request({ method: 'PATCH', url: `/api/admin/clubs/${id}`, payload });

  // registered is set directly: these tests only need the counter that the clubs CHECK compares
  // capacity with, not real registrations.
  const setRegistered = async (clubId: number, registered: number) => {
    await pool.query('UPDATE clubs SET registered = $2 WHERE id = $1', [clubId, registered]);
  };

  const storedClub = async (clubId: number) => {
    const { rows } = await pool.query<{
      name: string;
      description: string;
      capacity: number;
      registered: number;
    }>('SELECT name, description, capacity, registered FROM clubs WHERE id = $1', [clubId]);
    return rows[0]!;
  };

  const addAdvisor = async (clubId: number, advisor: Partial<Advisor> = {}) => {
    const { fullName, phone, email, lineId } = { ...ADVISOR, ...advisor };
    await pool.query(
      `INSERT INTO club_advisors (club_id, full_name, phone, email, line_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [clubId, fullName, phone, email, lineId],
    );
  };

  const createOpenRound = async (): Promise<number> => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO rounds (term, grade, opens_at, closes_at)
       VALUES ($1, 2, now() - interval '1 hour', now() + interval '1 hour') RETURNING id`,
      [uniqueTerm()],
    );
    return rows[0]!.id;
  };

  const newClub = async (options: Parameters<typeof createClub>[3] = {}) => {
    const roundId = await createRound(pool, uniqueTerm(), 1);
    const clubId = await createClub(pool, roundId, uniqueCode(), options);
    return { roundId, clubId };
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(appConnectionUri(container));
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    logLines = [];
    app = await buildApp({
      pool,
      jwtSecret: TEST_JWT_SECRET,
      logger: { level: 'info', stream: { write: (line) => logLines.push(line) } },
    });
    const admin = await createTestUser(pool, { role: 'admin' });
    adminId = admin.id;
    adminToken = await loginAs(admin);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/admin/rounds/:roundId/clubs', () => {
    it('lists the round clubs by code with capacity, registered, remaining and advisors', async () => {
      const roundId = await createRound(pool, uniqueTerm(), 1);
      const second = await createClub(pool, roundId, 'B200', {
        name: 'ชุมนุมดนตรีสมมติ',
        capacity: 20,
        description: 'บรรทัดแรก\nบรรทัดสอง',
      });
      const first = await createClub(pool, roundId, 'A100', { name: 'ชุมนุมหมากรุกสมมติ' });
      await setRegistered(second, 15);
      await addAdvisor(second);
      await addAdvisor(second, { fullName: 'ครูสมมติ คนที่สอง', phone: null, email: null });

      const response = await getClubs(roundId);

      expect(response.statusCode).toBe(200);
      const { round, clubs } = listOf(response);
      expect(round).toMatchObject({ id: roundId, clubCount: 2, totalCapacity: 50 });
      expect(round.totalRegistered).toBe(15);
      expect(clubs).toEqual([
        {
          id: first,
          roundId,
          clubCode: 'A100',
          name: 'ชุมนุมหมากรุกสมมติ',
          description: '',
          capacity: 30,
          registered: 0,
          remaining: 30,
          waitlistCount: 0,
          advisors: [],
        },
        {
          id: second,
          roundId,
          clubCode: 'B200',
          name: 'ชุมนุมดนตรีสมมติ',
          description: 'บรรทัดแรก\nบรรทัดสอง',
          capacity: 20,
          registered: 15,
          remaining: 5,
          waitlistCount: 0,
          advisors: [
            { id: expect.any(Number) as number, ...ADVISOR },
            {
              id: expect.any(Number) as number,
              fullName: 'ครูสมมติ คนที่สอง',
              phone: null,
              email: null,
              lineId: ADVISOR.lineId,
            },
          ],
        },
      ]);
    });

    it('counts each club waitlist, without saying who is on it', async () => {
      const roundId = await createRound(pool, uniqueTerm(), 1);
      const full = await createClub(pool, roundId, uniqueCode(), { capacity: 1 });
      const other = await createClub(pool, roundId, uniqueCode());
      await setRegistered(full, 1);
      for (const studentId of await createStudents(pool, 2)) {
        await addWaitingDirectly(pool, { roundId, clubId: full, studentId });
      }

      const { clubs } = listOf(await getClubs(roundId));

      expect(clubs.find(({ id }) => id === full)?.waitlistCount).toBe(2);
      expect(clubs.find(({ id }) => id === other)?.waitlistCount).toBe(0);
    });

    it('leaves out clubs of other rounds', async () => {
      const { roundId, clubId } = await newClub();
      await newClub();

      const { clubs } = listOf(await getClubs(roundId));

      expect(clubs.map(({ id }) => id)).toEqual([clubId]);
    });

    it('answers an empty list for a round without clubs', async () => {
      const roundId = await createRound(pool, uniqueTerm(), 3);

      const response = await getClubs(roundId);

      expect(response.statusCode).toBe(200);
      expect(listOf(response).clubs).toEqual([]);
    });

    it('reports the round status so the page knows whether to keep polling', async () => {
      const roundId = await createOpenRound();

      const { round } = listOf(await getClubs(roundId));

      expect(round.status).toBe('open');
    });

    it('answers 404 for an unknown round', async () => {
      const response = await getClubs(UNKNOWN_ID);

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).code).toBe('not_found');
    });

    it.each(['abc', '0', '-1', '99999999999'])(
      'answers 400 validation_error for round id %s',
      async (roundId) => {
        const response = await getClubs(roundId);

        expect(response.statusCode).toBe(400);
        expect(errorOf(response).code).toBe('validation_error');
      },
    );
  });

  describe('PATCH /api/admin/clubs/:id', () => {
    it('updates name, description and capacity and returns the club with its advisors', async () => {
      const { roundId, clubId } = await newClub({ capacity: 30 });
      await setRegistered(clubId, 4);
      await addAdvisor(clubId);

      const response = await patchClub(clubId, {
        name: '  ชุมนุมใหม่สมมติ  ',
        description: 'รายละเอียดใหม่',
        capacity: 40,
      });

      expect(response.statusCode).toBe(200);
      expect(clubOf(response)).toMatchObject({
        id: clubId,
        roundId,
        name: 'ชุมนุมใหม่สมมติ',
        description: 'รายละเอียดใหม่',
        capacity: 40,
        registered: 4,
        remaining: 36,
        advisors: [ADVISOR],
      });
      expect(await storedClub(clubId)).toEqual({
        name: 'ชุมนุมใหม่สมมติ',
        description: 'รายละเอียดใหม่',
        capacity: 40,
        registered: 4,
      });
    });

    it('changes only the fields that were sent', async () => {
      const { clubId } = await newClub({ name: 'ชื่อเดิม', description: 'เดิม', capacity: 25 });

      const response = await patchClub(clubId, { capacity: 26 });

      expect(response.statusCode).toBe(200);
      expect(await storedClub(clubId)).toEqual({
        name: 'ชื่อเดิม',
        description: 'เดิม',
        capacity: 26,
        registered: 0,
      });
    });

    it('clears the description with an empty string', async () => {
      const { clubId } = await newClub({ description: 'เดิม' });

      const response = await patchClub(clubId, { description: '' });

      expect(clubOf(response).description).toBe('');
    });

    it('lets capacity drop to exactly the number registered', async () => {
      const { clubId } = await newClub({ capacity: 30 });
      await setRegistered(clubId, 12);

      const response = await patchClub(clubId, { capacity: 12 });

      expect(response.statusCode).toBe(200);
      expect(clubOf(response)).toMatchObject({ capacity: 12, registered: 12, remaining: 0 });
    });

    it('answers 409 capacity_below_registered and keeps the club as it was', async () => {
      const { clubId } = await newClub({ name: 'ชื่อเดิม', capacity: 30 });
      await setRegistered(clubId, 12);

      const response = await patchClub(clubId, { name: 'ชื่อใหม่', capacity: 11 });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('capacity_below_registered');
      expect(response.body).not.toContain('clubs_check');
      expect(await storedClub(clubId)).toMatchObject({
        name: 'ชื่อเดิม',
        capacity: 30,
        registered: 12,
      });
    });

    it('refuses the lower capacity when a registration commits while the update waits', async () => {
      const { clubId } = await newClub({ capacity: 10 });
      await setRegistered(clubId, 5);
      const registration = await pool.connect();
      let committed = false;
      try {
        // A registration in flight: it holds the club row lock with registered = 6 uncommitted,
        // so capacity 5 still looks fine to anything reading committed data.
        await registration.query('BEGIN');
        await registration.query(
          'UPDATE clubs SET registered = registered + 1 WHERE id = $1 AND registered < capacity',
          [clubId],
        );

        const pending = patchClub(clubId, { capacity: 5 });
        await waitForLockWaiter(pool);
        await registration.query('COMMIT');
        committed = true;
        const response = await pending;

        expect(response.statusCode).toBe(409);
        expect(errorOf(response).code).toBe('capacity_below_registered');
      } finally {
        if (!committed) await registration.query('ROLLBACK');
        registration.release();
      }
      const stored = await storedClub(clubId);
      expect(stored).toMatchObject({ capacity: 10, registered: 6 });
      expect(stored.registered).toBeLessThanOrEqual(stored.capacity);
    });

    it('waits for the round advisory lock held by a registration in flight', async () => {
      const { roundId, clubId } = await newClub({ capacity: 10 });
      await setRegistered(clubId, 5);
      const registration = await pool.connect();
      let committed = false;
      try {
        // A registration that holds the round lock (CLAUDE.md rule 3) but has not yet touched the
        // club row: only the advisory lock can make the edit wait for it.
        await registration.query('BEGIN');
        await registration.query('SELECT pg_advisory_xact_lock($1::bigint)', [roundId]);

        const pending = patchClub(clubId, { capacity: 5 });
        await waitForAdvisoryLockWaiter(pool);
        expect(await storedClub(clubId)).toMatchObject({ capacity: 10 });
        await registration.query(
          'UPDATE clubs SET registered = registered + 1 WHERE id = $1 AND registered < capacity',
          [clubId],
        );
        await registration.query('COMMIT');
        committed = true;
        const response = await pending;

        expect(response.statusCode).toBe(409);
        expect(errorOf(response).code).toBe('capacity_below_registered');
      } finally {
        if (!committed) await registration.query('ROLLBACK');
        registration.release();
      }
      expect(await storedClub(clubId)).toMatchObject({ capacity: 10, registered: 6 });
    });

    it('raises capacity while the round is open', async () => {
      const roundId = await createOpenRound();
      const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 10 });
      await setRegistered(clubId, 10);

      const response = await patchClub(clubId, { capacity: 15 });

      expect(response.statusCode).toBe(200);
      expect(clubOf(response)).toMatchObject({ capacity: 15, registered: 10, remaining: 5 });
    });

    it.each([
      ['an empty body', {}],
      ['club code', { clubCode: 'X1' }],
      ['registered', { registered: 0 }],
      ['round id', { roundId: 1 }],
      ['a negative capacity', { capacity: -1 }],
      ['a fractional capacity', { capacity: 10.5 }],
      ['a capacity as text', { capacity: '10' }],
      ['a capacity above the limit', { capacity: CAPACITY_MAX + 1 }],
      ['a blank name', { name: '   ' }],
      ['a name that is too long', { name: 'ก'.repeat(201) }],
      ['a name with a control character', { name: 'ชุมนุม\u0007' }],
      ['a description that is too long', { description: 'ก'.repeat(2_001) }],
    ])('answers 400 validation_error for %s and changes nothing', async (_label, payload) => {
      const { clubId } = await newClub({ name: 'ชื่อเดิม', capacity: 30 });

      const response = await patchClub(clubId, payload);

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
      expect(await storedClub(clubId)).toMatchObject({ name: 'ชื่อเดิม', capacity: 30 });
    });

    it('answers 404 for an unknown club', async () => {
      const response = await patchClub(UNKNOWN_ID, { capacity: 10 });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).code).toBe('not_found');
    });

    it('answers 400 for a club id that is not a positive integer', async () => {
      const response = await patchClub('abc', { capacity: 10 });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('access control', () => {
    it('forbids a student from listing and editing clubs and changes nothing', async () => {
      const { roundId, clubId } = await newClub({ name: 'ชื่อเดิม', capacity: 30 });
      const studentToken = await loginAs(await createTestUser(pool));

      const responses = await Promise.all([
        request({ method: 'GET', url: `/api/admin/rounds/${roundId}/clubs` }, studentToken),
        request(
          { method: 'PATCH', url: `/api/admin/clubs/${clubId}`, payload: { capacity: 1 } },
          studentToken,
        ),
      ]);

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([403, 403]);
      expect(responses.map((response) => errorOf(response).code)).toEqual([
        'forbidden',
        'forbidden',
      ]);
      expect(await storedClub(clubId)).toMatchObject({ name: 'ชื่อเดิม', capacity: 30 });
    });

    it('answers 403 before validating, so a student learns nothing about the schema', async () => {
      const studentToken = await loginAs(await createTestUser(pool));

      const response = await request(
        { method: 'PATCH', url: '/api/admin/clubs/abc', payload: { nonsense: true } },
        studentToken,
      );

      expect(response.statusCode).toBe(403);
    });

    it.each([
      ['GET', '/api/admin/rounds/1/clubs'],
      ['PATCH', '/api/admin/clubs/1'],
    ] as const)('requires a session for %s %s', async (method, url) => {
      const response = await app.inject({ method, url, payload: { capacity: 1 } });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('audit log', () => {
    const clubUpdates = () =>
      logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter(({ audit }) => audit === 'club.update');

    it('records which admin changed a club, the fields sent and the capacity after', async () => {
      const { roundId, clubId } = await newClub();

      const response = await patchClub(clubId, { capacity: 40, description: 'ข้อความสมมติ' });

      expect(response.statusCode).toBe(200);
      expect(clubUpdates()).toEqual([
        expect.objectContaining({
          adminId,
          clubId,
          roundId,
          changed: ['capacity', 'description'],
          capacity: 40,
        }),
      ]);
    });

    it('records nothing when the change is refused', async () => {
      const { clubId } = await newClub();
      await setRegistered(clubId, 5);

      const response = await patchClub(clubId, { capacity: 2 });

      expect(response.statusCode).toBe(409);
      expect(clubUpdates()).toEqual([]);
    });
  });

  it('never writes advisor contacts or club text to the log', async () => {
    const { roundId, clubId } = await newClub({ description: 'รายละเอียดลับสมมติ' });
    await setRegistered(clubId, 3);
    await addAdvisor(clubId);

    await getClubs(roundId);
    await patchClub(clubId, { capacity: 1, description: 'รายละเอียดใหม่สมมติ' });
    await patchClub(clubId, { name: 'ชื่อสมมติ', registered: 0 });

    const log = logLines.join('\n');
    expect(logLines.length).toBeGreaterThan(0);
    [
      'ครูสมมติ',
      '080-000-0001',
      'fictional.teacher@example.com',
      'fictional.line',
      'รายละเอียด',
      'ชื่อสมมติ',
    ].forEach((value) => expect(log).not.toContain(value));
  });
});

// Waits until some backend is blocked on a lock, i.e. the PATCH has reached the locked club row.
const waitForLockWaiter = async (pool: Pool): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query LIKE '%UPDATE clubs%'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await sleep(25);
  }
  throw new Error('The club update never waited for the row lock');
};
