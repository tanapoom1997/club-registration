import { ERROR_CODES, GRADES, roundStatusSchema } from '@club-registration/shared';
import type {
  CreateRoundBatchRequest,
  CreateRoundRequest,
  ListRoundsQuery,
  Round,
  RoundStatus,
  UpdateRoundRequest,
} from '@club-registration/shared';
import { isPgError, PG_ERROR_CODES } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';

const TERM_GRADE_UNIQUE = 'rounds_term_grade_key';
const WINDOW_CHECK = 'rounds_check';

type RoundRow = {
  id: number;
  term: string;
  grade: number;
  opens_at: Date;
  closes_at: Date;
  max_active: number;
  club_count: number;
  total_capacity: number;
  total_registered: number;
};

// The window is half-open: a round is open from opens_at up to, but not including, closes_at.
export const roundStatusAt = (
  { opensAt, closesAt }: { opensAt: Date; closesAt: Date },
  now: Date,
): RoundStatus => {
  if (now < opensAt) return roundStatusSchema.enum.upcoming;
  if (now < closesAt) return roundStatusSchema.enum.open;
  return roundStatusSchema.enum.closed;
};

// The one place snake_case rows become the API shape. Status is derived here, at read time, so a
// round can never be stuck in a stale stored state.
const toRound = (row: RoundRow, now: Date): Round => ({
  id: row.id,
  term: row.term,
  grade: row.grade,
  opensAt: row.opens_at.toISOString(),
  closesAt: row.closes_at.toISOString(),
  maxActive: row.max_active,
  status: roundStatusAt({ opensAt: row.opens_at, closesAt: row.closes_at }, now),
  clubCount: row.club_count,
  totalCapacity: row.total_capacity,
  totalRegistered: row.total_registered,
});

const ROUND_COLUMNS = 'id, term, grade, opens_at, closes_at, max_active';

// Totals are summed from clubs on every read instead of being cached on rounds, so they cannot
// drift from clubs.registered. `source` is always a constant (a table or a CTE name), never input.
const selectWithTotals = (source: string, filter = '') => `
  SELECT r.id, r.term, r.grade, r.opens_at, r.closes_at, r.max_active,
         totals.club_count, totals.total_capacity, totals.total_registered
  FROM ${source} r
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS club_count,
           COALESCE(sum(c.capacity), 0)::int AS total_capacity,
           COALESCE(sum(c.registered), 0)::int AS total_registered
    FROM clubs c
    WHERE c.round_id = r.id
  ) totals
  ${filter}
  ORDER BY r.term DESC, r.grade`;

// Every round write is checked by the DB; this turns the violations a client can cause into
// business errors without echoing Postgres text back.
const toRoundWriteError = (error: unknown): unknown => {
  if (isPgError(error, PG_ERROR_CODES.uniqueViolation, TERM_GRADE_UNIQUE)) {
    return new AppError(ERROR_CODES.roundExists);
  }
  if (isPgError(error, PG_ERROR_CODES.checkViolation, WINDOW_CHECK)) {
    return new AppError(ERROR_CODES.validationError, 'closesAt must be after opensAt');
  }
  if (isPgError(error, PG_ERROR_CODES.checkViolation)) {
    return new AppError(ERROR_CODES.validationError);
  }
  return error;
};

const runRoundWrite = async (
  db: Queryable,
  sql: string,
  params: readonly unknown[],
): Promise<RoundRow[]> => {
  try {
    const { rows } = await db.query<RoundRow>(sql, [...params]);
    return rows;
  } catch (error) {
    throw toRoundWriteError(error);
  }
};

export const listRounds = async (
  db: Queryable,
  { term }: ListRoundsQuery,
  now: Date,
): Promise<Round[]> => {
  const { rows } = await db.query<RoundRow>(
    selectWithTotals('rounds', 'WHERE $1::text IS NULL OR r.term = $1'),
    [term ?? null],
  );
  return rows.map((row) => toRound(row, now));
};

export const findRound = async (
  db: Queryable,
  id: number,
  now: Date,
): Promise<Round | undefined> => {
  const { rows } = await db.query<RoundRow>(selectWithTotals('rounds', 'WHERE r.id = $1'), [id]);
  const row = rows[0];
  return row ? toRound(row, now) : undefined;
};

// The UNIQUE (term, grade) constraint decides duplicates, so two admins racing cannot both win.
export const createRound = async (
  db: Queryable,
  { term, grade, opensAt, closesAt, maxActive }: CreateRoundRequest,
  now: Date,
): Promise<Round> => {
  const rows = await runRoundWrite(
    db,
    `WITH created AS (
       INSERT INTO rounds (term, grade, opens_at, closes_at, max_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${ROUND_COLUMNS}
     )
     ${selectWithTotals('created')}`,
    [term, grade, opensAt, closesAt, maxActive],
  );
  const row = rows[0];
  if (!row) throw new Error('Round insert returned no row');
  return toRound(row, now);
};

// One INSERT statement is atomic on its own: if any grade already exists for the term, the
// unique violation aborts the whole statement and no grade is created.
export const createRoundBatch = async (
  db: Queryable,
  { term, opensAt, closesAt, maxActive }: CreateRoundBatchRequest,
  now: Date,
): Promise<Round[]> => {
  const rows = await runRoundWrite(
    db,
    `WITH created AS (
       INSERT INTO rounds (term, grade, opens_at, closes_at, max_active)
       SELECT $1::text, grade, $2::timestamptz, $3::timestamptz, $4::int FROM unnest($5::smallint[]) AS grade
       RETURNING ${ROUND_COLUMNS}
     )
     ${selectWithTotals('created')}`,
    [term, opensAt, closesAt, maxActive, GRADES],
  );
  return rows.map((row) => toRound(row, now));
};

// Only the window and max_active are updatable; term and grade identify the round. A half-given
// window is checked against the stored half by the CHECK (closes_at > opens_at) constraint.
export const updateRound = async (
  db: Queryable,
  id: number,
  { opensAt, closesAt, maxActive }: UpdateRoundRequest,
  now: Date,
): Promise<Round> => {
  const rows = await runRoundWrite(
    db,
    `WITH updated AS (
       UPDATE rounds
       SET opens_at = COALESCE($2::timestamptz, opens_at),
           closes_at = COALESCE($3::timestamptz, closes_at),
           max_active = COALESCE($4::int, max_active)
       WHERE id = $1
       RETURNING ${ROUND_COLUMNS}
     )
     ${selectWithTotals('updated')}`,
    [id, opensAt ?? null, closesAt ?? null, maxActive ?? null],
  );
  const row = rows[0];
  if (!row) throw new AppError(ERROR_CODES.notFound, 'Round not found');
  return toRound(row, now);
};

// No pre-check for clubs: a club inserted concurrently would slip past it. The foreign keys from
// clubs (and every other per-round table) make the DELETE itself fail while anything is attached.
export const deleteRound = async (db: Queryable, id: number): Promise<void> => {
  let deleted: number;
  try {
    const { rowCount } = await db.query('DELETE FROM rounds WHERE id = $1', [id]);
    deleted = rowCount ?? 0;
  } catch (error) {
    if (isPgError(error, PG_ERROR_CODES.foreignKeyViolation)) {
      throw new AppError(ERROR_CODES.roundNotEmpty);
    }
    throw error;
  }
  if (deleted === 0) throw new AppError(ERROR_CODES.notFound, 'Round not found');
};
