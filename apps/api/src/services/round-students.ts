import { ERROR_CODES } from '@club-registration/shared';
import type { ClubRef, RoundStudent, RoundStudentsResponse } from '@club-registration/shared';
import type pg from 'pg';
import { withReadOnlySnapshot } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import { compareClassrooms } from './classroom-order.js';

// Every student an admin can seat in a round, with where each stands in it, so the members panel
// can find a student by name or classroom (the admin rarely knows the code). The same students
// assign accepts (club-members.ts findStudent): student accounts with a profile in the round's
// grade. That is the student's current grade, so after an import moves a grade on, members of
// the closed round's old grade are no longer listed here (the club's member list still has them).

type RoundStudentRow = {
  login_id: string;
  full_name: string;
  classroom: string;
  seat_no: number;
  club_id: number | null;
  club_code: string | null;
  club_name: string | null;
  waiting_club_id: number | null;
  waiting_club_code: string | null;
  waiting_club_name: string | null;
};

const clubRef = (
  id: number | null,
  clubCode: string | null,
  name: string | null,
): ClubRef | null =>
  id === null || clubCode === null || name === null ? null : { id, clubCode, name };

// The one place snake_case rows become the API shape.
const toRoundStudent = (row: RoundStudentRow): RoundStudent => ({
  loginId: row.login_id,
  fullName: row.full_name,
  classroom: row.classroom,
  seatNo: row.seat_no,
  club: clubRef(row.club_id, row.club_code, row.club_name),
  waitingFor: clubRef(row.waiting_club_id, row.waiting_club_code, row.waiting_club_name),
});

// The export order (name-lists.ts). Sorted here, not in SQL: the DB collation is not numeric-aware,
// so "10" would come before "2".
const compareStudents = (a: RoundStudentRow, b: RoundStudentRow): number =>
  compareClassrooms(a.classroom, b.classroom) ||
  a.seat_no - b.seat_no ||
  a.login_id.localeCompare(b.login_id);

// One statement for the whole grade (~450 students), no query per student: student_profiles_grade_idx
// covers the grade and each UNIQUE (round_id, student_id) the seat and the waitlist entry (not
// checked with EXPLAIN on a full-size grade yet). A student has at most one of each per round, so
// the left joins add no rows.
const findRoundStudents = async (
  db: Queryable,
  { roundId, grade }: { roundId: number; grade: number },
): Promise<RoundStudentRow[]> => {
  const { rows } = await db.query<RoundStudentRow>(
    `SELECT u.login_id, u.full_name, sp.classroom, sp.seat_no,
            rc.id AS club_id, rc.club_code, rc.name AS club_name,
            wc.id AS waiting_club_id, wc.club_code AS waiting_club_code,
            wc.name AS waiting_club_name
     FROM student_profiles sp
     JOIN users u ON u.id = sp.user_id
     LEFT JOIN registrations r ON r.round_id = $1 AND r.student_id = sp.user_id
     LEFT JOIN clubs rc ON rc.id = r.club_id
     LEFT JOIN waitlist_entries w ON w.round_id = $1 AND w.student_id = sp.user_id
     LEFT JOIN clubs wc ON wc.id = w.club_id
     WHERE sp.grade = $2 AND u.role = 'student'`,
    [roundId, grade],
  );
  return rows;
};

// Read-only: one snapshot, so a student moved between clubs mid-read shows in one place only.
export const listRoundStudents = async (
  pool: pg.Pool,
  roundId: number,
): Promise<RoundStudentsResponse> =>
  await withReadOnlySnapshot(pool, async (client) => {
    const { rows } = await client.query<{ grade: number }>(
      'SELECT grade FROM rounds WHERE id = $1',
      [roundId],
    );
    const round = rows[0];
    if (!round) throw new AppError(ERROR_CODES.notFound, 'Round not found');
    const students = await findRoundStudents(client, { roundId, grade: round.grade });
    return { students: [...students].sort(compareStudents).map(toRoundStudent) };
  });
