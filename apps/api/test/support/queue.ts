import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { Pool } from 'pg';

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

export const setMaxActive = async (pool: Pool, roundId: number, maxActive: number) => {
  await pool.query('UPDATE rounds SET max_active = $2 WHERE id = $1', [roundId, maxActive]);
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
// admitted, which those tests assert themselves).
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
       WHERE r.id <> ALL ($1::int[])
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
