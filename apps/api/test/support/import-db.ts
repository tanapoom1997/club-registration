import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

// Rows the import tests set up directly in the DB. Every value is made up.

const hex = (bytes = 4) => randomBytes(bytes).toString('hex');
// Fresh terms, codes and IDs per test, so tests never see each other's data.
export const uniqueTerm = () => `t-${hex()}`;
export const uniqueCode = () => `C${hex(3).toUpperCase()}`;
export const uniqueStudentId = () => `s${hex(5)}`;

const firstId = (rows: { id: number }[]): number => {
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('Insert returned no row');
  return id;
};

// Upcoming by default (opens tomorrow); closedDaysAgo makes it a round that has already closed.
export const createRound = async (
  pool: Pool,
  term: string,
  grade: number,
  { closedDaysAgo }: { closedDaysAgo?: number } = {},
): Promise<number> => {
  const { rows } = await pool.query<{ id: number }>(
    closedDaysAgo === undefined
      ? `INSERT INTO rounds (term, grade, opens_at, closes_at)
         VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days') RETURNING id`
      : `INSERT INTO rounds (term, grade, opens_at, closes_at)
         VALUES ($1, $2, now() - ($3::int + 1) * interval '1 day', now() - $3::int * interval '1 day')
         RETURNING id`,
    closedDaysAgo === undefined ? [term, grade] : [term, grade, closedDaysAgo],
  );
  return firstId(rows);
};

export const createClub = async (
  pool: Pool,
  roundId: number,
  clubCode: string,
  {
    name = 'ชุมนุมสมมติ',
    capacity = 30,
    description = '',
  }: { name?: string; capacity?: number; description?: string } = {},
): Promise<number> => {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO clubs (round_id, club_code, name, capacity, description)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [roundId, clubCode, name, capacity, description],
  );
  return firstId(rows);
};

export const createStudent = async (
  pool: Pool,
  {
    loginId = uniqueStudentId(),
    fullName = 'นักเรียน สมมติ',
    grade = 1,
    classroom = '1',
    seatNo = 1,
  }: {
    loginId?: string;
    fullName?: string;
    grade?: number;
    classroom?: string;
    seatNo?: number;
  } = {},
) => {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (login_id, full_name, role, password_hash)
     VALUES ($1, $2, 'student', 'not-a-real-hash') RETURNING id`,
    [loginId, fullName],
  );
  const id = firstId(rows);
  await pool.query(
    'INSERT INTO student_profiles (user_id, grade, classroom, seat_no) VALUES ($1, $2, $3, $4)',
    [id, grade, classroom, seatNo],
  );
  return { id, loginId };
};

// Seats a student directly, keeping clubs.registered equal to the registrations.
export const register = async (
  pool: Pool,
  roundId: number,
  studentId: number,
  clubId: number,
): Promise<void> => {
  await pool.query(
    'INSERT INTO registrations (round_id, student_id, club_id) VALUES ($1, $2, $3)',
    [roundId, studentId, clubId],
  );
  await pool.query('UPDATE clubs SET registered = registered + 1 WHERE id = $1', [clubId]);
};

// Puts a student on a club's waitlist directly, with no event: for the planning rules only, which
// read the entry and nothing else.
export const addWaitlistEntry = async (
  pool: Pool,
  roundId: number,
  studentId: number,
  clubId: number,
): Promise<void> => {
  await pool.query(
    'INSERT INTO waitlist_entries (round_id, student_id, club_id) VALUES ($1, $2, $3)',
    [roundId, studentId, clubId],
  );
};

export const addAdvisor = async (pool: Pool, clubId: number, fullName: string): Promise<number> => {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO club_advisors (club_id, full_name) VALUES ($1, $2) RETURNING id',
    [clubId, fullName],
  );
  return firstId(rows);
};

const SNAPSHOT_TABLES = [
  'users',
  'student_profiles',
  'rounds',
  'clubs',
  'club_advisors',
  'registrations',
  'registration_events',
] as const;

// The full contents of every table the import can touch, as a count and a digest per table.
export const snapshotDatabase = async (pool: Pool) =>
  await Promise.all(
    SNAPSHOT_TABLES.map(async (table) => {
      // table comes from the constant list above, never from input.
      const { rows } = await pool.query<{ count: number; digest: string }>(
        `SELECT count(*)::int AS count,
                md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS digest
         FROM ${table} t`,
      );
      return { table, ...rows[0] };
    }),
  );
