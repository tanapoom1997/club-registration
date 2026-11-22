import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/test-support/render-app';
import {
  ADMITTED,
  CLUBS,
  CLUBS_PATH,
  QUEUE_HEARTBEAT_PATH,
  QUEUE_JOIN_PATH,
  QUEUE_PATH,
  REGISTER_PATH,
  ROUND_PATH,
  apiError,
  callsTo,
  mockStudentApi,
  registrationFor,
  roundFixture,
  waitingAt,
  waitlistFor,
} from '@/test-support/student-api';
import { HEARTBEAT_INTERVAL_MS } from './queue-ui';
import { CLUBS_POLL_INTERVAL_MS } from './student-ui';

// The clubs page with the API's queue gate (README Phase 3, Q2): the fake API answers the club
// list and the seat writes 403 queue_required out of turn, as the real one does.

const [CHESS, MUSIC, ART] = [CLUBS[0]!, CLUBS[1]!, CLUBS[2]!];
const CLUB_LIST = 'รายการชุมนุม';
const REJOIN_BUTTON = 'เข้าคิวใหม่';
const EXPIRED_LINE = 'หมดเวลาคิวแล้ว';
const PROMOTED_TO_MUSIC = 'ได้ที่ในชุมนุม B200 ชุมนุมดนตรีสมมติ จากรายชื่อรอแล้ว';

const queueCard = () => screen.getByRole('region', { name: 'คิวเลือกชุมนุม' });
const queueStatus = () => within(queueCard()).getByRole('status');
const clubList = () => screen.queryByRole('list', { name: CLUB_LIST });
const registerButton = (club: (typeof CLUBS)[number]) =>
  screen.getByRole<HTMLButtonElement>('button', { name: `ลงชุมนุม ${club.clubCode} ${club.name}` });

