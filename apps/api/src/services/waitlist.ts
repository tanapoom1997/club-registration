import { ERROR_CODES } from '@club-registration/shared';
import type { StudentWaitlist } from '@club-registration/shared';
import type pg from 'pg';
import { AppError } from '../errors.js';
import {
  REGISTRATION_OUTCOMES,
  assertSameRequest,
  dbNow,
  findPriorEvent,
  insertEvent,
  lockStudentProfile,
  visibleClubTarget,
} from './registrations.js';
import type { PriorEvent, RegistrationOutcome } from './registrations.js';
import { lockRound, lockRoundOfClub } from './round-lock.js';
import { findStudentGrade, findWaitlist, selectStudentRound } from './student-round.js';

// A student joining and leaving a club's waitlist (README Phase 2 "กติกา waitlist"). Same shape as
// registrations.ts: each function runs inside the caller's transaction, takes the round lock
// first, then idempotency, then the rules, with the window decided by the DB clock of the writing
// statement. Neither frees a seat, so neither promotes anyone.
//
// Queue order is (created_at, id). created_at is clock_timestamp() taken by the INSERT, which runs
// after the round lock is held, so joins are ordered the way they took the lock: a join that
// waited for the lock behind another one gets a later time even though its transaction (and so
// now()) began first. id breaks a tie in the clock's resolution.

export type WaitlistResult = {
  outcome: RegistrationOutcome;
  roundId: number;
  clubId: number | null;
  // Only for a join that gave up the entry for another club: that club.
  fromClubId?: number;
  // The student's entry in the round after the request.
  waitlist: StudentWaitlist | null;
};

// A replayed key answers with the entry as it is now in the round the first request acted on, like
// a replayed registration write.
const replayPriorEvent = async (
  db: pg.PoolClient,
  studentId: number,
  prior: PriorEvent,
  request: { eventType: 'waitlist_join' | 'waitlist_leave'; clubId: number | null },
): Promise<WaitlistResult> => {
  assertSameRequest(prior, request);
  return {
    outcome: REGISTRATION_OUTCOMES.replayed,
    roundId: prior.round_id,
    clubId: prior.club_id,
    waitlist: await findWaitlist(db, prior.round_id, studentId),
  };
};

type JoinState = {
  round_id: number;
  is_open: boolean;
  held_club_id: number | null;
  waiting_club_id: number | null;
  has_free_seat: boolean;
};

// Everything the answer order needs, read in one statement under the round lock. has_free_seat is
// exactly "a register would get a seat now": free, and nobody waiting (with the promote engine a
// club with waiters is always full until the round closes, but a free seat with waiters must not
// send the student round in circles between club_full and waitlist_not_needed).
const readJoinState = async (
  db: pg.PoolClient,
  studentId: number,
  clubId: number,
): Promise<JoinState | undefined> => {
  const { rows } = await db.query<JoinState>(
    `WITH target AS (${visibleClubTarget('$1', '$2')})
     SELECT t.round_id, t.is_open,
            (SELECT reg.club_id FROM registrations reg
             WHERE reg.round_id = t.round_id AND reg.student_id = $2) AS held_club_id,
            (SELECT w.club_id FROM waitlist_entries w
             WHERE w.round_id = t.round_id AND w.student_id = $2) AS waiting_club_id,
            c.registered < c.capacity AND NOT EXISTS (
              SELECT 1 FROM waitlist_entries w WHERE w.club_id = c.id AND w.round_id = c.round_id
            ) AS has_free_seat
     FROM target t
     JOIN clubs c ON c.id = t.club_id`,
    [clubId, studentId],
  );
  return rows[0];
};

// Giving up the old entry is its own statement before the insert: a DELETE and an INSERT of the
// same UNIQUE (round_id, student_id) slot in one statement have no defined order between them.
const deleteEntry = async (
  db: pg.PoolClient,
  { roundId, studentId, clubId }: { roundId: number; studentId: number; clubId: number },
): Promise<void> => {
  const { rowCount } = await db.query(
    'DELETE FROM waitlist_entries WHERE round_id = $1 AND student_id = $2 AND club_id = $3',
    [roundId, studentId, clubId],
  );
  if (rowCount !== 1) throw new Error('Waitlist entry read under the round lock is gone');
};

// The writing statement decides the window again by its own clock, and the club must still have
// no seat for a register: under the round lock only the clock can have moved since readJoinState,
// so 0 rows means the round closed in between. The caller's throw rolls back the delete above.
const insertEntry = async (
  db: pg.PoolClient,
  { roundId, studentId, clubId }: { roundId: number; studentId: number; clubId: number },
): Promise<boolean> => {
  const { rowCount } = await db.query(
    `INSERT INTO waitlist_entries (round_id, student_id, club_id, created_at)
     SELECT c.round_id, $2, c.id, clock_timestamp()
     FROM clubs c
     JOIN rounds r ON r.id = c.round_id
     WHERE c.id = $3 AND c.round_id = $1
       AND statement_timestamp() >= r.opens_at
       AND statement_timestamp() < r.closes_at
       AND NOT (
         c.registered < c.capacity AND NOT EXISTS (
           SELECT 1 FROM waitlist_entries w WHERE w.club_id = c.id AND w.round_id = c.round_id
         )
       )`,
    [roundId, studentId, clubId],
  );
  return rowCount === 1;
};

const currentWaitlist = async (
  db: pg.PoolClient,
  roundId: number,
  studentId: number,
): Promise<StudentWaitlist> => {
  const waitlist = await findWaitlist(db, roundId, studentId);
  if (!waitlist) throw new Error('Waitlist entry missing right after it was read or written');
  return waitlist;
};

