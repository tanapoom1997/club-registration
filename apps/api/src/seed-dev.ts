import { generatePassword, hashPassword } from './auth/password.js';
import { createUserIfMissing } from './auth/users.js';
import { loadDatabaseConfig } from './config.js';
import { createPool } from './db.js';

// Fictional students for trying the student pages before Excel import exists. The repo is
// public, so names and IDs here must never resemble real people.
const DEMO_STUDENTS = Object.freeze([
  { loginId: 'demo1001', fullName: 'นักเรียนสมมติ หนึ่ง', grade: 1, classroom: '1', seatNo: 1 },
  { loginId: 'demo1002', fullName: 'นักเรียนสมมติ สอง', grade: 1, classroom: '1', seatNo: 2 },
  { loginId: 'demo2001', fullName: 'นักเรียนสมมติ สาม', grade: 2, classroom: '1', seatNo: 1 },
]);
const STUDENT_PASSWORD_LENGTH = 10;

if (process.env.NODE_ENV === 'production') {
  console.error('seed-dev refuses to run with NODE_ENV=production');
  process.exitCode = 1;
} else {
  const pool = createPool(loadDatabaseConfig().DATABASE_URL);
  try {
    for (const student of DEMO_STUDENTS) {
      const password = generatePassword(STUDENT_PASSWORD_LENGTH);
      const passwordHash = await hashPassword(password);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await createUserIfMissing(client, {
          loginId: student.loginId,
          fullName: student.fullName,
          role: 'student',
          passwordHash,
        });
        if (result.created) {
          await client.query(
            `INSERT INTO student_profiles (user_id, grade, classroom, seat_no)
             VALUES ($1, $2, $3, $4)`,
            [result.user.id, student.grade, student.classroom, student.seatNo],
          );
        }
        await client.query('COMMIT');
        console.log(
          result.created
            ? `${student.loginId}  grade ${student.grade}  password: ${password}`
            : `${student.loginId}  already exists; unchanged`,
        );
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}
