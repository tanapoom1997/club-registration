import { ERROR_CODES } from '@club-registration/shared';
import type pg from 'pg';
import { UNISSUED_PASSWORD_HASH } from '../auth/password.js';
import { isPgError, PG_ERROR_CODES, withTransaction } from '../db.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';
import type { ParsedImport } from '../import/parse.js';
import { planImport } from './import-plan.js';
import type { ImportPlan } from './import-plan.js';
import { lockImport, lockRoundsForImport } from './round-lock.js';
import { promoteWaitlist } from './waitlist-promote.js';
import type { Promotion } from './waitlist-promote.js';

// Every import commit takes the import lock (lockImport) before it reads anything, so commits run
// one at a time and each plans against what the previous one committed: two racing uploads of the
// same file end with one creating everything and the other finding it unchanged, never with a
// half-merged mix. The initial password issuance takes the same lock before its row locks, so the
// two never hold users rows at once (they lock them in no common order, which could deadlock).
// The admin round edit takes it too, so it never writes a rounds row this commit holds FOR SHARE.
// commitImport takes the round locks right after it (CLAUDE.md rule 3; round-lock.ts has the whole
// order). The UNIQUE constraints used by ON CONFLICT below stay the backstop against writers that
// do not take this lock.
const conflict = () => new AppError(ERROR_CODES.importConflict);

const upsertStudents = async (db: Queryable, plan: ImportPlan['students']) => {
  const rows = [...plan.create, ...plan.update];
  if (rows.length === 0) return;
  // New accounts get the unissued marker and must change their password; an existing account
  // only has its name refreshed, so its password, forced-change flag and sessions are untouched.
  // WHERE role = 'student' keeps an admin that appeared since planning from being renamed.
  const { rows: users } = await db.query<{ id: number; login_id: string }>(
    `INSERT INTO users (login_id, full_name, role, password_hash, must_change_password)
     SELECT v.login_id, v.full_name, 'student', $3, true
     FROM unnest($1::text[], $2::text[]) AS v(login_id, full_name)
     ON CONFLICT (login_id) DO UPDATE SET full_name = EXCLUDED.full_name
     WHERE users.role = 'student'
     RETURNING id, login_id`,
    [
      rows.map(({ loginId }) => loginId),
      rows.map(({ fullName }) => fullName),
      UNISSUED_PASSWORD_HASH,
    ],
  );
  if (users.length !== rows.length) throw conflict();
  const ids = new Map(users.map(({ id, login_id: loginId }) => [loginId, id]));

  await db.query(
    `INSERT INTO student_profiles (user_id, grade, classroom, seat_no)
     SELECT * FROM unnest($1::int[], $2::smallint[], $3::text[], $4::smallint[])
     ON CONFLICT (user_id) DO UPDATE
     SET grade = EXCLUDED.grade, classroom = EXCLUDED.classroom, seat_no = EXCLUDED.seat_no`,
    [
      rows.map(({ loginId }) => ids.get(loginId)),
      rows.map(({ grade }) => grade),
      rows.map(({ classroom }) => classroom),
      rows.map(({ seatNo }) => seatNo),
    ],
  );
};

