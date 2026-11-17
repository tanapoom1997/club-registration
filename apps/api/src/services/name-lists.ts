import { ERROR_CODES } from '@club-registration/shared';
import type { RoundClassroom, RoundClassroomsResponse } from '@club-registration/shared';
import type pg from 'pg';
import { withReadOnlySnapshot } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import { compareClassrooms } from './classroom-order.js';
import { ADVISOR_NAMES_JOIN } from './clubs.js';
import { findRound } from './rounds.js';

// Name lists for teachers (README "Export รายชื่อ"). Each export reads everything in one read-only
// snapshot, so the counts in a sheet header always match the rows under it, even while students
// are registering.
//
// Advisors' contact columns (phone, email, LINE) are never selected here: the per-club list
// carries advisor names only and the per-classroom list no advisor data at all.
//
// A student is listed with their current profile (grade, classroom, seat). The import refuses to
// move a student who registered in a term to another grade, so the per-club and per-classroom
// lists of a round agree on who is in it.

export type ExportRound = { id: number; term: string; grade: number };

export type ClubListStudent = {
  loginId: string;
  fullName: string;
  grade: number;
  classroom: string;
  seatNo: number;
};

export type ClubList = {
  id: number;
  clubCode: string;
  name: string;
  capacity: number;
  advisorNames: string[];
  // Sorted grade → classroom → seat number, the order advisors call names in.
  students: ClubListStudent[];
};

export type ClassroomListStudent = {
  seatNo: number;
  loginId: string;
  fullName: string;
  // null = no club in this round yet.
  club: { clubCode: string; name: string } | null;
};

export type ClassroomList = {
  grade: number;
  classroom: string;
  // Every student of the classroom, registered or not, sorted by seat number.
  students: ClassroomListStudent[];
};

// Map.groupBy is ES2024; the project targets ES2023. A Map keeps first-seen key order.
const groupBy = <T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> =>
  items.reduce((groups, item) => {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
    return groups;
  }, new Map<K, T[]>());

const findExportRound = async (db: Queryable, roundId: number): Promise<ExportRound> => {
  const { rows } = await db.query<ExportRound>('SELECT id, term, grade FROM rounds WHERE id = $1', [
    roundId,
  ]);
  const round = rows[0];
  if (!round) throw new AppError(ERROR_CODES.notFound, 'Round not found');
  return round;
};

type ClubRow = {
  id: number;
  club_code: string;
  name: string;
  capacity: number;
  advisor_names: string[];
};

type MemberRow = {
  club_id: number;
  login_id: string;
  full_name: string;
  grade: number;
  classroom: string;
  seat_no: number;
};

const compareClubMembers = (a: ClubListStudent, b: ClubListStudent): number =>
  a.grade - b.grade ||
  compareClassrooms(a.classroom, b.classroom) ||
  a.seatNo - b.seatNo ||
  a.loginId.localeCompare(b.loginId);

// clubId undefined = every club of the round, by club code.
export const readClubLists = async (
  pool: pg.Pool,
  roundId: number,
  clubId: number | undefined,
): Promise<{ round: ExportRound; clubs: ClubList[] }> =>
  await withReadOnlySnapshot(pool, async (client) => {
    const round = await findExportRound(client, roundId);
    const { rows: clubRows } = await client.query<ClubRow>(
      `SELECT c.id, c.club_code, c.name, c.capacity,
              COALESCE(advisor_names.names, '{}') AS advisor_names
       FROM clubs c
       ${ADVISOR_NAMES_JOIN}
       WHERE c.round_id = $1 AND ($2::int IS NULL OR c.id = $2)
       ORDER BY c.club_code, c.id`,
      [roundId, clubId ?? null],
    );
    if (clubRows.length === 0) {
      // A club of another round is as unknown here as one that does not exist.
      if (clubId !== undefined) throw new AppError(ERROR_CODES.notFound, 'Club not found');
      throw new AppError(ERROR_CODES.nothingToExport, 'The round has no clubs');
    }

    const { rows: memberRows } = await client.query<MemberRow>(
      `SELECT r.club_id, u.login_id, u.full_name, sp.grade, sp.classroom, sp.seat_no
       FROM registrations r
       JOIN student_profiles sp ON sp.user_id = r.student_id
       JOIN users u ON u.id = r.student_id
       WHERE r.round_id = $1 AND ($2::int IS NULL OR r.club_id = $2)`,
      [roundId, clubId ?? null],
    );
    const members = groupBy(
      memberRows.map((row) => ({
        clubId: row.club_id,
        student: {
          loginId: row.login_id,
          fullName: row.full_name,
          grade: row.grade,
          classroom: row.classroom,
          seatNo: row.seat_no,
        },
      })),
      (member) => member.clubId,
    );

    return {
      round,
      clubs: clubRows.map((row) => ({
        id: row.id,
        clubCode: row.club_code,
        name: row.name,
        capacity: row.capacity,
        advisorNames: row.advisor_names,
        students: (members.get(row.id) ?? [])
          .map(({ student }) => student)
          .sort(compareClubMembers),
      })),
    };
  });

