import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/test-support/render-app';
import {
  ADMITTED,
  CLUBS,
  QUEUE_DONE_PATH,
  QUEUE_HEARTBEAT_PATH,
  QUEUE_JOIN_PATH,
  QUEUE_PATH,
  apiError,
  bodyOf,
  callsTo,
  mockStudentApi,
  networkFailure,
  registrationFor,
  roundFixture,
  waitingAt,
} from '@/test-support/student-api';
import { HEARTBEAT_INTERVAL_MS } from './queue-ui';

const [CHESS, , ART] = [CLUBS[0]!, CLUBS[1]!, CLUBS[2]!];
const CLUB_LIST = 'รายการชุมนุม';
const ADMITTED_LINE = 'ถึงคิวของคุณแล้ว เลือกชุมนุมได้ถึง 08:15 น.';
const RELEASE_BUTTON = 'เสร็จแล้ว ปล่อยคิว';
const REJOIN_BUTTON = 'เข้าคิวใหม่';
const KEEP_OPEN = 'อย่าปิดหรือสลับไปหน้าอื่นนาน ระบบอาจถือว่าออกจากคิว';

const queueCard = () => screen.getByRole('region', { name: 'คิวเลือกชุมนุม' });
const queueStatus = () => within(queueCard()).getByRole('status');
const clubList = () => screen.queryByRole('list', { name: CLUB_LIST });
const registerButton = (club: (typeof CLUBS)[number]) =>
  screen.getByRole<HTMLButtonElement>('button', { name: `ลงชุมนุม ${club.clubCode} ${club.name}` });

const openPage = async (options?: { strict?: boolean }) => {
  const router = renderAt('/student/clubs', options);
  await screen.findByRole('heading', { name: 'ภาคเรียน 2569/1 · ม.1' });
  return router;
};

const openWaiting = async (position = 3) => {
  const api = mockStudentApi({ joinTicket: waitingAt(position) });
  const router = await openPage();
  await within(queueCard()).findByText(String(position));
  return { ...api, router };
};

