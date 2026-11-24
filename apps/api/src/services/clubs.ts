import { ERROR_CODES } from '@club-registration/shared';
import type {
  AdminClub,
  ClubAdvisor,
  RoundClubsResponse,
  UpdateClubRequest,
} from '@club-registration/shared';
import type pg from 'pg';
import { isPgError, PG_ERROR_CODES, withReadOnlySnapshot } from '../db.js';
import { AppError } from '../errors.js';
import { lockRoundOfClub } from './round-lock.js';
import type { QueueSettings } from './queue.js';
import { findRound } from './rounds.js';
import { promoteWaitlist } from './waitlist-promote.js';
import type { Promotion } from './waitlist-promote.js';

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
  waitlist_count: number;
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
  waitlistCount: row.waitlist_count,
  advisors: row.advisors.map(toAdvisor),
});

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
         COALESCE(a.advisors, '[]'::json) AS advisors,
         (SELECT count(*)::int FROM waitlist_entries w
          WHERE w.club_id = c.id AND w.round_id = c.round_id) AS waitlist_count
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
  at: { now: Date; settings: QueueSettings },
): Promise<RoundClubsResponse> =>
  await withReadOnlySnapshot(pool, async (client) => {
    const round = await findRound(client, roundId, at);
    if (!round) throw new AppError(ERROR_CODES.notFound, 'Round not found');
    const { rows } = await client.query<ClubRow>(
      selectWithAdvisors('clubs', 'WHERE c.round_id = $1'),
      [roundId],
    );
    return { round, clubs: rows.map(toClub) };
  });

// An in-round write, so it runs in the caller's transaction and first takes the round's advisory
// lock (CLAUDE.md rule 3, round-lock.ts): it waits for any registration in flight in the round to
// commit, and registrations wait for it. The UPDATE then has no app-side check of registered: the
// clubs CHECK is evaluated against the row as it is when the UPDATE gets its row lock, so a
// registration committed a moment earlier is counted and the change is refused, whatever the
// admin's screen showed. The CHECK, not the lock, is what decides: a writer that skipped the lock
// would still meet the same row lock and the same CHECK.
//
// Raising capacity is allowed in any round, and it frees seats, so an edit that sends
// a capacity runs the promote engine (waitlist-promote.ts) in this same transaction, still under
// the round lock taken first, with the admin as the actor of every promotion. A lower or equal
// capacity frees nothing and the engine finds no one; an edit without a capacity cannot free a
// seat, so it does not run the engine at all (it would only ever find state another writer left,
// and must not promote in other clubs under this admin's name). After the round closed the engine
// promotes nobody by itself (DB clock). Promote failures are not caught below: a CHECK there is
// a bug, not a capacity the admin chose.
//
// The answer is the club as it is after the promotions, read again: a cascade can move holders of
// this very club out as well as waiters in, so its count cannot be derived from the promotions.
export const updateClub = async (
  db: pg.PoolClient,
  { clubId, changes, actorId }: { clubId: number; changes: UpdateClubRequest; actorId: number },
): Promise<{ club: AdminClub; promotions: Promotion[] }> => {
  const roundId = await lockRoundOfClub(db, clubId);
  if (roundId === undefined) throw new AppError(ERROR_CODES.notFound, 'Club not found');
  const { name, description, capacity } = changes;
  try {
    await db.query(
      `UPDATE clubs
       SET name = COALESCE($2::text, name),
           description = COALESCE($3::text, description),
           capacity = COALESCE($4::int, capacity)
       WHERE id = $1`,
      [clubId, name ?? null, description ?? null, capacity ?? null],
    );
  } catch (error) {
    if (isPgError(error, PG_ERROR_CODES.checkViolation, REGISTERED_WITHIN_CAPACITY_CHECK)) {
      throw new AppError(ERROR_CODES.capacityBelowRegistered);
    }
    if (isPgError(error, PG_ERROR_CODES.checkViolation)) {
      throw new AppError(ERROR_CODES.validationError);
    }
    throw error;
  }
  const promotions = capacity === undefined ? [] : await promoteWaitlist(db, { roundId, actorId });
  const { rows } = await db.query<ClubRow>(selectWithAdvisors('clubs', 'WHERE c.id = $1'), [
    clubId,
  ]);
  const row = rows[0];
  // The lock found the club and the app cannot delete clubs, so this is a broken invariant.
  if (!row) throw new Error('Club vanished under its round lock');
  return { club: toClub(row), promotions };
};