type ClassroomStudentRow = {
  classroom: string;
  seat_no: number;
  login_id: string;
  full_name: string;
  club_code: string | null;
  club_name: string | null;
};

const compareSeats = (a: ClassroomListStudent, b: ClassroomListStudent): number =>
  a.seatNo - b.seatNo || a.loginId.localeCompare(b.loginId);

// Starts from the students, not from registrations, so a student with no club is still listed:
// finding those is what homeroom teachers use this list for. classroom undefined = every
// classroom of the round's grade.
export const readClassroomLists = async (
  pool: pg.Pool,
  roundId: number,
  classroom: string | undefined,
): Promise<{ round: ExportRound; classrooms: ClassroomList[] }> =>
  await withReadOnlySnapshot(pool, async (client) => {
    const round = await findExportRound(client, roundId);
    const { rows } = await client.query<ClassroomStudentRow>(
      `SELECT sp.classroom, sp.seat_no, u.login_id, u.full_name,
              c.club_code, c.name AS club_name
       FROM student_profiles sp
       JOIN users u ON u.id = sp.user_id
       LEFT JOIN registrations r ON r.student_id = sp.user_id AND r.round_id = $1
       LEFT JOIN clubs c ON c.id = r.club_id
       WHERE u.role = 'student' AND sp.grade = $2 AND ($3::text IS NULL OR sp.classroom = $3)`,
      [roundId, round.grade, classroom ?? null],
    );
    if (rows.length === 0) {
      // A classroom exists only through its students, so an empty one is an unknown one.
      if (classroom !== undefined) throw new AppError(ERROR_CODES.notFound, 'Classroom not found');
      throw new AppError(ERROR_CODES.nothingToExport, 'The round grade has no students');
    }

    const byClassroom = groupBy(rows, (row) => row.classroom);
    return {
      round,
      classrooms: [...byClassroom.entries()]
        .sort(([a], [b]) => compareClassrooms(a, b))
        .map(([name, students]) => ({
          grade: round.grade,
          classroom: name,
          students: students
            .map((row) => ({
              seatNo: row.seat_no,
              loginId: row.login_id,
              fullName: row.full_name,
              club:
                row.club_code === null || row.club_name === null
                  ? null
                  : { clubCode: row.club_code, name: row.club_name },
            }))
            .sort(compareSeats),
        })),
    };
  });

type ClassroomCountRow = { classroom: string; student_count: number; registered_count: number };

// The classrooms of the round's grade with how many have registered, for the export page.
export const listRoundClassrooms = async (
  pool: pg.Pool,
  roundId: number,
  now: Date,
): Promise<RoundClassroomsResponse> =>
  await withReadOnlySnapshot(pool, async (client) => {
    const round = await findRound(client, roundId, now);
    if (!round) throw new AppError(ERROR_CODES.notFound, 'Round not found');
    const { rows } = await client.query<ClassroomCountRow>(
      `SELECT sp.classroom,
              count(*)::int AS student_count,
              count(r.id)::int AS registered_count
       FROM student_profiles sp
       JOIN users u ON u.id = sp.user_id
       LEFT JOIN registrations r ON r.student_id = sp.user_id AND r.round_id = $1
       WHERE u.role = 'student' AND sp.grade = $2
       GROUP BY sp.classroom`,
      [roundId, round.grade],
    );
    const classrooms: RoundClassroom[] = rows
      .map((row) => ({
        classroom: row.classroom,
        studentCount: row.student_count,
        registeredCount: row.registered_count,
      }))
      .sort((a, b) => compareClassrooms(a.classroom, b.classroom));
    return { round, classrooms };
  });
