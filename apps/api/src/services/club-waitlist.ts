import { ERROR_CODES } from '@club-registration/shared';
import type { ClubWaitlistEntry, ClubWaitlistResponse } from '@club-registration/shared';
import type pg from 'pg';
import { withReadOnlySnapshot } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import {
  assertSameAdminRequest,
  findAdminPriorEvent,
  findClubSeats,
  findStudent,
  insertAdminEvent,
  toClubSeats,
} from './club-members.js';
import { lockRoundOfClub } from './round-lock.js';

// An admin's view of a club's waitlist and an admin taking a student off it (README Phase 2,
// PR 3b). Same shape as club-members.ts, whose helpers it shares: the write runs inside the
// caller's transaction, takes the club's round lock first (CLAUDE.md rule 3), then the admin's
// idempotency, then the rule as a condition of the writing statement.
//
// The removal is for any round status, closed included: after a round closes nobody is promoted
// any more and a student can no longer leave by themself, so a stale entry stays on the list (and
// stops an import of the same term from changing the student's grade) until an admin removes it
// (README open item 19). Removing a waiter frees no seat, so it promotes nobody, in any round.

export const WAITLIST_REMOVE_OUTCOMES = Object.freeze({
  removed: 'removed',
  // The key was used by this same request before: nothing written, current list returned.
  replayed: 'replayed',
} as const);

export type WaitlistRemoveOutcome =
  (typeof WAITLIST_REMOVE_OUTCOMES)[keyof typeof WAITLIST_REMOVE_OUTCOMES];

export type WaitlistRemoveResult = ClubWaitlistResponse & {
  outcome: WaitlistRemoveOutcome;
  roundId: number;
  clubId: number;
  studentId: number;
};

type EntryRow = {
  student_id: number;
  login_id: string;
  full_name: string;
  classroom: string;
  seat_no: number;
  created_at: Date;
  held_club_id: number | null;
  held_club_code: string | null;
  held_club_name: string | null;
};

// The one place snake_case rows become the API shape. Rows come in queue order, so the position
// is the row's place in the list.
const toEntry = (row: EntryRow, index: number): ClubWaitlistEntry => ({
  position: index + 1,
  studentId: row.student_id,
  loginId: row.login_id,
  fullName: row.full_name,
  classroom: row.classroom,
  seatNo: row.seat_no,
  joinedAt: row.created_at.toISOString(),
  heldClub:
    row.held_club_id === null || row.held_club_code === null || row.held_club_name === null
      ? null
      : { id: row.held_club_id, clubCode: row.held_club_code, name: row.held_club_name },
});

// Queue order (created_at, id) through the (club_id, round_id, created_at, id) index, as the
// promote engine and a student's own position read it. A student holds at most one seat per
// round (UNIQUE (round_id, student_id)), so the held club join adds no row.
const findEntries = async (
  db: Queryable,
  { roundId, clubId }: { roundId: number; clubId: number },
): Promise<ClubWaitlistEntry[]> => {
  const { rows } = await db.query<EntryRow>(
    `SELECT w.student_id, u.login_id, u.full_name, sp.classroom, sp.seat_no, w.created_at,
            hc.id AS held_club_id, hc.club_code AS held_club_code, hc.name AS held_club_name
     FROM waitlist_entries w
     JOIN users u ON u.id = w.student_id
     JOIN student_profiles sp ON sp.user_id = w.student_id
     LEFT JOIN registrations r ON r.round_id = w.round_id AND r.student_id = w.student_id
     LEFT JOIN clubs hc ON hc.id = r.club_id
     WHERE w.club_id = $1 AND w.round_id = $2
     ORDER BY w.created_at, w.id`,
    [clubId, roundId],
  );
  return rows.map(toEntry);
};

const readWaitlist = async (db: Queryable, clubId: number): Promise<ClubWaitlistResponse> => {
  const club = await findClubSeats(db, clubId);
  if (!club) throw new AppError(ERROR_CODES.notFound, 'Club not found');
  return {
    club: toClubSeats(club),
    entries: await findEntries(db, { roundId: club.round_id, clubId }),
  };
};

// Read-only: one snapshot, so the queue and the club's counts describe the same moment even while
// students join, leave and get promoted.
export const listClubWaitlist = async (
  pool: pg.Pool,
  clubId: number,
): Promise<ClubWaitlistResponse> =>
  await withReadOnlySnapshot(pool, async (client) => await readWaitlist(client, clubId));

export type WaitlistRemoveInput = {
  adminId: number;
  clubId: number;
  loginId: string;
  idempotencyKey: string;
};

// Takes the student's entry for this club off the waitlist. The order of answers, each decided
// under the round lock:
//
//   404 unknown club → replay (200) / 409 idempotency_key_reused → 404 unknown student → 409
//   not_waitlisted (no entry for this club; an entry for another club of the round is left alone)
//   → delete.
//
// No window check (the point is the closed round), no grade check (an import may have moved the
// student up a grade since the round closed, as for removing a seat), no promotion (no seat was
// freed). One waitlist_leave event, club_id = this club, actor = the admin, with the request's
// key: the same event a student's own leave writes, told apart by its actor.
export const removeWaitlistEntry = async (
  db: pg.PoolClient,
  { adminId, clubId, loginId, idempotencyKey }: WaitlistRemoveInput,
): Promise<WaitlistRemoveResult> => {
  const roundId = await lockRoundOfClub(db, clubId);
  if (roundId === undefined) throw new AppError(ERROR_CODES.notFound, 'Club not found');

  const prior = await findAdminPriorEvent(db, adminId, idempotencyKey);
  if (prior) {
    assertSameAdminRequest(prior, { eventType: 'waitlist_leave', clubId, loginId });
    return {
      outcome: WAITLIST_REMOVE_OUTCOMES.replayed,
      roundId: prior.round_id,
      clubId,
      studentId: prior.student_id,
      ...(await readWaitlist(db, clubId)),
    };
  }

  const student = await findStudent(db, loginId, { lockProfile: false });
  const { rowCount } = await db.query(
    'DELETE FROM waitlist_entries WHERE round_id = $1 AND student_id = $2 AND club_id = $3',
    [roundId, student.id, clubId],
  );
  if (rowCount === 0) {
    throw new AppError(ERROR_CODES.notWaitlisted, 'The student is not waiting for this club');
  }

  await insertAdminEvent(db, {
    roundId,
    studentId: student.id,
    clubId,
    eventType: 'waitlist_leave',
    adminId,
    idempotencyKey,
  });
  return {
    outcome: WAITLIST_REMOVE_OUTCOMES.removed,
    roundId,
    clubId,
    studentId: student.id,
    ...(await readWaitlist(db, clubId)),
  };
};
