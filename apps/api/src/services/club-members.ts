import { ERROR_CODES } from '@club-registration/shared';
import type { ClubMember, ClubMemberSource, ClubSeats } from '@club-registration/shared';
import type pg from 'pg';
import { isPgError, PG_ERROR_CODES, withReadOnlySnapshot } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import { compareClassrooms } from './classroom-order.js';
import { EVENT_KEY_UNIQUE } from './registrations.js';
import { lockRoundOfClub } from './round-lock.js';
import { moveRegistration, releaseSeat } from './seats.js';
import { promoteWaitlist } from './waitlist-promote.js';
import type { Promotion } from './waitlist-promote.js';

// An admin listing a club's members and seating, moving or removing a student in their place
// (README Phase 2, PR 3a). Same shape as registrations.ts: each write runs inside the caller's
// transaction, takes the club's round lock first (CLAUDE.md rule 3), then idempotency, then the
// rules as conditions of the writing statements, and promotes the waitlist last when it freed a
// seat. The admin is the actor of every event it writes, promotions included.
//
// What differs from a student's own writes, on purpose (README PR 3a):
// - Any round status: upcoming, open or closed. Fixing the lists after the round closed is the
//   main use, so there is no window check. The promote engine still decides by the DB clock and
//   promotes nobody once the round has closed.
// - The seat is taken with `registered < capacity` alone, without register's "nobody waiting"
//   condition: until the round closes a club with waiters is always full anyway (the engine hands
//   on every free seat), and after it closed an admin may fill a free seat even though stale
//   entries remain. A full club is 409 club_full; the admin raises capacity first (PATCH club),
//   which promotes the waiters before anyone else gets the seat. No auto-raise.
// - The student is named by login ID and must be a student in the club's round's grade; there is
//   no "round the student is shown" rule, since an admin works on any round of the grade.

export const MEMBER_OUTCOMES = Object.freeze({
  // A new seat was taken (the student held none in the round).
  assigned: 'assigned',
  // The student's seat moved here from another club of the round.
  moved: 'moved',
  // The student already held this very club: nothing written.
  alreadyHeld: 'already_held',
  removed: 'removed',
  // The key was used by this same request before: nothing written, current state returned.
  replayed: 'replayed',
} as const);

export type MemberOutcome = (typeof MEMBER_OUTCOMES)[keyof typeof MEMBER_OUTCOMES];

// An admin's keyed requests for a student: seating, removing, and removing a waitlist entry
// (club-waitlist.ts), which shares these helpers and the admin's key space.
export type AdminEventType = 'admin_assign' | 'admin_remove' | 'waitlist_leave';

export type MemberWriteResult = {
  outcome: MemberOutcome;
  roundId: number;
  clubId: number;
  studentId: number;
  // Only for a move: the club the seat left.
  fromClubId?: number;
  // Students the freed seat promoted off a waitlist, in order (ids only, for the log).
  promotions: Promotion[];
  // The club and the student's seat in it after the request and every promotion it caused.
  club: ClubSeats;
  member: ClubMember | null;
};

type ClubSeatsRow = {
  id: number;
  round_id: number;
  club_code: string;
  name: string;
  capacity: number;
  registered: number;
};

type MemberRow = {
  student_id: number;
  login_id: string;
  full_name: string;
  grade: number;
  classroom: string;
  seat_no: number;
  created_at: Date;
  source_event: string | null;
};

const SOURCE_BY_EVENT: Readonly<Record<string, ClubMemberSource>> = Object.freeze({
  register: 'student',
  change: 'student',
  waitlist_promote: 'waitlist',
  admin_assign: 'admin',
});

// The one place snake_case rows become the API shape.
export const toClubSeats = (row: ClubSeatsRow): ClubSeats => ({
  id: row.id,
  roundId: row.round_id,
  clubCode: row.club_code,
  name: row.name,
  capacity: row.capacity,
  registered: row.registered,
  remaining: row.capacity - row.registered,
});

const toMember = (row: MemberRow): ClubMember => ({
  studentId: row.student_id,
  loginId: row.login_id,
  fullName: row.full_name,
  classroom: row.classroom,
  seatNo: row.seat_no,
  registeredAt: row.created_at.toISOString(),
  source: SOURCE_BY_EVENT[row.source_event ?? ''] ?? null,
});

// The export order (name-lists.ts): grade, classroom, seat number, then login ID for a tie. A
// club's members share the round's grade until it closes; after that an import may have moved
// some up, and they then sort after the rest, as on the per-club export.
const compareMembers = (a: MemberRow, b: MemberRow): number =>
  a.grade - b.grade ||
  compareClassrooms(a.classroom, b.classroom) ||
  a.seat_no - b.seat_no ||
  a.login_id.localeCompare(b.login_id);

