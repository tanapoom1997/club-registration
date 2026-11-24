import type { Queryable } from '../db.js';

// CLAUDE.md rule 3: every write transaction inside a round (register, change, cancel, waitlist join
// and leave, an admin club edit, an admin round edit, an admin seating or removing a student, an
// admin taking a student off a waitlist, the import commit) takes the round's transaction-scoped advisory lock before it reads anything it
// decides by, so writers in one round run one at a time and see each other's commits. The promote
// engine (waitlist-promote.ts) takes no lock of its own: it runs at the end of a cancel, a change,
// a club edit, a round edit or an admin's move or remove of a student, inside the transaction
// that already holds that round's lock, and at the end of the import
// commit once per round it locked, in the same ascending id order, so it never needs a lock the
// transaction does not hold yet. The lock is released by COMMIT or ROLLBACK, never by hand.
//
// Global lock order. Every writer takes its locks in this order, skipping the steps it does not
// need; apart from the import's step 2, all advisory locks come before any row lock:
//
// 1. The import lock (lockImport): the import commit, the initial password issuance, an admin's
//    reset of one student's password (password-reset.ts) and the admin round edit, each as its
//    first statement, holding nothing yet. The round edit takes it
//    only to run apart from the import: it writes the rounds row the import holds FOR SHARE in
//    step 2, after taking a round lock the import may be waiting for in step 3.
// 2. FOR SHARE on every rounds row: the import commit only (lockRoundsForImport).
// 3. Round locks in ascending id: the import commit takes the rounds it relies on
//    (lockRoundsForImport); register, change, cancel, waitlist join and leave, the club edit,
//    an admin's assign or remove of a student (club-members.ts) and an admin's removal of a
//    waitlist entry (club-waitlist.ts) take exactly one, holding nothing, and the round edit takes exactly one holding only the import lock (a change, an
//    admin's move, a waitlist move and a promotion cascade all stay within the clubs of one
//    round, so one lock covers them).
// 4. Row locks and writes, the promote engine's included: it runs last, only in rounds whose lock
//    is already held (one for the club edit, the round edit, cancel, change and an admin's move or
//    remove; each round the import locked).
//
// No deadlock: a transaction only ever waits for an advisory lock while holding advisory locks
// that come earlier in that order, plus (the import alone) the rounds row locks of step 2, so no
// cycle of waits can form through these locks. The row locks cannot close one either:
//
// - The import's rounds row locks conflict only with an UPDATE or DELETE of a rounds row. The
//   admin round edit never meets them: it holds the import lock, so the import is not running.
//   (Without that lock it would deadlock: the edit holds the round lock the import waits for
//   while its UPDATE waits for the import's FOR SHARE; test: admin-promote.test.ts.) The round
//   delete takes no advisory lock and locks that one row only, so it waits for the import and
//   never the other way round. Students' writes (and promote) touch rounds rows only through
//   foreign-key checks, which take FOR KEY SHARE; that mode does not conflict with FOR SHARE (nor
//   with a waiting UPDATE), so a register holding a round lock the import waits for never waits
//   for the import's rounds row locks (test: import-commit-round-locks.test.ts).
// - The round edit's UPDATE changes no column of a unique index (only the window and max_active;
//   the keys are id and (term, grade)), so it takes FOR NO KEY UPDATE on the one rounds row. That
//   does not conflict with the FOR KEY SHARE of students' foreign-key checks; it conflicts with
//   the import's FOR SHARE, which the import lock rules out, and with a round delete, which holds
//   nothing else and waits for nothing else. Every other writer of the round waits for its round
//   lock before the UPDATE, so the edit waits only for transactions that wait for nothing it holds
//   (a round lock holder never takes the import lock).
// - Rows of a round's clubs, registrations and waitlist_entries are written only by the one
//   holder of its lock. The one conflicting row lock across rounds is a student's
//   student_profiles row (the FOR SHARE of register, change, waitlist join and an admin's assign
//   against the import's grade update). A register, change, join or assign that holds it in a
//   round the import did not lock waits for nothing the import holds, so it simply commits first.
//   Unlike a student's writes, an admin's assign and remove also run in closed rounds, including
//   closed rounds of another term, which the import never locks: the same holds there, since the
//   assign's profile row lock is still the only thing it shares with the import (a remove, of a
//   seat or of a waitlist entry, takes no row lock on the profile at all: its event INSERT reaches
//   the profile only through a foreign-key check, FOR KEY SHARE, which the import's grade update
//   does not conflict with, since grade is no key column).
// - The promote engine adds no wait of its own. It writes only clubs, registrations and
//   waitlist_entries rows of a round whose lock its transaction already holds (the club or round
//   edit's one round; each round the import locked), and reaches rounds, users and
//   student_profiles rows only through foreign-key checks (FOR KEY SHARE, which conflicts with
//   neither FOR SHARE, FOR NO KEY UPDATE nor a waiting UPDATE of a non-key column) and a plain
//   read of the student's grade. In the round edit the rounds row is its own FOR NO KEY UPDATE.
// - The import and the password issuance both lock many users and student_profiles rows, in no
//   common order, so they must never hold row locks at the same time: the import lock makes them
//   run one after the other. The issuance takes no round lock. Its row locks (FOR NO KEY UPDATE on
//   users, FOR SHARE on student_profiles) do not conflict with what register takes on those rows
//   (FOR KEY SHARE through foreign keys, FOR SHARE on the profile), and the one other writer of
//   those users rows, a student's own password change, locks only its row and waits for nothing
//   else. So the issuance waits only for transactions that wait for nothing it holds. The reset of
//   one student's password takes the same locks as the issuance, on one users row and its profile,
//   after the import lock, so the same holds for it, and it never runs beside an issuance or an
//   import.
//
// The queue lock (lockQueue, README Phase 3) stands outside this order. A queue write (join,
// heartbeat, done in queue.ts) takes exactly one queue lock, of its round, holding nothing, and no
// other advisory lock after it. It writes only queue_tickets rows, which no other writer touches,
// and reaches rounds and student_profiles rows only through a plain read (the grade, max_active,
// the window) and the foreign-key checks of its INSERT (FOR KEY SHARE, which conflicts neither with
// the import's grade update, nor the round edit's FOR NO KEY UPDATE, nor the import's FOR SHARE;
// only with a round delete, which holds nothing else). So a queue lock holder never waits for a
// lock that someone waiting for the queue lock holds, and no cycle can pass through it. The admin
// round edit changes max_active without the queue lock: an admission reads it once, so what the
// queue guarantees is that no admission lifts the admitted count above the max_active it read.
// The queue gate of the seat writes (Q2: register, change and waitlist join of a student's own
// request) reads the ticket and max_active (Q4: NULL = no queue, no ticket needed) with a plain
// read that takes no lock at all, so those writes hold their round lock only and stay out of the
// queue's lock order. It is the round lock they already hold, which the round edit's UPDATE of
// max_active also needs, that orders a gate read and an admin turning the queue on or off. Should a writer ever need
// both, it takes the queue lock last, after every round lock.
//
// Key space: round locks are the one-bigint form, pg_advisory_xact_lock(round_id). The import
// lock is the two-int4 form pg_advisory_xact_lock(1, 1), and queue locks are the two-int4 form
// with class key 2, pg_advisory_xact_lock(2, round_id); Postgres keeps the one-bigint and two-int4
// forms in separate key spaces, and the class key keeps a queue lock apart from the import's, so
// no two of these keys can collide. Writers that skip a lock are still stopped by the DB
// constraints (UNIQUE, CHECK); the locks only make the order simple.

// A fixed key (not per term) because students are shared across terms. See import-commit.ts,
// initial-passwords.ts, password-reset.ts and updateRound in rounds.ts for what each holder relies
// on it for.
const IMPORT_LOCK_KEY: readonly [number, number] = Object.freeze([1, 1] as const);

export const lockImport = async (db: Queryable): Promise<void> => {
  await db.query('SELECT pg_advisory_xact_lock($1, $2)', [...IMPORT_LOCK_KEY]);
};

// The first key of the two-int4 form, per kind of lock; 1 is the import's (IMPORT_LOCK_KEY).
const QUEUE_LOCK_CLASS = 2;

// Serializes the queue writes of one round, so expiry, the admitted count and the admission that
// follows it see each other's commits (README Phase 3). round ids are integer columns, so they fit
// the int4 key.
export const lockQueue = async (db: Queryable, roundId: number): Promise<void> => {
  await db.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [QUEUE_LOCK_CLASS, roundId]);
};

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
// commit, so no rounds row can change between this pick and the import's writes. The admin round
// edit (which could reopen a closed round of another term) is already kept out by the import lock:
// one in flight commits first and its new window is read here. The row locks stay as a backstop
// for any writer of rounds rows that skips the import lock (the round delete does).
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
