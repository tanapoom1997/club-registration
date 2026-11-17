import type { Queryable } from '../db.js';

// CLAUDE.md rule 3: every write transaction inside a round (register, cancel, an admin club edit,
// the import commit, and in Phase 2 change/waitlist/promote) starts with the round's
// transaction-scoped advisory lock, so writers in one round run one at a time and see each other's
// commits. The lock is released by COMMIT or ROLLBACK, never by hand.
//
// No deadlock: every writer takes its advisory locks before it touches (or row-locks) anything,
// and in one global order. Register, cancel and the club edit take exactly one round lock. The
// import commit is the only writer that takes more than one: the import lock first, then every
// round of its term in ascending id (lockRoundsOfTerm). A transaction therefore only ever waits
// for an advisory lock while holding advisory locks that come earlier in that order and no row
// locks, so no cycle of waits can form through these locks. The row locks taken afterwards
// cannot close one either: rows of a round's clubs and registrations are written only by the one
// holder of its lock, and the one conflicting row lock across rounds is a student's
// student_profiles row (register's FOR SHARE against the import's grade update). A register in
// another term's round that holds it waits for nothing the import holds, so it simply commits
// first.
//
// Key space: this is the one-bigint form, pg_advisory_xact_lock(round_id). The import lock is the
// two-int4 form pg_advisory_xact_lock(1, 1); Postgres keeps the two forms in separate key spaces,
// so a round id can never collide with the import's key. Writers that skip the lock are still
// stopped by the DB constraints (UNIQUE, CHECK); the lock only makes the order simple.

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

// Locks every round of the term, one statement per round in ascending id: a single
// `SELECT pg_advisory_xact_lock(id) ... ORDER BY id` does not promise to call the function in
// sort order, and the order is what keeps this deadlock-free (see above). A term has at most one
// round per grade, so this is a handful of round trips. Returns the ids locked.
//
// A round created for the term after this read is not locked, and needs not be: a new round has
// no clubs, only the import creates clubs, and imports run one at a time under the import lock,
// so until this transaction commits no one else can register, cancel or edit a club in it.
export const lockRoundsOfTerm = async (db: Queryable, term: string): Promise<number[]> => {
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM rounds WHERE term = $1 ORDER BY id',
    [term],
  );
  const ids = rows.map(({ id }) => id);
  for (const id of ids) {
    await lockRound(db, id);
  }
  return ids;
};
