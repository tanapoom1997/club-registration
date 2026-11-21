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
  waits: {
    loginId: 'e2e-student-d',
    password: 'e2e-student-d-fictional',
    fullName: 'ด.ญ.สมมติ รอคิว',
  },
  holdsSeat: {
    loginId: 'e2e-student-e',
    password: 'e2e-student-e-fictional',
    fullName: 'ด.ช.สมมติ ถือที่นั่ง',
  },
  changes: {
    loginId: 'e2e-student-f',
    password: 'e2e-student-f-fictional',
    fullName: 'ด.ญ.สมมติ ย้ายชุมนุม',
  },
  seatedByAdmin: {
    loginId: 'e2e-student-g',
    password: 'e2e-student-g-fictional',
    fullName: 'ด.ช.สมมติ ผู้ดูแลจัดให้',
  },
  removedFromWaitlist: {
    loginId: 'e2e-student-h',
    password: 'e2e-student-h-fictional',
    fullName: 'ด.ญ.สมมติ ถูกนำออกจากคิว',
  },
} satisfies Record<string, Account>);

export const OPEN_CLUB = { code: 'E2E01', name: 'ชุมนุมสมมติ ดนตรี', capacity: 5 };
export const FULL_CLUB = { code: 'E2E02', name: 'ชุมนุมสมมติ เต็มแล้ว', capacity: 0 };
// One club per scenario, like the accounts: the waitlist one has a single seat, and the change
// goes from one to the other.
export const ONE_SEAT_CLUB = { code: 'E2E03', name: 'ชุมนุมสมมติ ที่นั่งเดียว', capacity: 1 };
export const CHANGE_FROM_CLUB = { code: 'E2E04', name: 'ชุมนุมสมมติ ต้นทาง', capacity: 3 };
export const CHANGE_TO_CLUB = { code: 'E2E05', name: 'ชุมนุมสมมติ ปลายทาง', capacity: 3 };
// The admin's member lists: a student seated in one club then moved to the other, and a club with
// no seats whose waitlist the admin clears.
export const ADMIN_FROM_CLUB = { code: 'E2E06', name: 'ชุมนุมสมมติ จัดให้', capacity: 2 };
export const ADMIN_TO_CLUB = { code: 'E2E07', name: 'ชุมนุมสมมติ ย้ายไป', capacity: 2 };
export const ADMIN_WAITLIST_CLUB = { code: 'E2E08', name: 'ชุมนุมสมมติ คิวรอ', capacity: 0 };
export const ADVISOR_NAME = 'ครูสมมติ ใจดี';
