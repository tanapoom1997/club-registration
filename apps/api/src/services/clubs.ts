import { ERROR_CODES } from '@club-registration/shared';
import type {
  AdminClub,
  ClubAdvisor,
  RoundClubsResponse,
  UpdateClubRequest,
} from '@club-registration/shared';
import type pg from 'pg';
import { isPgError, PG_ERROR_CODES, withReadOnlySnapshot } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import { findRound } from './rounds.js';

// The unnamed table CHECK (registered >= 0 AND registered <= capacity) from the initial migration.
const REGISTERED_WITHIN_CAPACITY_CHECK = 'clubs_check';

type AdvisorRow = {
  id: number;
  full_name: string;
  phone: string | null;
  email: string | null;
  line_id: string | null;
};

type ClubRow = {
  id: number;
  round_id: number;
  club_code: string;
  name: string;
  description: string;
  capacity: number;
  registered: number;
  advisors: AdvisorRow[];
};

const toAdvisor = (row: AdvisorRow): ClubAdvisor => ({
  id: row.id,
  fullName: row.full_name,
  phone: row.phone,
  email: row.email,
  lineId: row.line_id,
});

// The one place snake_case rows become the API shape.
const toClub = (row: ClubRow): AdminClub => ({
  id: row.id,
  roundId: row.round_id,
  clubCode: row.club_code,
  name: row.name,
  description: row.description,
  capacity: row.capacity,
  registered: row.registered,
  remaining: row.capacity - row.registered,
  advisors: row.advisors.map(toAdvisor),
});

const CLUB_COLUMNS = 'id, round_id, club_code, name, description, capacity, registered';

// For lists that show advisors by name only (the student club list, the per-club name list):
// joins the names of club `c`'s advisors, in insertion order as on the admin list, as
// advisor_names.names (NULL when there are none). The contact columns are deliberately not
// selected, so they cannot leak into such a list even through a later change to its mapping.
export const ADVISOR_NAMES_JOIN = `
  LEFT JOIN LATERAL (
    SELECT array_agg(ca.full_name ORDER BY ca.id) AS names
    FROM club_advisors ca
    WHERE ca.club_id = c.id
  ) advisor_names ON true`;

// Advisors are listed in insertion order, which is the order of the imported file. `source` is
// always a constant (a table or a CTE name), never input.
const selectWithAdvisors = (source: string, filter = '') => `
  SELECT c.id, c.round_id, c.club_code, c.name, c.description, c.capacity, c.registered,
         COALESCE(a.advisors, '[]'::json) AS advisors
  FROM ${source} c
  LEFT JOIN LATERAL (
    SELECT json_agg(
             json_build_object(
               'id', ca.id, 'full_name', ca.full_name, 'phone', ca.phone,
               'email', ca.email, 'line_id', ca.line_id
             ) ORDER BY ca.id
           ) AS advisors
    FROM club_advisors ca
    WHERE ca.club_id = c.id
  ) a ON true
  ${filter}
  ORDER BY c.club_code, c.id`;

// One snapshot, so the round totals always add up to the clubs listed with them.
export const listRoundClubs = async (
  pool: pg.Pool,
  roundId: number,
  now: Date,
): Promise<RoundClubsResponse> =>
  await withReadOnlySnapshot(pool, async (client) => {
    const round = await findRound(client, roundId, now);
    if (!round) throw new AppError(ERROR_CODES.notFound, 'Round not found');
    const { rows } = await client.query<ClubRow>(
      selectWithAdvisors('clubs', 'WHERE c.round_id = $1'),
      [roundId],
    );
    return { round, clubs: rows.map(toClub) };
  });

// A single UPDATE with no app-side check of registered: the clubs CHECK is evaluated against the
// row as it is when the UPDATE gets its row lock, so a registration committed a moment earlier is
// counted and the change is refused, whatever the admin's screen showed. Registration's own
// `UPDATE ... WHERE registered < capacity` takes the same row lock, so the two serialize without
// the round advisory lock. Raising capacity is allowed while the round is open; Phase 2 must then
// promote the waitlist in the same transaction, under pg_advisory_xact_lock(round_id).
export const updateClub = async (
  db: Queryable,
  id: number,
  { name, description, capacity }: UpdateClubRequest,
): Promise<AdminClub> => {
  let rows: ClubRow[];
  try {
    ({ rows } = await db.query<ClubRow>(
      `WITH updated AS (
         UPDATE clubs
         SET name = COALESCE($2::text, name),
             description = COALESCE($3::text, description),
             capacity = COALESCE($4::int, capacity)
         WHERE id = $1
         RETURNING ${CLUB_COLUMNS}
       )
       ${selectWithAdvisors('updated')}`,
      [id, name ?? null, description ?? null, capacity ?? null],
    ));
  } catch (error) {
    if (isPgError(error, PG_ERROR_CODES.checkViolation, REGISTERED_WITHIN_CAPACITY_CHECK)) {
      throw new AppError(ERROR_CODES.capacityBelowRegistered);
    }
    if (isPgError(error, PG_ERROR_CODES.checkViolation)) {
      throw new AppError(ERROR_CODES.validationError);
    }
    throw error;
  }
  const row = rows[0];
  if (!row) throw new AppError(ERROR_CODES.notFound, 'Club not found');
  return toClub(row);
};