export const findClubSeats = async (
  db: Queryable,
  clubId: number,
): Promise<ClubSeatsRow | undefined> => {
  const { rows } = await db.query<ClubSeatsRow>(
    'SELECT id, round_id, club_code, name, capacity, registered FROM clubs WHERE id = $1',
    [clubId],
  );
  return rows[0];
};

// source_event: the student's latest event in the round that moved one of their seats (not a
// waitlist join or leave), by id like findRegistration in student-round.ts, since one
// transaction's events share created_at. For a student holding a seat that is the event that gave
// it (the invariant checker's "latest seat event" rule). studentId null = every member.
const findMembers = async (
  db: Queryable,
  clubId: number,
  studentId: number | null,
): Promise<MemberRow[]> => {
  const { rows } = await db.query<MemberRow>(
    `SELECT r.student_id, u.login_id, u.full_name, sp.grade, sp.classroom, sp.seat_no,
            r.created_at,
            (SELECT e.event_type FROM registration_events e
             WHERE e.round_id = r.round_id AND e.student_id = r.student_id
               AND e.event_type NOT IN ('waitlist_join', 'waitlist_leave')
             ORDER BY e.id DESC
             LIMIT 1) AS source_event
     FROM registrations r
     JOIN users u ON u.id = r.student_id
     JOIN student_profiles sp ON sp.user_id = r.student_id
     WHERE r.club_id = $1 AND ($2::int IS NULL OR r.student_id = $2)`,
    [clubId, studentId],
  );
  return rows;
};

// Read-only: one snapshot, so the counts always match the members listed with them, even while
// students are registering.
export const listClubMembers = async (
  pool: pg.Pool,
  clubId: number,
): Promise<{ club: ClubSeats; members: ClubMember[] }> =>
  await withReadOnlySnapshot(pool, async (client) => {
    const club = await findClubSeats(client, clubId);
    if (!club) throw new AppError(ERROR_CODES.notFound, 'Club not found');
    const members = await findMembers(client, clubId, null);
    return { club: toClubSeats(club), members: [...members].sort(compareMembers).map(toMember) };
  });

// The answer of every write, read after its promotions: a cascade can move the student out of
// this club again (e.g. moved here while waiting for W, and W's seat freed by the cascade), and
// move holders of this club out, so neither the member nor the counts can be derived.
const readAnswer = async (
  db: pg.PoolClient,
  clubId: number,
  studentId: number,
): Promise<{ club: ClubSeats; member: ClubMember | null }> => {
  const club = await findClubSeats(db, clubId);
  // The lock found the club and the app cannot delete clubs, so this is a broken invariant.
  if (!club) throw new Error('Club vanished under its round lock');
  const [member] = await findMembers(db, clubId, studentId);
  return { club: toClubSeats(club), member: member ? toMember(member) : null };
};

type AdminPriorEvent = {
  event_type: string;
  round_id: number;
  club_id: number | null;
  student_id: number;
  login_id: string;
};

// The admin's own keys only (actor = this admin): a student's key, or another admin's, never
// collides with it, as UNIQUE (actor_id, idempotency_key) has it. The student comes along by login
// ID, so the replay is decided right after the lock, before the body's login ID is resolved.
export const findAdminPriorEvent = async (
  db: pg.PoolClient,
  adminId: number,
  idempotencyKey: string,
): Promise<AdminPriorEvent | undefined> => {
  const { rows } = await db.query<AdminPriorEvent>(
    `SELECT e.event_type, e.round_id, e.club_id, e.student_id, u.login_id
     FROM registration_events e
     JOIN users u ON u.id = e.student_id
     WHERE e.actor_id = $1 AND e.idempotency_key = $2`,
    [adminId, idempotencyKey],
  );
  return rows[0];
};

// Same request = same type, same club and same student. Anything else reusing the key is 409
// idempotency_key_reused: another student or club, or another kind of admin request (an assign's
// key sent to remove, or to the waitlist removal, and the other way round). Only committed
// requests leave an event, so a refused one (club_full) may be retried with its key.
export const assertSameAdminRequest = (
  prior: AdminPriorEvent,
  request: { eventType: AdminEventType; clubId: number; loginId: string },
): void => {
  const sameRequest =
    prior.event_type === request.eventType &&
    prior.club_id === request.clubId &&
    prior.login_id === request.loginId;
  if (!sameRequest) throw new AppError(ERROR_CODES.idempotencyKeyReused);
};

const replayPriorEvent = async (
  db: pg.PoolClient,
  prior: AdminPriorEvent,
  request: { eventType: AdminEventType; clubId: number; loginId: string },
): Promise<MemberWriteResult> => {
  assertSameAdminRequest(prior, request);
  return {
    outcome: MEMBER_OUTCOMES.replayed,
    roundId: prior.round_id,
    clubId: request.clubId,
    studentId: prior.student_id,
    promotions: [],
    ...(await readAnswer(db, request.clubId, prior.student_id)),
  };
};