const openPage = async () => {
  const router = renderAt('/student/clubs');
  await screen.findByRole('heading', { name: 'ภาคเรียน 2569/1 · ม.1' });
  return router;
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

// What a page that only ever hears queue_required must never show.
const expectNoGenericError = () => {
  expect(screen.queryByText('โหลดข้อมูลไม่สำเร็จ')).toBeNull();
  expect(screen.queryByText(/ไม่มีสิทธิ์/)).toBeNull();
  expect(screen.queryByText(/เชื่อมต่อระบบไม่ได้ชั่วคราว ตัวเลข/)).toBeNull();
  expect(screen.getByRole('heading', { name: 'ชุมนุมในชั้นของฉัน' })).toBeTruthy();
};

describe('clubs page behind the queue gate', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('while waiting', () => {
    it('starts from the round read and never asks for the club list', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock } = mockStudentApi({ joinTicket: waitingAt(2) });

      await openPage();
      await within(queueCard()).findByText('2');
      await advance(30_000);

      expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(0);
      expect(callsTo(fetchMock, 'GET', ROUND_PATH).length).toBeGreaterThan(1);
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
      expect(clubList()).toBeNull();
      expectNoGenericError();
    });

    it('asks for the club list once let in, and shows it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, state } = mockStudentApi({ joinTicket: waitingAt(1) });
      await openPage();
      await within(queueCard()).findByText('1');

      state.ticket = ADMITTED;
      await advance(HEARTBEAT_INTERVAL_MS);

      expect(await screen.findByRole('list', { name: CLUB_LIST })).toBeTruthy();
      expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(1);
    });

    it('keeps the held club, the waitlist place and its leave button from the round read', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockStudentApi({
        joinTicket: waitingAt(4),
        registration: registrationFor(ART),
        waitlist: waitlistFor(MUSIC, 3),
      });

      await openPage();
      await within(queueCard()).findByText('4');

      const held = screen.getByRole('heading', { name: 'ชุมนุมของฉัน' }).parentElement!;
      expect(held.textContent).toContain('C300 ชุมนุมวาดภาพสมมติ');
      const waiting = screen.getByRole('heading', { name: 'รายชื่อรอของฉัน' }).parentElement!;
      expect(waiting.textContent).toContain('B200 ชุมนุมดนตรีสมมติ');
      expect(waiting.textContent).toContain('ลำดับที่ 3');
      expect(within(waiting).getByRole('button', { name: 'ออกจากรายชื่อรอ' })).toBeTruthy();
    });

    it('shows a promotion that a poll of the round brings, with no club list', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, state } = mockStudentApi({
        joinTicket: waitingAt(4),
        registration: registrationFor(ART),
        waitlist: waitlistFor(MUSIC, 1),
      });
      await openPage();
      await within(queueCard()).findByText('4');

      state.registration = { ...registrationFor(MUSIC), promotedFromWaitlist: true };
      state.waitlist = null;
      await advance(CLUBS_POLL_INTERVAL_MS);

      expect(await screen.findByText(PROMOTED_TO_MUSIC)).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'รายชื่อรอของฉัน' })).toBeNull();
      expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(0);
    });
  });

  describe('when the API answers queue_required', () => {
    it('goes back to the queue after a refused register, with focus on the status line', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, state } = mockStudentApi();
      await openPage();
      await screen.findByRole('list', { name: CLUB_LIST });
      fireEvent.click(registerButton(CHESS));
      const dialog = screen.getByRole('alertdialog');
      const confirm = within(dialog).getByRole('button', { name: 'ยืนยัน ลงชุมนุม' });
      confirm.focus();
      // The turn ran out on the server before the next heartbeat could say so.
      state.ticket = { status: 'expired' };

      fireEvent.click(confirm);

      await waitFor(() => expect(queueStatus().textContent).toBe(EXPIRED_LINE));
      expect(clubList()).toBeNull();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.getByRole('button', { name: REJOIN_BUTTON })).toBeTruthy();
      expect(document.activeElement).toBe(queueStatus());
      expect(callsTo(fetchMock, 'POST', REGISTER_PATH)).toHaveLength(1);
      expect(callsTo(fetchMock, 'GET', QUEUE_PATH)).toHaveLength(1);
      await advance(60_000);
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
      expect(state.registration).toBeNull();
      expectNoGenericError();
    });

    it('goes back to the queue when the club list is refused, with focus on the status line', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let lists = 0;
      const api = mockStudentApi(
        {},
        {
          // The second poll of the list finds the turn over: only the gate says so, before
          // any heartbeat has.
          [`GET ${CLUBS_PATH}`]: () => {
            lists += 1;
            if (lists > 1) {
              api.state.ticket = { status: 'expired' };
              return apiError(403, 'queue_required')();
            }
            return Response.json({
              round: api.state.round,
              registration: null,
              waitlist: null,
              clubs: CLUBS,
            });
          },
        },
      );
      const { fetchMock } = api;
      await openPage();
      await screen.findByRole('list', { name: CLUB_LIST });
      registerButton(CHESS).focus();
      const beats = callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH).length;

      await advance(CLUBS_POLL_INTERVAL_MS);

      await waitFor(() => expect(queueStatus().textContent).toBe(EXPIRED_LINE));
      expect(clubList()).toBeNull();
      expect(document.activeElement).toBe(queueStatus());
      // The refusal itself sent the heartbeat that found the ticket over.
      expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH).length).toBeGreaterThan(beats);
      await advance(60_000);
      expect(lists).toBe(2);
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
      expectNoGenericError();
    });

    it('joins once when the list says the round opened before the round read did', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let refused = false;
      const api = mockStudentApi(
        { round: roundFixture({ status: 'upcoming' }) },
        {
          // By the API's clock the round has just opened; the page still thinks it upcoming.
          [`GET ${CLUBS_PATH}`]: () => {
            if (!refused) {
              refused = true;
              api.state.round = roundFixture({ status: 'open' });
              return apiError(403, 'queue_required')();
            }
            return Response.json({
              round: api.state.round,
              registration: null,
              waitlist: null,
              clubs: CLUBS,
            });
          },
        },
      );

      await openPage();

      expect(await screen.findByRole('list', { name: CLUB_LIST })).toBeTruthy();
      expect(queueStatus().textContent).toBe('ถึงคิวของคุณแล้ว เลือกชุมนุมได้ถึง 08:15 น.');
      await advance(30_000);
      expect(callsTo(api.fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
      expectNoGenericError();
    });
  });

  it.each(['upcoming', 'closed'] as const)(
    'lists the clubs of a %s round straight from the round read, with no queue',
    async (status) => {
      const { fetchMock } = mockStudentApi({ round: roundFixture({ status }) });

      await openPage();

      expect(await screen.findByRole('list', { name: CLUB_LIST })).toBeTruthy();
      expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([path]) => path.startsWith(QUEUE_PATH))).toEqual([]);
    },
  );
});
