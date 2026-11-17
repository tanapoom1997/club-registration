import type { Queryable } from '../db.js';

// CLAUDE.md rule 3: every write transaction inside a round (register, cancel, an admin club edit,
// and in Phase 2 change/waitlist/promote) starts with the round's transaction-scoped advisory
// lock, so writers in one round run one at a time and see each other's commits, with no
// deadlock between them. The lock is released by COMMIT or ROLLBACK, never by hand.
//
// Key space: this is the one-bigint form, pg_advisory_xact_lock(round_id). The import commit uses
// the two-int4 form pg_advisory_xact_lock(1, 1); Postgres keeps the two forms in separate key
// spaces, so a round id can never collide with the import's key. Writers that skip the lock are
// still stopped by the DB constraints (UNIQUE, CHECK); the lock only makes the order simple.

export const lockRound = async (db: Queryable, roundId: number): Promise<void> => {
  await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [roundId]);
};

// Finds the club's round and locks it in one statement. A club never moves to another round, so
// reading round_id before holding the lock is safe. undefined = no such club (nothing locked).
export const lockRoundOfClub = async (
  db: Queryable,
  clubId: number,
): Promise<number | undefined> => {
  const { rows } = await db.query<{ round_id: number }>(
    'SELECT round_id, pg_advisory_xact_lock(round_id::bigint) FROM clubs WHERE id = $1',
    [clubId],
  );
  return rows[0]?.round_id;
};
