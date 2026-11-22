import { ERROR_CODES } from '@club-registration/shared';
import type { QueueTicket, StudentQueueResponse, StudentRound } from '@club-registration/shared';
import type pg from 'pg';
import { dbNow } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import type { AdmissionGate } from './registrations.js';
import { lockQueue } from './round-lock.js';
import { findStudentGrade, selectStudentRound } from './student-round.js';

// The queue in front of a round (README Phase 3): at most rounds.max_active students of the round
// are admitted at once, the rest wait in join order. Same shape as registrations.ts: the writes
// (join, heartbeat, done) run inside the caller's transaction and take the round's queue lock
// (round-lock.ts) before reading anything they decide by; the route opens the transaction, so Q2
// can compose these with a seat write. Every time decision uses the DB clock.
//
// Every write first expires the round's stale tickets, then makes its own change, then (join and
// heartbeat) admits the next waiting tickets up to max_active. Under the queue lock no other queue
// write runs in between, so the admitted count the admission reads is exact and no admission can
// lift it above max_active.
//
// Queue order is (created_at, id). created_at is clock_timestamp() taken by the INSERT, after the
// queue lock is held, so tickets are ordered the way their joins took the lock (as for
// waitlist_entries; the column default now() would be the transaction start, before the wait).
//
// These writes take no idempotency key and log no registration_events (CLAUDE.md rule 7): they
// move no seat, and each is idempotent by construction. A repeated join finds the live ticket and
// returns it (the partial unique index queue_tickets_live_ticket_idx makes a second live ticket
// impossible even for a statement that skipped the lock), a repeated heartbeat only moves
// last_seen_at, and a repeated done finds no live ticket and answers with the state as it is.
//
// EXPLAIN ANALYZE (Postgres 18, 30,000 fictional tickets in 6 rounds, each round 150 admitted,
// 50 done and 4,800 waiting): the expiry reads the round's live tickets through the partial
// queue_tickets_live_ticket_idx, the admitted count, the admission's ORDER BY ... LIMIT ... FOR
// UPDATE SKIP LOCKED and the position count use queue_tickets_admission_idx (round_id, status,
// created_at, id), the admission reading only the front of the round's waiting range in queue
// order (no sort), and the student's own ticket is found through queue_tickets_student_id_idx or
// the live-ticket index. Every statement ran in under 0.5 ms, so no new index. The admission
// updates the picked ids through = ANY (ARRAY(...)) so it reaches them by primary key: a join on
// the CTE was planned as a hash join over a scan of the whole table (1.3 ms, growing with every
// term's tickets, since none is ever deleted).

export type QueueSettings = Readonly<{
  // A ticket (waiting or admitted) whose last heartbeat is older than this expires.
  idleTimeoutSeconds: number;
  // An admitted ticket expires this long after its admission, heartbeats or not.
  admissionTtlSeconds: number;
}>;

// Starting points, not measurements: the load test on the real host (O5) decides the production
// values, which come from env (QUEUE_* in config.ts). The page polls every 3–5 s, so 60 s is a
// dozen missed heartbeats; 10 minutes is long enough to read the club list and choose.
export const DEFAULT_QUEUE_SETTINGS: QueueSettings = Object.freeze({
  idleTimeoutSeconds: 60,
  admissionTtlSeconds: 600,
});

// An idle timeout of a few polls would expire students who are still there; the TTL is kept
// within the 2 h session, and a TTL shorter than a minute leaves no time to choose.
export const QUEUE_SETTING_LIMITS = Object.freeze({
  idleTimeoutSeconds: Object.freeze({ min: 15, max: 3_600 }),
  admissionTtlSeconds: Object.freeze({ min: 60, max: 7_200 }),
});

export const QUEUE_OUTCOMES = Object.freeze({
  queued: 'queued',
  alreadyQueued: 'already_queued',
  seen: 'seen',
  released: 'released',
  noLiveTicket: 'no_live_ticket',
} as const);

export type QueueOutcome = (typeof QUEUE_OUTCOMES)[keyof typeof QUEUE_OUTCOMES];

export type QueueResult = {
  outcome: QueueOutcome;
  roundId: number | null;
  // What this request's own expiry and admission did to the round (counts only, for the log).
  expired: number;
  admitted: number;
  response: StudentQueueResponse;
};