export type JoinWaitlistInput = { studentId: number; clubId: number; idempotencyKey: string };

// The order of answers, each decided under the round lock:
//
//   404 unknown club → replay (200) / 409 idempotency_key_reused → 403 student_profile_missing
//   → 404 club the student is not shown → 200 already waiting for this club (written nothing, so
//   answered even outside the window, like register's already_held) → 409 round_not_open → 409
//   already_in_club → 409 waitlist_not_needed → write.
//
// round_not_open comes before the rest, as for register, change and cancel: outside the window the
// answer is always "not open". A student who holds another club may join (README Phase 2 decision
// 1: promotion moves them like a change); so may one with no club. Waiting for another club = that
// entry is deleted and a new one inserted at the back of this queue, one waitlist_join event with
// from_club_id = the club given up (UNIQUE (actor_id, idempotency_key) allows one keyed event per
// request).
export const joinWaitlist = async (
  db: pg.PoolClient,
  { studentId, clubId, idempotencyKey }: JoinWaitlistInput,
): Promise<WaitlistResult> => {
  const roundId = await lockRoundOfClub(db, clubId);
  if (roundId === undefined) throw new AppError(ERROR_CODES.notFound, 'Club not found');

  const prior = await findPriorEvent(db, studentId, idempotencyKey);
  if (prior) {
    return await replayPriorEvent(db, studentId, prior, { eventType: 'waitlist_join', clubId });
  }

  await lockStudentProfile(db, studentId);
  const state = await readJoinState(db, studentId, clubId);
  if (!state) throw new AppError(ERROR_CODES.notFound, 'Club not found');

  if (state.waiting_club_id === clubId) {
    return {
      outcome: REGISTRATION_OUTCOMES.alreadyWaiting,
      roundId,
      clubId,
      waitlist: await currentWaitlist(db, roundId, studentId),
    };
  }
  if (!state.is_open) throw new AppError(ERROR_CODES.roundNotOpen);
  if (state.held_club_id === clubId) throw new AppError(ERROR_CODES.alreadyInClub);
  if (state.has_free_seat) throw new AppError(ERROR_CODES.waitlistNotNeeded);

  const fromClubId = state.waiting_club_id;
  if (fromClubId !== null) await deleteEntry(db, { roundId, studentId, clubId: fromClubId });
  if (!(await insertEntry(db, { roundId, studentId, clubId }))) {
    throw new AppError(ERROR_CODES.roundNotOpen);
  }
  await insertEvent(db, {
    roundId,
    studentId,
    clubId,
    fromClubId,
    eventType: 'waitlist_join',
    idempotencyKey,
  });
  return {
    outcome: REGISTRATION_OUTCOMES.waitlisted,
    roundId,
    clubId,
    ...(fromClubId === null ? {} : { fromClubId }),
    waitlist: await currentWaitlist(db, roundId, studentId),
  };
};

type LeaveAttempt = { is_open: boolean; club_id: number | null };

// One statement, one statement_timestamp(), like a cancel: the entry is deleted only while the
// round is open.
const attemptLeave = async (
  db: pg.PoolClient,
  roundId: number,
  studentId: number,
): Promise<LeaveAttempt | undefined> => {
  const { rows } = await db.query<LeaveAttempt>(
    `WITH target AS (
       SELECT statement_timestamp() >= opens_at
                AND statement_timestamp() < closes_at AS is_open
       FROM rounds
       WHERE id = $1
     ),
     deleted AS (
       DELETE FROM waitlist_entries
       WHERE round_id = $1 AND student_id = $2 AND (SELECT is_open FROM target)
       RETURNING club_id
     )
     SELECT t.is_open, d.club_id
     FROM target t
     LEFT JOIN deleted d ON true`,
    [roundId, studentId],
  );
  return rows[0];
};

export type LeaveWaitlistInput = { studentId: number; idempotencyKey: string };

// Leaves the entry in the round the student is shown, picked like cancel picks it (DB clock,
// before the lock, since its id is the lock key). Order: 403 student_profile_missing (the round
// pick needs the grade) → replay (200) / 409 idempotency_key_reused → 409 round_not_open (no round
// at all, or outside the window) → 409 not_waitlisted → delete. Nobody moves up: no seat was freed.
export const leaveWaitlist = async (
  db: pg.PoolClient,
  { studentId, idempotencyKey }: LeaveWaitlistInput,
): Promise<WaitlistResult> => {
  const grade = await findStudentGrade(db, studentId);
  const round = await selectStudentRound(db, grade, await dbNow(db));
  if (round) await lockRound(db, round.id);

  const prior = await findPriorEvent(db, studentId, idempotencyKey);
  if (prior) {
    return await replayPriorEvent(db, studentId, prior, {
      eventType: 'waitlist_leave',
      clubId: null,
    });
  }

  if (!round) throw new AppError(ERROR_CODES.roundNotOpen);
  const attempt = await attemptLeave(db, round.id, studentId);
  if (attempt?.is_open !== true) throw new AppError(ERROR_CODES.roundNotOpen);
  if (attempt.club_id === null) throw new AppError(ERROR_CODES.notWaitlisted);

  await insertEvent(db, {
    roundId: round.id,
    studentId,
    clubId: attempt.club_id,
    eventType: 'waitlist_leave',
    idempotencyKey,
  });
  return {
    outcome: REGISTRATION_OUTCOMES.leftWaitlist,
    roundId: round.id,
    clubId: attempt.club_id,
    waitlist: null,
  };
};