const openAdmitted = async () => {
  const api = mockStudentApi();
  const router = await openPage();
  await screen.findByRole('list', { name: CLUB_LIST });
  return { ...api, router };
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const beat = async () => {
  await advance(HEARTBEAT_INTERVAL_MS);
};

const setVisibility = (state: DocumentVisibilityState) => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  act(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
};

describe('student queue on the clubs page', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('joining', () => {
    it('joins the queue of an open round by itself with the empty JSON body', async () => {
      const { fetchMock } = await openAdmitted();

      const joins = callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH);
      expect(joins).toHaveLength(1);
      expect(bodyOf(joins[0]?.[1])).toEqual({});
    });

    it('joins once when StrictMode mounts the page twice', async () => {
      const { fetchMock } = mockStudentApi();

      await openPage({ strict: true });
      await screen.findByRole('list', { name: CLUB_LIST });

      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
    });

    it('hides the club list while the join is on its way', async () => {
      let answer: (response: Response) => void = () => undefined;
      const { state } = mockStudentApi(
        {},
        {
          [`POST ${QUEUE_JOIN_PATH}`]: () =>
            new Promise<Response>((resolve) => {
              answer = resolve;
            }),
        },
      );

      await openPage();

      expect(queueStatus().textContent).toBe('กำลังเข้าคิว…');
      expect(clubList()).toBeNull();
      state.ticket = ADMITTED;
      answer(Response.json({ round: roundFixture(), ticket: ADMITTED }));
      expect(await screen.findByRole('list', { name: CLUB_LIST })).toBeTruthy();
    });

    it.each(['upcoming', 'closed'] as const)(
      'makes no queue call and shows the club list as before while the round is %s',
      async (status) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { fetchMock } = mockStudentApi({ round: roundFixture({ status }) });

        await openPage();
        await screen.findByRole('list', { name: CLUB_LIST });
        await advance(60_000);

        expect(fetchMock.mock.calls.filter(([path]) => path.startsWith(QUEUE_PATH))).toEqual([]);
        expect(screen.queryByRole('region', { name: 'คิวเลือกชุมนุม' })).toBeNull();
        expect(registerButton(CHESS).disabled).toBe(true);
      },
    );

    it('joins when an upcoming round opens while the page is on screen', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const opensAt = new Date(Date.now() + 20_000).toISOString();
      const { fetchMock, state } = mockStudentApi({
        round: roundFixture({ status: 'upcoming', opensAt }),
      });
      await openPage();
      await screen.findByRole('list', { name: CLUB_LIST });
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(0);

      state.round = roundFixture({ status: 'open', opensAt });
      await advance(22_000);

      await waitFor(() => expect(queueStatus().textContent).toBe(ADMITTED_LINE));
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
    });

    it('falls back to the closed round when the join finds it closed', async () => {
      const api = mockStudentApi(
        {},
        {
          [`POST ${QUEUE_JOIN_PATH}`]: () => {
            api.state.round = roundFixture({ status: 'closed' });
            return apiError(409, 'round_not_open')();
          },
        },
      );

      await openPage();

      expect(await screen.findByText('รอบนี้ปิดรับลงทะเบียนแล้ว')).toBeTruthy();
      // The list of a round that is not open comes without a ticket, after the round read.
      await screen.findByRole('list', { name: CLUB_LIST });
      expect(screen.queryByRole('region', { name: 'คิวเลือกชุมนุม' })).toBeNull();
      expect(registerButton(CHESS).disabled).toBe(true);
      expect(callsTo(api.fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
    });

    it('retries a join that got no answer a few times, then offers a retry', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock } = mockStudentApi({}, { [`POST ${QUEUE_JOIN_PATH}`]: networkFailure });
      await openPage();

      await advance(60_000);

      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(4);
      expect(queueStatus().textContent).toContain('เข้าคิวไม่สำเร็จ เพราะเชื่อมต่อระบบไม่ได้');
      expect(screen.getByRole('button', { name: 'ลองเข้าคิวอีกครั้ง' })).toBeTruthy();
      expect(clubList()).toBeNull();
    });

    it('does not retry a refused join by itself, and the retry button joins again', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let refuse = true;
      const api = mockStudentApi(
        {},
        {
          [`POST ${QUEUE_JOIN_PATH}`]: () => {
            if (refuse) return apiError(429, 'rate_limited')();
            api.state.ticket = ADMITTED;
            return Response.json({ round: roundFixture(), ticket: ADMITTED });
          },
        },
      );
      const { fetchMock } = api;
      await openPage();
      const retryButton = await screen.findByRole('button', { name: 'ลองเข้าคิวอีกครั้ง' });
      expect(queueStatus().textContent).toBe('ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่');
      await advance(60_000);
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);

      refuse = false;
      fireEvent.click(retryButton);

      expect(await screen.findByRole('list', { name: CLUB_LIST })).toBeTruthy();
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(2);
    });

    it('stops sending heartbeats when the student leaves the page, and joins once on return', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, router } = await openAdmitted();
      await beat();
      const beats = callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH).length;
      expect(beats).toBeGreaterThan(0);

      // The home page, which has nothing of the queue (the result page keeps the ticket alive:
      // MyRegistrationPage.test.tsx).
      await act(async () => {
        await router.navigate('/student');
      });
      await advance(60_000);
      expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH)).toHaveLength(beats);

      await act(async () => {
        await router.navigate('/student/clubs');
      });
      await screen.findByRole('list', { name: CLUB_LIST });
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(2);
    });
  });

  describe('waiting', () => {
    it('shows the place in the queue and no club list or seat buttons', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await openWaiting(3);

      const card = queueCard();
      expect(queueStatus().textContent).toBe('รอคิว');
      expect(card.textContent).toContain('ลำดับที่ 3');
      expect(card.textContent).toContain('หน้านี้จะแสดงรายการชุมนุมให้เลือกเอง');
      expect(card.textContent).toContain(KEEP_OPEN);
      expect(clubList()).toBeNull();
      expect(screen.queryByRole('button', { name: /^ลงชุมนุม / })).toBeNull();
      expect(screen.queryByRole('button', { name: /^เข้ารายชื่อรอ / })).toBeNull();
      expect(screen.getByRole('heading', { name: 'ภาคเรียน 2569/1 · ม.1' })).toBeTruthy();
    });

    it('keeps the held club and its link to my registration on screen', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockStudentApi({ joinTicket: waitingAt(2), registration: registrationFor(ART) });
      await openPage();
      await within(queueCard()).findByText('2');

      expect(screen.getByRole('heading', { name: 'ชุมนุมของฉัน' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'ดูผลของฉันและยกเลิก' })).toBeTruthy();
      // The change buttons it would point to are hidden with the list.
      expect(document.body.textContent).not.toContain('ย้ายมาชุมนุมนี้');
    });

    it('sends a heartbeat every few seconds', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock } = await openWaiting();

      await beat();
      await beat();

      const beats = callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH);
      expect(beats).toHaveLength(2);
      expect(bodyOf(beats[0]?.[1])).toEqual({});
    });

    it('moves the number up without announcing it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = await openWaiting(3);

      state.ticket = waitingAt(1);
      await beat();

      await waitFor(() => expect(queueCard().textContent).toContain('ลำดับที่ 1'));
      expect(queueStatus().textContent).toBe('รอคิว');
    });

    it('shows the club list and announces the turn once let in', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = await openWaiting();

      state.ticket = ADMITTED;
      await beat();

      expect(await screen.findByRole('list', { name: CLUB_LIST })).toBeTruthy();
      expect(queueStatus().textContent).toBe(ADMITTED_LINE);
      expect(registerButton(CHESS).disabled).toBe(false);
      expect(queueCard().textContent).toContain(KEEP_OPEN);
    });

    it('leaves focus where it was when the student is let in', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = mockStudentApi({
        joinTicket: waitingAt(1),
        registration: registrationFor(ART),
      });
      await openPage();
      await within(queueCard()).findByText('1');
      const link = screen.getByRole('link', { name: 'ดูผลของฉันและยกเลิก' });
      link.focus();

      state.ticket = ADMITTED;
      await beat();

      await screen.findByRole('list', { name: CLUB_LIST });
      expect(document.activeElement).toBe(link);
    });

    it('does not take focus from the page when the student is let in', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = await openWaiting();
      expect(document.activeElement).toBe(document.body);

      state.ticket = ADMITTED;
      await beat();

      await screen.findByRole('list', { name: CLUB_LIST });
      expect(document.activeElement).toBe(document.body);
    });

    it('sends a heartbeat at once when the tab is shown again', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock } = await openWaiting();
      setVisibility('hidden');
      expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH)).toHaveLength(0);

      setVisibility('visible');

      await waitFor(() => expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH)).toHaveLength(1));
    });

    it('keeps the heartbeat going in a hidden tab', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock } = await openWaiting();
      setVisibility('hidden');

      await beat();

      expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH)).toHaveLength(1);
    });

    it('says so when heartbeats get no answer, and keeps the place shown', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const api = mockStudentApi(
        { joinTicket: waitingAt(2) },
        { [`POST ${QUEUE_HEARTBEAT_PATH}`]: networkFailure },
      );
      await openPage();
      await within(queueCard()).findByText('2');

      await advance(HEARTBEAT_INTERVAL_MS + 8_000);

      expect(await within(queueCard()).findByText(/เชื่อมต่อระบบไม่ได้ชั่วคราว/)).toBeTruthy();
      expect(queueCard().textContent).toContain('ลำดับที่ 2');
      expect(callsTo(api.fetchMock, 'POST', QUEUE_HEARTBEAT_PATH).length).toBeGreaterThan(1);
    });
  });

  describe('admitted', () => {
    it('shows until when the student may choose, with a release button', async () => {
      await openAdmitted();

      expect(queueStatus().textContent).toBe(ADMITTED_LINE);
      expect(screen.getByRole('button', { name: RELEASE_BUTTON })).toBeTruthy();
    });

    it('releases the turn, says so and sends no more heartbeats', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock } = await openAdmitted();

      fireEvent.click(screen.getByRole('button', { name: RELEASE_BUTTON }));

      await waitFor(() => expect(queueStatus().textContent).toBe('ปล่อยคิวแล้ว'));
      expect(bodyOf(callsTo(fetchMock, 'POST', QUEUE_DONE_PATH)[0]?.[1])).toEqual({});
      expect(clubList()).toBeNull();
      expect(screen.getByRole('button', { name: REJOIN_BUTTON })).toBeTruthy();
      expect(within(queueCard()).getByRole('link', { name: 'ดูผลของฉัน' }).getAttribute('href')).toBe(
        '/student/my-registration',
      );
      const beats = callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH).length;
      await advance(60_000);
      expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH)).toHaveLength(beats);
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
    });

    it('moves focus from the release button to the status line', async () => {
      await openAdmitted();
      const release = screen.getByRole('button', { name: RELEASE_BUTTON });
      release.focus();

      fireEvent.click(release);

      await waitFor(() => expect(document.activeElement).toBe(queueStatus()));
    });

    it('keeps the turn and says why when the release is refused', async () => {
      mockStudentApi({}, { [`POST ${QUEUE_DONE_PATH}`]: apiError(429, 'rate_limited') });
      await openPage();
      await screen.findByRole('list', { name: CLUB_LIST });

      fireEvent.click(screen.getByRole('button', { name: RELEASE_BUTTON }));

      expect(await within(queueCard()).findByRole('alert')).toBeTruthy();
      expect(queueCard().textContent).toContain('ส่งคำขอถี่เกินไป');
      expect(queueStatus().textContent).toBe(ADMITTED_LINE);
      expect(clubList()).toBeTruthy();
    });

    it('does not reopen a confirmation left open when the turn ended', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = await openAdmitted();
      fireEvent.click(registerButton(CHESS));
      expect(screen.getByRole('alertdialog')).toBeTruthy();

      state.ticket = { status: 'expired' };
      await beat();
      await screen.findByRole('button', { name: REJOIN_BUTTON });
      state.joinTicket = { status: 'admitted', admittedUntil: '2026-12-01T01:40:00.000Z' };
      fireEvent.click(screen.getByRole('button', { name: REJOIN_BUTTON }));

      await screen.findByRole('list', { name: CLUB_LIST });
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    it('keeps a confirmation open when the round closes under it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = await openAdmitted();
      fireEvent.click(registerButton(CHESS));

      state.round = roundFixture({ status: 'closed' });
      await advance(5_000);

      await waitFor(() => expect(screen.queryByRole('region', { name: 'คิวเลือกชุมนุม' })).toBeNull());
      expect(screen.getByRole('alertdialog')).toBeTruthy();
    });
  });

  describe('when the ticket ends', () => {
    it('shows the turn ended, reads the queue and stops polling, without rejoining', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, state } = await openAdmitted();

      state.ticket = { status: 'expired' };
      await beat();

      await waitFor(() => expect(queueStatus().textContent).toBe('หมดเวลาคิวแล้ว'));
      expect(clubList()).toBeNull();
      expect(callsTo(fetchMock, 'GET', QUEUE_PATH)).toHaveLength(1);
      const beats = callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH).length;
      await advance(60_000);
      expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH)).toHaveLength(beats);
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(1);
    });

    it.each([
      ['expired', 'หมดเวลาคิวแล้ว'],
      ['done', 'ปล่อยคิวแล้ว'],
    ] as const)(
      'tells a student without a club that they have none when the ticket is %s',
      async (status, headline) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { state } = await openAdmitted();

        state.ticket = { status };
        await beat();

        await waitFor(() => expect(queueStatus().textContent).toBe(headline));
        const text = queueCard().textContent;
        expect(text).toContain('คุณยังไม่ได้ลงชุมนุมในรอบนี้ ถ้าจะเลือก กดเข้าคิวใหม่');
        expect(text).not.toContain('ที่ลงไว้ยังอยู่');
      },
    );

    it.each(['expired', 'done'] as const)(
      'tells a student who holds a club that it stays when the ticket is %s',
      async (status) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { state } = mockStudentApi({ registration: registrationFor(ART) });
        await openPage();
        await screen.findByRole('list', { name: CLUB_LIST });

        state.ticket = { status };
        await beat();

        await screen.findByRole('button', { name: REJOIN_BUTTON });
        const text = queueCard().textContent;
        expect(text).toContain(`ชุมนุม ${ART.clubCode} ${ART.name} ที่ลงไว้ยังอยู่`);
        expect(text).not.toContain('ยังไม่ได้ลงชุมนุม');
      },
    );

    it('says why the turn ended only when it timed out', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = await openAdmitted();

      state.ticket = { status: 'done' };
      await beat();

      await screen.findByRole('button', { name: REJOIN_BUTTON });
      expect(queueCard().textContent).not.toContain('ไม่ได้ติดต่อระบบนานเกินไป');
    });

    it('shows the release from another tab as released', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = await openAdmitted();

      state.ticket = { status: 'done' };
      await beat();

      await waitFor(() => expect(queueStatus().textContent).toBe('ปล่อยคิวแล้ว'));
    });

    it('joins again at the back when the student asks, with focus on the status line', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, state } = await openAdmitted();
      state.ticket = { status: 'expired' };
      await beat();
      const rejoin = await screen.findByRole('button', { name: REJOIN_BUTTON });
      state.joinTicket = waitingAt(7);
      rejoin.focus();

      fireEvent.click(rejoin);

      await waitFor(() => expect(queueCard().textContent).toContain('ลำดับที่ 7'));
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(2);
      expect(document.activeElement).toBe(queueStatus());
    });

    it('moves focus from a club button the ended turn removed to the status line', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = await openAdmitted();
      const button = registerButton(CHESS);
      button.focus();

      state.ticket = { status: 'expired' };
      await beat();

      await screen.findByRole('button', { name: REJOIN_BUTTON });
      expect(document.activeElement).toBe(queueStatus());
    });

    it('moves focus from the release button to the heading when the round closes', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = await openAdmitted();
      screen.getByRole('button', { name: RELEASE_BUTTON }).focus();

      state.round = roundFixture({ status: 'closed' });
      await advance(5_000);

      await waitFor(() => expect(screen.queryByRole('region', { name: 'คิวเลือกชุมนุม' })).toBeNull());
      expect(clubList()).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'ชุมนุมในชั้นของฉัน' }));
    });
  });

  it('sends the student to the login page when the session expires mid-queue', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openWaiting();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(Response.json({ code: 'unauthorized', message: 'x' }, { status: 401 })),
      ),
    );

    await beat();

    expect(await screen.findByRole('button', { name: 'เข้าสู่ระบบ' })).toBeTruthy();
  });
});
