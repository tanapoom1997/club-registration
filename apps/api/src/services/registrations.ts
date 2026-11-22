import { ERROR_CODES } from '@club-registration/shared';
import type { StudentRegistration } from '@club-registration/shared';
import type pg from 'pg';
import { dbNow, isPgError, PG_ERROR_CODES } from '../db.js';
import { AppError } from '../errors.js';
import { lockRound, lockRoundOfClub } from './round-lock.js';
import { moveRegistration, releaseSeat } from './seats.js';
import {
  findRegistration,
  findStudentGrade,
  roundSelectionOrder,
  selectStudentRound,
  toRegistration,
} from './student-round.js';
import { promoteWaitlist } from './waitlist-promote.js';
import type { Promotion } from './waitlist-promote.js';

// A student registering for a club, cancelling it and changing it for another (README "จุดวิกฤต:
// การจองที่นั่ง" and Phase 2). The waitlist's join and leave (waitlist.ts) follow the same steps
// and share the helpers exported here.
//
// Each function is one step of business logic that runs inside the caller's transaction (it takes
// the transaction's client and never commits), so a route wraps it in withTransaction and the
// waitlist can compose them with promote in one transaction. Statements run one after the other,
// in this order:
//
// 1. Take the round's advisory lock (round-lock.ts) before reading anything that decides the
//    outcome. Writers in a round are serialized, so each sees what the previous one committed.
// 2. Idempotency (CLAUDE.md rule 7): a registration_events row with this student as actor and this
//    key means the request was already carried out. The same request (same type, same club) is
//    answered 200 with the student's registration as it is now; anything else that reuses the key
//    is 409 idempotency_key_reused. Only committed requests leave an event, so a request that
//    failed (e.g. club_full) leaves no trace and may be retried with its key. UNIQUE(actor_id,
//    idempotency_key) is the final word: under the round lock two requests with one key can only
//    both get past the lookup when they are in different rounds, which means different requests,
//    so a unique violation there is always 409.
// 3. The rules, as conditions of the writing statement itself rather than app checks before it:
//    the club's round must be the student's own grade's selected round, and the DB clock must be
//    inside [opens_at, closes_at). UNIQUE(round_id, student_id) keeps one club per round, and
//    `UPDATE ... WHERE registered < capacity` together with the clubs CHECK keeps seats within
//    capacity (CLAUDE.md rule 1). A failed step throws, which rolls back everything before it.
// 4. A cancel or change that gave a seat back promotes the waitlist (waitlist-promote.ts) in the
//    same transaction, after its own event, and answers with the student's registration as it is
//    after the promotions: a cascade can promote the student who made the request.
//
// The queue gate (README Phase 3, Q2): register, change and the waitlist join take a seat or a
// place in line, so in an open round the student's own request needs a live admitted queue
// ticket. The caller passes the check in (AdmissionGate) rather than this module asking the
// queue itself, because only the student routes are gated: an admin's assign, an import and a
// promotion seat students who hold no ticket, and none of them calls these functions anyway.
// The gate runs right where round_not_open would be thrown, once the writing statement has said
// the round is open by its own clock, so:
//
// - a replayed key is answered before it (CLAUDE.md rule 7: a write that went through keeps its
//   answer after the ticket ended), and so are the answers that write nothing (already_held,
//   already_waiting) and 404;
// - outside the window the answer stays round_not_open, ticket or not;
// - no boundary slips through: "open" is the verdict of the very statement that took the seat, so
//   a request at opens_at cannot be judged closed by the gate and open by the write. A refusal
//   throws, and the rollback undoes that statement's insert or seat;
// - a refusal leaves no event, like club_full, so the same key works once the student is back in
//   their turn.
//
// The check is a plain read (hasAdmittedTicket in queue.ts), no queue lock, so a seat write keeps
// holding its round lock only (round-lock.ts).
//
// Clock: writes decide the window with the DB clock, statement_timestamp() of the writing
// statement, which runs after the lock is held. A request that waited for the lock across
// closes_at is therefore refused, and every app process (or a skewed app host) agrees on one
// clock. The reads in student-round.ts pick the round and its status by the DB clock too (since
// Q2, so the club list's queue gate and the queue's join agree on "open"); they differ from a
// write only by the moments between the two, and the write is the one that counts (README Phase
// 1 item 4).

// The table's UNIQUE (actor_id, idempotency_key) from the initial migration.
export const EVENT_KEY_UNIQUE = 'registration_events_actor_id_idempotency_key_key';

