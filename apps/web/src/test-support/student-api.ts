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
// A change is a PUT to REGISTER_PATH.
export const WAITLIST_PATH = '/api/student/waitlist';
export const LEAVE_PATH = '/api/student/waitlist/leave';

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

export const waitlistFor = (
  club: StudentClub,
  position = 1,
  joinedAt = '2026-12-01T01:10:00.000Z',
): StudentWaitlist => ({
  club: { id: club.id, clubCode: club.clubCode, name: club.name },
  position,
  joinedAt,
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

const withWaiterChange = (clubs: StudentClub[], clubId: number, change: number) =>
  clubs.map((club) =>
    club.id === clubId ? { ...club, waitlistCount: club.waitlistCount + change } : club,
  );

// The server's rule: a seat is taken directly only when free and nobody waits for it.
const seatFree = (club: StudentClub) => club.remaining > 0 && club.waitlistCount === 0;

const keyedClubOf = (state: StudentState, init: RequestInit | undefined) => {
  const { clubId } = bodyOf(init) as { clubId: number };
  return state.clubs.find(({ id }) => id === clubId);
};

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
      const club = keyedClubOf(state, init);
      if (club && !state.registration) {
        if (!seatFree(club)) return apiError(409, 'club_full')();
        state.registration = registrationFor(club);
        state.clubs = withSeatChange(state.clubs, club.id, 1);
      }
      return Response.json({ registration: state.registration });
    },
    [`PUT ${REGISTER_PATH}`]: (init) => {
      const club = keyedClubOf(state, init);
      if (!club) return apiError(404, 'not_found')();
      if (!state.registration) return apiError(409, 'not_registered')();
      if (state.registration.club.id !== club.id) {
        if (!seatFree(club)) return apiError(409, 'club_full')();
        state.clubs = withSeatChange(state.clubs, state.registration.club.id, -1);
        state.clubs = withSeatChange(state.clubs, club.id, 1);
        state.registration = registrationFor(club, '2026-12-01T02:00:00.000Z');
      }
      return Response.json({ registration: state.registration });
    },
    [`POST ${WAITLIST_PATH}`]: (init) => {
      const club = keyedClubOf(state, init);
      if (!club) return apiError(404, 'not_found')();
      if (state.waitlist?.club.id !== club.id) {
        // Joining another queue gives up the place in the old one.
        if (state.waitlist) {
          state.clubs = withWaiterChange(state.clubs, state.waitlist.club.id, -1);
        }
        state.waitlist = waitlistFor(club, club.waitlistCount + 1, '2026-12-01T02:30:00.000Z');
        state.clubs = withWaiterChange(state.clubs, club.id, 1);
      }
      return Response.json({ waitlist: state.waitlist });
    },
    [`POST ${LEAVE_PATH}`]: () => {
      if (!state.waitlist) return apiError(409, 'not_waitlisted')();
      state.clubs = withWaiterChange(state.clubs, state.waitlist.club.id, -1);
      state.waitlist = null;
      return Response.json({ waitlist: null });
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
