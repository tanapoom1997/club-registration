import { ERROR_CODES } from '@club-registration/shared';
import type {
  StudentClub,
  StudentClubsResponse,
  StudentRegistration,
  StudentRound,
  StudentRoundResponse,
} from '@club-registration/shared';
import type pg from 'pg';
import { withReadOnlySnapshot } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import { ADVISOR_NAMES_JOIN } from './clubs.js';
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
};

type RegistrationRow = {
  club_id: number;
  club_code: string;
  club_name: string;
  created_at: Date;
};

type StudentClubRow = {
  id: number;
  club_code: string;
  name: string;
  description: string;
  capacity: number;
  registered: number;
  advisor_names: string[];
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
});

const toRegistration = (row: RegistrationRow): StudentRegistration => ({
  club: { id: row.club_id, clubCode: row.club_code, name: row.club_name },
  registeredAt: row.created_at.toISOString(),
});

const toStudentClub = (row: StudentClubRow): StudentClub => ({
  id: row.id,
  clubCode: row.club_code,
  name: row.name,
  description: row.description,
  capacity: row.capacity,
  registered: row.registered,
  remaining: row.capacity - row.registered,
  advisorNames: row.advisor_names,
});

// Every account the import creates gets a profile in the same transaction, so a student without
// one was made some other way (by hand, or a broken import). Such an account cannot register at
// all (registrations reference student_profiles), so it gets a distinct 403 that tells the student
// to ask an admin, instead of `round: null`, which would claim their grade simply has no round.
const findStudentGrade = async (db: Queryable, studentId: number): Promise<number> => {
  const { rows } = await db.query<{ grade: number }>(
    'SELECT grade FROM student_profiles WHERE user_id = $1',
    [studentId],
  );
  const profile = rows[0];
  if (!profile) throw new AppError(ERROR_CODES.studentProfileMissing);
  return profile.grade;
};

// Exactly one round of the grade, or none: the one open now; else the upcoming one that opens
// soonest; else the one that closed last, so a student can still see their result. Ties only
// happen when an admin lets two terms' windows overlap; then the open round closing soonest wins
// (the most urgent), and id keeps the choice stable. The window is half-open, as in
// roundStatusAt.
const selectStudentRound = async (
  db: Queryable,
  grade: number,
  now: Date,
): Promise<StudentRound | undefined> => {
  const { rows } = await db.query<StudentRoundRow>(
    `SELECT id, term, grade, opens_at, closes_at
     FROM rounds
     WHERE grade = $1
     ORDER BY
       CASE
         WHEN $2::timestamptz < opens_at THEN 1
         WHEN $2::timestamptz < closes_at THEN 0
         ELSE 2
       END,
       CASE WHEN $2::timestamptz < opens_at THEN opens_at END,
       CASE WHEN $2::timestamptz >= closes_at THEN closes_at END DESC,
       closes_at,
       id
     LIMIT 1`,
    [grade, now],
  );
  const row = rows[0];
  return row && toStudentRound(row, now);
};

const findRegistration = async (
  db: Queryable,
  roundId: number,
  studentId: number,
): Promise<StudentRegistration | null> => {
  const { rows } = await db.query<RegistrationRow>(
    `SELECT c.id AS club_id, c.club_code, c.name AS club_name, r.created_at
     FROM registrations r
     JOIN clubs c ON c.id = r.club_id
     WHERE r.round_id = $1 AND r.student_id = $2`,
    [roundId, studentId],
  );
  const row = rows[0];
  return row ? toRegistration(row) : null;
};

const listClubs = async (db: Queryable, roundId: number): Promise<StudentClub[]> => {
  const { rows } = await db.query<StudentClubRow>(
    `SELECT c.id, c.club_code, c.name, c.description, c.capacity, c.registered,
            COALESCE(advisor_names.names, '{}') AS advisor_names
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
  if (!round) return { round: null, registration: null };
  return { round, registration: await findRegistration(db, round.id, studentId) };
};

// Each read runs in one read-only snapshot, so the round, the student's registration and the
// club counts all describe the same moment, even while others are registering.
export const readStudentRound = async (
  pool: pg.Pool,
  studentId: number,
  now: Date,
): Promise<StudentRoundResponse> =>
  await withReadOnlySnapshot(pool, async (client) => await readSelection(client, studentId, now));

export const listStudentClubs = async (
  pool: pg.Pool,
  studentId: number,
  now: Date,
): Promise<StudentClubsResponse> =>
  await withReadOnlySnapshot(pool, async (client) => {
    const selection = await readSelection(client, studentId, now);
    const clubs = selection.round ? await listClubs(client, selection.round.id) : [];
    return { ...selection, clubs };
  });
