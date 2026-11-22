import { ERROR_CODES } from '@club-registration/shared';
import type {
  StudentAdminChange,
  StudentClub,
  StudentClubsResponse,
  StudentRegistration,
  StudentRound,
  StudentRoundResponse,
  StudentWaitlist,
} from '@club-registration/shared';
import type pg from 'pg';
import { dbNow, withReadOnlySnapshot } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import { ADVISOR_NAMES_JOIN } from './clubs.js';
import type { AdmissionGate } from './registrations.js';
import { roundStatusAt } from './rounds.js';

// What a student sees of their own grade's round. Every function takes the student id from the
// caller, which takes it from the session; nothing here accepts a grade or a round from a client.
// Club rows never carry advisors' contact columns (see ADVISOR_NAMES_JOIN).

type StudentRoundRow = {
  id: number;
  term: string;
  grade: number;
  opens_at: Date;
  closes_at: Date;
  has_queue: boolean;
};

export type RegistrationRow = {
  club_id: number;
  club_code: string;
  club_name: string;
  created_at: Date;
  promoted_from_waitlist: boolean;
};

type WaitlistRow = {
  club_id: number;
  club_code: string;
  club_name: string;
  created_at: Date;
  position: number;
};

// The club an admin_assign moved the student from: all three set, or (a fresh seat, a removal, a
// waitlist removal) all three null.
type FromClubColumns =
  | { from_club_id: number; from_club_code: string; from_club_name: string }
  | { from_club_id: null; from_club_code: null; from_club_name: null };

type AdminChangeRow = {
  event_type: 'admin_assign' | 'admin_remove' | 'waitlist_leave';
  created_at: Date;
  club_id: number;
  club_code: string;
  club_name: string;
} & FromClubColumns;

type StudentClubRow = {
  id: number;
  club_code: string;
  name: string;
  description: string;
  capacity: number;
  registered: number;
  advisor_names: string[];
  waitlist_count: number;
};

// The one place snake_case rows become the API shape. Status uses the same half-open window as
// the admin round list, from the same `now` the round was picked with.
const toStudentRound = (row: StudentRoundRow, now: Date): StudentRound => ({
  id: row.id,
  term: row.term,
  grade: row.grade,
  opensAt: row.opens_at.toISOString(),
  closesAt: row.closes_at.toISOString(),
  status: roundStatusAt({ opensAt: row.opens_at, closesAt: row.closes_at }, now),
  hasQueue: row.has_queue,
});

export const toRegistration = (row: RegistrationRow): StudentRegistration => ({
  club: { id: row.club_id, clubCode: row.club_code, name: row.club_name },
  registeredAt: row.created_at.toISOString(),
  promotedFromWaitlist: row.promoted_from_waitlist,
});

const toWaitlist = (row: WaitlistRow): StudentWaitlist => ({
  club: { id: row.club_id, clubCode: row.club_code, name: row.club_name },
  position: row.position,
  joinedAt: row.created_at.toISOString(),
});

const toAdminChange = (row: AdminChangeRow): StudentAdminChange => {
  const club = { id: row.club_id, clubCode: row.club_code, name: row.club_name };
  const at = row.created_at.toISOString();
  switch (row.event_type) {
    case 'admin_assign':
      return row.from_club_id === null
        ? { kind: 'assigned', club, at }
        : {
            kind: 'moved',
            club,
            fromClub: {
              id: row.from_club_id,
              clubCode: row.from_club_code,
              name: row.from_club_name,
            },
            at,
          };
    case 'admin_remove':
      return { kind: 'removed', club, at };
    case 'waitlist_leave':
      return { kind: 'waitlist_removed', club, at };
  }
};

const toStudentClub = (row: StudentClubRow): StudentClub => ({
  id: row.id,
  clubCode: row.club_code,
  name: row.name,
  description: row.description,
  capacity: row.capacity,
  registered: row.registered,
  remaining: row.capacity - row.registered,
  advisorNames: row.advisor_names,
  waitlistCount: row.waitlist_count,
});

// Every account the import creates gets a profile in the same transaction, so a student without
// one was made some other way (by hand, or a broken import). Such an account cannot register at
// all (registrations reference student_profiles), so it gets a distinct 403 that tells the student
// to ask an admin, instead of `round: null`, which would claim their grade simply has no round.
export const findStudentGrade = async (db: Queryable, studentId: number): Promise<number> => {
  const { rows } = await db.query<{ grade: number }>(
    'SELECT grade FROM student_profiles WHERE user_id = $1',
    [studentId],
  );
  const profile = rows[0];
  if (!profile) throw new AppError(ERROR_CODES.studentProfileMissing);
  return profile.grade;
};

