import { randomBytes } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  errorResponseSchema,
  roundListResponseSchema,
  roundResponseSchema,
} from '@club-registration/shared';
import type { Round } from '@club-registration/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool } from '../src/db.js';
import { roundStatusAt } from '../src/services/rounds.js';
import { TEST_JWT_SECRET, createTestUser } from './support/app.js';
import type { TestUser } from './support/app.js';
import { startMigratedPostgres, stopPostgres } from './support/postgres.js';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const errorOf = (response: InjectResponse) => errorResponseSchema.parse(response.json());
const roundOf = (response: InjectResponse) => roundResponseSchema.parse(response.json()).round;
const roundsOf = (response: InjectResponse) =>
  roundListResponseSchema.parse(response.json()).rounds;

const isoFromNow = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

// Each test gets its own term, so tests never see each other's rounds.
const uniqueTerm = () => `t-${randomBytes(4).toString('hex')}`;

const futureWindow = () => ({ opensAt: isoFromNow(DAY_MS), closesAt: isoFromNow(2 * DAY_MS) });

describe('admin rounds', () => {
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

  const postRound = async (payload: Record<string, unknown>) =>
    await request({ method: 'POST', url: '/api/admin/rounds', payload });

  const createRound = async (overrides: Record<string, unknown> = {}): Promise<Round> => {
    const response = await postRound({
      term: uniqueTerm(),
      grade: 1,
      ...futureWindow(),
      maxActive: 150,
      ...overrides,
    });
    expect(response.statusCode).toBe(201);
    return roundOf(response);
  };

  const listRounds = async (term: string): Promise<Round[]> => {
    const response = await request({ method: 'GET', url: '/api/admin/rounds', query: { term } });
    expect(response.statusCode).toBe(200);
    return roundsOf(response);
  };

  const countRounds = async (term: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM rounds WHERE term = $1',
      [term],
    );
    return rows[0]!.count;
  };

  const insertClub = async (roundId: number, capacity: number, registered = 0) => {
    await pool.query(
      `INSERT INTO clubs (round_id, club_code, name, capacity, registered)
       VALUES ($1, $2, 'Fictional Club', $3, $4)`,
      [roundId, `C-${randomBytes(3).toString('hex')}`, capacity, registered],
    );
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(container.getConnectionUri());
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

  describe('POST /api/admin/rounds', () => {
    it('creates a round and returns it with UTC times, zero totals and a status', async () => {
      const term = uniqueTerm();

      const response = await postRound({
        term,
        grade: 3,
        opensAt: '2030-06-01T08:00:00+07:00',
        closesAt: '2030-06-01T16:00:00+07:00',
        maxActive: 120,
      });

      expect(response.statusCode).toBe(201);
      expect(roundOf(response)).toMatchObject({
        term,
        grade: 3,
        opensAt: '2030-06-01T01:00:00.000Z',
        closesAt: '2030-06-01T09:00:00.000Z',
        maxActive: 120,
        status: 'upcoming',
        clubCount: 0,
        totalCapacity: 0,
        totalRegistered: 0,
      });
    });

    it('answers 409 round_exists for a second round with the same term and grade', async () => {
      const existing = await createRound({ grade: 2 });

      const response = await postRound({
        term: existing.term,
        grade: 2,
        ...futureWindow(),
        maxActive: 150,
      });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_exists');
      expect(response.body).not.toContain('rounds_term_grade_key');
      expect(await countRounds(existing.term)).toBe(1);
    });

    it('lets exactly one of several concurrent identical creates succeed', async () => {
      const payload = { term: uniqueTerm(), grade: 4, ...futureWindow(), maxActive: 150 };

      const responses = await Promise.all(Array.from({ length: 8 }, () => postRound(payload)));

      const statuses = responses.map(({ statusCode }) => statusCode).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
      expect(await countRounds(payload.term)).toBe(1);
    });

    it.each([
      ['equal to', 0],
      ['before', -HOUR_MS],
    ])('rejects closesAt %s opensAt with 400 validation_error', async (_label, offsetMs) => {
      const opensAt = new Date(Date.now() + DAY_MS);
      const term = uniqueTerm();

      const response = await postRound({
        term,
        grade: 1,
        opensAt: opensAt.toISOString(),
        closesAt: new Date(opensAt.getTime() + offsetMs).toISOString(),
        maxActive: 150,
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
      expect(await countRounds(term)).toBe(0);
    });

    it('rejects a time without a timezone, which would be ambiguous', async () => {
      const response = await postRound({
        term: uniqueTerm(),
        grade: 1,
        opensAt: '2030-06-01T08:00:00',
        closesAt: '2030-06-01T16:00:00',
        maxActive: 150,
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
    });
  });

  describe('GET /api/admin/rounds', () => {
    it('lists only the requested term, ordered by grade', async () => {
      const term = uniqueTerm();
      await createRound({ term, grade: 2 });
      await createRound({ term, grade: 1 });
      await createRound({ grade: 1 });

      const rounds = await listRounds(term);

      expect(rounds.map(({ term: t, grade }) => [t, grade])).toEqual([
        [term, 1],
        [term, 2],
      ]);
    });

    it('sums club count, capacity and registered from the round clubs', async () => {
      const round = await createRound();
      await insertClub(round.id, 30, 12);
      await insertClub(round.id, 25, 25);

      const [listed] = await listRounds(round.term);

      expect(listed).toMatchObject({ clubCount: 2, totalCapacity: 55, totalRegistered: 37 });
    });

    it('derives upcoming, open and closed from the current time', async () => {
      const term = uniqueTerm();
      await createRound({
        term,
        grade: 1,
        opensAt: isoFromNow(HOUR_MS),
        closesAt: isoFromNow(2 * HOUR_MS),
      });
      await createRound({
        term,
        grade: 2,
        opensAt: isoFromNow(-HOUR_MS),
        closesAt: isoFromNow(HOUR_MS),
      });
      await createRound({
        term,
        grade: 3,
        opensAt: isoFromNow(-2 * HOUR_MS),
        closesAt: isoFromNow(-HOUR_MS),
      });

      const rounds = await listRounds(term);

      expect(rounds.map(({ status }) => status)).toEqual(['upcoming', 'open', 'closed']);
    });

    it('lists every term when no term is given', async () => {
      const [first, second] = [await createRound(), await createRound()];

      const response = await request({ method: 'GET', url: '/api/admin/rounds' });

      const ids = roundsOf(response).map(({ id }) => id);
      expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
    });
  });

  describe('roundStatusAt', () => {
    const opensAt = new Date('2030-06-01T01:00:00Z');
    const closesAt = new Date('2030-06-01T09:00:00Z');

    it.each([
      ['2030-06-01T00:59:59.999Z', 'upcoming'],
      ['2030-06-01T01:00:00.000Z', 'open'],
      ['2030-06-01T08:59:59.999Z', 'open'],
      ['2030-06-01T09:00:00.000Z', 'closed'],
    ])('treats %s as %s (open from opensAt, closed from closesAt)', (now, expected) => {
      expect(roundStatusAt({ opensAt, closesAt }, new Date(now))).toBe(expected);
    });
  });

  describe('PATCH /api/admin/rounds/:id', () => {
    const patchRound = async (id: number, payload: Record<string, unknown>) =>
      await request({ method: 'PATCH', url: `/api/admin/rounds/${id}`, payload });

    it('updates the window and max active of a round', async () => {
      const round = await createRound();
      const opensAt = isoFromNow(-HOUR_MS);
      const closesAt = isoFromNow(HOUR_MS);

      const response = await patchRound(round.id, { opensAt, closesAt, maxActive: 80 });

      expect(response.statusCode).toBe(200);
      expect(roundOf(response)).toMatchObject({
        id: round.id,
        term: round.term,
        grade: round.grade,
        opensAt,
        closesAt,
        maxActive: 80,
        status: 'open',
      });
    });

    it('changes only the fields that were sent', async () => {
      const round = await createRound();

      const response = await patchRound(round.id, { maxActive: 99 });

      expect(roundOf(response)).toEqual({ ...round, maxActive: 99 });
    });

    it.each([
      ['term', { term: 'other-term' }],
      ['grade', { grade: 5 }],
    ])('refuses to change %s and leaves the round untouched', async (_field, change) => {
      const round = await createRound();

      const response = await patchRound(round.id, { ...change, maxActive: 99 });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
      expect(await listRounds(round.term)).toEqual([round]);
    });

    it('rejects closesAt before opensAt sent in the same request', async () => {
      const round = await createRound();

      const response = await patchRound(round.id, {
        opensAt: isoFromNow(2 * DAY_MS),
        closesAt: isoFromNow(DAY_MS),
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
    });

    it('lets the DB check reject a closesAt before the stored opensAt', async () => {
      const round = await createRound();

      const response = await patchRound(round.id, {
        closesAt: new Date(Date.parse(round.opensAt) - HOUR_MS).toISOString(),
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
      expect(response.body).not.toContain('rounds_check');
      expect(await listRounds(round.term)).toEqual([round]);
    });

    it('rejects an empty change', async () => {
      const round = await createRound();

      const response = await patchRound(round.id, {});

      expect(response.statusCode).toBe(400);
    });

    it('answers 404 for an unknown round', async () => {
      const response = await patchRound(2_000_000_000, { maxActive: 10 });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).code).toBe('not_found');
    });
  });

  describe('DELETE /api/admin/rounds/:id', () => {
    const deleteRound = async (id: number) =>
      await request({ method: 'DELETE', url: `/api/admin/rounds/${id}` });

    it('deletes a round without clubs', async () => {
      const round = await createRound();

      const response = await deleteRound(round.id);

      expect(response.statusCode).toBe(204);
      expect(await countRounds(round.term)).toBe(0);
    });

    it('answers 409 round_not_empty for a round with clubs and keeps it', async () => {
      const round = await createRound();
      await insertClub(round.id, 20);

      const response = await deleteRound(round.id);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_not_empty');
      expect(response.body).not.toContain('clubs_round_id_fkey');
      expect(await countRounds(round.term)).toBe(1);
    });

    it('answers 404 for an unknown round', async () => {
      const response = await deleteRound(2_000_000_000);

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /api/admin/rounds/batch', () => {
    const postBatch = async (payload: Record<string, unknown>) =>
      await request({ method: 'POST', url: '/api/admin/rounds/batch', payload });

    it('creates grades 1 to 6 for the term with the same window', async () => {
      const term = uniqueTerm();
      const window = futureWindow();

      const response = await postBatch({ term, ...window, maxActive: 100 });

      expect(response.statusCode).toBe(201);
      const rounds = roundsOf(response);
      expect(rounds.map(({ grade }) => grade)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(rounds.every((round) => round.opensAt === window.opensAt)).toBe(true);
      expect(await countRounds(term)).toBe(6);
    });

    it('creates nothing and answers 409 round_exists when one grade already exists', async () => {
      const existing = await createRound({ grade: 4 });

      const response = await postBatch({ term: existing.term, ...futureWindow(), maxActive: 100 });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_exists');
      expect(await listRounds(existing.term)).toEqual([existing]);
    });

    it('rejects a batch whose closesAt is not after opensAt', async () => {
      const term = uniqueTerm();
      const opensAt = isoFromNow(DAY_MS);

      const response = await postBatch({ term, opensAt, closesAt: opensAt, maxActive: 100 });

      expect(response.statusCode).toBe(400);
      expect(await countRounds(term)).toBe(0);
    });
  });

  describe('audit log', () => {
    const auditEntries = (action: string) =>
      logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter(({ audit }) => audit === action);

    it('records which admin created a round and its settings', async () => {
      const round = await createRound({ grade: 4, maxActive: 90 });

      expect(auditEntries('round.create')).toEqual([
        expect.objectContaining({
          adminId,
          roundId: round.id,
          term: round.term,
          grade: 4,
          opensAt: round.opensAt,
          closesAt: round.closesAt,
          maxActive: 90,
        }),
      ]);
    });

    it('records which admin created a batch, every round id and the stored window', async () => {
      const term = uniqueTerm();

      const response = await request({
        method: 'POST',
        url: '/api/admin/rounds/batch',
        // Thai time, as an admin's browser may send it.
        payload: {
          term,
          opensAt: '2099-12-01T08:00:00+07:00',
          closesAt: '2099-12-01T16:00:00+07:00',
          maxActive: 100,
        },
      });

      expect(response.statusCode).toBe(201);
      const rounds = roundsOf(response);
      expect(auditEntries('round.create_batch')).toEqual([
        expect.objectContaining({
          adminId,
          term,
          roundIds: rounds.map(({ id }) => id),
          opensAt: '2099-12-01T01:00:00.000Z',
          closesAt: '2099-12-01T09:00:00.000Z',
          maxActive: 100,
        }),
      ]);
      // The same form the create and update lines log.
      expect(rounds[0]?.opensAt).toBe('2099-12-01T01:00:00.000Z');
    });

    it('records which admin changed a round, the fields sent and the values after', async () => {
      const round = await createRound();

      await request({
        method: 'PATCH',
        url: `/api/admin/rounds/${round.id}`,
        payload: { maxActive: 77 },
      });

      expect(auditEntries('round.update')).toEqual([
        expect.objectContaining({
          adminId,
          roundId: round.id,
          changed: ['maxActive'],
          opensAt: round.opensAt,
          closesAt: round.closesAt,
          maxActive: 77,
        }),
      ]);
    });

    it('records which admin deleted a round', async () => {
      const round = await createRound();

      await request({ method: 'DELETE', url: `/api/admin/rounds/${round.id}` });

      expect(auditEntries('round.delete')).toEqual([
        expect.objectContaining({ adminId, roundId: round.id }),
      ]);
    });

    it('records nothing for a change that was refused', async () => {
      const round = await createRound();
      await insertClub(round.id, 20);

      const refusedDelete = await request({
        method: 'DELETE',
        url: `/api/admin/rounds/${round.id}`,
      });
      const refusedUpdate = await request({
        method: 'PATCH',
        url: '/api/admin/rounds/2000000000',
        payload: { maxActive: 1 },
      });

      expect([refusedDelete.statusCode, refusedUpdate.statusCode]).toEqual([409, 404]);
      expect([...auditEntries('round.delete'), ...auditEntries('round.update')]).toEqual([]);
    });
  });

  describe('access control', () => {
    const routes = (roundId: number, term: string): InjectOptions[] => [
      { method: 'GET', url: '/api/admin/rounds' },
      {
        method: 'POST',
        url: '/api/admin/rounds',
        payload: { term, grade: 6, ...futureWindow(), maxActive: 150 },
      },
      {
        method: 'POST',
        url: '/api/admin/rounds/batch',
        payload: { term, ...futureWindow(), maxActive: 150 },
      },
      { method: 'PATCH', url: `/api/admin/rounds/${roundId}`, payload: { maxActive: 1 } },
      { method: 'DELETE', url: `/api/admin/rounds/${roundId}` },
    ];

    it('forbids a student from every admin round route and changes nothing', async () => {
      const round = await createRound();
      const studentToken = await loginAs(await createTestUser(pool));
      const term = uniqueTerm();

      const responses = await Promise.all(
        routes(round.id, term).map((options) => request(options, studentToken)),
      );

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([403, 403, 403, 403, 403]);
      expect(responses.map((response) => errorOf(response).code)).toEqual(
        Array.from({ length: 5 }, () => 'forbidden'),
      );
      expect(await countRounds(term)).toBe(0);
      expect(await listRounds(round.term)).toEqual([round]);
    });

    it('answers 403 before validating, so a student learns nothing about the schema', async () => {
      const studentToken = await loginAs(await createTestUser(pool));

      const response = await request(
        { method: 'POST', url: '/api/admin/rounds', payload: { nonsense: true } },
        studentToken,
      );

      expect(response.statusCode).toBe(403);
    });

    it('requires a session', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/rounds' });

      expect(response.statusCode).toBe(401);
    });
  });
});
