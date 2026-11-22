import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { Pool } from 'pg';
import { ERROR_CODES } from '@club-registration/shared';
import { withTransaction } from '../../src/db.js';
import { AppError } from '../../src/errors.js';
import { DEFAULT_QUEUE_SETTINGS, joinQueue } from '../../src/services/queue.js';
import type { QueueSettings } from '../../src/services/queue.js';

// Fixtures and invariant checks for the queue tests (README Phase 3). Every value is made up.

export type StoredTicket = {
  id: number;
  round_id: number;
  status: string;
  admitted_at: Date | null;
};

export const ticketsOf = async (pool: Pool, studentId: number): Promise<StoredTicket[]> => {
  const { rows } = await pool.query<StoredTicket>(
    `SELECT id, round_id, status, admitted_at FROM queue_tickets
     WHERE student_id = $1 ORDER BY created_at, id`,
    [studentId],
  );
  return rows;
};

export const statusCounts = async (pool: Pool, roundId: number) => {
  const { rows } = await pool.query<{ status: string; tickets: number }>(
    `SELECT status, count(*)::int AS tickets FROM queue_tickets
     WHERE round_id = $1 GROUP BY status ORDER BY status`,
    [roundId],
  );
  return Object.fromEntries(rows.map(({ status, tickets }) => [status, tickets]));
};

// null = the round has no queue (Q4).
export const setMaxActive = async (pool: Pool, roundId: number, maxActive: number | null) => {
  await pool.query('UPDATE rounds SET max_active = $2 WHERE id = $1', [roundId, maxActive]);
};

// Lets students into their turn the way the web page does: each joins the queue of the round they
// are shown, through the real service, so the seat writes' queue gate (Q2) lets them through. The
// round (open now) gets room for all of them first, so the admission order and max_active stay
// as the queue's invariants expect. Throws if anyone was not let in, so a test never silently
// starts with a waiting ticket. A round without a queue (max_active NULL) is left without one
// (GREATEST would skip the NULL and turn the queue on), so the join throws queue_off.
export const admitStudents = async (
  pool: Pool,
  roundId: number,
  studentIds: readonly number[],
  settings: QueueSettings = DEFAULT_QUEUE_SETTINGS,
): Promise<void> => {
  await pool.query(
    `UPDATE rounds SET max_active = GREATEST(max_active, $2::int + (
       SELECT count(*)::int FROM queue_tickets WHERE round_id = $1 AND status = 'admitted'
     ))
     WHERE id = $1 AND max_active IS NOT NULL`,
    [roundId, studentIds.length],
  );
  for (const studentId of studentIds) {
    const { roundId: joined, response } = await withTransaction(
      pool,
      async (client) => await joinQueue(client, { studentId, settings }),
    );
    if (joined !== roundId || response.ticket?.status !== 'admitted') {
      throw new Error(`Student ${studentId} was not admitted in round ${roundId}`);
    }
  }
};

// Admitted tickets written straight to the table, for a round the queue cannot be joined in now:
// students let in before an admin closed it, still on the page when it reopens. Same columns a
// real admission writes (status, admitted_at, last_seen_at by the DB clock), with room made in
// max_active as admitStudents does, so the queue's invariants hold. In a round without a queue the
// setting is left NULL: these are then tickets left from before an admin turned the queue off.
export const admitDirectly = async (
  pool: Pool,
  roundId: number,
  studentIds: readonly number[],
): Promise<void> => {
  await pool.query(
    `UPDATE rounds SET max_active = GREATEST(max_active, $2::int + (
       SELECT count(*)::int FROM queue_tickets WHERE round_id = $1 AND status = 'admitted'
     ))
     WHERE id = $1 AND max_active IS NOT NULL`,
    [roundId, studentIds.length],
  );
  await pool.query(
    `INSERT INTO queue_tickets (round_id, student_id, status, created_at, last_seen_at, admitted_at)
     SELECT $1, id, 'admitted', clock_timestamp(), statement_timestamp(), statement_timestamp()
     FROM unnest($2::int[]) WITH ORDINALITY AS v(id, ord)
     ORDER BY ord`,
    [roundId, studentIds],
  );
};

// What the web page does before it offers a student the clubs: join the queue of the round they
// are shown (README Phase 3, Q3), through the real service. For the tests of what a seat write
// does once the student may choose (Q2's gate itself is tested apart, without this). A round that
// is not open has no queue, and the request under test then answers for itself (round_not_open,
// already_held, student_profile_missing), as it would on the page; nor has a round without a queue
// (queue_off, Q4), whose seat writes need no turn; a ticket left waiting throws,
// so a test never silently writes without its turn (raise max_active, or use admitStudents).
export const takeTurn = async (
  pool: Pool,
  studentId: number,
  settings: QueueSettings = DEFAULT_QUEUE_SETTINGS,
): Promise<void> => {
  try {
    const { roundId, response } = await withTransaction(
      pool,
      async (client) => await joinQueue(client, { studentId, settings }),
    );
    if (response.ticket?.status !== 'admitted') {
      throw new Error(`Student ${studentId} is still waiting in round ${roundId}`);
    }
  } catch (error) {
    const noQueue =
      error instanceof AppError &&
      (error.code === ERROR_CODES.roundNotOpen ||
        error.code === ERROR_CODES.studentProfileMissing ||
        error.code === ERROR_CODES.queueOff);
    if (!noQueue) throw error;
  }
};

