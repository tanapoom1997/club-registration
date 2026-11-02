import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMigratedPostgres } from './support/postgres.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

describe('initial schema constraints', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let nextLoginId = 0;
  let nextRound = 0;

  const insertId = async (sql: string, params: unknown[]): Promise<number> => {
    const { rows } = await pool.query<{ id: number }>(sql, params);
    return rows[0]!.id;
  };

  const createRound = async (): Promise<number> => {
    nextRound += 1;
    return await insertId(
      `INSERT INTO rounds (term, grade, opens_at, closes_at)
       VALUES ($1, 1, now(), now() + interval '1 day') RETURNING id`,
      [`term-${nextRound}`],
    );
  };

  const createClub = async (roundId: number, capacity = 2): Promise<number> =>
    await insertId(
      `INSERT INTO clubs (round_id, club_code, name, capacity)
       VALUES ($1, $2, 'Fictional Club', $3) RETURNING id`,
      [roundId, `C${nextLoginId++}`, capacity],
    );

  const createStudent = async (): Promise<number> => {
    nextLoginId += 1;
    const userId = await insertId(
      `INSERT INTO users (login_id, full_name, role, password_hash)
       VALUES ($1, 'Fictional Student', 'student', 'not-a-real-hash') RETURNING id`,
      [`student-${nextLoginId}`],
    );
    await pool.query(
      `INSERT INTO student_profiles (user_id, grade, classroom, seat_no) VALUES ($1, 1, '1', 1)`,
      [userId],
    );
    return userId;
  };

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('rejects registered above capacity', async () => {
    const clubId = await createClub(await createRound(), 1);

    await expect(
      pool.query('UPDATE clubs SET registered = 2 WHERE id = $1', [clubId]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('rejects a second registration for the same student in one round', async () => {
    const roundId = await createRound();
    const [firstClub, secondClub] = [await createClub(roundId), await createClub(roundId)];
    const studentId = await createStudent();
    const register =
      'INSERT INTO registrations (round_id, student_id, club_id) VALUES ($1, $2, $3)';
    await pool.query(register, [roundId, studentId, firstClub]);

    await expect(pool.query(register, [roundId, studentId, secondClub])).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
  });

  it('rejects a registration pointing at a club from another round', async () => {
    const [roundId, otherRoundId] = [await createRound(), await createRound()];
    const otherClub = await createClub(otherRoundId);
    const studentId = await createStudent();

    await expect(
      pool.query('INSERT INTO registrations (round_id, student_id, club_id) VALUES ($1, $2, $3)', [
        roundId,
        studentId,
        otherClub,
      ]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
  });

  it('rejects reusing an idempotency key for the same actor', async () => {
    const roundId = await createRound();
    const studentId = await createStudent();
    const insertEvent = `INSERT INTO registration_events
      (round_id, student_id, event_type, actor_id, idempotency_key)
      VALUES ($1, $2, 'register', $2, 'same-key')`;
    await pool.query(insertEvent, [roundId, studentId]);

    await expect(pool.query(insertEvent, [roundId, studentId])).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
  });

  it('keeps registration_events append-only', async () => {
    const roundId = await createRound();
    const studentId = await createStudent();
    const eventId = await insertId(
      `INSERT INTO registration_events (round_id, student_id, event_type, actor_id)
       VALUES ($1, $2, 'cancel', $2) RETURNING id`,
      [roundId, studentId],
    );

    await expect(
      pool.query('DELETE FROM registration_events WHERE id = $1', [eventId]),
    ).rejects.toThrow('append-only');
  });
});