export const REGISTRATION_OUTCOMES = Object.freeze({
  // A seat was taken and an event written.
  registered: 'registered',
  // The student already held this very club (a retry with a new key): nothing written.
  alreadyHeld: 'already_held',
  // The key was used by this same request before: nothing written, current state returned.
  replayed: 'replayed',
  cancelled: 'cancelled',
  // The seat moved from one club to another and an event was written.
  changed: 'changed',
  // Waitlist (waitlist.ts): an entry was written, the student already waited for this very club
  // (a retry with a new key: nothing written), or the entry was left.
  waitlisted: 'waitlisted',
  alreadyWaiting: 'already_waiting',
  leftWaitlist: 'left_waitlist',
} as const);

export type RegistrationOutcome =
  (typeof REGISTRATION_OUTCOMES)[keyof typeof REGISTRATION_OUTCOMES];

export type RegistrationResult = {
  outcome: RegistrationOutcome;
  roundId: number;
  clubId: number | null;
  // Only for a change that moved the seat: the club given back.
  fromClubId?: number;
  // The student's registration in the round after the request.
  registration: StudentRegistration | null;
  // Students the request's freed seat promoted off a waitlist, in order (ids only, for the log).
  promotions: Promotion[];
};

// Throws (queue_required) when the student may not take a seat in the round now. Called under the
// round lock, inside the request's transaction, only once the round is known to be open.
export type AdmissionGate = (db: pg.PoolClient, roundId: number) => Promise<void>;

// The event types a student's own request writes, always with its idempotency key.
export type StudentEventType =
  'register' | 'cancel' | 'change' | 'waitlist_join' | 'waitlist_leave';

export type PriorEvent = { event_type: string; round_id: number; club_id: number | null };

export const findPriorEvent = async (
  db: pg.PoolClient,
  studentId: number,
  idempotencyKey: string,
): Promise<PriorEvent | undefined> => {
  const { rows } = await db.query<PriorEvent>(
    `SELECT event_type, round_id, club_id
     FROM registration_events
     WHERE actor_id = $1 AND idempotency_key = $2`,
    [studentId, idempotencyKey],
  );
  return rows[0];
};

// Same request = same type and, for the requests that name a club (register, change, waitlist
// join), the same club; a cancel or a waitlist leave names none. Anything else that reuses the key
// is 409 idempotency_key_reused.
export const assertSameRequest = (
  prior: PriorEvent,
  request: { eventType: StudentEventType; clubId: number | null },
): void => {
  const sameRequest =
    prior.event_type === request.eventType &&
    (request.clubId === null || prior.club_id === request.clubId);
  if (!sameRequest) throw new AppError(ERROR_CODES.idempotencyKeyReused);
};

// The answer is the registration as it stands now in the round the first request acted on, so a
// client that retries after the state moved on (e.g. a register replayed after a cancel) learns
// the truth instead of a stale copy.
const replayPriorEvent = async (
  db: pg.PoolClient,
  studentId: number,
  prior: PriorEvent,
  request: { eventType: StudentEventType; clubId: number | null },
): Promise<RegistrationResult> => {
  assertSameRequest(prior, request);
  return {
    outcome: REGISTRATION_OUTCOMES.replayed,
    roundId: prior.round_id,
    clubId: prior.club_id,
    registration: await findRegistration(db, prior.round_id, studentId),
    promotions: [],
  };
};

type EventInput = {
  roundId: number;
  studentId: number;
  clubId: number;
  // The club a change left, or the waitlist a join gave up; null for every other event.
  fromClubId?: number | null;
  eventType: StudentEventType;
  idempotencyKey: string;
};

// The student is the actor: these are their own requests (admin_* events have an admin actor:
// club-members.ts; a waitlist_promote the actor who freed the seat, with no key:
// waitlist-promote.ts).
export const insertEvent = async (
  db: pg.PoolClient,
  { roundId, studentId, clubId, fromClubId = null, eventType, idempotencyKey }: EventInput,
): Promise<void> => {
  try {
    await db.query(
      `INSERT INTO registration_events
         (round_id, student_id, club_id, from_club_id, event_type, actor_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $2, $6)`,
      [roundId, studentId, clubId, fromClubId, eventType, idempotencyKey],
    );
  } catch (error) {
    if (isPgError(error, PG_ERROR_CODES.uniqueViolation, EVENT_KEY_UNIQUE)) {
      throw new AppError(ERROR_CODES.idempotencyKeyReused);
    }
    throw error;
  }
};

