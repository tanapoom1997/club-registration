import type pg from 'pg';

// Seat moves shared by a student's change of club (registrations.ts) and a promotion off the
// waitlist (waitlist-promote.ts). Both run under the round lock their caller holds.

// The clubs CHECK (registered >= 0) is the backstop; a missing row would mean a registration
// pointing at no club, which the composite foreign key already rules out.
export const releaseSeat = async (
  db: pg.PoolClient,
  roundId: number,
  clubId: number,
): Promise<void> => {
  const { rowCount } = await db.query(
    'UPDATE clubs SET registered = registered - 1 WHERE id = $1 AND round_id = $2',
    [clubId, roundId],
  );
  if (rowCount !== 1) throw new Error('Gave back a seat whose club row is missing');
};

export type MoveInput = { roundId: number; studentId: number; fromClubId: number; clubId: number };

// Moves the student's one row instead of DELETE + INSERT: the row never leaves the UNIQUE
// (round_id, student_id) slot, and the api needs UPDATE on these two columns only (migration
// 20261120000000). created_at becomes the column default, the clock register's INSERT uses, so
// registeredAt is when the current club was obtained. Matching the old club too means exactly one
// row, or something moved under the round lock, which cannot happen.
export const moveRegistration = async (
  db: pg.PoolClient,
  { roundId, studentId, fromClubId, clubId }: MoveInput,
): Promise<Date> => {
  const { rows } = await db.query<{ created_at: Date }>(
    `UPDATE registrations SET club_id = $4, created_at = DEFAULT
     WHERE round_id = $1 AND student_id = $2 AND club_id = $3
     RETURNING created_at`,
    [roundId, studentId, fromClubId, clubId],
  );
  const [row, ...more] = rows;
  if (!row || more.length > 0) throw new Error('Found no single registration to move');
  return row.created_at;
};