// The student endpoints behind the queue gate (README Phase 3, decision 1), by path: the club list
// (GET), register and change (POST/PUT /registration) and the waitlist join (POST /waitlist).
// Cancel (/registration/cancel) and leave (/waitlist/leave) are other paths.
const GATED_PATHS: ReadonlySet<string> = new Set([
  '/api/student/clubs',
  '/api/student/registration',
  '/api/student/waitlist',
]);

// takeTurn before a request to a gated path, as the page would have; nothing for other paths.
export const takeTurnFor = async (pool: Pool, studentId: number, url: string): Promise<void> => {
  if (GATED_PATHS.has(url.split('?')[0] ?? url)) await takeTurn(pool, studentId);
};

// Moves the live tickets of these students back in time, as if their last heartbeat or their
// admission happened `seconds` earlier: the queue decides by the DB clock, so tests rewind the
// rows instead of waiting a minute. As the owner, with triggers off for this session only,
// because the forward-only trigger (rightly) refuses any change of an admission time.
export const rewindTickets = async (
  container: StartedPostgreSqlContainer,
  studentIds: readonly number[],
  {
    lastSeenSeconds = 0,
    admittedSeconds = 0,
  }: { lastSeenSeconds?: number; admittedSeconds?: number },
): Promise<void> => {
  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  try {
    await client.query('SET session_replication_role = replica');
    await client.query(
      `UPDATE queue_tickets
       SET last_seen_at = last_seen_at - $2::int * interval '1 second',
           admitted_at = admitted_at - $3::int * interval '1 second'
       WHERE student_id = ANY ($1::int[]) AND status IN ('waiting', 'admitted')`,
      [studentIds, lastSeenSeconds, admittedSeconds],
    );
  } finally {
    await client.end();
  }
};

// Each query returns the rows that break one invariant; all must be empty. Rounds in
// `lowered` are left out of the max_active check: an admin may lower max_active under the
// admitted count on purpose, and nobody is kicked out (the check there is that nobody more is
// admitted, which those tests assert themselves). So are rounds without a queue (max_active NULL,
// Q4): there is no limit to stay under, and the tickets admitted before the queue went off simply
// expire. Every other check holds for them too.
const invariants = (lowered: readonly number[]): Readonly<Record<string, [string, unknown[]]>> =>
  Object.freeze({
    'one live ticket per student and round': [
      `SELECT round_id, student_id, count(*)::int AS live FROM queue_tickets
       WHERE status IN ('waiting', 'admitted')
       GROUP BY round_id, student_id HAVING count(*) > 1`,
      [],
    ],
    'admitted tickets carry their admission time and waiting ones none': [
      `SELECT id, status, admitted_at FROM queue_tickets
       WHERE (status = 'admitted' AND admitted_at IS NULL)
          OR (status = 'waiting' AND admitted_at IS NOT NULL)`,
      [],
    ],
    'admitted tickets never above max_active': [
      `SELECT r.id, r.max_active, count(t.id)::int AS admitted
       FROM rounds r JOIN queue_tickets t ON t.round_id = r.id AND t.status = 'admitted'
       WHERE r.id <> ALL ($1::int[]) AND r.max_active IS NOT NULL
       GROUP BY r.id, r.max_active HAVING count(t.id) > r.max_active`,
      [lowered],
    ],
    'admission in queue order: no waiting ticket ahead of an admitted one': [
      `SELECT w.id AS waiting_id, a.id AS admitted_id
       FROM queue_tickets w
       JOIN queue_tickets a ON a.round_id = w.round_id AND a.status = 'admitted'
       WHERE w.status = 'waiting' AND (w.created_at, w.id) < (a.created_at, a.id)`,
      [],
    ],
    'tickets only in a round of the student grade': [
      `SELECT t.id, t.round_id, p.grade, r.grade AS round_grade
       FROM queue_tickets t
       JOIN student_profiles p ON p.user_id = t.student_id
       JOIN rounds r ON r.id = t.round_id
       WHERE p.grade <> r.grade`,
      [],
    ],
  });

// Names each broken invariant with up to five offending rows, so a failure explains itself.
export const queueInvariantViolations = async (
  pool: Pool,
  { lowered = [] }: { lowered?: readonly number[] } = {},
): Promise<string[]> => {
  const results = await Promise.all(
    Object.entries(invariants(lowered)).map(async ([name, [sql, values]]) => {
      const { rows } = await pool.query(sql, values);
      return rows.length === 0 ? [] : [`${name}: ${JSON.stringify(rows.slice(0, 5))}`];
    }),
  );
  return results.flat();
};
