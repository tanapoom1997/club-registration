import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Role } from '@club-registration/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { withTransaction } from '../../src/db.js';
import { registerForClub } from '../../src/services/registrations.js';
import { uniqueStudentId, uniqueTerm } from './import-db.js';

// Fixtures for the registration tests. Every value is made up.

export const STUDENT_NAME = 'นักเรียนสมมติ ทดสอบลงทะเบียน';

export const newKey = (): string => randomUUID();

// Students who can hold a session, made in one statement so a test can have hundreds without
// spending seconds on Argon2: their sessions are signed directly (sessionCookie), not logged in.
export const createStudents = async (
  pool: Pool,
  count: number,
  { grade = 1, mustChangePassword = false }: { grade?: number; mustChangePassword?: boolean } = {},
): Promise<number[]> => {
  const loginIds = Array.from({ length: count }, () => uniqueStudentId());
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (login_id, full_name, role, password_hash, must_change_password)
     SELECT login_id, $2, 'student', 'not-a-real-hash', $3
     FROM unnest($1::text[]) WITH ORDINALITY AS v(login_id, ord)
     ORDER BY ord
     RETURNING id`,
    [loginIds, STUDENT_NAME, mustChangePassword],
  );
  const ids = rows.map(({ id }) => id);
  await pool.query(
    `INSERT INTO student_profiles (user_id, grade, classroom, seat_no)
     SELECT id, $2, '1', ord FROM unnest($1::int[]) WITH ORDINALITY AS v(id, ord)`,
    [ids, grade],
  );
  return ids;
};

export const createStudentId = async (pool: Pool, grade = 1): Promise<number> => {
  const [id] = await createStudents(pool, 1, { grade });
  if (id === undefined) throw new Error('Student insert returned no row');
  return id;
};

// A session cookie value as the login route would issue it (session_version 0 = never revoked).
// The guard still checks it against the users row on every request.
export const sessionCookie = (app: FastifyInstance, userId: number, role: Role = 'student') =>
  app.jwt.sign({ sub: String(userId), role, sv: 0 });

// Window edges relative to the DB clock, which is the clock registration decides by.
export const createRoundAt = async (
  pool: Pool,
  grade: number,
  { opensInSeconds, closesInSeconds }: { opensInSeconds: number; closesInSeconds: number },
): Promise<number> => {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO rounds (term, grade, opens_at, closes_at)
     VALUES ($1, $2, now() + $3::int * interval '1 second', now() + $4::int * interval '1 second')
     RETURNING id`,
    [uniqueTerm(), grade, opensInSeconds, closesInSeconds],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('Round insert returned no row');
  return id;
};

const HOUR = 3_600;
export const createOpenRound = async (pool: Pool, grade = 1) =>
  await createRoundAt(pool, grade, { opensInSeconds: -HOUR, closesInSeconds: HOUR });
export const createUpcomingRound = async (pool: Pool, grade = 1) =>
  await createRoundAt(pool, grade, { opensInSeconds: HOUR, closesInSeconds: 2 * HOUR });
export const createClosedRound = async (pool: Pool, grade = 1, closedSecondsAgo = HOUR) =>
  await createRoundAt(pool, grade, {
    opensInSeconds: -closedSecondsAgo - HOUR,
    closesInSeconds: -closedSecondsAgo,
  });

// Closes (or re-opens) a round after the fact, relative to the DB clock.
export const moveWindow = async (
  pool: Pool,
  roundId: number,
  { opensInSeconds, closesInSeconds }: { opensInSeconds: number; closesInSeconds: number },
): Promise<void> => {
  await pool.query(
    `UPDATE rounds
     SET opens_at = now() + $2::int * interval '1 second',
         closes_at = now() + $3::int * interval '1 second'
     WHERE id = $1`,
    [roundId, opensInSeconds, closesInSeconds],
  );
};

// Seats a student through the real service, so the event log stays consistent with the seats and
// the invariant check below holds for seeded data too.
export const seatStudent = async (pool: Pool, studentId: number, clubId: number) =>
  await withTransaction(
    pool,
    async (client) =>
      await registerForClub(client, { studentId, clubId, idempotencyKey: newKey() }),
  );