// "Live by the DB clock": waiting or admitted, seen within the idle timeout, and (admitted) within
// the admission TTL. The one definition of a ticket that still counts, used by the expiry, the
// read, the position and hasAdmittedTicket alike, so a ticket past its time reads as expired even
// where no write has marked it so yet. `alias`, `idle` and `ttl` are always constants of this
// module (a table alias and parameter placeholders), never input.
const liveTicket = (alias: string, idle: string, ttl: string): string => `
  ${alias}.status IN ('waiting', 'admitted')
  AND ${alias}.last_seen_at >= statement_timestamp() - ${idle}::int * interval '1 second'
  AND (
    ${alias}.status = 'waiting'
    OR ${alias}.admitted_at >= statement_timestamp() - ${ttl}::int * interval '1 second'
  )`;

// Marks the round's tickets that are no longer live as expired. Returns how many.
const expireStaleTickets = async (
  db: pg.PoolClient,
  roundId: number,
  settings: QueueSettings,
): Promise<number> => {
  const { rowCount } = await db.query(
    `UPDATE queue_tickets t SET status = 'expired'
     WHERE t.round_id = $1 AND t.status IN ('waiting', 'admitted')
       AND NOT (${liveTicket('t', '$2', '$3')})`,
    [roundId, settings.idleTimeoutSeconds, settings.admissionTtlSeconds],
  );
  return rowCount ?? 0;
};

// The student's heartbeat. Runs after the expiry, so a ticket idle past the timeout has already
// ended and is not revived: whether it expired never depends on other students' traffic.
const touchLiveTicket = async (
  db: pg.PoolClient,
  roundId: number,
  studentId: number,
): Promise<boolean> => {
  const { rowCount } = await db.query(
    `UPDATE queue_tickets SET last_seen_at = statement_timestamp()
     WHERE round_id = $1 AND student_id = $2 AND status IN ('waiting', 'admitted')`,
    [roundId, studentId],
  );
  return rowCount === 1;
};

// A new ticket at the back of the queue, only while the round is open by this statement's clock.
// false = the round is not open. No ON CONFLICT: the caller found no live ticket under the queue
// lock, so the live-ticket unique index can only fire on a bug, which must fail loudly (500 and a
// rollback), never be read as "not open".
const insertTicket = async (
  db: pg.PoolClient,
  roundId: number,
  studentId: number,
): Promise<boolean> => {
  const { rowCount } = await db.query(
    `INSERT INTO queue_tickets (round_id, student_id, status, created_at, last_seen_at)
     SELECT r.id, $2, 'waiting', clock_timestamp(), statement_timestamp()
     FROM rounds r
     WHERE r.id = $1
       AND statement_timestamp() >= r.opens_at
       AND statement_timestamp() < r.closes_at`,
    [roundId, studentId],
  );
  return rowCount === 1;
};

// One statement: the free slots (max_active of an open round minus the admitted tickets, never
// below 0, so a max_active an admin lowered under the admitted count admits nobody and kicks
// nobody out) and the next waiting tickets in queue order, admitted together. The expiry ran just
// before under the same lock, so every admitted ticket counted here is live. A closed or upcoming
// round has no slots: nobody is admitted to a round that cannot be written to. SKIP LOCKED never
// skips anything while every writer of queue_tickets holds the queue lock; it is there so that a
// future statement locking a ticket row without the lock delays nobody's admission (the
// admission only ever takes the front of the queue, and the lock keeps that order).
const admitWaitingTickets = async (db: pg.PoolClient, roundId: number): Promise<number> => {
  const { rowCount } = await db.query(
    `WITH room AS (
       SELECT GREATEST(
         COALESCE((
           SELECT r.max_active FROM rounds r
           WHERE r.id = $1
             AND statement_timestamp() >= r.opens_at
             AND statement_timestamp() < r.closes_at
         ), 0)
         - (SELECT count(*) FROM queue_tickets a WHERE a.round_id = $1 AND a.status = 'admitted'),
         0
       ) AS slots
     ),
     next AS (
       SELECT w.id FROM queue_tickets w
       WHERE w.round_id = $1 AND w.status = 'waiting'
       ORDER BY w.created_at, w.id
       LIMIT (SELECT slots FROM room)
       FOR UPDATE SKIP LOCKED
     )
     UPDATE queue_tickets SET status = 'admitted', admitted_at = statement_timestamp()
     WHERE id = ANY (ARRAY(SELECT id FROM next))`,
    [roundId],
  );
  return rowCount ?? 0;
};

