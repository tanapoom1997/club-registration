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
import { createClub, uniqueCode } from './support/import-db.js';
import { DEFAULT_QUEUE_SETTINGS } from '../src/services/queue.js';
import { roundStatusAt } from '../src/services/rounds.js';
import { TEST_JWT_SECRET, createTestUser } from './support/app.js';
import type { TestUser } from './support/app.js';
import { appConnectionUri, startMigratedPostgres, stopPostgres } from './support/postgres.js';
import { createStudents, seatStudent } from './support/registration.js';

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

const IDLE = DEFAULT_QUEUE_SETTINGS.idleTimeoutSeconds;
const TTL = DEFAULT_QUEUE_SETTINGS.admissionTtlSeconds;

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

  const storedMaxActive = async (roundId: number): Promise<number | null> => {
    const { rows } = await pool.query<{ max_active: number | null }>(
      'SELECT max_active FROM rounds WHERE id = $1',
      [roundId],
    );
    return rows[0]!.max_active;
  };

  // Queue tickets of the round's grade written straight to the table, each with its own student:
  // how long ago it was last seen and (admitted) let in decides whether the queue counts it as
  // live, so no test waits for the clock.
  type TicketSpec = {
    status: 'waiting' | 'admitted' | 'expired' | 'done';
    seenSecondsAgo?: number;
    admittedSecondsAgo?: number;
  };
  const insertTickets = async (round: Round, specs: readonly TicketSpec[]) => {
    const students = await createStudents(pool, specs.length, { grade: round.grade });
    for (const [index, spec] of specs.entries()) {
      await pool.query(
        `INSERT INTO queue_tickets
           (round_id, student_id, status, created_at, last_seen_at, admitted_at)
         VALUES ($1, $2, $3, clock_timestamp(),
                 statement_timestamp() - $4::int * interval '1 second',
                 CASE WHEN $3 = 'waiting' THEN NULL
                      ELSE statement_timestamp() - $5::int * interval '1 second' END)`,
        [
          round.id,
          students[index],
          spec.status,
          spec.seenSecondsAgo ?? 0,
          spec.admittedSecondsAgo ?? 0,
        ],
      );
    }
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

    // The browser's date field takes the Christian year; 2569 is the Buddhist year typed by habit.
    it('rejects a Buddhist year with 400 validation_error and creates nothing', async () => {
      const term = uniqueTerm();

      const response = await postRound({
        term,
        grade: 1,
        opensAt: '2569-06-01T08:00:00+07:00',
        closesAt: '2569-06-01T16:00:00+07:00',
        maxActive: 150,
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
      expect(await countRounds(term)).toBe(0);
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

    // What the admin home chases on registration day: who in the grade has no club yet. Counted
    // as a change from before, since other tests here add students too.
    it('counts the students of the grade and those without a club in this round', async () => {
      const round = await createRound({
        grade: 6,
        opensAt: isoFromNow(-HOUR_MS),
        closesAt: isoFromNow(HOUR_MS),
      });
      const [before] = await listRounds(round.term);
      const clubId = await createClub(pool, round.id, uniqueCode(), { capacity: 5 });
      const [seated] = await createStudents(pool, 3, { grade: 6 });
      // Another grade's students are not this round's.
      await createStudents(pool, 2, { grade: 5 });
      await seatStudent(pool, seated!, clubId);

      const [after] = await listRounds(round.term);

      expect(after!.studentCount - before!.studentCount).toBe(3);
      expect(after!.studentsWithoutClub - before!.studentsWithoutClub).toBe(2);
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

    it('refuses a Buddhist year and leaves the round untouched', async () => {
      const round = await createRound();

      const response = await patchRound(round.id, { closesAt: '2569-06-01T16:00:00+07:00' });

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

    // The foreign key from queue_tickets refuses it too (no pre-check), with the same code: the
    // admin's message names students who entered the queue among the reasons.
    it('answers 409 round_not_empty for a round whose only data is queue tickets', async () => {
      const round = await createRound();
      await insertTickets(round, [{ status: 'done' }]);

      const response = await deleteRound(round.id);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('round_not_empty');
      expect(response.body).not.toContain('queue_tickets_round_id_fkey');
      expect(await countRounds(round.term)).toBe(1);
    });

    it('answers 404 for an unknown round', async () => {
      const response = await deleteRound(2_000_000_000);

      expect(response.statusCode).toBe(404);
    });
  });

  // README Phase 3 decision 6 (Q4): maxActive null = the round has no queue.
  describe('a round without a queue', () => {
    const patchRound = async (id: number, payload: Record<string, unknown>) =>
      await request({ method: 'PATCH', url: `/api/admin/rounds/${id}`, payload });

    it('creates a round with maxActive null and stores NULL', async () => {
      const response = await postRound({
        term: uniqueTerm(),
        grade: 2,
        ...futureWindow(),
        maxActive: null,
      });

      expect(response.statusCode).toBe(201);
      const round = roundOf(response);
      expect(round.maxActive).toBeNull();
      expect(await storedMaxActive(round.id)).toBeNull();
    });

    it('creates every grade of a batch without a queue', async () => {
      const term = uniqueTerm();

      const response = await request({
        method: 'POST',
        url: '/api/admin/rounds/batch',
        payload: { term, ...futureWindow(), maxActive: null },
      });

      expect(response.statusCode).toBe(201);
      expect(roundsOf(response).map(({ maxActive }) => maxActive)).toEqual(Array(6).fill(null));
    });

    it('turns the queue off with maxActive null and keeps the window', async () => {
      const round = await createRound({ maxActive: 120 });

      const response = await patchRound(round.id, { maxActive: null });

      expect(response.statusCode).toBe(200);
      expect(roundOf(response)).toEqual({ ...round, maxActive: null });
      expect(await storedMaxActive(round.id)).toBeNull();
    });

    it('turns the queue back on with a number', async () => {
      const round = await createRound({ maxActive: null });

      const response = await patchRound(round.id, { maxActive: 40 });

      expect(roundOf(response).maxActive).toBe(40);
      expect(await storedMaxActive(round.id)).toBe(40);
    });

    it.each([
      ['no queue', null],
      ['a number', 70],
    ])('keeps %s when a change leaves maxActive out', async (_case, maxActive) => {
      const round = await createRound({ maxActive });
      const closesAt = new Date(Date.parse(round.closesAt) + HOUR_MS).toISOString();

      const response = await patchRound(round.id, { closesAt });

      expect(roundOf(response)).toEqual({ ...round, closesAt });
      expect(await storedMaxActive(round.id)).toBe(maxActive);
    });

    it('refuses maxActive 0 and keeps the setting', async () => {
      const round = await createRound({ maxActive: null });

      const response = await patchRound(round.id, { maxActive: 0 });

      expect(response.statusCode).toBe(400);
      expect(await storedMaxActive(round.id)).toBeNull();
    });

    it('keeps the CHECK and the default of the column', async () => {
      const term = uniqueTerm();

      const defaulted = await pool.query<{ max_active: number | null }>(
        `INSERT INTO rounds (term, grade, opens_at, closes_at)
         VALUES ($1, 1, now() + interval '1 day', now() + interval '2 days')
         RETURNING max_active`,
        [term],
      );
      const zero = pool.query(
        `INSERT INTO rounds (term, grade, opens_at, closes_at, max_active)
         VALUES ($1, 2, now() + interval '1 day', now() + interval '2 days', 0)`,
        [term],
      );

      expect(defaulted.rows[0]?.max_active).toBe(150);
      await expect(zero).rejects.toMatchObject({ code: '23514' });
    });
  });

  // The admin's view of the queue (Q4): live tickets now by the DB clock, as the queue counts them.
  describe('queue counts', () => {
    it('counts the live waiting and admitted tickets of each round', async () => {
      const round = await createRound({ maxActive: 5 });
      const other = await createRound({ grade: 2, maxActive: 5 });
      await insertTickets(round, [
        { status: 'waiting' },
        { status: 'waiting', seenSecondsAgo: IDLE - 10 },
        { status: 'admitted' },
        { status: 'admitted', seenSecondsAgo: 5, admittedSecondsAgo: TTL - 10 },
        { status: 'admitted' },
      ]);
      await insertTickets(other, [{ status: 'waiting' }]);

      const [listed] = await listRounds(round.term);
      const [listedOther] = await listRounds(other.term);

      expect(listed).toMatchObject({ queueWaiting: 2, queueAdmitted: 3 });
      expect(listedOther).toMatchObject({ queueWaiting: 1, queueAdmitted: 0 });
    });

    // Stale rows still say waiting or admitted until the next queue write marks them expired.
    it('leaves out tickets past the idle timeout or the TTL, and ended ones', async () => {
      const round = await createRound();
      await insertTickets(round, [
        { status: 'waiting', seenSecondsAgo: IDLE + 1 },
        { status: 'admitted', seenSecondsAgo: IDLE + 1 },
        { status: 'admitted', admittedSecondsAgo: TTL + 1 },
        { status: 'expired' },
        { status: 'done' },
        { status: 'waiting' },
      ]);

      const [listed] = await listRounds(round.term);

      expect(listed).toMatchObject({ queueWaiting: 1, queueAdmitted: 0 });
    });

    it('starts a new round at zero and answers the counts on an edit too', async () => {
      const round = await createRound();
      expect(round).toMatchObject({ queueWaiting: 0, queueAdmitted: 0 });
      await insertTickets(round, [{ status: 'admitted' }, { status: 'admitted' }]);

      const response = await request({
        method: 'PATCH',
        url: `/api/admin/rounds/${round.id}`,
        payload: { maxActive: 1 },
      });

      // Lowered under the admitted count: nobody is removed, so both still count.
      expect(roundOf(response)).toMatchObject({ maxActive: 1, queueWaiting: 0, queueAdmitted: 2 });
    });

    it('still counts the tickets left when the queue was turned off', async () => {
      const round = await createRound({ maxActive: 3 });
      await insertTickets(round, [{ status: 'admitted' }, { status: 'waiting' }]);

      const response = await request({
        method: 'PATCH',
        url: `/api/admin/rounds/${round.id}`,
        payload: { maxActive: null },
      });

      expect(roundOf(response)).toMatchObject({
        maxActive: null,
        queueWaiting: 1,
        queueAdmitted: 1,
      });
    });

    it('uses the queue settings the app runs with', async () => {
      const round = await createRound();
      await insertTickets(round, [{ status: 'waiting', seenSecondsAgo: 30 }]);
      const strict = await buildApp({
        pool,
        jwtSecret: TEST_JWT_SECRET,
        queue: { idleTimeoutSeconds: 20, admissionTtlSeconds: TTL },
      });
      try {
        const response = await strict.inject({
          method: 'GET',
          url: '/api/admin/rounds',
          query: { term: round.term },
          cookies: { [SESSION_COOKIE]: adminToken },
        });

        expect(roundsOf(response)[0]).toMatchObject({ queueWaiting: 0 });
      } finally {
        await strict.close();
      }
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

    it('records a round created without a queue as maxActive null', async () => {
      const round = await createRound({ maxActive: null });

      expect(auditEntries('round.create')).toEqual([
        expect.objectContaining({ adminId, roundId: round.id, maxActive: null }),
      ]);
    });

    it('records turning the queue off as a change of maxActive to null', async () => {
      const round = await createRound();

      await request({
        method: 'PATCH',
        url: `/api/admin/rounds/${round.id}`,
        payload: { maxActive: null },
      });

      expect(auditEntries('round.update')).toEqual([
        expect.objectContaining({
          adminId,
          roundId: round.id,
          changed: ['maxActive'],
          maxActive: null,
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
