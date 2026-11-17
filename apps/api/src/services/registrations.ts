import { ERROR_CODES } from '@club-registration/shared';
import type { StudentRegistration } from '@club-registration/shared';
import type pg from 'pg';
import { isPgError, PG_ERROR_CODES } from '../db.js';
import { AppError } from '../errors.js';
import { lockRound, lockRoundOfClub } from './round-lock.js';
import {
  findRegistration,
  findStudentGrade,
  roundSelectionOrder,
  selectStudentRound,
} from './student-round.js';

// A student registering for a club and cancelling it (README "จุดวิกฤต: การจองที่นั่ง").
//
// Each function is one step of business logic that runs inside the caller's transaction (it takes
// the transaction's client and never commits), so a route wraps it in withTransaction and Phase 2
// can compose it with change/waitlist/promote in one transaction. Statements run one after the
// other, in this order:
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
//
// Clock: writes decide the window with the DB clock, statement_timestamp() of the writing
// statement, which runs after the lock is held. A request that waited for the lock across
// closes_at is therefore refused, and every app process (or a skewed app host) agrees on one
// clock. The reads in student-round.ts show a status computed from the app clock; on the
// single-host deployment both read the same system clock, so they differ only by the moments
// between a read and a write, and the write is the one that counts (README Phase 1 item 4).

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
} as const);

export type RegistrationOutcome =
  (typeof REGISTRATION_OUTCOMES)[keyof typeof REGISTRATION_OUTCOMES];

export type RegistrationResult = {
  outcome: RegistrationOutcome;
  roundId: number;
  clubId: number | null;
  // The student's registration in the round after the request.
  registration: StudentRegistration | null;
};

type EventType = 'register' | 'cancel';

type PriorEvent = { event_type: string; round_id: number; club_id: number | null };

const findPriorEvent = async (
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

// Same request = same type and, for register, the same club. The answer is the registration as
// it stands now in the round the first request acted on, so a client that retries after the state
// moved on (e.g. a register replayed after a cancel) learns the truth instead of a stale copy.
const replayPriorEvent = async (
  db: pg.PoolClient,
  studentId: number,
  prior: PriorEvent,
  request: { eventType: EventType; clubId: number | null },
): Promise<RegistrationResult> => {
  const sameRequest =
    prior.event_type === request.eventType &&
    (request.eventType === 'cancel' || prior.club_id === request.clubId);
  if (!sameRequest) throw new AppError(ERROR_CODES.idempotencyKeyReused);
  return {
    outcome: REGISTRATION_OUTCOMES.replayed,
    roundId: prior.round_id,
    clubId: prior.club_id,
    registration: await findRegistration(db, prior.round_id, studentId),
  };
};

type EventInput = {
  roundId: number;
  studentId: number;
  clubId: number;
  eventType: EventType;
  idempotencyKey: string;
};

// The student is the actor: these are their own requests (admin_* events have an admin actor).
const insertEvent = async (
  db: pg.PoolClient,
  { roundId, studentId, clubId, eventType, idempotencyKey }: EventInput,
): Promise<void> => {
  try {
    await db.query(
      `INSERT INTO registration_events
         (round_id, student_id, club_id, event_type, actor_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $2, $5)`,
      [roundId, studentId, clubId, eventType, idempotencyKey],
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
const lockStudentProfile = async (db: pg.PoolClient, studentId: number): Promise<void> => {
  const { rowCount } = await db.query(
    'SELECT 1 FROM student_profiles WHERE user_id = $1 FOR SHARE',
    [studentId],
  );
  if (rowCount === 0) throw new AppError(ERROR_CODES.studentProfileMissing);
};

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
    `WITH target AS (
       SELECT c.id AS club_id, c.round_id,
              statement_timestamp() >= r.opens_at
                AND statement_timestamp() < r.closes_at AS is_open
       FROM clubs c
       JOIN rounds r ON r.id = c.round_id
       JOIN student_profiles sp ON sp.user_id = $2 AND sp.grade = r.grade
       WHERE c.id = $1
         AND r.id = (
           SELECT s.id FROM rounds s
           WHERE s.grade = sp.grade
           ORDER BY ${roundSelectionOrder('statement_timestamp()', 's')}
           LIMIT 1
         )
     ),
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

// The seat itself. 0 rows = full; the caller's throw rolls back the registration inserted above.
const takeSeat = async (
  db: pg.PoolClient,
  roundId: number,
  clubId: number,
): Promise<ClubLabel | undefined> => {
  const { rows } = await db.query<ClubLabel>(
    `UPDATE clubs SET registered = registered + 1
     WHERE id = $1 AND round_id = $2 AND registered < capacity
     RETURNING club_code, name`,
    [clubId, roundId],
  );
  return rows[0];
};

export type RegisterInput = { studentId: number; clubId: number; idempotencyKey: string };

export const registerForClub = async (
  db: pg.PoolClient,
  { studentId, clubId, idempotencyKey }: RegisterInput,
): Promise<RegistrationResult> => {
  const roundId = await lockRoundOfClub(db, clubId);
  if (roundId === undefined) throw new AppError(ERROR_CODES.notFound, 'Club not found');

  const prior = await findPriorEvent(db, studentId, idempotencyKey);
  if (prior) return await replayPriorEvent(db, studentId, prior, { eventType: 'register', clubId });

  await lockStudentProfile(db, studentId);
  const attempt = await attemptSeat(db, studentId, clubId);
  if (!attempt) throw new AppError(ERROR_CODES.notFound, 'Club not found');

  if (attempt.created_at === null) {
    // Nothing inserted: the window is closed, or the student already holds a seat in the round.
    const held = await findRegistration(db, roundId, studentId);
    // The same club again (a retry with a new key): the README's idempotent same-club case. It
    // writes nothing, so it is answered even outside the window.
    if (held?.club.id === clubId) {
      return { outcome: REGISTRATION_OUTCOMES.alreadyHeld, roundId, clubId, registration: held };
    }
    if (!attempt.is_open) throw new AppError(ERROR_CODES.roundNotOpen);
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
    registration: {
      club: { id: clubId, clubCode: club.club_code, name: club.name },
      registeredAt: attempt.created_at.toISOString(),
    },
  };
};

const dbNow = async (db: pg.PoolClient): Promise<Date> => {
  const { rows } = await db.query<{ now: Date }>('SELECT statement_timestamp() AS now');
  const row = rows[0];
  if (!row) throw new Error('statement_timestamp() returned no row');
  return row.now;
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

// The clubs CHECK (registered >= 0) is the backstop; a missing row would mean a registration
// pointing at no club, which the composite foreign key already rules out.
const releaseSeat = async (db: pg.PoolClient, roundId: number, clubId: number): Promise<void> => {
  const { rowCount } = await db.query(
    'UPDATE clubs SET registered = registered - 1 WHERE id = $1 AND round_id = $2',
    [clubId, roundId],
  );
  if (rowCount !== 1) throw new Error('Cancelled a registration whose club row is missing');
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
  return {
    outcome: REGISTRATION_OUTCOMES.cancelled,
    roundId: round.id,
    clubId: attempt.club_id,
    registration: null,
  };
};
