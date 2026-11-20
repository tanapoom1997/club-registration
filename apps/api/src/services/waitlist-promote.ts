import type pg from 'pg';
import { moveRegistration, releaseSeat } from './seats.js';

// The promote engine (README Phase 2 "กติกา waitlist" rules 4–6). Whoever frees a seat in a round
// that has not closed calls it at the end of their own transaction, after their own event, while
// still holding the round lock they took first (round-lock.ts); it takes no lock of its own. The
// callers: a student's cancel and change (registrations.ts), an admin club edit that sends a
// capacity (clubs.ts), an admin round edit, which may reopen a closed round (rounds.ts), and the
// import commit, once per round it locked (import-commit.ts).
//
// One loop, until a pass promotes nobody:
//
// 1. Pick the oldest entry, by (created_at, id), among the round's clubs that have a free seat,
//    and delete it in the same statement. Only until the round closes by the DB clock
//    (statement_timestamp() of that statement; a closed round promotes nobody, rule 6) and only an
//    entry whose student is still in the round's grade. An upcoming round promotes too: entries
//    exist there only if an admin moved an opened round back to upcoming, and when it opens by
//    the clock no write runs the engine, so a free seat left beside a queue would stay until the
//    next cancel or admin edit (README open item 18). Every pass deletes the entry it promotes,
//    so the loop ends after at most as many passes as there are entries.
// 2. Take the seat (+1, guarded by registered < capacity).
// 3. A student who holds another club in the round is moved like a change: their old seat is
//    given back (-1) and their one registrations row moves to the new club. That old club now has
//    a free seat, so the next pass may promote its oldest waiter: the cascade (rule 5). A student
//    with no club gets a new registrations row.
// 4. One waitlist_promote event: club_id = the new club, from_club_id = the club left (or NULL),
//    actor_id = whoever freed the first seat (the student who cancelled or changed, or the admin
//    whose club edit or import raised a capacity or whose round edit reopened the round; a cascade
//    has no request of its own), and no idempotency key: the request's own event carries it, and
//    UNIQUE (actor_id, idempotency_key) treats NULL keys as distinct.
//
// The grade check needs no row lock on student_profiles: an import commit that could move the
// student to another grade holds the lock of every round that has not closed yet
// (lockRoundsForImport), this round included until it closes, so it cannot run in between. It
// is a backstop: the import refuses to change the grade of a student with an entry in such a
// round (import-plan.ts), so in a round that has not closed every entry is in the round's grade.

export type Promotion = { studentId: number; clubId: number; fromClubId: number | null };

type PickedEntry = { student_id: number; club_id: number; held_club_id: number | null };

// For each club with a free seat, the oldest eligible entry through the (club_id, round_id,
// created_at, id) index; then the oldest of those. A round has few clubs with free seats and
// waiters at once (normally the one just freed), so this reads a handful of rows.
const pickNextEntry = async (
  db: pg.PoolClient,
  roundId: number,
): Promise<PickedEntry | undefined> => {
  const { rows } = await db.query<PickedEntry>(
    `WITH next AS (
       SELECT first.id
       FROM rounds r
       JOIN clubs c ON c.round_id = r.id AND c.registered < c.capacity
       CROSS JOIN LATERAL (
         SELECT w.id, w.created_at
         FROM waitlist_entries w
         JOIN student_profiles sp ON sp.user_id = w.student_id AND sp.grade = r.grade
         WHERE w.club_id = c.id AND w.round_id = c.round_id
         ORDER BY w.created_at, w.id
         LIMIT 1
       ) first
       WHERE r.id = $1
         AND statement_timestamp() < r.closes_at
       ORDER BY first.created_at, first.id
       LIMIT 1
     )
     DELETE FROM waitlist_entries w
     USING next
     WHERE w.id = next.id
     RETURNING w.student_id, w.club_id,
       (SELECT reg.club_id FROM registrations reg
        WHERE reg.round_id = w.round_id AND reg.student_id = w.student_id) AS held_club_id`,
    [roundId],
  );
  return rows[0];
};

// No waitlist condition here, unlike register's seat: the student promoted is the head of this
// very queue. The pick saw the free seat under the round lock, so 0 rows cannot happen.
const takePromotedSeat = async (
  db: pg.PoolClient,
  roundId: number,
  clubId: number,
): Promise<void> => {
  const { rowCount } = await db.query(
    `UPDATE clubs SET registered = registered + 1
     WHERE id = $1 AND round_id = $2 AND registered < capacity`,
    [clubId, roundId],
  );
  if (rowCount !== 1) throw new Error('Promoted into a club without a free seat');
};

const insertRegistration = async (
  db: pg.PoolClient,
  { roundId, studentId, clubId }: { roundId: number; studentId: number; clubId: number },
): Promise<void> => {
  await db.query('INSERT INTO registrations (round_id, student_id, club_id) VALUES ($1, $2, $3)', [
    roundId,
    studentId,
    clubId,
  ]);
};

const insertPromoteEvent = async (
  db: pg.PoolClient,
  roundId: number,
  actorId: number,
  { studentId, clubId, fromClubId }: Promotion,
): Promise<void> => {
  await db.query(
    `INSERT INTO registration_events
       (round_id, student_id, club_id, from_club_id, event_type, actor_id, idempotency_key)
     VALUES ($1, $2, $3, $4, 'waitlist_promote', $5, NULL)`,
    [roundId, studentId, clubId, fromClubId, actorId],
  );
};

const promoteOne = async (
  db: pg.PoolClient,
  roundId: number,
  { student_id: studentId, club_id: clubId, held_club_id: heldClubId }: PickedEntry,
): Promise<Promotion> => {
  // Every writer keeps a student off the waitlist of the club they hold (join refuses it, and
  // register and change refuse a club with waiters), so this is a broken invariant, not a case.
  if (heldClubId === clubId) throw new Error('Waitlist entry for the club the student holds');
  await takePromotedSeat(db, roundId, clubId);
  if (heldClubId === null) {
    await insertRegistration(db, { roundId, studentId, clubId });
  } else {
    await releaseSeat(db, roundId, heldClubId);
    await moveRegistration(db, { roundId, studentId, fromClubId: heldClubId, clubId });
  }
  return { studentId, clubId, fromClubId: heldClubId };
};

export const promoteWaitlist = async (
  db: pg.PoolClient,
  { roundId, actorId }: { roundId: number; actorId: number },
): Promise<Promotion[]> => {
  const promotions: Promotion[] = [];
  for (
    let entry = await pickNextEntry(db, roundId);
    entry;
    entry = await pickNextEntry(db, roundId)
  ) {
    const promotion = await promoteOne(db, roundId, entry);
    await insertPromoteEvent(db, roundId, actorId, promotion);
    promotions.push(promotion);
  }
  return promotions;
};
