import { createHash, randomUUID } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  adminClubResponseSchema,
  errorResponseSchema,
  importCommitResponseSchema,
  roundResponseSchema,
} from '@club-registration/shared';
import type ExcelJS from 'exceljs';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { DEFAULT_POOL_SETTINGS, createPool } from '../src/db.js';
import { parseImportWorkbook } from '../src/import/parse.js';
import { commitImport } from '../src/services/import-commit.js';
import { lockRound } from '../src/services/round-lock.js';
import { TEST_JWT_SECRET } from './support/app.js';
import {
  createClub,
  createStudent,
  uniqueCode,
  uniqueStudentId,
  uniqueTerm,
} from './support/import-db.js';
import { buildImportWorkbook, clubRow, multipartBody, studentRow } from './support/import.js';
import { waitForLockWaiter } from './support/lock-waiter.js';
import {
  appConnectionUri,
  startMigratedPostgres,
  stopPostgres,
  truncateAsOwner,
} from './support/postgres.js';
import {
  addWaitingDirectly,
  createAdminId,
  createOpenRound,
  createStudentId,
  createStudents,
  moveWindow,
  newKey,
  registrationInvariantViolations,
  seatStudent,
  sessionCookie,
  storedSeats,
} from './support/registration.js';

// The promote engine run by an admin's writes (README Phase 2): a club edit that raises capacity,
// a round edit that reopens a closed round and an import commit that raises capacity. Each
// promotes under the round locks it already holds, with the admin as the actor of every
// promotion, in a round that is open or upcoming (a closed one promotes nobody). Every value is
// made up.

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const CLUB_NAME = 'ชุมนุมสมมติ เพิ่มที่นั่ง';
const HOUR = 3_600;

type EventRow = {
  student_id: number;
  club_id: number | null;
  from_club_id: number | null;
  actor_id: number;
  idempotency_key: string | null;
};

const codeOf = (response: InjectResponse) =>
  response.statusCode === 200 ? 'ok' : errorResponseSchema.parse(response.json()).code;
const clubOf = (response: InjectResponse) => adminClubResponseSchema.parse(response.json()).club;
const roundOf = (response: InjectResponse) => roundResponseSchema.parse(response.json()).round;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// An instant `seconds` from now, as an admin's form would send it.
const isoIn = (seconds: number) => new Date(Date.now() + seconds * 1_000).toISOString();

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

// Never rejects, so a promise started before the test awaits it cannot surface as an unhandled
// rejection in between.
const settle = async <T>(work: Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error };
  }
};

const backendPid = async (client: PoolClient): Promise<number> => {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0]!.pid;
};

const ROUND_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1::bigint)';
const IMPORT_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1, $2)';

