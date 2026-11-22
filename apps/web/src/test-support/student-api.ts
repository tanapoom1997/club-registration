import type {
  QueueTicket,
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

export const QUEUE_PATH = '/api/student/queue';
export const QUEUE_JOIN_PATH = '/api/student/queue/join';
export const QUEUE_HEARTBEAT_PATH = '/api/student/queue/heartbeat';
export const QUEUE_DONE_PATH = '/api/student/queue/done';

// 08:15 Thai time on the fixture round's day.
export const ADMITTED_UNTIL = '2026-12-01T01:15:00.000Z';
export const ADMITTED: QueueTicket = { status: 'admitted', admittedUntil: ADMITTED_UNTIL };
export const waitingAt = (position: number): QueueTicket => ({ status: 'waiting', position });

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
  // The student's latest queue ticket, and the one a join gives when there is no live ticket.
  ticket: QueueTicket | null;
  joinTicket: QueueTicket;
};

const isLiveTicket = (ticket: QueueTicket | null) =>
  ticket?.status === 'waiting' || ticket?.status === 'admitted';

// The API's queue gate (Q2), enforced here too so a page that asked for the list or a seat out of
// turn fails in its tests as it would against the real API: in an open round, the club list and
// the seat-taking writes need an admitted ticket.
const outOfTurn = (state: StudentState) =>
  state.round?.status === 'open' && state.ticket?.status !== 'admitted';
const queueRequired = apiError(403, 'queue_required');

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
    ticket: null,
    // Let in at once, as with the default max_active, so the club list shows straight away.
    joinTicket: ADMITTED,
    ...initial,
  };
  const queueAnswer = () => Response.json({ round: state.round, ticket: state.ticket });
  const fetchMock = mockApi({
    'GET /api/auth/me': () => Response.json({ user: STUDENT }),
    [`GET ${CLUBS_PATH}`]: () =>
      outOfTurn(state)
        ? queueRequired()
        : Response.json({
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
      if (outOfTurn(state)) return queueRequired();
      const club = keyedClubOf(state, init);
      if (club && !state.registration) {
        if (!seatFree(club)) return apiError(409, 'club_full')();
        state.registration = registrationFor(club);
        state.clubs = withSeatChange(state.clubs, club.id, 1);
      }
      return Response.json({ registration: state.registration });
    },
    [`PUT ${REGISTER_PATH}`]: (init) => {
      if (outOfTurn(state)) return queueRequired();
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
      if (outOfTurn(state)) return queueRequired();
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
    // The queue as the API keeps it: a join answers the live ticket or makes the next one (only
    // while the round is open), a heartbeat needs a live ticket, done ends it.
    [`POST ${QUEUE_JOIN_PATH}`]: () => {
      if (!isLiveTicket(state.ticket)) {
        if (state.round?.status !== 'open') return apiError(409, 'round_not_open')();
        state.ticket = state.joinTicket;
      }
      return queueAnswer();
    },
    [`POST ${QUEUE_HEARTBEAT_PATH}`]: () =>
      isLiveTicket(state.ticket) ? queueAnswer() : apiError(409, 'not_in_queue')(),
    [`POST ${QUEUE_DONE_PATH}`]: () => {
      if (isLiveTicket(state.ticket)) state.ticket = { status: 'done' };
      return queueAnswer();
    },
    [`GET ${QUEUE_PATH}`]: queueAnswer,
    ...extra,
  });
  return { fetchMock, state };
};
