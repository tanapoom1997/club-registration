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
  apiError,
  callsTo,
  mockStudentApi,
  roundFixture,
  waitingAt,
} from '@/test-support/student-api';
import type { StudentState } from '@/test-support/student-api';
import { HEARTBEAT_INTERVAL_MS } from './queue-ui';
import { CLUBS_POLL_INTERVAL_MS } from './student-ui';

// A round without a queue (README Phase 3 decision 6, Q4): the round read says hasQueue false,
// the page makes no queue call and shows the list, and an admin may turn the queue off or on while
// students have the page open. The fake API answers queue_off and gates nothing, as the real one.

const CHESS = CLUBS[0]!;
const CLUB_LIST = 'รายการชุมนุม';
const QUEUE_CARD = 'คิวเลือกชุมนุม';
const NO_QUEUE_ROUND = roundFixture({ hasQueue: false });

const queueCard = () => screen.queryByRole('region', { name: QUEUE_CARD });
const queueStatus = () =>
  within(screen.getByRole('region', { name: QUEUE_CARD })).getByRole('status');
const clubList = () => screen.queryByRole('list', { name: CLUB_LIST });
const registerButton = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: `ลงชุมนุม ${CHESS.clubCode} ${CHESS.name}` });

const queueCalls = (fetchMock: ReturnType<typeof mockStudentApi>['fetchMock']) =>
  fetchMock.mock.calls.filter(([input]) => input.startsWith(QUEUE_PATH));

const openPage = async (path = '/student/clubs') => {
  renderAt(path);
  await screen.findByRole('heading', { name: 'ภาคเรียน 2569/1 · ม.1' });
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const setQueue = (state: StudentState, hasQueue: boolean) => {
  state.round = roundFixture({ hasQueue });
};

// Nothing a switch of the setting should ever show.
const expectNoErrorShown = () => {
  expect(screen.queryByText(/เชื่อมต่อระบบไม่ได้ชั่วคราว/)).toBeNull();
  expect(screen.queryByText('โหลดข้อมูลไม่สำเร็จ')).toBeNull();
  expect(screen.queryByText(/เข้าคิวไม่สำเร็จ/)).toBeNull();
};

describe('student pages in a round without a queue', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the club list of an open round without any queue call', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchMock } = mockStudentApi({ round: NO_QUEUE_ROUND });

    await openPage();
    await screen.findByRole('list', { name: CLUB_LIST });
    await advance(30_000);

    expect(queueCalls(fetchMock)).toEqual([]);
    expect(queueCard()).toBeNull();
    expect(registerButton().disabled).toBe(false);
  });

  it('lets the student register without a turn', async () => {
    const { fetchMock, state } = mockStudentApi({ round: NO_QUEUE_ROUND });
    await openPage();
    await screen.findByRole('list', { name: CLUB_LIST });

    fireEvent.click(registerButton());
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'ยืนยัน ลงชุมนุม' }),
    );

    await waitFor(() => expect(state.registration?.club.id).toBe(CHESS.id));
    expect(callsTo(fetchMock, 'POST', REGISTER_PATH)).toHaveLength(1);
    expect(queueCalls(fetchMock)).toEqual([]);
  });

  it('makes no queue call from the result page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchMock } = mockStudentApi({ round: NO_QUEUE_ROUND, ticket: ADMITTED });

    await openPage('/student/my-registration');
    await advance(30_000);

    expect(queueCalls(fetchMock)).toEqual([]);
    expect(screen.queryByText(/ถึงคิวของคุณแล้ว/)).toBeNull();
  });

  describe('when an admin turns the queue off', () => {
    it('shows the list to a waiting student after a heartbeat answers queue_off', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, state } = mockStudentApi({ joinTicket: waitingAt(3) });
      await openPage();
      await within(screen.getByRole('region', { name: QUEUE_CARD })).findByText('3');
      expect(clubList()).toBeNull();

      setQueue(state, false);
      await advance(HEARTBEAT_INTERVAL_MS);

      expect(await screen.findByRole('list', { name: CLUB_LIST })).toBeTruthy();
      expect(queueCard()).toBeNull();
      expectNoErrorShown();
      const beats = callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH).length;
      await advance(5 * HEARTBEAT_INTERVAL_MS);
      expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH)).toHaveLength(beats);
    });

    it('shows the list when the join itself answers queue_off', async () => {
      const { fetchMock, state } = mockStudentApi(
        {},
        {
          // Turned off between the round read and the join.
          [`POST ${QUEUE_JOIN_PATH}`]: () => {
            setQueue(state, false);
            return apiError(409, 'queue_off')();
          },
        },
      );

      await openPage();

      expect(await screen.findByRole('list', { name: CLUB_LIST })).toBeTruthy();
      expect(queueCard()).toBeNull();
      expectNoErrorShown();
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
    });

    it('stops the heartbeats of the result page', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, state } = mockStudentApi({ ticket: waitingAt(2) });
      await openPage('/student/my-registration');
      await screen.findByText(/ลำดับที่/);

      setQueue(state, false);
      await advance(HEARTBEAT_INTERVAL_MS);
      await waitFor(() => expect(screen.queryByText(/ลำดับที่/)).toBeNull());
      const beats = callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH).length;
      await advance(5 * HEARTBEAT_INTERVAL_MS);

      expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH)).toHaveLength(beats);
    });
  });

  describe('when an admin turns the queue on', () => {
    it('joins exactly once once the list answers queue_required', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, state } = mockStudentApi({
        round: NO_QUEUE_ROUND,
        joinTicket: waitingAt(4),
      });
      await openPage();
      await screen.findByRole('list', { name: CLUB_LIST });

      setQueue(state, true);
      await advance(CLUBS_POLL_INTERVAL_MS);

      await waitFor(() => expect(queueStatus().textContent).toBe('รอคิว'));
      expect(clubList()).toBeNull();
      await advance(6 * HEARTBEAT_INTERVAL_MS);
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
      expect(within(screen.getByRole('region', { name: QUEUE_CARD })).getByText('4')).toBeTruthy();
      expectNoErrorShown();
    });

    it('joins exactly once after a refused register', async () => {
      const { fetchMock, state } = mockStudentApi({ round: NO_QUEUE_ROUND });
      await openPage();
      await screen.findByRole('list', { name: CLUB_LIST });
      fireEvent.click(registerButton());
      setQueue(state, true);

      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'ยืนยัน ลงชุมนุม' }),
      );

      // The fake lets the student in at once, as with room in the queue: the list comes back.
      await waitFor(() => expect(queueStatus().textContent).toMatch(/^ถึงคิวของคุณแล้ว/));
      expect(await screen.findByRole('list', { name: CLUB_LIST })).toBeTruthy();
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
      expect(state.registration).toBeNull();
    });

    it('joins again rather than showing an old ticket expired after an off and on', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, state } = mockStudentApi();
      await openPage();
      await screen.findByRole('list', { name: CLUB_LIST });
      setQueue(state, false);
      await advance(HEARTBEAT_INTERVAL_MS);
      await waitFor(() => expect(queueCard()).toBeNull());
      // The ticket ran out while the queue was off; the next join makes a new one.
      state.ticket = { status: 'expired' };

      setQueue(state, true);
      await advance(CLUBS_POLL_INTERVAL_MS);

      await waitFor(() => expect(queueStatus().textContent).toMatch(/^ถึงคิวของคุณแล้ว/));
      expect(screen.queryByText('หมดเวลาคิวแล้ว')).toBeNull();
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(2);
      expect(callsTo(fetchMock, 'GET', CLUBS_PATH).length).toBeGreaterThan(0);
    });
  });
});