const releaseLiveTicket = async (
  db: pg.PoolClient,
  roundId: number,
  studentId: number,
): Promise<boolean> => {
  const { rowCount } = await db.query(
    `UPDATE queue_tickets SET status = 'done'
     WHERE round_id = $1 AND student_id = $2 AND status IN ('waiting', 'admitted')`,
    [roundId, studentId],
  );
  return rowCount === 1;
};

type TicketRow = {
  status: QueueTicket['status'];
  live: boolean;
  admitted_until: Date | null;
  position: number | null;
};

// The one place a ticket row becomes the API shape. A waiting or admitted ticket that is not live
// any more is expired, written so or not.
const toTicket = (row: TicketRow): QueueTicket => {
  if (row.live && row.status === 'admitted' && row.admitted_until) {
    return { status: 'admitted', admittedUntil: row.admitted_until.toISOString() };
  }
  if (row.live && row.status === 'waiting' && row.position !== null) {
    return { status: 'waiting', position: row.position };
  }
  return { status: row.status === 'done' ? 'done' : 'expired' };
};

// The student's latest ticket in the round (live tickets are always the latest: a new one is only
// made when none is live). position = the live waiting tickets ahead in queue order + 1, read with
// queue_tickets_admission_idx; stale tickets ahead are not counted, since the next write expires
// them. Nothing else of other students is read out.
const findTicket = async (
  db: Queryable,
  roundId: number,
  studentId: number,
  settings: QueueSettings,
): Promise<QueueTicket | null> => {
  const { rows } = await db.query<TicketRow>(
    `SELECT t.status,
            ${liveTicket('t', '$3', '$4')} AS live,
            t.admitted_at + $4::int * interval '1 second' AS admitted_until,
            CASE WHEN t.status = 'waiting' THEN 1 + (
              SELECT count(*)::int FROM queue_tickets a
              WHERE a.round_id = t.round_id AND a.status = 'waiting'
                AND (a.created_at, a.id) < (t.created_at, t.id)
                AND ${liveTicket('a', '$3', '$4')}
            ) END AS position
     FROM queue_tickets t
     WHERE t.round_id = $1 AND t.student_id = $2
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT 1`,
    [roundId, studentId, settings.idleTimeoutSeconds, settings.admissionTtlSeconds],
  );
  const row = rows[0];
  return row ? toTicket(row) : null;
};

// The round the student is shown, picked exactly like GET /api/student/round picks it (S1), by the
// DB clock of this transaction, before any lock: its id is the lock key. 403
// student_profile_missing for an account without a profile, as on every student endpoint.
const selectRound = async (
  db: pg.PoolClient,
  studentId: number,
): Promise<StudentRound | undefined> => {
  const grade = await findStudentGrade(db, studentId);
  return await selectStudentRound(db, grade, await dbNow(db));
};

const answer = async (
  db: pg.PoolClient,
  round: StudentRound,
  studentId: number,
  settings: QueueSettings,
): Promise<StudentQueueResponse> => ({
  round,
  ticket: await findTicket(db, round.id, studentId, settings),
});

export type QueueInput = { studentId: number; settings: QueueSettings };

// Order: 403 student_profile_missing → 409 round_not_open (the grade has no round) → lock →
// expiry → a live ticket already: 200 with it, its heartbeat taken (answered even outside the
// window, like a repeated register: nothing new is written) → 409 round_not_open (upcoming or
// closed) → a new ticket at the back → admission, so a short queue admits at once.
export const joinQueue = async (
  db: pg.PoolClient,
  { studentId, settings }: QueueInput,
): Promise<QueueResult> => {
  const round = await selectRound(db, studentId);
  if (!round) throw new AppError(ERROR_CODES.roundNotOpen);
  await lockQueue(db, round.id);

  const expired = await expireStaleTickets(db, round.id, settings);
  let outcome: QueueOutcome = QUEUE_OUTCOMES.alreadyQueued;
  if (!(await touchLiveTicket(db, round.id, studentId))) {
    if (!(await insertTicket(db, round.id, studentId))) {
      throw new AppError(ERROR_CODES.roundNotOpen);
    }
    outcome = QUEUE_OUTCOMES.queued;
  }
  const admitted = await admitWaitingTickets(db, round.id);
  return {
    outcome,
    roundId: round.id,
    expired,
    admitted,
    response: await answer(db, round, studentId, settings),
  };
};