type StudentRow = { id: number; grade: number };

// A student account with a profile, by login ID. Unknown login, an admin's login and a student
// account with no profile (made by hand; it can hold no seat, registrations reference profiles)
// are all 404: student_profile_missing is a 403 worded for the student themself.
//
// FOR SHARE OF the profile, as register's lockStudentProfile: it holds the grade still until
// commit against an import moving the student to another grade, which either commits first (and
// the grade check below sees the new grade) or waits for this transaction. A remove (of a seat or
// of a waitlist entry), which decides nothing by grade, takes no row lock.
export const findStudent = async (
  db: pg.PoolClient,
  loginId: string,
  { lockProfile }: { lockProfile: boolean },
): Promise<StudentRow> => {
  const { rows } = await db.query<StudentRow>(
    `SELECT u.id, sp.grade
     FROM users u
     JOIN student_profiles sp ON sp.user_id = u.id
     WHERE u.login_id = $1 AND u.role = 'student'
     ${lockProfile ? 'FOR SHARE OF sp' : ''}`,
    [loginId],
  );
  const student = rows[0];
  if (!student) throw new AppError(ERROR_CODES.notFound, 'Student not found');
  return student;
};

const findRoundGrade = async (db: pg.PoolClient, roundId: number): Promise<number> => {
  const { rows } = await db.query<{ grade: number }>('SELECT grade FROM rounds WHERE id = $1', [
    roundId,
  ]);
  const round = rows[0];
  // A club's round cannot be deleted while the club exists (foreign key).
  if (!round) throw new Error('Round of a locked club is missing');
  return round.grade;
};

const findHeldClub = async (
  db: pg.PoolClient,
  roundId: number,
  studentId: number,
): Promise<number | null> => {
  const { rows } = await db.query<{ club_id: number }>(
    'SELECT club_id FROM registrations WHERE round_id = $1 AND student_id = $2',
    [roundId, studentId],
  );
  return rows[0]?.club_id ?? null;
};

// The seat itself, guarded by the clubs CHECK's own bound (CLAUDE.md rule 1). 0 rows = full; the
// caller's throw rolls back the transaction. No waitlist condition: see the top of this file.
const takeSeat = async (db: pg.PoolClient, roundId: number, clubId: number): Promise<void> => {
  const { rowCount } = await db.query(
    `UPDATE clubs SET registered = registered + 1
     WHERE id = $1 AND round_id = $2 AND registered < capacity`,
    [clubId, roundId],
  );
  if (rowCount === 0) throw new AppError(ERROR_CODES.clubFull);
};

// A student cannot both hold and wait for one club (the engine treats it as a broken invariant),
// so seating them in the club they waited for ends that entry, in this transaction. An entry for
// another club stays: holding one club and waiting for another is allowed (README Phase 2
// decision 1). Only reachable once the round has closed (until then a club with waiters is full).
// No event of its own: the admin_assign into the club is the record of it, and UNIQUE (actor_id,
// idempotency_key) allows one keyed event per request (README PR 3a).
const endEntryForClub = async (
  db: pg.PoolClient,
  { roundId, studentId, clubId }: { roundId: number; studentId: number; clubId: number },
): Promise<void> => {
  await db.query(
    'DELETE FROM waitlist_entries WHERE round_id = $1 AND student_id = $2 AND club_id = $3',
    [roundId, studentId, clubId],
  );
};

type AdminEventInput = {
  roundId: number;
  studentId: number;
  clubId: number;
  fromClubId?: number | null;
  eventType: AdminEventType;
  adminId: number;
  idempotencyKey: string;
};

