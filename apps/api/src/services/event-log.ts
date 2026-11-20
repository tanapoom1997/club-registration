import type { EventLogQuery, EventLogResponse, RegistrationEvent } from '@club-registration/shared';
import { eventTypeSchema, roleSchema } from '@club-registration/shared';
import type { Queryable } from '../db.js';

// The admin's event log (README Phase 2, decision 3 and PR 3b): registration_events newest first,
// one page at a time, filtered by round, student and club. Read-only, a single statement, so one
// page is one consistent snapshot without a transaction of its own.
//
// Keyset pagination on id, not created_at: id is unique and only grows, while one transaction's
// events share created_at. A page is `id < before ORDER BY id DESC LIMIT n`, so the pages after
// the first never repeat or skip an event that existed when the first was read, however many are
// written in between: new events land above the cursor. The one exception to "new = above" is an
// event whose transaction took its id before the first page was read and committed after; it can
// only be in another round than the events around it (a round's writers run one at a time under
// its lock and take their ids under it), and it shows up on a later page or the next first page.
// No event already listed moves.
//
// The WHERE holds only the filters given, each a fixed fragment with its value as a parameter
// (never in the text), so the statement planned is exactly the one for those filters. The plans
// (EXPLAIN on ~100k fictional events, README PR 3b): no filter and `before` walk the primary key
// backwards; roundId walks (round_id, id) backwards (migration
// 20261122000000_event-log-round-index.sql); studentId and clubId (club_id OR from_club_id, a
// BitmapOr) read the few hundred rows of their indexes and sort them.

type EventRow = {
  id: number;
  created_at: Date;
  event_type: string;
  round_id: number;
  term: string;
  grade: number;
  student_id: number;
  student_login_id: string;
  student_full_name: string;
  classroom: string;
  seat_no: number;
  club_id: number | null;
  club_code: string | null;
  club_name: string | null;
  from_club_id: number | null;
  from_club_code: string | null;
  from_club_name: string | null;
  actor_id: number;
  actor_login_id: string;
  actor_full_name: string;
  actor_role: string;
};

type Clause = { sql: (placeholder: string) => string; value: number };

const filterClauses = ({ roundId, studentId, clubId, before }: EventLogQuery): Clause[] => [
  ...(roundId === undefined ? [] : [{ sql: (p: string) => `e.round_id = ${p}`, value: roundId }]),
  ...(studentId === undefined
    ? []
    : [{ sql: (p: string) => `e.student_id = ${p}`, value: studentId }]),
  ...(clubId === undefined
    ? []
    : [{ sql: (p: string) => `(e.club_id = ${p} OR e.from_club_id = ${p})`, value: clubId }]),
  ...(before === undefined ? [] : [{ sql: (p: string) => `e.id < ${p}`, value: before }]),
];

// The statement for one page: the WHERE of the filters given, then the cursor and the limit.
const eventLogStatement = (query: EventLogQuery): { text: string; values: number[] } => {
  const clauses = filterClauses(query);
  const where = clauses.map(({ sql }, index) => sql(`$${index + 1}`));
  return {
    text: `SELECT e.id, e.created_at, e.event_type,
                  e.round_id, ro.term, ro.grade,
                  e.student_id, su.login_id AS student_login_id,
                  su.full_name AS student_full_name, sp.classroom, sp.seat_no,
                  e.club_id, c.club_code, c.name AS club_name,
                  e.from_club_id, fc.club_code AS from_club_code, fc.name AS from_club_name,
                  e.actor_id, au.login_id AS actor_login_id, au.full_name AS actor_full_name,
                  au.role AS actor_role
           FROM registration_events e
           JOIN rounds ro ON ro.id = e.round_id
           JOIN users su ON su.id = e.student_id
           JOIN student_profiles sp ON sp.user_id = e.student_id
           LEFT JOIN clubs c ON c.id = e.club_id
           LEFT JOIN clubs fc ON fc.id = e.from_club_id
           JOIN users au ON au.id = e.actor_id
           ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
           ORDER BY e.id DESC
           LIMIT $${clauses.length + 1}`,
    // One row past the page tells whether an older page exists without a count.
    values: [...clauses.map(({ value }) => value), query.limit + 1],
  };
};

const clubRef = (id: number | null, clubCode: string | null, name: string | null) =>
  id === null || clubCode === null || name === null ? null : { id, clubCode, name };

// The one place snake_case rows become the API shape. The type and role are parsed, not cast: a
// value outside the shared lists is a broken schema, better a 500 here than a wrong answer.
const toEvent = (row: EventRow): RegistrationEvent => ({
  id: row.id,
  createdAt: row.created_at.toISOString(),
  eventType: eventTypeSchema.parse(row.event_type),
  round: { id: row.round_id, term: row.term, grade: row.grade },
  student: {
    id: row.student_id,
    loginId: row.student_login_id,
    fullName: row.student_full_name,
    classroom: row.classroom,
    seatNo: row.seat_no,
  },
  club: clubRef(row.club_id, row.club_code, row.club_name),
  fromClub: clubRef(row.from_club_id, row.from_club_code, row.from_club_name),
  actor: {
    id: row.actor_id,
    loginId: row.actor_login_id,
    fullName: row.actor_full_name,
    role: roleSchema.parse(row.actor_role),
  },
});

export const listEvents = async (
  db: Queryable,
  query: EventLogQuery,
): Promise<EventLogResponse> => {
  const { text, values } = eventLogStatement(query);
  const { rows } = await db.query<EventRow>(text, values);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    events: page.map(toEvent),
    nextBefore: rows.length > query.limit && last ? last.id : null,
  };
};
