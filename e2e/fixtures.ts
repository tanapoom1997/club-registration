import { env } from 'node:process';

// Fixed ports (overridable) rather than random ones: the Playwright config needs the web URL
// before global setup runs. Chosen away from the dev servers (3000, 5173), so an E2E run never
// talks to a developer's own api or database.
export const API_PORT = Number(env.E2E_API_PORT ?? 3910);
export const WEB_PORT = Number(env.E2E_WEB_PORT ?? 5910);
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

// Set by global setup for the tests (workers inherit the environment): the throwaway database,
// as its owner, so a test can check what the browser's actions left behind.
export const DATABASE_URL_ENV = 'E2E_DATABASE_URL';

// Everything below is fictional and lives only in the database the run creates and removes.
export const TERM = 'E2E-2569';
export const GRADE = 4;

export type Account = { loginId: string; password: string; fullName: string };

export const ADMIN: Account = {
  loginId: 'e2e-admin',
  password: 'e2e-admin-fictional-pass',
  fullName: 'ผู้ดูแลสมมติ',
};

// One account per scenario, so the tests never depend on each other's state.
export const STUDENTS = Object.freeze({
  registers: {
    loginId: 'e2e-student-a',
    password: 'e2e-student-a-fictional',
    fullName: 'ด.ช.สมมติ ลงทะเบียน',
  },
  firstLogin: {
    loginId: 'e2e-student-b',
    password: 'e2e-student-b-initial',
    fullName: 'ด.ญ.สมมติ เข้าครั้งแรก',
  },
  browses: {
    loginId: 'e2e-student-c',
    password: 'e2e-student-c-fictional',
    fullName: 'ด.ช.สมมติ ดูรายการ',
  },
} satisfies Record<string, Account>);

export const OPEN_CLUB = { code: 'E2E01', name: 'ชุมนุมสมมติ ดนตรี', capacity: 5 };
export const FULL_CLUB = { code: 'E2E02', name: 'ชุมนุมสมมติ เต็มแล้ว', capacity: 0 };
export const ADVISOR_NAME = 'ครูสมมติ ใจดี';