// Exactly one round of the grade, or none: the one open at `at`; else the upcoming one that opens
// soonest; else the one that closed last, so a student can still see their result. Ties only
// happen when an admin lets two terms' windows overlap; then the open round closing soonest wins
// (the most urgent), and id keeps the choice stable. The window is half-open, as in
// roundStatusAt. `at` and `alias` are always constants in this module (a parameter placeholder or
// a DB clock function, and a table alias), never input. Writes use the same order with the DB
// clock, so a student can only write to the round they are shown (see registrations.ts).
export const roundSelectionOrder = (at: string, alias: string): string => `
  CASE
    WHEN ${at} < ${alias}.opens_at THEN 1
    WHEN ${at} < ${alias}.closes_at THEN 0
    ELSE 2
  END,
  CASE WHEN ${at} < ${alias}.opens_at THEN ${alias}.opens_at END,
  CASE WHEN ${at} >= ${alias}.closes_at THEN ${alias}.closes_at END DESC,
  ${alias}.closes_at,
  ${alias}.id`;

export const selectStudentRound = async (
  db: Queryable,
  grade: number,
  now: Date,
): Promise<StudentRound | undefined> => {
  const { rows } = await db.query<StudentRoundRow>(
    `SELECT r.id, r.term, r.grade, r.opens_at, r.closes_at, r.max_active IS NOT NULL AS has_queue
     FROM rounds r
     WHERE r.grade = $1
     ORDER BY ${roundSelectionOrder('$2::timestamptz', 'r')}
     LIMIT 1`,
    [grade, now],
  );
  const row = rows[0];
  return row && toStudentRound(row, now);
};

// The one source of a registration in every answer, reads and writes alike. promotedFromWaitlist
// comes from the event log: the student's latest event in the round that moved one of their
// seats (anything but a waitlist join or leave) is a waitlist_promote. Events are ordered by id,
// not created_at: a cancel and the promotions it causes share one transaction and so one now().
export const findRegistration = async (
  db: Queryable,
  roundId: number,
  studentId: number,
): Promise<StudentRegistration | null> => {
  const { rows } = await db.query<RegistrationRow>(
    `SELECT c.id AS club_id, c.club_code, c.name AS club_name, r.created_at,
            COALESCE((
              SELECT e.event_type = 'waitlist_promote'
              FROM registration_events e
              WHERE e.round_id = r.round_id AND e.student_id = r.student_id
                AND e.event_type NOT IN ('waitlist_join', 'waitlist_leave')
              ORDER BY e.id DESC
              LIMIT 1
            ), false) AS promoted_from_waitlist
     FROM registrations r
     JOIN clubs c ON c.id = r.club_id
     WHERE r.round_id = $1 AND r.student_id = $2`,
    [roundId, studentId],
  );
  const row = rows[0];
  return row ? toRegistration(row) : null;
};

// The student's waitlist entry in the round, if any. Queue order is (created_at, id) everywhere
// (README Phase 2): position = 1 + the entries of the same club ordered before this one, read with
// the (club_id, round_id, created_at, id) index.
export const findWaitlist = async (
  db: Queryable,
  roundId: number,
  studentId: number,
): Promise<StudentWaitlist | null> => {
  const { rows } = await db.query<WaitlistRow>(
    `SELECT c.id AS club_id, c.club_code, c.name AS club_name, w.created_at,
            1 + (
              SELECT count(*)::int FROM waitlist_entries a
              WHERE a.club_id = w.club_id AND a.round_id = w.round_id
                AND (a.created_at, a.id) < (w.created_at, w.id)
            ) AS position
     FROM waitlist_entries w
     JOIN clubs c ON c.id = w.club_id
     WHERE w.round_id = $1 AND w.student_id = $2`,
    [roundId, studentId],
  );
  const row = rows[0];
  return row ? toWaitlist(row) : null;
};

