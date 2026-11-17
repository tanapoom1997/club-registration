import { setTimeout as sleep } from 'node:timers/promises';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { IMPORT_COLUMNS, importPreviewResponseSchema } from '@club-registration/shared';
import type ExcelJS from 'exceljs';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool, withTransaction } from '../src/db.js';
import { parseImportWorkbook } from '../src/import/parse.js';
import { commitImport } from '../src/services/import-commit.js';
import { registerForClub } from '../src/services/registrations.js';
import { lockRound, lockRoundsForImport } from '../src/services/round-lock.js';
import { buildTestApp, createTestUser } from './support/app.js';
import {
  createClub,
  createStudent,
  uniqueCode,
  uniqueStudentId,
  uniqueTerm,
} from './support/import-db.js';
import { buildImportWorkbook, clubRow, multipartBody, studentRow } from './support/import.js';
import { startMigratedPostgres, stopPostgres } from './support/postgres.js';
import {
  createStudents,
  eventsOf,
  moveWindow,
  newKey,
  registrationInvariantViolations,
  seatStudent,
  sessionCookie,
} from './support/registration.js';

// The import commit against registrations (CLAUDE.md rule 3): before planning, the commit takes
// the round lock of every round of its term and of every round of another term that has not
// closed yet, so a registration in one of them either commits before the plan reads it or waits
// for the import to commit. Each race is made deterministic by holding a lock
// on a separate connection and watching pg_stat_activity until the other side is blocked on it.
// Every value is made up.

type LockWaiter = { pid: number; waitEvent: string; query: string };

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

// Never rejects, so a promise started before the test is ready to await it cannot surface as an
// unhandled rejection in between.
const settle = async <T>(work: Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error };
  }
};

const HOUR = 3_600;