// The admin is the actor (registrations.ts insertEvent is the student's own request).
export const insertAdminEvent = async (
  db: pg.PoolClient,
  {
    roundId,
    studentId,
    clubId,
    fromClubId = null,
    eventType,
    adminId,
    idempotencyKey,
  }: AdminEventInput,
): Promise<void> => {
  try {
    await db.query(
      `INSERT INTO registration_events
         (round_id, student_id, club_id, from_club_id, event_type, actor_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [roundId, studentId, clubId, fromClubId, eventType, adminId, idempotencyKey],
    );
  } catch (error) {
    // Under the round lock two requests with one key only both pass the lookup when they are in
    // different rounds, which makes them different requests.
    if (isPgError(error, PG_ERROR_CODES.uniqueViolation, EVENT_KEY_UNIQUE)) {
      throw new AppError(ERROR_CODES.idempotencyKeyReused);
    }
    throw error;
  }
};

export type MemberWriteInput = {
  adminId: number;
  clubId: number;
  loginId: string;
  idempotencyKey: string;
};

// Seats the student in the club, moving them from the club they hold in the round if any. The
// order of answers, each decided under the round lock:
//
//   404 unknown club → replay (200) / 409 idempotency_key_reused → 404 unknown student → 409
//   student_not_in_round_grade → 200 already_held (written nothing) → 409 club_full → write.
//
// A move takes the new seat before giving back the old one (like a student's change, so a full
// club leaves the student where they were), writes one admin_assign with from_club_id = the club
// left, and promotes the waitlist: the old club has a free seat now. A fresh seat frees none, so
// it runs no promotion (and so never promotes in other clubs under this admin's name).
export const assignMember = async (
  db: pg.PoolClient,
  { adminId, clubId, loginId, idempotencyKey }: MemberWriteInput,
): Promise<MemberWriteResult> => {
  const roundId = await lockRoundOfClub(db, clubId);
  if (roundId === undefined) throw new AppError(ERROR_CODES.notFound, 'Club not found');

  const prior = await findAdminPriorEvent(db, adminId, idempotencyKey);
  if (prior) {
    return await replayPriorEvent(db, prior, { eventType: 'admin_assign', clubId, loginId });
  }

  const student = await findStudent(db, loginId, { lockProfile: true });
  if (student.grade !== (await findRoundGrade(db, roundId))) {
    throw new AppError(ERROR_CODES.studentNotInRoundGrade);
  }

  const heldClubId = await findHeldClub(db, roundId, student.id);
  if (heldClubId === clubId) {
    return {
      outcome: MEMBER_OUTCOMES.alreadyHeld,
      roundId,
      clubId,
      studentId: student.id,
      promotions: [],
      ...(await readAnswer(db, clubId, student.id)),
    };
  }

  await takeSeat(db, roundId, clubId);
  if (heldClubId === null) {
    await db.query(
      'INSERT INTO registrations (round_id, student_id, club_id) VALUES ($1, $2, $3)',
      [roundId, student.id, clubId],
    );
  } else {
    await releaseSeat(db, roundId, heldClubId);
    await moveRegistration(db, { roundId, studentId: student.id, fromClubId: heldClubId, clubId });
  }
  await endEntryForClub(db, { roundId, studentId: student.id, clubId });
  await insertAdminEvent(db, {
    roundId,
    studentId: student.id,
    clubId,
    fromClubId: heldClubId,
    eventType: 'admin_assign',
    adminId,
    idempotencyKey,
  });
  const promotions =
    heldClubId === null ? [] : await promoteWaitlist(db, { roundId, actorId: adminId });
  return {
    outcome: heldClubId === null ? MEMBER_OUTCOMES.assigned : MEMBER_OUTCOMES.moved,
    roundId,
    clubId,
    studentId: student.id,
    ...(heldClubId === null ? {} : { fromClubId: heldClubId }),
    promotions,
    ...(await readAnswer(db, clubId, student.id)),
  };
};

// Removes the student's seat in this club. Order, under the round lock:
//
//   404 unknown club → replay (200) / 409 idempotency_key_reused → 404 unknown student → 409
//   not_registered (the student holds no seat in this club) → write.
//
// No grade check: after a round closed an import may have moved the student up a grade, and
// removing that old seat is exactly the kind of fix this is for. The freed seat promotes the
// club's oldest waiter while the round has not closed (the engine decides by the DB clock).
export const removeMember = async (
  db: pg.PoolClient,
  { adminId, clubId, loginId, idempotencyKey }: MemberWriteInput,
): Promise<MemberWriteResult> => {
  const roundId = await lockRoundOfClub(db, clubId);
  if (roundId === undefined) throw new AppError(ERROR_CODES.notFound, 'Club not found');

  const prior = await findAdminPriorEvent(db, adminId, idempotencyKey);
  if (prior) {
    return await replayPriorEvent(db, prior, { eventType: 'admin_remove', clubId, loginId });
  }

  const student = await findStudent(db, loginId, { lockProfile: false });
  const { rowCount } = await db.query(
    'DELETE FROM registrations WHERE round_id = $1 AND student_id = $2 AND club_id = $3',
    [roundId, student.id, clubId],
  );
  if (rowCount === 0) {
    throw new AppError(ERROR_CODES.notRegistered, 'The student holds no seat in this club');
  }

  await releaseSeat(db, roundId, clubId);
  await insertAdminEvent(db, {
    roundId,
    studentId: student.id,
    clubId,
    eventType: 'admin_remove',
    adminId,
    idempotencyKey,
  });
  const promotions = await promoteWaitlist(db, { roundId, actorId: adminId });
  return {
    outcome: MEMBER_OUTCOMES.removed,
    roundId,
    clubId,
    studentId: student.id,
    promotions,
    ...(await readAnswer(db, clubId, student.id)),
  };
};