// What an admin last did to the student in the round (README Phase 4, P3), from the event log
// like promotedFromWaitlist: the student's latest event in the round of any type, by id (one
// transaction's events share created_at), and only then whether it is an admin's seat, move,
// removal or waitlist removal. The order matters: picking the latest admin event instead would
// keep the notice after the student's own register, cancel, change, join or leave, by which time
// they know their state. A waitlist_promote is never one, whoever freed the seat (an admin's
// remove or move promotes under the admin's id): promotedFromWaitlist tells it. A waitlist_leave
// is the admin's only when someone other than the student wrote it (club-waitlist.ts); admin_*
// events always have an admin actor, but the check costs nothing. The actor is compared in SQL
// and never selected, so no admin id, name or login can reach the answer.
export const findAdminChange = async (
  db: Queryable,
  roundId: number,
  studentId: number,
): Promise<StudentAdminChange | null> => {
  const { rows } = await db.query<AdminChangeRow>(
    `SELECT e.event_type, e.created_at,
            c.id AS club_id, c.club_code, c.name AS club_name,
            f.id AS from_club_id, f.club_code AS from_club_code, f.name AS from_club_name
     FROM (
       SELECT event_type, club_id, from_club_id, actor_id, student_id, created_at
       FROM registration_events
       WHERE round_id = $1 AND student_id = $2
       ORDER BY id DESC
       LIMIT 1
     ) e
     JOIN clubs c ON c.id = e.club_id
     LEFT JOIN clubs f ON f.id = e.from_club_id
     WHERE e.actor_id <> e.student_id
       AND e.event_type IN ('admin_assign', 'admin_remove', 'waitlist_leave')`,
    [roundId, studentId],
  );
  const row = rows[0];
  return row ? toAdminChange(row) : null;
};

const listClubs = async (db: Queryable, roundId: number): Promise<StudentClub[]> => {
  const { rows } = await db.query<StudentClubRow>(
    `SELECT c.id, c.club_code, c.name, c.description, c.capacity, c.registered,
            COALESCE(advisor_names.names, '{}') AS advisor_names,
            (SELECT count(*)::int FROM waitlist_entries w
             WHERE w.club_id = c.id AND w.round_id = c.round_id) AS waitlist_count
     FROM clubs c
     ${ADVISOR_NAMES_JOIN}
     WHERE c.round_id = $1
     ORDER BY c.club_code, c.id`,
    [roundId],
  );
  return rows.map(toStudentClub);
};

const readSelection = async (
  db: Queryable,
  studentId: number,
  now: Date,
): Promise<StudentRoundResponse> => {
  const grade = await findStudentGrade(db, studentId);
  const round = await selectStudentRound(db, grade, now);
  if (!round) return { round: null, registration: null, waitlist: null, adminChange: null };
  return {
    round,
    registration: await findRegistration(db, round.id, studentId),
    waitlist: await findWaitlist(db, round.id, studentId),
    adminChange: await findAdminChange(db, round.id, studentId),
  };
};

// Each read runs in one read-only snapshot, so the round, the student's registration, their
// waitlist place, what an admin last did and the club counts all describe the same moment, even
// while others write. The round is picked, and its status decided, by the DB clock, as the writes
// and the queue's join pick it (Q2): the web joins the queue when this says open, and the club
// list's gate below asks for a ticket when it says open, so the three must never disagree about
// "open" at a window edge (a web page told "open" by one and "not open" by the other would go
// round in circles).
export const readStudentRound = async (
  pool: pg.Pool,
  studentId: number,
): Promise<StudentRoundResponse> =>
  await withReadOnlySnapshot(
    pool,
    async (client) => await readSelection(client, studentId, await dbNow(client)),
  );

// The club list is what a queue turn is for (README Phase 3, decision 1): while the round is open
// by that same DB clock, `gate` must pass (403 queue_required without a live admitted ticket).
// An upcoming or closed round, or none at all, is listed to anyone, as before the queue: nothing
// can be taken from it. So is a round without a queue (max_active NULL, Q4): hasQueue comes from
// the same REPEATABLE READ snapshot as the gate's own read of max_active, so the answer's
// hasQueue and whether the list was gated always agree, whatever an admin commits meanwhile.
export const listStudentClubs = async (
  pool: pg.Pool,
  studentId: number,
  gate: AdmissionGate,
): Promise<StudentClubsResponse> =>
  await withReadOnlySnapshot(pool, async (client) => {
    const selection = await readSelection(client, studentId, await dbNow(client));
    if (selection.round?.status === 'open' && selection.round.hasQueue) {
      await gate(client, selection.round.id);
    }
    const clubs = selection.round ? await listClubs(client, selection.round.id) : [];
    return { ...selection, clubs };
  });
