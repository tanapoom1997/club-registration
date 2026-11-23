import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/test-support/render-app';
import {
  ADMITTED,
  CANCEL_PATH,
  CLUBS,
  QUEUE_HEARTBEAT_PATH,
  QUEUE_JOIN_PATH,
  QUEUE_PATH,
  ROUND_PATH,
  UUID_PATTERN,
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

const ART = CLUBS[2]!;
const HELD = registrationFor(ART);
const CANCEL_BUTTON = 'ยกเลิกชุมนุมนี้';
const DIALOG = `ยืนยันการยกเลิกชุมนุม ${ART.clubCode} ${ART.name}`;

const openPage = async () => {
  const router = renderAt('/student/my-registration');
  await screen.findByRole('heading', { name: 'ภาคเรียน 2569/1 · ม.1' });
  return router;
};

const confirmCancel = () => {
  fireEvent.click(screen.getByRole('button', { name: CANCEL_BUTTON }));
  const dialog = screen.getByRole('alertdialog', { name: DIALOG });
  fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน ยกเลิกชุมนุม' }));
  return dialog;
};

const cancelKeys = (fetchMock: ReturnType<typeof mockStudentApi>['fetchMock']) =>
  callsTo(fetchMock, 'POST', CANCEL_PATH).map(
    ([, init]) => (bodyOf(init) as { idempotencyKey: string }).idempotencyKey,
  );

describe('student my-registration page', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the held club with the time it was registered in Thai time', async () => {
    mockStudentApi({ registration: HELD });

    await openPage();

    const held = screen.getByRole('heading', { name: 'ชุมนุมของฉัน' }).parentElement as HTMLElement;
    expect(held.textContent).toContain('C300 ชุมนุมวาดภาพสมมติ');
    expect(held.textContent).toContain('ลงเมื่อ 1 ธ.ค. 2569 08:05 น.');
    expect(screen.getByText('เปิดอยู่')).toBeTruthy();
    expect(screen.getByRole('button', { name: CANCEL_BUTTON })).toBeTruthy();
  });

  it('points a student without a club to the club list', async () => {
    mockStudentApi();

    await openPage();

    const empty = screen.getByText('ยังไม่ได้ลงชุมนุม').parentElement as HTMLElement;
    expect(within(empty).getByRole('link', { name: 'ไปเลือกชุมนุม' }).getAttribute('href')).toBe(
      '/student/clubs',
    );
    expect(screen.queryByRole('button', { name: CANCEL_BUTTON })).toBeNull();
  });

  it.each(['upcoming', 'closed'] as const)(
    'offers no cancel button while the round is %s',
    async (status) => {
      mockStudentApi({ round: roundFixture({ status }), registration: HELD });

      await openPage();

      expect(screen.getByText('C300 ชุมนุมวาดภาพสมมติ')).toBeTruthy();
      expect(screen.queryByRole('button', { name: CANCEL_BUTTON })).toBeNull();
    },
  );

  it('warns that the seat may be taken and cancels only after confirmation', async () => {
    const { fetchMock } = mockStudentApi({ registration: HELD });
    await openPage();

    fireEvent.click(screen.getByRole('button', { name: CANCEL_BUTTON }));
    const dialog = screen.getByRole('alertdialog', { name: DIALOG });
    expect(dialog.textContent).toContain('อาจมีคนอื่นลงแทน');
    expect(callsTo(fetchMock, 'POST', CANCEL_PATH)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน ยกเลิกชุมนุม' }));

    expect(await screen.findByText(/ยกเลิกชุมนุมแล้ว/)).toBeTruthy();
    const [call] = callsTo(fetchMock, 'POST', CANCEL_PATH);
    expect(bodyOf(call?.[1])).toEqual({
      idempotencyKey: expect.stringMatching(UUID_PATTERN) as unknown,
    });
    expect(screen.getByText('ยังไม่ได้ลงชุมนุม')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(callsTo(fetchMock, 'GET', ROUND_PATH)).toHaveLength(2));
  });

  it('shows the cancel confirmation in the destructive style', async () => {
    mockStudentApi({ registration: HELD });
    await openPage();

    fireEvent.click(screen.getByRole('button', { name: CANCEL_BUTTON }));

    const dialog = screen.getByRole('alertdialog', { name: DIALOG });
    const confirm = within(dialog).getByRole('button', { name: 'ยืนยัน ยกเลิกชุมนุม' });
    expect(confirm.dataset.variant).toBe('destructive');
  });

  it('keeps the club when the student backs out of the confirmation', async () => {
    const { fetchMock } = mockStudentApi({ registration: HELD });
    await openPage();

    fireEvent.click(screen.getByRole('button', { name: CANCEL_BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: 'ไม่ยกเลิก' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: CANCEL_BUTTON })).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', CANCEL_PATH)).toHaveLength(0);
  });

  it.each([
    [
      'the dismiss button',
      (dialog: HTMLElement) => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'ไม่ยกเลิก' }));
      },
    ],
    [
      'Escape',
      (dialog: HTMLElement) => {
        fireEvent.keyDown(dialog, { key: 'Escape' });
      },
    ],
  ])(
    'returns focus to the cancel button when the student backs out with %s',
    async (_, backOut) => {
      mockStudentApi({ registration: HELD });
      await openPage();
      fireEvent.click(screen.getByRole('button', { name: CANCEL_BUTTON }));
      const dialog = screen.getByRole('alertdialog', { name: DIALOG });
      expect(document.activeElement).toBe(dialog);

      backOut(dialog);

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: CANCEL_BUTTON }));
    },
  );

  it('returns focus to the cancel button when a refusal is dismissed', async () => {
    mockStudentApi(
      { registration: HELD },
      { [`POST ${CANCEL_PATH}`]: apiError(429, 'rate_limited') },
    );
    await openPage();
    const dialog = confirmCancel();
    await within(dialog).findByRole('alert');

    fireEvent.click(within(dialog).getByRole('button', { name: 'ปิด' }));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: CANCEL_BUTTON }));
  });

  it('moves focus to the outcome once the cancel went through', async () => {
    mockStudentApi({ registration: HELD });
    await openPage();

    confirmCancel();

    const notice = await screen.findByText(/ยกเลิกชุมนุมแล้ว/);
    expect(document.activeElement).toBe(notice);
    expect(within(notice).getByRole('link', { name: 'ชุมนุมในชั้นของฉัน' })).toBeTruthy();
  });

  it.each([
    [409, 'round_not_open', 'ยกเลิกไม่ได้ เพราะรอบนี้ไม่ได้เปิดอยู่แล้ว'],
    [409, 'not_registered', 'คุณไม่มีชุมนุมที่ลงไว้ในรอบนี้ (อาจยกเลิกไปแล้ว)'],
    [409, 'idempotency_key_reused', 'คำขอนี้ซ้ำกับคำขอก่อนหน้า กรุณากดใหม่อีกครั้ง'],
    [429, 'rate_limited', 'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'],
    [400, 'validation_error', 'ยกเลิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'],
  ])('explains a %i %s refusal in Thai', async (status, code, message) => {
    const { fetchMock } = mockStudentApi(
      { registration: HELD },
      { [`POST ${CANCEL_PATH}`]: apiError(status, code) },
    );
    await openPage();

    const dialog = confirmCancel();

    expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
    expect(within(dialog).queryByRole('button', { name: 'ลองอีกครั้ง' })).toBeNull();
    await waitFor(() => expect(callsTo(fetchMock, 'GET', ROUND_PATH)).toHaveLength(2));
  });

  it('retries a cancel whose answer was lost with the same idempotency key', async () => {
    const { fetchMock, state } = mockStudentApi({ registration: HELD });
    let failNext = true;
    const answer = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input === CANCEL_PATH && failNext) {
        failNext = false;
        // The server applied the cancel; only the reply was lost on the way back.
        state.registration = null;
        return networkFailure();
      }
      return answer?.(input, init) ?? networkFailure();
    });
    await openPage();

    const dialog = confirmCancel();
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'ยังไม่รู้ว่ายกเลิกสำเร็จหรือไม่',
    );
    const retry = within(dialog).getByRole('button', { name: 'ลองอีกครั้ง' });
    // It resends the same cancel, so it looks like the confirm it repeats.
    expect(retry.dataset.variant).toBe('destructive');
    fireEvent.click(retry);

    expect(await screen.findByText(/ยกเลิกชุมนุมแล้ว/)).toBeTruthy();
    const keys = cancelKeys(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(UUID_PATTERN);
    expect(keys[1]).toBe(keys[0]);
  });

  it('says so when the student grade has no round', async () => {
    mockStudentApi({ round: null });
    renderAt('/student/my-registration');

    expect(await screen.findByText(/ยังไม่มีรอบลงทะเบียนของชั้นนี้/)).toBeTruthy();
  });

  it('tells a student whose account has no profile to contact an admin', async () => {
    mockStudentApi({}, { [`GET ${ROUND_PATH}`]: apiError(403, 'student_profile_missing') });
    renderAt('/student/my-registration');

    expect((await screen.findByRole('alert')).textContent).toContain('กรุณาติดต่อผู้ดูแลระบบ');
  });

  // README Phase 3, Q2: the result page keeps a live ticket alive, so a student who came here to
  // cancel keeps their place, but it never joins the queue itself.
  describe('queue ticket', () => {
    const TURN = 'คิวเลือกชุมนุม';
    const queueRegion = () => screen.queryByRole('region', { name: TURN });
    const queueCalls = (fetchMock: ReturnType<typeof mockStudentApi>['fetchMock']) =>
      fetchMock.mock.calls.filter(([path]) => path.startsWith(QUEUE_PATH));
    const beat = async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      });
    };

    it('reads a waiting ticket, then keeps it alive with heartbeats, never joining', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock } = mockStudentApi({ registration: HELD, ticket: waitingAt(2) });
      await openPage();

      const region = await screen.findByRole('region', { name: TURN });
      expect(callsTo(fetchMock, 'GET', QUEUE_PATH)).toHaveLength(1);
      expect(within(region).getByRole('status').textContent).toBe('รอคิว');
      expect(region.textContent).toContain('ลำดับที่ 2');
      const link = within(region).getByRole('link', { name: 'กลับไปหน้าเลือกชุมนุม' });
      expect(link.getAttribute('href')).toBe('/student/clubs');
      await beat();
      await beat();

      expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH)).toHaveLength(2);
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(0);
    });

    it('keeps the place out of the status line, which only says the state', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = mockStudentApi({ ticket: waitingAt(5) });
      await openPage();
      const region = await screen.findByRole('region', { name: TURN });

      state.ticket = waitingAt(4);
      await beat();

      await waitFor(() => expect(region.textContent).toContain('ลำดับที่ 4'));
      expect(within(region).getByRole('status').textContent).toBe('รอคิว');
    });

    it("shows the student's turn with its end time and a link to choose", async () => {
      mockStudentApi({ ticket: ADMITTED });
      await openPage();

      const region = await screen.findByRole('region', { name: TURN });
      expect(within(region).getByRole('status').textContent).toBe(
        'ถึงคิวของคุณแล้ว เลือกชุมนุมได้ถึง 08:15 น.',
      );
      const link = within(region).getByRole('link', { name: 'ไปเลือกชุมนุม' });
      expect(link.getAttribute('href')).toBe('/student/clubs');
    });

    it('offers one way to choose a club during the turn, not a second one in the no-club card', async () => {
      mockStudentApi({ ticket: ADMITTED });
      await openPage();
      await screen.findByRole('region', { name: TURN });

      expect(screen.getByText('ยังไม่ได้ลงชุมนุม')).toBeTruthy();
      expect(screen.getAllByRole('link', { name: 'ไปเลือกชุมนุม' })).toHaveLength(1);
    });

    it('stops and shows nothing once the ticket ends', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, state } = mockStudentApi({ ticket: ADMITTED });
      await openPage();
      await screen.findByRole('region', { name: TURN });

      state.ticket = { status: 'expired' };
      await beat();

      await waitFor(() => expect(queueRegion()).toBeNull());
      const beats = callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH).length;
      expect(callsTo(fetchMock, 'GET', QUEUE_PATH)).toHaveLength(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH)).toHaveLength(beats);
      expect(callsTo(fetchMock, 'POST', QUEUE_JOIN_PATH)).toHaveLength(0);
    });

    it('shows nothing and sends no heartbeat without a ticket', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock } = mockStudentApi({ registration: HELD });
      await openPage();
      await waitFor(() => expect(callsTo(fetchMock, 'GET', QUEUE_PATH)).toHaveLength(1));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(queueRegion()).toBeNull();
      expect(screen.queryByText(/ลำดับที่/)).toBeNull();
      expect(queueCalls(fetchMock)).toHaveLength(1);
    });

    it.each(['upcoming', 'closed'] as const)(
      'makes no queue call while the round is %s',
      async (status) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { fetchMock } = mockStudentApi({
          round: roundFixture({ status }),
          ticket: ADMITTED,
        });
        await openPage();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });

        expect(queueCalls(fetchMock)).toEqual([]);
        expect(queueRegion()).toBeNull();
      },
    );

    it('stops the heartbeats when the student leaves the page', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock } = mockStudentApi({ ticket: ADMITTED });
      const router = await openPage();
      await screen.findByRole('region', { name: TURN });
      await beat();
      const beats = callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH).length;

      await act(async () => {
        await router.navigate('/change-password');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(callsTo(fetchMock, 'POST', QUEUE_HEARTBEAT_PATH)).toHaveLength(beats);
    });
  });
});