// FOR SHARE holds the student's grade still until commit: an import that is moving the student
// to another grade either commits first (and the insert below sees the new grade) or waits for
// this transaction. For an import of this round's term the round lock already orders the two
// (the import commit holds every round lock of its term); this row lock also covers an import of
// another term, which does not. Missing profile = 403, as on the reads.
export const lockStudentProfile = async (db: pg.PoolClient, studentId: number): Promise<void> => {
  const { rowCount } = await db.query(
    'SELECT 1 FROM student_profiles WHERE user_id = $1 FOR SHARE',
    [studentId],
  );
  if (rowCount === 0) throw new AppError(ERROR_CODES.studentProfileMissing);
};

// The club $club as the student $student may see it: in their own grade's round, and that round
// the one picked like the reads pick it, with the DB clock of the statement this is part of. No
// row = the student may not see the club, which every caller answers 404 exactly like a club that
// does not exist. is_open is the window by the same clock. The parameters are always placeholder
// constants of this module, never input.
export const visibleClubTarget = (club: string, student: string): string => `
  SELECT c.id AS club_id, c.round_id,
         statement_timestamp() >= r.opens_at
           AND statement_timestamp() < r.closes_at AS is_open
  FROM clubs c
  JOIN rounds r ON r.id = c.round_id
  JOIN student_profiles sp ON sp.user_id = ${student} AND sp.grade = r.grade
  WHERE c.id = ${club}
    AND r.id = (
      SELECT s.id FROM rounds s
      WHERE s.grade = sp.grade
      ORDER BY ${roundSelectionOrder('statement_timestamp()', 's')}
      LIMIT 1
    )`;

// No jumping the queue (README Phase 2, waitlist rule 2): a club with anyone on its waitlist has
// no seat for a register or a change, even a free one, until the promote engine hands it on.
const NO_WAITLIST = `NOT EXISTS (
  SELECT 1 FROM waitlist_entries w WHERE w.club_id = clubs.id AND w.round_id = clubs.round_id
)`;

type SeatAttempt = { round_id: number; is_open: boolean; created_at: Date | null };

// One statement, one statement_timestamp(): the club must be in the round the student is shown
// (own grade, picked like the reads pick it) and that round must be open now; only then is the
// row inserted. No row back = the student may not see this club, which answers 404 exactly like a
// club that does not exist. ON CONFLICT DO NOTHING lets the UNIQUE decide "already registered"
// without aborting the transaction; the caller then reads which club the student holds.
const attemptSeat = async (
  db: pg.PoolClient,
  studentId: number,
  clubId: number,
): Promise<SeatAttempt | undefined> => {
  const { rows } = await db.query<SeatAttempt>(
    `WITH target AS (${visibleClubTarget('$1', '$2')}),
     inserted AS (
       INSERT INTO registrations (round_id, student_id, club_id)
       SELECT round_id, $2, club_id FROM target WHERE is_open
       ON CONFLICT (round_id, student_id) DO NOTHING
       RETURNING created_at
     )
     SELECT t.round_id, t.is_open, i.created_at
     FROM target t
     LEFT JOIN inserted i ON true`,
    [clubId, studentId],
  );
  return rows[0];
};

type ClubLabel = { club_code: string; name: string };

// The seat itself. 0 rows = full, or free but with a waitlist; either way club_full, and the
// caller's throw rolls back the registration inserted above.
const takeSeat = async (
  db: pg.PoolClient,
  roundId: number,
  clubId: number,
): Promise<ClubLabel | undefined> => {
  const { rows } = await db.query<ClubLabel>(
    `UPDATE clubs SET registered = registered + 1
     WHERE id = $1 AND round_id = $2 AND registered < capacity AND ${NO_WAITLIST}
     RETURNING club_code, name`,
    [clubId, roundId],
  );
  return rows[0];
};

export type RegisterInput = { studentId: number; clubId: number; idempotencyKey: string };

