import { ERROR_CODES, GRADES, roundStatusSchema } from '@club-registration/shared';
import type {
  CreateRoundBatchRequest,
  CreateRoundRequest,
  ListRoundsQuery,
  Round,
  RoundStatus,
  UpdateRoundRequest,
} from '@club-registration/shared';
import type pg from 'pg';
import { isPgError, PG_ERROR_CODES } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import { lockImport, lockRound } from './round-lock.js';
import { promoteWaitlist } from './waitlist-promote.js';
import type { Promotion } from './waitlist-promote.js';

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

const runRoundWrite = async <Row extends pg.QueryResultRow = RoundRow>(
  db: Queryable,
  sql: string,
  params: readonly unknown[],
): Promise<Row[]> => {
  try {
    const { rows } = await db.query<Row>(sql, [...params]);
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
//
// An in-round write (CLAUDE.md rule 3), because a new window can open a round: after a close an
// admin may raise a capacity (the engine promotes nobody in a closed round) and then reopen the
// round, which would leave a club with both a free seat and waiters in an open round. So the edit
// promotes in the same transaction, under the round lock, with the admin as actor. The engine
// decides by the DB clock, so an edit that leaves the round upcoming or closed promotes nobody.
//
// Locks in the global order of round-lock.ts: the import lock first, then the round lock, then
// the UPDATE. The import holds FOR SHARE on every rounds row and then waits for round locks, so
// an edit that took the round lock and then waited for that row would deadlock with it; holding
// the import lock makes the edit and the import run one after the other instead.
//
// A round create needs none of this (a new round has no clubs, so no seats or waiters), nor does
// a delete (a round it can delete has no clubs either).
export const updateRound = async (
  db: pg.PoolClient,
  {
    id,
    changes: { opensAt, closesAt, maxActive },
    actorId,
    now,
  }: { id: number; changes: UpdateRoundRequest; actorId: number; now: Date },
): Promise<{ round: Round; promotions: Promotion[] }> => {
  await lockImport(db);
  await lockRound(db, id);
  const updated = await runRoundWrite<{ id: number }>(
    db,
    `UPDATE rounds
     SET opens_at = COALESCE($2::timestamptz, opens_at),
         closes_at = COALESCE($3::timestamptz, closes_at),
         max_active = COALESCE($4::int, max_active)
     WHERE id = $1
     RETURNING id`,
    [id, opensAt ?? null, closesAt ?? null, maxActive ?? null],
  );
  if (updated.length === 0) throw new AppError(ERROR_CODES.notFound, 'Round not found');
  // Outside runRoundWrite's error mapping: a fault in the engine is never a validation error.
  const promotions = await promoteWaitlist(db, { roundId: id, actorId });
  // Read after promoting: each waiter promoted without a club of their own adds to the totals.
  const round = await findRound(db, id, now);
  // The UPDATE found the row under its round lock and the delete cannot remove a round mid-edit
  // (it waits for this row), so this is a broken invariant.
  if (!round) throw new Error('Round vanished after its update');
  return { round, promotions };
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
