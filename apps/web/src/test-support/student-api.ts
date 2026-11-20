import type {
  SessionUser,
  StudentClub,
  StudentRegistration,
  StudentRound,
  StudentWaitlist,
} from '@club-registration/shared';
import { mockApi } from './render-app';
import type { Handler } from './render-app';

// Every name below is made up.
export const STUDENT: SessionUser = {
  id: 1,
  loginId: 'demo1001',
  fullName: 'นักเรียนสมมติ หนึ่ง',
  role: 'student',
  mustChangePassword: false,
};

export const CLUBS_PATH = '/api/student/clubs';
export const ROUND_PATH = '/api/student/round';
export const REGISTER_PATH = '/api/student/registration';
export const CANCEL_PATH = '/api/student/registration/cancel';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const roundFixture = (overrides: Partial<StudentRound> = {}): StudentRound => ({
  id: 1,
  term: '2569/1',
  grade: 1,
  opensAt: '2026-12-01T01:00:00.000Z',
  closesAt: '2026-12-01T09:00:00.000Z',
  status: 'open',
  ...overrides,
});

export const CLUBS: StudentClub[] = [
  {
    id: 11,
    clubCode: 'A100',
    name: 'ชุมนุมหมากรุกสมมติ',
    description: 'เล่น <b>หมากรุก</b>\nทุกวันศุกร์',
    capacity: 30,
    registered: 12,
    remaining: 18,
    advisorNames: ['ครูสมมติ ใจดี', 'ครูสมมติ ใจเย็น'],
    waitlistCount: 0,
  },
  {
    id: 12,
    clubCode: 'B200',
    name: 'ชุมนุมดนตรีสมมติ',
    description: '',
    capacity: 20,
    registered: 20,
    remaining: 0,
    advisorNames: [],
    waitlistCount: 0,
  },
  {
    id: 13,
    clubCode: 'C300',
    name: 'ชุมนุมวาดภาพสมมติ',
    description: 'วาดภาพสีน้ำ',
    capacity: 25,
    registered: 3,
    remaining: 22,
    advisorNames: ['ครูสมมติ ศิลป์ดี'],
    waitlistCount: 0,
  },
];

export const registrationFor = (
  club: StudentClub,
  registeredAt = '2026-12-01T01:05:00.000Z',
): StudentRegistration => ({
  club: { id: club.id, clubCode: club.clubCode, name: club.name },
  registeredAt,
  promotedFromWaitlist: false,
});

export const apiError = (status: number, code: string) => () =>
  Response.json({ code, message: code }, { status });

export const networkFailure = () => Promise.reject(new TypeError('Failed to fetch'));

export const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

export const callsTo = (fetchMock: ReturnType<typeof mockApi>, method: string, path: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => input === path && (init?.method ?? 'GET') === method,
  );

export type StudentState = {
  round: StudentRound | null;
  registration: StudentRegistration | null;
  waitlist: StudentWaitlist | null;
  clubs: StudentClub[];
};

const withSeatChange = (clubs: StudentClub[], clubId: number, change: number) =>
  clubs.map((club) =>
    club.id === clubId
      ? {
          ...club,
          registered: club.registered + change,
          remaining: club.remaining - change,
        }
      : club,
  );

// A small in-memory stand-in for the student API, so refetches show what a write changed. A test
// changes `state` to make the next answer differ (e.g. the round opening).
export const mockStudentApi = (
  initial: Partial<StudentState> = {},
  extra: Record<string, Handler> = {},
) => {
  const state: StudentState = {
    round: roundFixture(),
    registration: null,
    waitlist: null,
    clubs: CLUBS,
    ...initial,
  };
  const fetchMock = mockApi({
    'GET /api/auth/me': () => Response.json({ user: STUDENT }),
    [`GET ${CLUBS_PATH}`]: () =>
      Response.json({
        round: state.round,
        registration: state.registration,
        waitlist: state.waitlist,
        clubs: state.round ? state.clubs : [],
      }),
    [`GET ${ROUND_PATH}`]: () =>
      Response.json({
        round: state.round,
        registration: state.registration,
        waitlist: state.waitlist,
      }),
    [`POST ${REGISTER_PATH}`]: (init) => {
      const { clubId } = bodyOf(init) as { clubId: number };
      const club = state.clubs.find(({ id }) => id === clubId);
      if (club && !state.registration) {
        state.registration = registrationFor(club);
        state.clubs = withSeatChange(state.clubs, clubId, 1);
      }
      return Response.json({ registration: state.registration });
    },
    [`POST ${CANCEL_PATH}`]: () => {
      if (state.registration) {
        state.clubs = withSeatChange(state.clubs, state.registration.club.id, -1);
        state.registration = null;
      }
      return Response.json({ registration: null });
    },
    ...extra,
  });
  return { fetchMock, state };
};