// The order of answers, each decided under the round lock: 404 unknown club → replay (200) / 409
// idempotency_key_reused → 403 student_profile_missing → 404 club the student is not shown → 200
// already_held → 409 round_not_open → 403 queue_required (the gate) → 409 already_registered → 409
// club_full.
export const registerForClub = async (
  db: pg.PoolClient,
  { studentId, clubId, idempotencyKey }: RegisterInput,
  gate: AdmissionGate,
): Promise<RegistrationResult> => {
  const roundId = await lockRoundOfClub(db, clubId);
  if (roundId === undefined) throw new AppError(ERROR_CODES.notFound, 'Club not found');

  const prior = await findPriorEvent(db, studentId, idempotencyKey);
  if (prior) return await replayPriorEvent(db, studentId, prior, { eventType: 'register', clubId });

  await lockStudentProfile(db, studentId);
  const attempt = await attemptSeat(db, studentId, clubId);
  if (!attempt) throw new AppError(ERROR_CODES.notFound, 'Club not found');

  // Nothing inserted: the window is closed, or the student already holds a seat in the round.
  const held = attempt.created_at === null ? await findRegistration(db, roundId, studentId) : null;
  // The same club again (a retry with a new key): the README's idempotent same-club case. It
  // writes nothing, so it is answered even outside the window.
  if (held?.club.id === clubId) {
    return {
      outcome: REGISTRATION_OUTCOMES.alreadyHeld,
      roundId,
      clubId,
      registration: held,
      promotions: [],
    };
  }
  if (!attempt.is_open) throw new AppError(ERROR_CODES.roundNotOpen);
  await gate(db, roundId);
  if (attempt.created_at === null) {
    if (held) throw new AppError(ERROR_CODES.alreadyRegistered);
    // Under the round lock the insert can only skip a row that is there to be read.
    throw new Error('Registration insert skipped without a conflicting row');
  }

  const club = await takeSeat(db, roundId, clubId);
  if (!club) throw new AppError(ERROR_CODES.clubFull);

  await insertEvent(db, { roundId, studentId, clubId, eventType: 'register', idempotencyKey });
  return {
    outcome: REGISTRATION_OUTCOMES.registered,
    roundId,
    clubId,
    // Built from what the statements returned rather than read again: this is the hot path, and a
    // seat just taken by the student's own register was not a promotion.
    registration: toRegistration({
      club_id: clubId,
      club_code: club.club_code,
      club_name: club.name,
      created_at: attempt.created_at,
      promoted_from_waitlist: false,
    }),
    promotions: [],
  };
};

type CancelAttempt = { is_open: boolean; club_id: number | null };