// Order: 403 student_profile_missing → 409 not_in_queue (no round) → lock → expiry → 409
// not_in_queue (no live ticket: never joined, released, or expired, this request's expiry
// included; the rollback undoes that expiry too, which the next write redoes) → heartbeat →
// admission. No window check: outside the window the admission finds no slots, and the ticket
// simply runs out.
export const heartbeatQueue = async (
  db: pg.PoolClient,
  { studentId, settings }: QueueInput,
): Promise<QueueResult> => {
  const round = await selectRound(db, studentId);
  if (!round) throw new AppError(ERROR_CODES.notInQueue);
  await lockQueue(db, round.id);

  const expired = await expireStaleTickets(db, round.id, settings);
  if (!(await touchLiveTicket(db, round.id, studentId))) {
    throw new AppError(ERROR_CODES.notInQueue);
  }
  const admitted = await admitWaitingTickets(db, round.id);
  return {
    outcome: QUEUE_OUTCOMES.seen,
    roundId: round.id,
    expired,
    admitted,
    response: await answer(db, round, studentId, settings),
  };
};

// Releases the student's live ticket (waiting or admitted) in any state of the round. No live
// ticket is not an error: the answer is the state as it is, so a retry of a done that went through
// gets the same answer. It admits nobody; the next join or heartbeat fills the freed slot.
export const releaseQueue = async (
  db: pg.PoolClient,
  { studentId, settings }: QueueInput,
): Promise<QueueResult> => {
  const round = await selectRound(db, studentId);
  if (!round) {
    return {
      outcome: QUEUE_OUTCOMES.noLiveTicket,
      roundId: null,
      expired: 0,
      admitted: 0,
      response: { round: null, ticket: null },
    };
  }
  await lockQueue(db, round.id);

  const expired = await expireStaleTickets(db, round.id, settings);
  const released = await releaseLiveTicket(db, round.id, studentId);
  return {
    outcome: released ? QUEUE_OUTCOMES.released : QUEUE_OUTCOMES.noLiveTicket,
    roundId: round.id,
    expired,
    admitted: 0,
    response: await answer(db, round, studentId, settings),
  };
};

// GET: reads only, in the caller's read-only snapshot. It neither expires nor admits and is no
// heartbeat (only POST heartbeat keeps a ticket alive); a ticket past its time reads as expired.
export const readQueue = async (
  db: pg.PoolClient,
  { studentId, settings }: QueueInput,
): Promise<StudentQueueResponse> => {
  const round = await selectRound(db, studentId);
  if (!round) return { round: null, ticket: null };
  return await answer(db, round, studentId, settings);
};

// The queue gate's question (Q2): whether the student holds a live admitted ticket in the round now
// (DB clock). A plain read with no lock, so a transaction holding the round lock may call it
// without joining the queue's lock order (round-lock.ts).
export const hasAdmittedTicket = async (
  db: Queryable,
  { roundId, studentId }: { roundId: number; studentId: number },
  settings: QueueSettings,
): Promise<boolean> => {
  const { rows } = await db.query<{ admitted: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM queue_tickets t
       WHERE t.round_id = $1 AND t.student_id = $2 AND t.status = 'admitted'
         AND ${liveTicket('t', '$3', '$4')}
     ) AS admitted`,
    [roundId, studentId, settings.idleTimeoutSeconds, settings.admissionTtlSeconds],
  );
  return rows[0]?.admitted === true;
};

// The gate of a student's own seat-taking request and of their club list (README Phase 3, Q2): in
// an open round, no live admitted ticket = 403 queue_required. The callers decide when the round
// is open (registrations.ts, student-round.ts); this only asks the queue. Built by the student
// routes, the only callers that are gated.
export const requireAdmittedTicket =
  (studentId: number, settings: QueueSettings): AdmissionGate =>
  async (db, roundId) => {
    if (!(await hasAdmittedTicket(db, { roundId, studentId }, settings))) {
      throw new AppError(ERROR_CODES.queueRequired);
    }
  };