describe('import commit and the round locks', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  // Window edges in seconds from now by the DB clock, the clock registration decides by.
  const createRoundInTerm = async (
    term: string,
    grade: number,
    { opensIn, closesIn }: { opensIn: number; closesIn: number },
  ): Promise<number> => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO rounds (term, grade, opens_at, closes_at)
       VALUES ($1, $2, now() + $3::int * interval '1 second', now() + $4::int * interval '1 second')
       RETURNING id`,
      [term, grade, opensIn, closesIn],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('Round insert returned no row');
    return id;
  };

  // Rounds of one term, open now by the DB clock, so registrations in them are accepted.
  const createOpenRoundInTerm = async (term: string, grade: number): Promise<number> =>
    await createRoundInTerm(term, grade, { opensIn: -HOUR, closesIn: HOUR });

  const parse = async (rows: Partial<Record<'students' | 'clubs', ExcelJS.CellValue[][]>>) =>
    await parseImportWorkbook(await buildImportWorkbook(rows));

  const backendPid = async (client: PoolClient): Promise<number> => {
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error('pg_backend_pid() returned no row');
    return pid;
  };

  // Polls until a backend in this database waits on a heavyweight lock and matches.
  const waitForLockWaiter = async (matches: (waiter: LockWaiter) => boolean) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rows } = await pool.query<{ pid: number; wait_event: string; query: string }>(
        `SELECT pid, wait_event, query FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND datname = current_database()`,
      );
      const waiter = rows
        .map(({ pid, wait_event: waitEvent, query }) => ({ pid, waitEvent, query }))
        .find(matches);
      if (waiter) return waiter;
      await sleep(25);
    }
    throw new Error('No backend ever waited for the expected lock');
  };

  const gradeOf = async (studentId: number) => {
    const { rows } = await pool.query<{ grade: number }>(
      'SELECT grade FROM student_profiles WHERE user_id = $1',
      [studentId],
    );
    return rows[0]?.grade;
  };

  const userExists = async (loginId: string) => {
    const { rowCount } = await pool.query('SELECT 1 FROM users WHERE login_id = $1', [loginId]);
    return rowCount === 1;
  };

  const seatsOf = async (studentId: number) => {
    const { rows } = await pool.query<{ club_id: number }>(
      'SELECT club_id FROM registrations WHERE student_id = $1',
      [studentId],
    );
    return rows.map(({ club_id: clubId }) => clubId);
  };

  const capacityOf = async (clubId: number) => {
    const { rows } = await pool.query<{ capacity: number }>(
      'SELECT capacity FROM clubs WHERE id = $1',
      [clubId],
    );
    return rows[0]?.capacity;
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(container.getConnectionUri());
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    // A student registers in their grade's selected round, so each test starts with no rounds.
    await pool.query('TRUNCATE rounds CASCADE');
  });

  afterEach(async () => {
    expect(await registrationInvariantViolations(pool)).toEqual([]);
  });

  it('refuses the grade change of a student whose registration commits while it waits', async () => {
    const term = uniqueTerm();
    const roundId = await createOpenRoundInTerm(term, 1);
    await createOpenRoundInTerm(term, 2);
    const clubId = await createClub(pool, roundId, uniqueCode());
    const student = await createStudent(pool, { grade: 1 });
    const newcomer = uniqueStudentId();
    const parsed = await parse({
      students: [
        studentRow({ loginId: student.loginId, grade: 2 }),
        studentRow({ loginId: newcomer }),
      ],
    });
    const registrar = await pool.connect();
    let finished = false;
    try {
      await registrar.query('BEGIN');
      const registrarPid = await backendPid(registrar);
      // The real service, not committed yet: it holds the round lock and the seat.
      await registerForClub(registrar, { studentId: student.id, clubId, idempotencyKey: newKey() });

      const importing = settle(commitImport(pool, term, parsed));
      const waiter = await waitForLockWaiter(({ pid }) => pid !== registrarPid);
      await registrar.query('COMMIT');
      finished = true;
      const result = await importing;

      // Planned after the registration committed, so the move is refused and nothing is written.
      expect(result.ok && result.value.status).toBe('invalid');
      expect(result.ok && result.value.plan.errors).toEqual([
        expect.objectContaining({
          sheet: 'students',
          row: 2,
          column: IMPORT_COLUMNS.students.grade,
        }),
      ]);
      expect(waiter).toMatchObject({
        waitEvent: 'advisory',
        query: 'SELECT pg_advisory_xact_lock($1::bigint)',
      });
      expect(await gradeOf(student.id)).toBe(1);
      expect(await userExists(newcomer)).toBe(false);
      expect(await seatsOf(student.id)).toEqual([clubId]);
    } finally {
      if (!finished) await registrar.query('ROLLBACK');
      registrar.release();
    }
  });

  it('makes a registration wait for the import and then refuses it in the old grade', async () => {
    const term = uniqueTerm();
    const roundId = await createOpenRoundInTerm(term, 1);
    await createOpenRoundInTerm(term, 2);
    const clubId = await createClub(pool, roundId, uniqueCode());
    const student = await createStudent(pool, { grade: 1 });
    // Another student in the file, whose users row is held so the import stops at its first
    // write: after planning, with the round locks taken, before anything is committed.
    const other = await createStudent(pool, { grade: 1, fullName: 'ชื่อเก่า สมมติ' });
    const parsed = await parse({
      students: [
        studentRow({ loginId: student.loginId, grade: 2 }),
        studentRow({ loginId: other.loginId, fullName: 'ชื่อใหม่ สมมติ' }),
      ],
    });
    const blocker = await pool.connect();
    let released = false;
    try {
      await blocker.query('BEGIN');
      const blockerPid = await backendPid(blocker);
      await blocker.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [other.id]);

      const importing = settle(commitImport(pool, term, parsed));
      const importWaiter = await waitForLockWaiter(({ pid }) => pid !== blockerPid);
      expect(importWaiter.query).toContain('INSERT INTO users');
      const registering = settle(
        withTransaction(
          pool,
          async (client) =>
            await registerForClub(client, {
              studentId: student.id,
              clubId,
              idempotencyKey: newKey(),
            }),
        ),
      );
      // The registration queues on the round lock the import holds.
      await waitForLockWaiter(
        ({ pid, waitEvent }) => pid !== importWaiter.pid && waitEvent === 'advisory',
      );
      await blocker.query('ROLLBACK');
      released = true;

      const imported = await importing;
      const registered = await registering;

      expect(imported.ok && imported.value.status).toBe('committed');
      // S2: a club of a grade the student is not in answers 404, as if it did not exist.
      expect(registered.ok).toBe(false);
      expect(!registered.ok && registered.error).toMatchObject({
        code: 'not_found',
        statusCode: 404,
      });
      expect(await gradeOf(student.id)).toBe(2);
      expect(await seatsOf(student.id)).toEqual([]);
      expect(await eventsOf(pool, student.id)).toEqual([]);
    } finally {
      if (!released) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('runs alongside many registrations across the term without deadlock', async () => {
    const term = uniqueTerm();
    const rounds = await Promise.all(
      [1, 2, 3].map(async (grade) => await createOpenRoundInTerm(term, grade)),
    );
    const codes = rounds.map(() => uniqueCode());
    const clubs = await Promise.all(
      rounds.map(
        async (roundId, index) => await createClub(pool, roundId, codes[index]!, { capacity: 40 }),
      ),
    );
    const students = await Promise.all(
      rounds.map(async (_roundId, index) => await createStudents(pool, 25, { grade: index + 1 })),
    );
    // Movers from grade 1 to 2 who also try to register in grade 1 while the import runs.
    const movers = await Promise.all(
      Array.from({ length: 5 }, async () => await createStudent(pool, { grade: 1 })),
    );
    const parsed = await parse({
      students: movers.map(({ loginId }) => studentRow({ loginId, grade: 2 })),
      clubs: codes.map((clubCode, index) => clubRow({ clubCode, grade: index + 1, capacity: 50 })),
    });

    const registrations = [
      ...students.flatMap((ids, index) => ids.map((id) => ({ id, clubId: clubs[index]! }))),
      ...movers.map(({ id }) => ({ id, clubId: clubs[0]! })),
    ];
    const half = Math.floor(registrations.length / 2);
    const seat = async ({ id, clubId }: { id: number; clubId: number }) =>
      await settle(seatStudent(pool, id, clubId));
    const [firstHalf, imported, secondHalf] = await Promise.all([
      Promise.all(registrations.slice(0, half).map(seat)),
      settle(commitImport(pool, term, parsed)),
      Promise.all(registrations.slice(half).map(seat)),
    ]);
    const results = [...firstHalf, ...secondHalf];

    expect(imported.ok).toBe(true);
    // Every student who was not moved gets a seat: no deadlock, no timeout.
    const settledByStudent = new Map(registrations.map(({ id }, index) => [id, results[index]!]));
    for (const ids of students) {
      expect(ids.map((id) => settledByStudent.get(id)?.ok)).toEqual(ids.map(() => true));
    }
    // Movers: the import either refused them (some registered first) or moved them all, and then
    // none of them holds a seat in grade 1.
    const moverSeats = await Promise.all(movers.map(async ({ id }) => await seatsOf(id)));
    const moverGrades = await Promise.all(movers.map(async ({ id }) => await gradeOf(id)));
    if (imported.ok && imported.value.status === 'committed') {
      expect(moverSeats.flat()).toEqual([]);
      expect(moverGrades).toEqual(movers.map(() => 2));
      expect(await Promise.all(clubs.map(capacityOf))).toEqual([50, 50, 50]);
    } else {
      expect(moverSeats.flat().length).toBeGreaterThan(0);
      expect(moverGrades).toEqual(movers.map(() => 1));
      expect(await Promise.all(clubs.map(capacityOf))).toEqual([40, 40, 40]);
    }
  }, 60_000);

  describe("another term's rounds", () => {
    const UPCOMING = Object.freeze({ opensIn: HOUR, closesIn: 2 * HOUR });
    const CLOSED = Object.freeze({ opensIn: -2 * HOUR, closesIn: -HOUR });

    // A student of grade 1 with a seat in an open grade-1 round of an earlier term, taken through
    // the real service.
    const seatedInEarlierTerm = async () => {
      const earlierTerm = uniqueTerm();
      const roundId = await createOpenRoundInTerm(earlierTerm, 1);
      const clubId = await createClub(pool, roundId, uniqueCode());
      const student = await createStudent(pool, { grade: 1 });
      await seatStudent(pool, student.id, clubId);
      return { earlierTerm, roundId, clubId, student };
    };

    const otherTermMessage = (earlierTerm: string) =>
      `นักเรียนมีชุมนุมในรอบ ม.1 ของภาคเรียน ${earlierTerm} ที่ยังไม่ปิด จึงเปลี่ยนชั้นไม่ได้ ให้ปิดรอบนั้นก่อนแล้วนำเข้าใหม่`;

    it('locks the rounds of the term and the unclosed rounds of other terms, in id order', async () => {
      const term = uniqueTerm();
      const otherTerm = uniqueTerm();
      const expected = [
        await createRoundInTerm(otherTerm, 1, UPCOMING),
        await createRoundInTerm(term, 1, CLOSED),
        await createRoundInTerm(otherTerm, 3, CLOSED),
        await createOpenRoundInTerm(term, 2),
        await createOpenRoundInTerm(otherTerm, 2),
      ];
      const skipped = expected.splice(2, 1);

      const locked = await withTransaction(pool, async (client) => {
        const ids = await lockRoundsForImport(client, term);
        const { rows } = await client.query<{ objid: number }>(
          `SELECT objid::int FROM pg_locks
           WHERE locktype = 'advisory' AND classid = 0 AND objsubid = 1
             AND pid = pg_backend_pid() AND granted
           ORDER BY objid`,
        );
        return { ids, held: rows.map(({ objid }) => objid) };
      });

      expect(locked.ids).toEqual(expected);
      expect(locked.held).toEqual(expected);
      expect(locked.ids).not.toContain(skipped[0]);
    });

    it("refuses the grade change of a student whose seat in another term's open round commits while it waits", async () => {
      const earlierTerm = uniqueTerm();
      const roundId = await createOpenRoundInTerm(earlierTerm, 1);
      const clubId = await createClub(pool, roundId, uniqueCode());
      const student = await createStudent(pool, { grade: 1 });
      const term = uniqueTerm();
      await createRoundInTerm(term, 2, UPCOMING);
      const newcomer = uniqueStudentId();
      const parsed = await parse({
        students: [
          studentRow({ loginId: student.loginId, grade: 2 }),
          studentRow({ loginId: newcomer }),
        ],
      });
      const registrar = await pool.connect();
      let finished = false;
      try {
        await registrar.query('BEGIN');
        const registrarPid = await backendPid(registrar);
        // The real service in the earlier term's round, not committed yet: it holds that round's
        // lock, the seat and a FOR SHARE lock on the student's profile.
        await registerForClub(registrar, {
          studentId: student.id,
          clubId,
          idempotencyKey: newKey(),
        });

        const importing = settle(commitImport(pool, term, parsed));
        const waiter = await waitForLockWaiter(({ pid }) => pid !== registrarPid);
        await registrar.query('COMMIT');
        finished = true;
        const result = await importing;

        // It waited on the earlier term's round lock, before planning, not on the profile row.
        expect(waiter).toMatchObject({
          waitEvent: 'advisory',
          query: 'SELECT pg_advisory_xact_lock($1::bigint)',
        });
        expect(result.ok && result.value.status).toBe('invalid');
        expect(result.ok && result.value.plan.errors).toEqual([
          {
            sheet: 'students',
            row: 2,
            column: IMPORT_COLUMNS.students.grade,
            message: otherTermMessage(earlierTerm),
          },
        ]);
        expect(await gradeOf(student.id)).toBe(1);
        expect(await userExists(newcomer)).toBe(false);
        expect(await seatsOf(student.id)).toEqual([clubId]);
      } finally {
        if (!finished) await registrar.query('ROLLBACK');
        registrar.release();
      }
    });

    it("refuses the grade change of a student with a seat in another term's upcoming round", async () => {
      const { earlierTerm, roundId, clubId, student } = await seatedInEarlierTerm();
      await moveWindow(pool, roundId, { opensInSeconds: HOUR, closesInSeconds: 2 * HOUR });
      const parsed = await parse({
        students: [studentRow({ loginId: student.loginId, grade: 2 })],
      });

      const result = await commitImport(pool, uniqueTerm(), parsed);

      expect(result.status).toBe('invalid');
      expect(result.plan.errors).toEqual([
        expect.objectContaining({ row: 2, message: otherTermMessage(earlierTerm) }),
      ]);
      expect(await gradeOf(student.id)).toBe(1);
      expect(await seatsOf(student.id)).toEqual([clubId]);
    });

    it("moves a student whose seat is in another term's closed round, keeping the seat", async () => {
      const { roundId, clubId, student } = await seatedInEarlierTerm();
      await moveWindow(pool, roundId, { opensInSeconds: -2 * HOUR, closesInSeconds: -HOUR });
      const parsed = await parse({
        students: [studentRow({ loginId: student.loginId, grade: 2 })],
      });

      const result = await commitImport(pool, uniqueTerm(), parsed);

      // A seat in a closed round is history: the student moves up and the seat stays on record.
      expect(result.status).toBe('committed');
      expect(await gradeOf(student.id)).toBe(2);
      expect(await seatsOf(student.id)).toEqual([clubId]);
    });

    it('makes an edit of a round window wait until the import commits', async () => {
      const closedId = await createRoundInTerm(uniqueTerm(), 1, CLOSED);
      // A student in the file whose users row is held, so the import stops at its first write,
      // after taking its locks.
      const other = await createStudent(pool, { grade: 1, fullName: 'ชื่อเก่า สมมติ' });
      const parsed = await parse({
        students: [studentRow({ loginId: other.loginId, fullName: 'ชื่อใหม่ สมมติ' })],
      });
      const blocker = await pool.connect();
      let released = false;
      try {
        await blocker.query('BEGIN');
        const blockerPid = await backendPid(blocker);
        await blocker.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [other.id]);
        const importing = settle(commitImport(pool, uniqueTerm(), parsed));
        const importWaiter = await waitForLockWaiter(({ pid }) => pid !== blockerPid);
        expect(importWaiter.query).toContain('INSERT INTO users');

        // Reopening a closed round of another term would add a round the import has not locked.
        const reopening = settle(
          moveWindow(pool, closedId, { opensInSeconds: -HOUR, closesInSeconds: HOUR }),
        );
        const editWaiter = await waitForLockWaiter(
          ({ pid }) => pid !== blockerPid && pid !== importWaiter.pid,
        );
        expect(editWaiter.query).toContain('UPDATE rounds');
        await blocker.query('ROLLBACK');
        released = true;

        expect((await importing).ok).toBe(true);
        expect((await reopening).ok).toBe(true);
      } finally {
        if (!released) await blocker.query('ROLLBACK');
        blocker.release();
      }
    });

    it('does not deadlock a registration whose round edit queues behind the import', async () => {
      const roundId = await createOpenRoundInTerm(uniqueTerm(), 1);
      const clubId = await createClub(pool, roundId, uniqueCode());
      const student = await createStudent(pool, { grade: 1 });
      const newcomer = uniqueStudentId();
      const parsed = await parse({ students: [studentRow({ loginId: newcomer })] });
      const registrar = await pool.connect();
      let finished = false;
      try {
        await registrar.query('BEGIN');
        const registrarPid = await backendPid(registrar);
        // The registration's first step only: it holds the round lock, nothing else yet.
        await lockRound(registrar, roundId);
        const importing = settle(commitImport(pool, uniqueTerm(), parsed));
        const importWaiter = await waitForLockWaiter(({ pid }) => pid !== registrarPid);
        expect(importWaiter.waitEvent).toBe('advisory');
        // An admin edit of that round queues behind the import's FOR SHARE on the rounds row.
        const editing = settle(
          pool.query('UPDATE rounds SET max_active = max_active + 1 WHERE id = $1', [roundId]),
        );
        await waitForLockWaiter(
          ({ pid, query }) => pid !== importWaiter.pid && query.includes('UPDATE rounds'),
        );

        // The rest of the registration checks its foreign keys with FOR KEY SHARE on that same
        // rounds row; it must not queue behind the edit (which waits for the import, which waits
        // for this registration). Postgres would break such a cycle with 40P01.
        const registered = await settle(
          registerForClub(registrar, { studentId: student.id, clubId, idempotencyKey: newKey() }),
        );
        await registrar.query('COMMIT');
        finished = true;

        expect(registered.ok).toBe(true);
        expect((await importing).ok).toBe(true);
        expect((await editing).ok).toBe(true);
        expect(await seatsOf(student.id)).toEqual([clubId]);
        expect(await userExists(newcomer)).toBe(true);
      } finally {
        if (!finished) await registrar.query('ROLLBACK');
        registrar.release();
      }
    });
  });

  it('previews without waiting for a round lock or the import lock', async () => {
    const term = uniqueTerm();
    const roundId = await createOpenRoundInTerm(term, 1);
    const code = uniqueCode();
    await createClub(pool, roundId, code);
    const app = await buildTestApp(pool);
    const admin = await createTestUser(pool, { role: 'admin' });
    const bytes = await buildImportWorkbook({
      students: [studentRow({ loginId: uniqueStudentId() })],
      clubs: [clubRow({ clubCode: code, capacity: 35 })],
    });
    const body = await multipartBody({ term }, [{ name: 'import.xlsx', bytes }]);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(1, 1)');
      await lockRound(holder, roundId);

      const outcome = await Promise.race([
        app.inject({
          method: 'POST',
          url: '/api/admin/import/preview',
          payload: body.payload,
          headers: body.headers,
          cookies: { [SESSION_COOKIE]: sessionCookie(app, admin.id, 'admin') },
        }),
        (async () => {
          await sleep(5_000);
          return 'still waiting' as const;
        })(),
      ]);

      expect(outcome).not.toBe('still waiting');
      if (outcome === 'still waiting') return;
      expect(outcome.statusCode).toBe(200);
      expect(importPreviewResponseSchema.parse(outcome.json())).toMatchObject({
        students: { create: 1 },
        clubs: { update: 1 },
        errorCount: 0,
      });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await app.close();
    }
  });
});