// One statement, one statement_timestamp(), as for register: the row is deleted only while the
// round is open.
const attemptCancel = async (
  db: pg.PoolClient,
  roundId: number,
  studentId: number,
): Promise<CancelAttempt | undefined> => {
  const { rows } = await db.query<CancelAttempt>(
    `WITH target AS (
       SELECT statement_timestamp() >= opens_at
                AND statement_timestamp() < closes_at AS is_open
       FROM rounds
       WHERE id = $1
     ),
     deleted AS (
       DELETE FROM registrations
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

export type CancelInput = { studentId: number; idempotencyKey: string };

// Cancels in the round the student is shown. The round is picked with the DB clock, like the
// window check, so both use one clock; the pick happens before the lock (its id is the lock key),
// and the window is checked again by the DELETE once the lock is held.
export const cancelRegistration = async (
  db: pg.PoolClient,
  { studentId, idempotencyKey }: CancelInput,
): Promise<RegistrationResult> => {
  const grade = await findStudentGrade(db, studentId);
  const round = await selectStudentRound(db, grade, await dbNow(db));
  if (round) await lockRound(db, round.id);

  const prior = await findPriorEvent(db, studentId, idempotencyKey);
  if (prior) {
    return await replayPriorEvent(db, studentId, prior, { eventType: 'cancel', clubId: null });
  }

  // No round at all for the grade: nothing can be open.
  if (!round) throw new AppError(ERROR_CODES.roundNotOpen);
  const attempt = await attemptCancel(db, round.id, studentId);
  if (attempt?.is_open !== true) throw new AppError(ERROR_CODES.roundNotOpen);
  if (attempt.club_id === null) throw new AppError(ERROR_CODES.notRegistered);

  await releaseSeat(db, round.id, attempt.club_id);
  await insertEvent(db, {
    roundId: round.id,
    studentId,
    clubId: attempt.club_id,
    eventType: 'cancel',
    idempotencyKey,
  });
  const promotions = await promoteWaitlist(db, { roundId: round.id, actorId: studentId });
  return {
    outcome: REGISTRATION_OUTCOMES.cancelled,
    roundId: round.id,
    clubId: attempt.club_id,
    // Usually null; a cascade may have handed the student the club they were waiting for.
    registration: await findRegistration(db, round.id, studentId),
    promotions,
  };
};

// Changing club (README Phase 2 "เปลี่ยนชุมนุมแบบ atomic"): one transaction that takes the new
// seat, gives back the old one, moves the registration row and logs one `change` event. The order
// of answers, each decided under the round lock:
//
//   404 unknown club → replay (200) / 409 idempotency_key_reused → 403 student_profile_missing
//   → 404 club the student is not shown → 200 already_held (the club they hold; written nothing,
//   so answered even outside the window, like register) → 409 round_not_open → 403
//   queue_required (the gate) → 409 not_registered → 409 club_full.
//
// round_not_open before not_registered and club_full matches register (round_not_open before
// already_registered and club_full) and cancel (round_not_open before not_registered): outside
// the window the answer is always "not open", whatever the student holds.
//
// The new seat is taken before the old one is given back, so the student never stands without a
// seat. The cost: two students in two full clubs who want to swap both get club_full, because
// neither seat is free at the moment the other asks. That is the README rule "the new club full =
// stay where you are"; a swap is a cancel and a register (or, later, the waitlist).

type ChangeAttempt = {
  round_id: number;
  is_open: boolean;
  from_club_id: number | null;
  seated: boolean;
};

// One statement, one statement_timestamp(), like attemptSeat: the club must be in the round the
// student is shown, the round open, the student registered there in another club, and the club
// with a free seat and nobody on its waitlist (no jumping the queue, as for register). Only then
// is the seat taken. No row back = 404, as for register. The other columns say which condition
// failed when no seat was taken.
const attemptChange = async (
  db: pg.PoolClient,
  studentId: number,
  clubId: number,
): Promise<ChangeAttempt | undefined> => {
  const { rows } = await db.query<ChangeAttempt>(
    `WITH target AS (${visibleClubTarget('$1', '$2')}),
     held AS (
       SELECT reg.club_id
       FROM registrations reg
       JOIN target t ON reg.round_id = t.round_id
       WHERE reg.student_id = $2
     ),
     seated AS (
       UPDATE clubs SET registered = registered + 1
       FROM target t
       WHERE clubs.id = t.club_id
         AND clubs.round_id = t.round_id
         AND t.is_open
         AND EXISTS (SELECT 1 FROM held h WHERE h.club_id <> t.club_id)
         AND clubs.registered < clubs.capacity
         AND ${NO_WAITLIST}
       RETURNING clubs.id
     )
     SELECT t.round_id, t.is_open, h.club_id AS from_club_id, s.id IS NOT NULL AS seated
     FROM target t
     LEFT JOIN held h ON true
     LEFT JOIN seated s ON true`,
    [clubId, studentId],
  );
  return rows[0];
};

export type ChangeInput = { studentId: number; clubId: number; idempotencyKey: string };

export const changeRegistration = async (
  db: pg.PoolClient,
  { studentId, clubId, idempotencyKey }: ChangeInput,
  gate: AdmissionGate,
): Promise<RegistrationResult> => {
  const roundId = await lockRoundOfClub(db, clubId);
  if (roundId === undefined) throw new AppError(ERROR_CODES.notFound, 'Club not found');

  const prior = await findPriorEvent(db, studentId, idempotencyKey);
  if (prior) return await replayPriorEvent(db, studentId, prior, { eventType: 'change', clubId });

  await lockStudentProfile(db, studentId);
  const attempt = await attemptChange(db, studentId, clubId);
  if (!attempt) throw new AppError(ERROR_CODES.notFound, 'Club not found');

  if (attempt.from_club_id === clubId) {
    return {
      outcome: REGISTRATION_OUTCOMES.alreadyHeld,
      roundId,
      clubId,
      registration: await findRegistration(db, roundId, studentId),
      promotions: [],
    };
  }
  if (!attempt.is_open) throw new AppError(ERROR_CODES.roundNotOpen);
  // The statement may have taken the new seat already; a refusal rolls it back.
  await gate(db, roundId);
  if (attempt.from_club_id === null) throw new AppError(ERROR_CODES.notRegistered);
  if (!attempt.seated) throw new AppError(ERROR_CODES.clubFull);

  const fromClubId = attempt.from_club_id;
  await releaseSeat(db, roundId, fromClubId);
  await moveRegistration(db, { roundId, studentId, fromClubId, clubId });
  await insertEvent(db, {
    roundId,
    studentId,
    clubId,
    fromClubId,
    eventType: 'change',
    idempotencyKey,
  });
  // The old club has a free seat now; its waiters (and, through a cascade, maybe the student's
  // own waitlist entry) move up in this same transaction.
  const promotions = await promoteWaitlist(db, { roundId, actorId: studentId });
  return {
    outcome: REGISTRATION_OUTCOMES.changed,
    roundId,
    clubId,
    fromClubId,
    registration: await findRegistration(db, roundId, studentId),
    promotions,
  };
};
