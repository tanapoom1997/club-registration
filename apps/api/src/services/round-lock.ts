import type { Queryable } from '../db.js';

// CLAUDE.md rule 3: every write transaction inside a round (register, cancel, an admin club edit,
// the import commit, and in Phase 2 change/waitlist/promote) starts with the round's
// transaction-scoped advisory lock, so writers in one round run one at a time and see each other's
// commits. The lock is released by COMMIT or ROLLBACK, never by hand.
//
// No deadlock: every writer takes its advisory locks before it touches (or row-locks) anything
// the others lock, and in one global order. Register, cancel and the club edit take exactly one
// round lock. The import commit is the only writer that takes more than one: the import lock
// first, then a FOR SHARE lock on every rounds row (see lockRoundsForImport), then the rounds it
// relies on in ascending id. A transaction therefore only ever waits for an advisory lock while
// holding advisory locks that come earlier in that order, plus (the import alone) the rounds row
// locks, so no cycle of waits can form through these locks:
//
// - The rounds row locks conflict only with an UPDATE or DELETE of a rounds row (the admin round
//   edit and delete), which take no advisory lock and lock that one row only, so they wait for
//   the import and never the other way round. Register and cancel touch rounds rows only through
//   foreign-key checks, which take FOR KEY SHARE; that mode does not conflict with FOR SHARE (nor
//   with a waiting UPDATE), so a register holding a round lock the import waits for never waits
//   for the import's rounds row locks (test: import-commit-round-locks.test.ts).
// - The row locks taken afterwards cannot close a cycle either: rows of a round's clubs and
//   registrations are written only by the one holder of its lock, and the one conflicting row
//   lock across rounds is a student's student_profiles row (register's FOR SHARE against the
//   import's grade update). A register that holds it in a round the import did not lock waits for
//   nothing the import holds, so it simply commits first.
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

// The round locks of an import commit, taken right after the import lock and before planning
// reads anything. Returns the ids locked. Two kinds of round matter to an import of `term`:
//
// - Every round of the term: the import writes clubs (capacity) into them, and a student's grade
//   decides which of them the student may hold a seat in.
// - Every round of another term that has not closed yet (open or upcoming by the DB clock): a
//   student holding a seat in one cannot be moved to another grade (planImport refuses it), since
//   the web app would then show them the new grade's round and they could no longer see or cancel
//   that seat. Holding these locks means no seat in such a round can commit between the plan
//   reading the student's registrations and the grade update.
//
// Closed rounds of other terms are not locked: no seat can be taken or given back in them any
// more, so a seat there is history (students move up a grade each year) and never stops a grade
// change. A register in such a round that took its seat just before closes_at and is still
// committing is harmless for the same reason: it ends as a seat in a closed round.
//
// FOR SHARE on every rounds row, not only the ones picked: it keeps every window still until
// commit, so an admin cannot reopen a closed round (or extend one) of another term between this
// pick and the import's writes; an edit in flight is waited for and its new window read here.
// A round inserted after this read needs no lock: a new round has no clubs, only the import
// creates clubs, and imports run one at a time under the import lock, so until this transaction
// commits no one can register, cancel or edit a club in it.
//
// One statement per round lock, in ascending id: a single `SELECT pg_advisory_xact_lock(id) ...
// ORDER BY id` does not promise to call the function in sort order, and the order is what keeps
// this deadlock-free (see above). A term has at most one round per grade and few rounds stay
// unclosed, so this is a handful of round trips.
export const lockRoundsForImport = async (db: Queryable, term: string): Promise<number[]> => {
  const { rows } = await db.query<{ id: number; relied_on: boolean }>(
    `SELECT id, term = $1 OR closes_at > statement_timestamp() AS relied_on
     FROM rounds
     ORDER BY id
     FOR SHARE`,
    [term],
  );
  const ids = rows.filter(({ relied_on: reliedOn }) => reliedOn).map(({ id }) => id);
  for (const id of ids) {
    await lockRound(db, id);
  }
  return ids;
};