export const storedSeats = async (pool: Pool, clubId: number) => {
  const { rows } = await pool.query<{ registered: number; capacity: number; rows: number }>(
    `SELECT c.registered, c.capacity,
            (SELECT count(*)::int FROM registrations r WHERE r.club_id = c.id) AS rows
     FROM clubs c WHERE c.id = $1`,
    [clubId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Club ${clubId} not found`);
  return row;
};

export const eventsOf = async (pool: Pool, studentId: number) => {
  const { rows } = await pool.query<{
    event_type: string;
    round_id: number;
    club_id: number | null;
    actor_id: number;
    idempotency_key: string | null;
  }>(
    `SELECT event_type, round_id, club_id, actor_id, idempotency_key
     FROM registration_events WHERE student_id = $1 ORDER BY id`,
    [studentId],
  );
  return rows;
};

// Waits until some backend is blocked on an advisory lock, i.e. on a round lock.
export const waitForAdvisoryLockWaiter = async (pool: Pool): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await sleep(25);
  }
  throw new Error('Nothing ever waited for the round advisory lock');
};

// How each event type moves seats, as a VALUES list every event check reads: what it does to the
// seat of club_id and to the seat of from_club_id. A change takes the new club's seat and gives
// back the old one. waitlist_promote and admin_* add their rows here when they exist (a promote
// that moves a student is a change; waitlist_join/leave move no seat: 0, 0). An event type
// missing from this list fails the check below, so a new writer cannot slip past the accounting.
const SEAT_EFFECTS = `
  seat_effect (event_type, club_delta, from_club_delta) AS (
    VALUES ('register', 1, 0), ('cancel', -1, 0), ('change', 1, -1)
  )`;

// One row per seat an event took (+1) or gave back (-1), keyed by round, student and club.
const SEAT_MOVES = `
  ${SEAT_EFFECTS},
  seat_moves AS (
    SELECT e.round_id, e.student_id, e.club_id, f.club_delta AS delta
    FROM registration_events e JOIN seat_effect f USING (event_type)
    WHERE f.club_delta <> 0
    UNION ALL
    SELECT e.round_id, e.student_id, e.from_club_id, f.from_club_delta
    FROM registration_events e JOIN seat_effect f USING (event_type)
    WHERE f.from_club_delta <> 0 AND e.from_club_id IS NOT NULL
  )`;

// Each query returns the rows that break one invariant; all must be empty. The event checks
// assume every seat came from the service (seatStudent or the API), as in the registration tests.
const INVARIANTS: Readonly<Record<string, string>> = Object.freeze({
  'clubs.registered equals the registrations of the club': `
    SELECT c.id, c.registered, count(r.id)::int AS rows
    FROM clubs c LEFT JOIN registrations r ON r.club_id = c.id
    GROUP BY c.id
    HAVING c.registered <> count(r.id)`,
  'registered stays within 0..capacity': `
    SELECT id, registered, capacity FROM clubs
    WHERE registered < 0 OR registered > capacity`,
  'a student holds at most one registration per round': `
    SELECT round_id, student_id, count(*)::int AS rows
    FROM registrations GROUP BY round_id, student_id HAVING count(*) > 1`,
  // Until the round closes: a seat in a closed round is history, and an import of a later term
  // may move the student up a grade (docs/excel.md, item 3). It never may while the round is open
  // or upcoming.
  "a registration's student is in the round's grade until the round closes": `
    SELECT r.id, sp.grade AS student_grade, ro.grade AS round_grade
    FROM registrations r
    JOIN student_profiles sp ON sp.user_id = r.student_id
    JOIN rounds ro ON ro.id = r.round_id
    WHERE sp.grade <> ro.grade AND ro.closes_at > statement_timestamp()`,
  "a registration's club belongs to its round": `
    SELECT r.id FROM registrations r JOIN clubs c ON c.id = r.club_id
    WHERE c.round_id <> r.round_id`,
  'every event type has a seat effect in this checker': `
    WITH ${SEAT_EFFECTS}
    SELECT DISTINCT e.event_type FROM registration_events e
    WHERE e.event_type NOT IN (SELECT event_type FROM seat_effect)`,
  // A promote of a student with no club yet will leave from_club_id null, so only change requires
  // it; an event type that gives back no from-club seat must not name one.
  'a change names the other club it left, and no seatless move names one': `
    WITH ${SEAT_EFFECTS}
    SELECT e.id, e.event_type, e.club_id, e.from_club_id
    FROM registration_events e JOIN seat_effect f USING (event_type)
    WHERE (e.event_type = 'change' AND e.from_club_id IS NULL)
       OR (f.from_club_delta = 0 AND e.from_club_id IS NOT NULL)
       OR e.from_club_id = e.club_id`,
  'seats taken minus seats given back equals the seats each student holds': `
    WITH ${SEAT_MOVES},
    net AS (
      SELECT round_id, student_id, sum(delta) AS net
      FROM seat_moves GROUP BY round_id, student_id
    )
    SELECT COALESCE(n.round_id, r.round_id) AS round_id,
           COALESCE(n.student_id, r.student_id) AS student_id,
           n.net, r.id AS registration_id
    FROM net n
    FULL JOIN registrations r ON r.round_id = n.round_id AND r.student_id = n.student_id
    WHERE COALESCE(n.net, 0) <> CASE WHEN r.id IS NULL THEN 0 ELSE 1 END`,
  'seats taken minus seats given back per club equals clubs.registered': `
    WITH ${SEAT_MOVES},
    net AS (SELECT club_id, sum(delta) AS net FROM seat_moves GROUP BY club_id)
    SELECT c.id, c.registered, n.net
    FROM clubs c LEFT JOIN net n ON n.club_id = c.id
    WHERE c.registered <> COALESCE(n.net, 0)`,
  // The latest event that moved one of the student's seats in the round must be one that gave
  // them the club they hold (a register or a change into it), not a cancel or another club.
  "the student's latest seat event gave them the club they hold": `
    WITH ${SEAT_EFFECTS}
    SELECT r.id, r.club_id, latest.event_type, latest.club_id AS event_club_id
    FROM registrations r
    LEFT JOIN LATERAL (
      SELECT e.event_type, e.club_id, f.club_delta FROM registration_events e
      JOIN seat_effect f USING (event_type)
      WHERE e.round_id = r.round_id AND e.student_id = r.student_id
        AND (f.club_delta <> 0 OR f.from_club_delta <> 0)
      ORDER BY e.id DESC LIMIT 1
    ) latest ON true
    WHERE latest.club_id IS DISTINCT FROM r.club_id OR latest.club_delta IS DISTINCT FROM 1`,
  'students act for themselves and every event has a key': `
    SELECT id, actor_id, student_id FROM registration_events
    WHERE actor_id <> student_id OR idempotency_key IS NULL`,
});

// Names each broken invariant with up to five offending rows, so a failure explains itself.
export const registrationInvariantViolations = async (pool: Pool): Promise<string[]> => {
  const results = await Promise.all(
    Object.entries(INVARIANTS).map(async ([name, sql]) => {
      const { rows } = await pool.query(sql);
      return rows.length === 0 ? [] : [`${name}: ${JSON.stringify(rows.slice(0, 5))}`];
    }),
  );
  return results.flat();
};