describe('promotion by admin writes', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminId: number;
  let logLines: string[];

  const asStudent = async (
    method: 'POST',
    url: string,
    studentId: number,
    payload: NonNullable<InjectOptions['payload']>,
  ) =>
    await app.inject({
      method,
      url,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, studentId) },
      payload,
    });

  const join = async (studentId: number, clubId: number) =>
    await asStudent('POST', '/api/student/waitlist', studentId, {
      clubId,
      idempotencyKey: newKey(),
    });
  const register = async (studentId: number, clubId: number) =>
    await asStudent('POST', '/api/student/registration', studentId, {
      clubId,
      idempotencyKey: newKey(),
    });
  const cancel = async (studentId: number) =>
    await asStudent('POST', '/api/student/registration/cancel', studentId, {
      idempotencyKey: newKey(),
    });
  const leave = async (studentId: number) =>
    await asStudent('POST', '/api/student/waitlist/leave', studentId, {
      idempotencyKey: newKey(),
    });

  const joinAll = async (studentIds: readonly number[], clubId: number) => {
    for (const studentId of studentIds) expect(codeOf(await join(studentId, clubId))).toBe('ok');
  };

  const patchClub = async (clubId: number, payload: Record<string, unknown>) =>
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/clubs/${clubId}`,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, adminId, 'admin') },
      payload,
    });

  const commitFile = async (term: string, bytes: Buffer) => {
    const body = await multipartBody(
      { term, fileSha256: sha256(bytes), idempotencyKey: randomUUID() },
      [{ name: 'import.xlsx', bytes }],
    );
    return await app.inject({
      method: 'POST',
      url: '/api/admin/import/commit',
      payload: body.payload,
      headers: body.headers,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, adminId, 'admin') },
    });
  };

  const importClubs = async (term: string, rows: ExcelJS.CellValue[][]) =>
    await commitFile(term, await buildImportWorkbook({ clubs: rows }));

  const queueOf = async (clubId: number) => {
    const { rows } = await pool.query<{ student_id: number }>(
      'SELECT student_id FROM waitlist_entries WHERE club_id = $1 ORDER BY created_at, id',
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

  const promoteEvents = async () => {
    const { rows } = await pool.query<EventRow>(
      `SELECT student_id, club_id, from_club_id, actor_id, idempotency_key
       FROM registration_events WHERE event_type = 'waitlist_promote' ORDER BY id`,
    );
    return rows;
  };

  const promoted = (studentId: number, clubId: number, fromClubId: number | null = null) => ({
    student_id: studentId,
    club_id: clubId,
    from_club_id: fromClubId,
    actor_id: adminId,
    idempotency_key: null,
  });

  const termOf = async (roundId: number) => {
    const { rows } = await pool.query<{ term: string }>('SELECT term FROM rounds WHERE id = $1', [
      roundId,
    ]);
    return rows[0]!.term;
  };

  const createOpenRoundIn = async (term: string, grade: number) => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO rounds (term, grade, opens_at, closes_at)
       VALUES ($1, $2, now() - interval '1 hour', now() + interval '1 hour') RETURNING id`,
      [term, grade],
    );
    return rows[0]!.id;
  };

  // A club in an open round whose seats are all taken, and students waiting for it in join order.
  const fullClubWithWaiters = async ({
    capacity = 1,
    waiters = 1,
    grade = 1,
    roundId,
  }: { capacity?: number; waiters?: number; grade?: number; roundId?: number } = {}) => {
    const round = roundId ?? (await createOpenRound(pool, grade));
    const clubCode = uniqueCode();
    const clubId = await createClub(pool, round, clubCode, { name: CLUB_NAME, capacity });
    const holders = await createStudents(pool, capacity, { grade });
    for (const holder of holders) await seatStudent(pool, holder, clubId);
    const queue = await createStudents(pool, waiters, { grade });
    await joinAll(queue, clubId);
    return { roundId: round, clubId, clubCode, holders, queue };
  };

  const patchRound = async (roundId: number, payload: Record<string, unknown>) =>
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/rounds/${roundId}`,
      cookies: { [SESSION_COOKIE]: sessionCookie(app, adminId, 'admin') },
      payload,
    });

  const auditLines = (action = 'club.update') =>
    logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(({ audit }) => audit === action);

  const importLines = () =>
    logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(({ msg }) => msg === 'import committed' || msg === 'import rejected');

  beforeAll(async () => {
    container = await startMigratedPostgres();
    // The race below has a few dozen requests contend for the round lock; same reason as
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

  describe('PATCH /api/admin/clubs/:id', () => {
    it.each([
      ['fewer new seats than waiters', { added: 2, waiters: 3, promotedCount: 2 }],
      ['more new seats than waiters', { added: 3, waiters: 2, promotedCount: 2 }],
    ])(
      'promotes min(new seats, waiters) in queue order with %s',
      async (_label, { added, waiters, promotedCount }) => {
        const { clubId, queue } = await fullClubWithWaiters({ capacity: 2, waiters });

        const response = await patchClub(clubId, { capacity: 2 + added });

        expect(response.statusCode).toBe(200);
        expect(await promoteEvents()).toEqual(
          queue.slice(0, promotedCount).map((studentId) => promoted(studentId, clubId)),
        );
        expect(await queueOf(clubId)).toEqual(queue.slice(promotedCount));
        await Promise.all(
          queue
            .slice(0, promotedCount)
            .map(async (studentId) => expect(await heldClubs(studentId)).toEqual([clubId])),
        );
      },
    );

    it('answers with the club as it is after the promotions', async () => {
      const { clubId } = await fullClubWithWaiters({ capacity: 2, waiters: 3 });

      const response = await patchClub(clubId, { capacity: 4 });

      expect(clubOf(response)).toMatchObject({ capacity: 4, registered: 4, remaining: 0 });
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 4, capacity: 4, rows: 4 });
    });

    it('moves a waiter who holds another club and promotes on in that club', async () => {
      const { roundId, clubId: clubX } = await fullClubWithWaiters({ waiters: 0 });
      const { clubId: clubY, holders, queue } = await fullClubWithWaiters({ roundId });
      const [fromY] = holders;
      const [waitingForY] = queue;
      expect(codeOf(await join(fromY!, clubX))).toBe('ok');

      const response = await patchClub(clubX, { capacity: 2 });

      expect(await promoteEvents()).toEqual([
        promoted(fromY!, clubX, clubY),
        promoted(waitingForY!, clubY),
      ]);
      expect(await heldClubs(fromY!)).toEqual([clubX]);
      expect(await heldClubs(waitingForY!)).toEqual([clubY]);
      expect(await storedSeats(pool, clubY)).toEqual({ registered: 1, capacity: 1, rows: 1 });
      expect(clubOf(response)).toMatchObject({ capacity: 2, registered: 2, remaining: 0 });
    });

    it('promotes nobody after the round closed', async () => {
      const { roundId, clubId, queue } = await fullClubWithWaiters({ waiters: 2 });
      await moveWindow(pool, roundId, { opensInSeconds: -2 * HOUR, closesInSeconds: -60 });

      const response = await patchClub(clubId, { capacity: 3 });

      expect(clubOf(response)).toMatchObject({ capacity: 3, registered: 1, remaining: 2 });
      expect(await queueOf(clubId)).toEqual(queue);
      expect(await promoteEvents()).toEqual([]);
    });

    it('promotes nobody when another club of the round lowers its capacity', async () => {
      const { roundId, clubId, queue } = await fullClubWithWaiters({ waiters: 2 });
      const roomy = await createClub(pool, roundId, uniqueCode(), { capacity: 5 });
      await seatStudent(pool, await createStudentId(pool), roomy);

      const response = await patchClub(roomy, { capacity: 3 });

      expect(clubOf(response)).toMatchObject({ capacity: 3, registered: 1 });
      expect(await queueOf(clubId)).toEqual(queue);
      expect(await promoteEvents()).toEqual([]);
    });

    it('does not run the engine for an edit without a capacity', async () => {
      const roundId = await createOpenRound(pool);
      const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 2 });
      const waiting = await createStudentId(pool);
      // A free seat with a queue in an open round, which no writer leaves behind: put in directly.
      await addWaitingDirectly(pool, { roundId, clubId, studentId: waiting });

      const response = await patchClub(clubId, { name: 'ชื่อใหม่สมมติ', description: 'ใหม่' });

      expect(response.statusCode).toBe(200);
      expect(await queueOf(clubId)).toEqual([waiting]);
      expect(await promoteEvents()).toEqual([]);
      expect(codeOf(await leave(waiting))).toBe('ok');
    });

    it('logs the promotions as a count and student ids, never a name', async () => {
      const { clubId, queue } = await fullClubWithWaiters({ waiters: 2 });

      await patchClub(clubId, { capacity: 3 });

      expect(auditLines()).toEqual([
        expect.objectContaining({ adminId, clubId, promoted: 2, promotedStudentIds: queue }),
      ]);
      const log = logLines.join('\n');
      expect(log).not.toContain(CLUB_NAME);
      expect(log).not.toContain('นักเรียนสมมติ');
    });

    it('logs a capacity edit that promoted nobody with a count of 0 and no ids', async () => {
      const { clubId } = await fullClubWithWaiters({ waiters: 0 });

      await patchClub(clubId, { capacity: 3 });

      const [line] = auditLines();
      expect(line).toMatchObject({ promoted: 0 });
      expect(line).not.toHaveProperty('promotedStudentIds');
    });

    it('keeps every invariant while it races cancels and joins in the round', async () => {
      const { clubId, holders, queue } = await fullClubWithWaiters({ capacity: 10, waiters: 20 });
      const newcomers = await createStudents(pool, 10);

      const [patched, cancels, outcomes] = await Promise.all([
        patchClub(clubId, { capacity: 15 }),
        Promise.all(holders.slice(0, 5).map(async (studentId) => await cancel(studentId))),
        Promise.all(
          newcomers.map(async (studentId) => {
            const registered = await register(studentId, clubId);
            return codeOf(registered) === 'club_full'
              ? codeOf(await join(studentId, clubId))
              : codeOf(registered);
          }),
        ),
      ]);

      expect(patched.statusCode).toBe(200);
      expect(cancels.map(codeOf)).toEqual(Array.from({ length: 5 }, () => 'ok'));
      // The queue is never empty, so nobody gets a seat directly and every newcomer queues.
      expect(outcomes).toEqual(Array.from({ length: 10 }, () => 'ok'));
      // Five seats from the cancels and five from the capacity go to the first ten waiters, in
      // the order they joined, whichever writer freed each seat.
      const { rows } = await pool.query<{ student_id: number }>(
        `SELECT student_id FROM registration_events
         WHERE event_type = 'waitlist_promote' AND club_id = $1 ORDER BY id`,
        [clubId],
      );
      expect(rows.map(({ student_id: studentId }) => studentId)).toEqual(queue.slice(0, 10));
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 15, capacity: 15, rows: 15 });
      expect(await queueOf(clubId)).toHaveLength(20);
    }, 60_000);
  });

  describe('PATCH /api/admin/rounds/:id', () => {
    const CLOSED = Object.freeze({ opensInSeconds: -2 * HOUR, closesInSeconds: -60 });

    // The gap a round edit has to close: after the round closed, an admin raised a capacity (the
    // engine promotes nobody in a closed round), so the club has free seats and a queue.
    const closedClubWithSeatsAndWaiters = async ({
      capacity = 1,
      added = 2,
      waiters = 3,
    }: { capacity?: number; added?: number; waiters?: number } = {}) => {
      const club = await fullClubWithWaiters({ capacity, waiters });
      await moveWindow(pool, club.roundId, CLOSED);
      expect(clubOf(await patchClub(club.clubId, { capacity: capacity + added }))).toMatchObject({
        registered: capacity,
        remaining: added,
      });
      expect(await promoteEvents()).toEqual([]);
      return club;
    };

    const reopen = { closesAt: isoIn(HOUR) };

    it('promotes the waiters in queue order when it reopens a closed round', async () => {
      const { roundId, clubId, queue } = await closedClubWithSeatsAndWaiters();

      const response = await patchRound(roundId, reopen);

      expect(response.statusCode).toBe(200);
      expect(await promoteEvents()).toEqual([
        promoted(queue[0]!, clubId),
        promoted(queue[1]!, clubId),
      ]);
      expect(await queueOf(clubId)).toEqual([queue[2]]);
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 3, capacity: 3, rows: 3 });
    });

    it('answers with the round totals as they are after the promotions', async () => {
      const { roundId } = await closedClubWithSeatsAndWaiters();

      const response = await patchRound(roundId, reopen);

      expect(roundOf(response)).toMatchObject({
        status: 'open',
        totalCapacity: 3,
        totalRegistered: 3,
      });
    });

    it('promotes nobody when the edit leaves it closed', async () => {
      const { roundId, clubId, queue } = await closedClubWithSeatsAndWaiters();

      const response = await patchRound(roundId, { maxActive: 5 });

      expect(response.statusCode).toBe(200);
      expect(await queueOf(clubId)).toEqual(queue);
      expect(await promoteEvents()).toEqual([]);
      const [line] = auditLines('round.update');
      expect(line).toMatchObject({ promoted: 0 });
      expect(line).not.toHaveProperty('promotedStudentIds');
    });

    // An upcoming round opens by the clock with no write to run the engine, so the edit that
    // makes it upcoming has to promote already (README open item 18).
    it('promotes the waiters in queue order when it reopens a closed round as upcoming', async () => {
      const { roundId, clubId, queue } = await closedClubWithSeatsAndWaiters();

      const response = await patchRound(roundId, {
        opensAt: isoIn(HOUR),
        closesAt: isoIn(2 * HOUR),
      });

      expect(roundOf(response)).toMatchObject({ status: 'upcoming', totalRegistered: 3 });
      expect(await promoteEvents()).toEqual([
        promoted(queue[0]!, clubId),
        promoted(queue[1]!, clubId),
      ]);
      expect(await queueOf(clubId)).toEqual([queue[2]]);
      expect(auditLines('round.update')).toEqual([
        expect.objectContaining({ promoted: 2, promotedStudentIds: queue.slice(0, 2) }),
      ]);
    });

    it('logs the promotions as a count and student ids, never a name', async () => {
      const { roundId, queue } = await closedClubWithSeatsAndWaiters();

      await patchRound(roundId, reopen);

      expect(auditLines('round.update')).toEqual([
        expect.objectContaining({
          adminId,
          roundId,
          changed: ['closesAt'],
          promoted: 2,
          promotedStudentIds: queue.slice(0, 2),
        }),
      ]);
      const log = logLines.join('\n');
      expect(log).not.toContain(CLUB_NAME);
      expect(log).not.toContain('นักเรียนสมมติ');
    });

    it('promotes nobody and changes nothing when the window is refused', async () => {
      const { roundId, clubId, queue } = await closedClubWithSeatsAndWaiters();

      // A closesAt before the stored opensAt: only the DB CHECK can tell.
      const response = await patchRound(roundId, { closesAt: isoIn(-3 * HOUR) });

      expect(codeOf(response)).toBe('validation_error');
      expect(await queueOf(clubId)).toEqual(queue);
      expect(await promoteEvents()).toEqual([]);
    });

    it('waits for an import commit that is running, then promotes', async () => {
      const { roundId, clubId, queue } = await closedClubWithSeatsAndWaiters({ waiters: 2 });
      // A student in the file whose users row is held, so the import stops at its first write
      // while it holds the import lock.
      const other = await createStudent(pool, { fullName: 'ชื่อเก่า สมมติ' });
      const parsed = await parseImportWorkbook(
        await buildImportWorkbook({
          students: [studentRow({ loginId: other.loginId, fullName: 'ชื่อใหม่ สมมติ' })],
        }),
      );
      const blocker = await pool.connect();
      let released = false;
      try {
        await blocker.query('BEGIN');
        const blockerPid = await backendPid(blocker);
        await blocker.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [other.id]);
        const importing = settle(
          commitImport(pool, { term: uniqueTerm(), parsed, actorId: adminId }),
        );
        const importWaiter = await waitForLockWaiter(pool, ({ pid }) => pid !== blockerPid);
        expect(importWaiter.query).toContain('INSERT INTO users');

        const editing = settle(patchRound(roundId, reopen));
        const editWaiter = await waitForLockWaiter(
          pool,
          ({ pid }) => pid !== blockerPid && pid !== importWaiter.pid,
        );
        // On the import lock, before its round lock or the rounds row.
        expect(editWaiter).toMatchObject({ waitEvent: 'advisory', query: IMPORT_LOCK_SQL });
        expect(await promoteEvents()).toEqual([]);
        await blocker.query('ROLLBACK');
        released = true;

        const imported = await importing;
        expect(imported.ok && imported.value.status).toBe('committed');
        const edited = await editing;
        expect(edited.ok && edited.value.statusCode).toBe(200);
        expect(await promoteEvents()).toEqual(
          queue.map((studentId) => promoted(studentId, clubId)),
        );
      } finally {
        if (!released) await blocker.query('ROLLBACK');
        blocker.release();
      }
    });

    it('makes an import commit wait behind an edit that waits for a round lock, without deadlock', async () => {
      const { roundId, clubId, queue } = await closedClubWithSeatsAndWaiters({ waiters: 2 });
      // An import of the round's own term locks every round of the term, this closed one too.
      const newcomer = uniqueStudentId();
      const parsed = await parseImportWorkbook(
        await buildImportWorkbook({ students: [studentRow({ loginId: newcomer })] }),
      );
      const registrar = await pool.connect();
      let finished = false;
      try {
        await registrar.query('BEGIN');
        const registrarPid = await backendPid(registrar);
        // A student's write in that round, at its first step: it holds the round lock only.
        await lockRound(registrar, roundId);
        const editing = settle(patchRound(roundId, reopen));
        const editWaiter = await waitForLockWaiter(pool, ({ pid }) => pid !== registrarPid);
        expect(editWaiter).toMatchObject({ waitEvent: 'advisory', query: ROUND_LOCK_SQL });

        const importing = settle(
          commitImport(pool, { term: await termOf(roundId), parsed, actorId: adminId }),
        );
        const importWaiter = await waitForLockWaiter(
          pool,
          ({ pid }) => pid !== registrarPid && pid !== editWaiter.pid,
        );
        // Behind the edit's import lock, holding nothing. Were it to get past it, it would take
        // FOR SHARE on the rounds row and queue for the round lock behind the edit, whose UPDATE
        // would then wait for that row: a deadlock Postgres breaks with 40P01.
        expect(importWaiter).toMatchObject({ waitEvent: 'advisory', query: IMPORT_LOCK_SQL });
        await registrar.query('COMMIT');
        finished = true;

        const edited = await editing;
        expect(edited.ok && edited.value.statusCode).toBe(200);
        const imported = await importing;
        expect(imported.ok && imported.value.status).toBe('committed');
        expect(await promoteEvents()).toEqual(
          queue.map((studentId) => promoted(studentId, clubId)),
        );
      } finally {
        if (!finished) await registrar.query('ROLLBACK');
        registrar.release();
      }
    });

    it('keeps every invariant while it reopens the round under student registrations', async () => {
      const { roundId, clubId, queue } = await closedClubWithSeatsAndWaiters({
        capacity: 2,
        added: 5,
        waiters: 8,
      });
      const roomy = await createClub(pool, roundId, uniqueCode(), { capacity: 20 });
      const [forRoomy, forFull] = [await createStudents(pool, 10), await createStudents(pool, 5)];

      const [patched, roomyOutcomes, fullOutcomes] = await Promise.all([
        patchRound(roundId, reopen),
        Promise.all(forRoomy.map(async (studentId) => codeOf(await register(studentId, roomy)))),
        Promise.all(
          forFull.map(async (studentId) => {
            const registered = await register(studentId, clubId);
            return codeOf(registered) === 'club_full'
              ? codeOf(await join(studentId, clubId))
              : codeOf(registered);
          }),
        ),
      ]);

      expect(patched.statusCode).toBe(200);
      // Before the edit commits the round is closed; after it, the full club still has a queue.
      for (const outcome of [...roomyOutcomes, ...fullOutcomes]) {
        expect(['ok', 'round_not_open']).toContain(outcome);
      }
      const { rows } = await pool.query<{ student_id: number }>(
        `SELECT student_id FROM registration_events
         WHERE event_type = 'waitlist_promote' AND club_id = $1 ORDER BY id`,
        [clubId],
      );
      expect(rows.map(({ student_id: studentId }) => studentId)).toEqual(queue.slice(0, 5));
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 7, capacity: 7, rows: 7 });
      const seated = roomyOutcomes.filter((outcome) => outcome === 'ok').length;
      expect(await storedSeats(pool, roomy)).toEqual({
        registered: seated,
        capacity: 20,
        rows: seated,
      });
    }, 60_000);
  });

  describe('POST /api/admin/import/commit', () => {
    it('promotes in queue order when the file raises a capacity in an open round', async () => {
      const { roundId, clubId, clubCode, queue } = await fullClubWithWaiters({ waiters: 3 });

      const response = await importClubs(await termOf(roundId), [
        clubRow({ clubCode, name: CLUB_NAME, capacity: 3 }),
      ]);

      expect(response.statusCode).toBe(200);
      expect(importCommitResponseSchema.parse(response.json()).clubs.update).toBe(1);
      expect(await promoteEvents()).toEqual([
        promoted(queue[0]!, clubId),
        promoted(queue[1]!, clubId),
      ]);
      expect(await queueOf(clubId)).toEqual([queue[2]]);
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 3, capacity: 3, rows: 3 });
    });

    it('logs how many it promoted, per round, as counts only', async () => {
      const { roundId, clubCode } = await fullClubWithWaiters({ waiters: 3 });

      await importClubs(await termOf(roundId), [
        clubRow({ clubCode, name: CLUB_NAME, capacity: 3 }),
      ]);

      expect(importLines()).toEqual([
        expect.objectContaining({ promoted: 2, promotedByRound: [{ roundId, count: 2 }] }),
      ]);
      expect(logLines.join('\n')).not.toContain(CLUB_NAME);
    });

    it('promotes nobody in a round that is closed', async () => {
      const { roundId, clubId, clubCode, queue } = await fullClubWithWaiters({ waiters: 2 });
      await moveWindow(pool, roundId, { opensInSeconds: -2 * HOUR, closesInSeconds: -60 });

      const response = await importClubs(await termOf(roundId), [
        clubRow({ clubCode, name: CLUB_NAME, capacity: 3 }),
      ]);

      expect(response.statusCode).toBe(200);
      expect(await queueOf(clubId)).toEqual(queue);
      expect(await promoteEvents()).toEqual([]);
      expect(importLines()).toEqual([expect.objectContaining({ promoted: 0 })]);
    });

    it('promotes in every open round of the term whose capacity it raised', async () => {
      const term = uniqueTerm();
      const first = await fullClubWithWaiters({
        roundId: await createOpenRoundIn(term, 1),
        waiters: 2,
      });
      const second = await fullClubWithWaiters({
        roundId: await createOpenRoundIn(term, 2),
        grade: 2,
        waiters: 2,
      });

      await importClubs(term, [
        clubRow({ clubCode: first.clubCode, name: CLUB_NAME, grade: 1, capacity: 2 }),
        clubRow({ clubCode: second.clubCode, name: CLUB_NAME, grade: 2, capacity: 3 }),
      ]);

      expect(await promoteEvents()).toEqual([
        promoted(first.queue[0]!, first.clubId),
        promoted(second.queue[0]!, second.clubId),
        promoted(second.queue[1]!, second.clubId),
      ]);
      expect(importLines()).toEqual([
        expect.objectContaining({
          promoted: 3,
          promotedByRound: [
            { roundId: first.roundId, count: 1 },
            { roundId: second.roundId, count: 2 },
          ],
        }),
      ]);
    });

    it('promotes nobody when the file is refused', async () => {
      const { roundId, clubId, clubCode, queue } = await fullClubWithWaiters({ waiters: 2 });
      const workbook = await buildImportWorkbook({
        clubs: [clubRow({ clubCode, name: CLUB_NAME, capacity: 3 })],
        students: [studentRow({ loginId: '' })],
      });

      const response = await commitFile(await termOf(roundId), workbook);

      expect(response.statusCode).toBe(422);
      expect(await queueOf(clubId)).toEqual(queue);
      expect(await promoteEvents()).toEqual([]);
    });
  });

  // README open item 18: waiters exist in an upcoming round only if an admin moved an opened
  // round back to upcoming. A capacity raised then must promote at once, because the round opens
  // by the clock later and no write runs the engine at that moment.
  describe('in a round moved back to upcoming', () => {
    const upcomingClubWithWaiters = async () => {
      const club = await fullClubWithWaiters({ capacity: 1, waiters: 3 });
      const response = await patchRound(club.roundId, {
        opensAt: isoIn(HOUR),
        closesAt: isoIn(2 * HOUR),
      });
      expect(roundOf(response)).toMatchObject({ status: 'upcoming' });
      expect(await promoteEvents()).toEqual([]);
      return club;
    };

    it('promotes in queue order when a club edit raises the capacity', async () => {
      const { clubId, queue } = await upcomingClubWithWaiters();

      const response = await patchClub(clubId, { capacity: 3 });

      expect(clubOf(response)).toMatchObject({ registered: 3, remaining: 0 });
      expect(await promoteEvents()).toEqual([
        promoted(queue[0]!, clubId),
        promoted(queue[1]!, clubId),
      ]);
      expect(await queueOf(clubId)).toEqual([queue[2]]);
      expect(await heldClubs(queue[0]!)).toEqual([clubId]);
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 3, capacity: 3, rows: 3 });
    });

    it('promotes in queue order when an import commit raises the capacity', async () => {
      const { roundId, clubId, clubCode, queue } = await upcomingClubWithWaiters();

      const response = await importClubs(await termOf(roundId), [
        clubRow({ clubCode, name: CLUB_NAME, capacity: 3 }),
      ]);

      expect(response.statusCode).toBe(200);
      expect(await promoteEvents()).toEqual([
        promoted(queue[0]!, clubId),
        promoted(queue[1]!, clubId),
      ]);
      expect(await queueOf(clubId)).toEqual([queue[2]]);
      expect(await storedSeats(pool, clubId)).toEqual({ registered: 3, capacity: 3, rows: 3 });
      expect(importLines()).toEqual([
        expect.objectContaining({ promoted: 2, promotedByRound: [{ roundId, count: 2 }] }),
      ]);
    });
  });
});