// registered is never in the column list: seats taken belong to registrations, not to the file.
// A capacity below it fails the clubs CHECK, which the caller turns into import_conflict.
const upsertClubs = async (db: Queryable, plan: ImportPlan['clubs']) => {
  const rows = [...plan.create, ...plan.update];
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO clubs (round_id, club_code, name, description, capacity)
     SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::int[])
     ON CONFLICT (round_id, club_code) DO UPDATE
     SET name = EXCLUDED.name, description = EXCLUDED.description, capacity = EXCLUDED.capacity`,
    [
      rows.map(({ roundId }) => roundId),
      rows.map(({ clubCode }) => clubCode),
      rows.map(({ name }) => name),
      rows.map(({ description }) => description),
      rows.map(({ capacity }) => capacity),
    ],
  );
};

// Replaces each listed club's whole advisor set, so a teacher removed from the file is removed
// here too. Clubs are found by round and code because a club created above has no id in the plan.
const replaceAdvisors = async (db: Queryable, plan: ImportPlan['advisors']) => {
  if (plan.replace.length === 0) return;
  await db.query(
    `DELETE FROM club_advisors a
     USING clubs c, unnest($1::int[], $2::text[]) AS v(round_id, club_code)
     WHERE a.club_id = c.id AND c.round_id = v.round_id AND c.club_code = v.club_code`,
    [plan.replace.map(({ roundId }) => roundId), plan.replace.map(({ clubCode }) => clubCode)],
  );

  const rows = plan.replace.flatMap(({ roundId, clubCode, advisors }) =>
    advisors.map(({ fullName, phone, email, lineId }) => ({
      roundId,
      clubCode,
      fullName,
      phone,
      email,
      lineId,
    })),
  );
  // ORDER BY ord keeps the file's order, which is how the planner compares lists next time.
  const { rowCount } = await db.query(
    `INSERT INTO club_advisors (club_id, full_name, phone, email, line_id)
     SELECT c.id, v.full_name, v.phone, v.email, v.line_id
     FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       WITH ORDINALITY AS v(round_id, club_code, full_name, phone, email, line_id, ord)
     JOIN clubs c ON c.round_id = v.round_id AND c.club_code = v.club_code
     ORDER BY v.ord`,
    [
      rows.map(({ roundId }) => roundId),
      rows.map(({ clubCode }) => clubCode),
      rows.map(({ fullName }) => fullName),
      rows.map(({ phone }) => phone),
      rows.map(({ email }) => email),
      rows.map(({ lineId }) => lineId),
    ],
  );
  if (rowCount !== rows.length) throw conflict();
};

const isConstraintError = (error: unknown): boolean =>
  isPgError(error, PG_ERROR_CODES.checkViolation) ||
  isPgError(error, PG_ERROR_CODES.foreignKeyViolation) ||
  isPgError(error, PG_ERROR_CODES.uniqueViolation);

// Writes a plan built in the same transaction. A constraint that still fires means the data
// moved under the plan (a registration above a new capacity, a round deleted): the caller's
// transaction rolls back and the admin is told to preview again, without any DB text.
export const applyImportPlan = async (db: Queryable, plan: ImportPlan): Promise<void> => {
  try {
    await upsertStudents(db, plan.students);
    await upsertClubs(db, plan.clubs);
    await replaceAdvisors(db, plan.advisors);
  } catch (error) {
    if (isConstraintError(error)) throw conflict();
    throw error;
  }
};

// A promotion made by the import commit, with the round it happened in.
export type ImportPromotion = Promotion & { roundId: number };

export type CommitImportResult = {
  status: 'invalid' | 'committed';
  plan: ImportPlan;
  // Waiters moved up by the commit, round by round in ascending id; empty when invalid.
  promotions: ImportPromotion[];
};

// Runs the promote engine (waitlist-promote.ts) in every round the commit locked, in the order it
// locked them (ascending id), as the last writes of the transaction. A capacity the file raised in
// a round that has not closed (open or upcoming) frees seats, and the waiters for them move up
// here, with the admin who committed as the actor. No lock is taken: the engine takes none of its
// own, and every round it runs in is one whose lock this transaction already holds (round-lock.ts
// has why that adds no wait). The engine skips a round that has closed by the DB clock by itself,
// and in a round whose clubs the file did not touch it normally finds no one (every other
// in-round writer promotes before it commits), so running it in all of them costs one indexed
// statement each. Outside applyImportPlan's catch on purpose: a constraint failing in the engine
// is a bug, not data that moved under the plan, and must not be answered as import_conflict.
const promoteLockedRounds = async (
  db: pg.PoolClient,
  roundIds: readonly number[],
  actorId: number,
): Promise<ImportPromotion[]> => {
  const promotions: ImportPromotion[] = [];
  for (const roundId of roundIds) {
    const promoted = await promoteWaitlist(db, { roundId, actorId });
    promotions.push(...promoted.map((promotion) => ({ ...promotion, roundId })));
  }
  return promotions;
};

// Parsing happens before this (it is pure and CPU-bound, so it does not hold the lock); the plan
// is rebuilt here, under the locks, and nothing from the preview is trusted.
//
// Round locks (CLAUDE.md rule 3): the import writes into the term's rounds (club capacity, and a
// student's grade decides which round they may hold a seat or a waitlist entry in), so before
// planning reads anything it also takes the advisory lock of every round of the term and of every
// round of another term that has not closed yet (lockRoundsForImport; round-lock.ts explains the
// set, the order and why it cannot deadlock with register, cancel, the waitlist or the club
// edit). Under READ COMMITTED, without them a student could register (or join a waitlist) and
// commit between planImport reading their registrations and entries and upsertStudents moving
// them to another grade, leaving a seat or an entry in a round of a grade they are no longer in.
// With them, a register or join in one of those rounds either commits before planning (and the
// grade change is refused) or waits until this commit (and then finds the student in the new
// grade: 404). Seats and entries in closed rounds of other terms are history and do not stop a
// grade change. The same locks cover the promotions at the end (promoteLockedRounds).
// The dry run (preview) takes none of these locks: it reads one READ ONLY snapshot and writes
// nothing, so it never makes registrations wait; it reports the same errors from that snapshot
// and promotes nobody.
export const commitImport = async (
  pool: pg.Pool,
  { term, parsed, actorId }: { term: string; parsed: ParsedImport; actorId: number },
): Promise<CommitImportResult> =>
  await withTransaction(pool, async (client) => {
    await lockImport(client);
    const roundIds = await lockRoundsForImport(client, term);
    const plan = await planImport(client, term, parsed);
    // One error is enough to write nothing. Only reads have run, so committing releases the
    // lock exactly as a rollback would.
    if (plan.errors.length > 0) return { status: 'invalid', plan, promotions: [] };
    await applyImportPlan(client, plan);
    const promotions = await promoteLockedRounds(client, roundIds, actorId);
    return { status: 'committed', plan, promotions };
  });
