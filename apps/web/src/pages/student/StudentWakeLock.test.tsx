import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/test-support/render-app';
import { ADMITTED, mockStudentApi, roundFixture, waitingAt } from '@/test-support/student-api';
import { installWakeLock, removeWakeLock, setVisibility } from '@/test-support/wake-lock';
import { HEARTBEAT_INTERVAL_MS } from './queue-ui';

// U1: how long is too long, and what is lost (the place) and kept (a club already chosen).
const KEEP_OPEN =
  'เปิดหน้านี้ค้างไว้และอย่าให้จอดับ ถ้าสลับไปแอปอื่นหรือล็อกจอนานราว 1 นาที จะหลุดจากคิวและต้องเข้าคิวใหม่ต่อท้าย (ถ้าลงชุมนุมไว้แล้ว ชุมนุมนั้นยังอยู่)';
const queueCard = () => screen.getByRole('region', { name: 'คิวเลือกชุมนุม' });

const openClubsPage = async () => {
  const router = renderAt('/student/clubs');
  await screen.findByRole('heading', { name: 'ภาคเรียน 2569/1 · ม.1' });
  return router;
};

const beat = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
  });
};

describe('keeping the screen on while the student holds a queue ticket', () => {
  afterEach(() => {
    cleanup();
    removeWakeLock();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('on the clubs page', () => {
    it('keeps the screen on while waiting, and says why', async () => {
      const lock = installWakeLock();
      mockStudentApi({ joinTicket: waitingAt(3) });

      await openClubsPage();
      await within(queueCard()).findByText('3');

      await waitFor(() => expect(lock.live()).toHaveLength(1));
      expect(queueCard().textContent).toContain(KEEP_OPEN);
    });

    it('keeps the same lock when the turn comes', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const lock = installWakeLock();
      const { state } = mockStudentApi({ joinTicket: waitingAt(1) });
      await openClubsPage();
      await waitFor(() => expect(lock.live()).toHaveLength(1));

      state.ticket = ADMITTED;
      await beat();

      await screen.findByRole('list', { name: 'รายการชุมนุม' });
      expect(lock.request).toHaveBeenCalledTimes(1);
      expect(lock.live()).toHaveLength(1);
    });

    it('lets the screen sleep once the student releases the turn', async () => {
      const lock = installWakeLock();
      mockStudentApi();
      await openClubsPage();
      await waitFor(() => expect(lock.live()).toHaveLength(1));

      fireEvent.click(screen.getByRole('button', { name: 'เสร็จแล้ว ปล่อยคิว' }));

      await waitFor(() =>
        expect(within(queueCard()).getByRole('status').textContent).toBe('ปล่อยคิวแล้ว'),
      );
      await waitFor(() => expect(lock.live()).toHaveLength(0));
    });

    it('lets the screen sleep once the ticket timed out', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const lock = installWakeLock();
      const { state } = mockStudentApi({ joinTicket: waitingAt(2) });
      await openClubsPage();
      await waitFor(() => expect(lock.live()).toHaveLength(1));

      state.ticket = { status: 'expired' };
      await beat();

      await waitFor(() =>
        expect(within(queueCard()).getByRole('status').textContent).toBe('หมดเวลาคิวแล้ว'),
      );
      expect(lock.live()).toHaveLength(0);
    });

    it('asks again when the student comes back to the page', async () => {
      const lock = installWakeLock();
      mockStudentApi();
      await openClubsPage();
      await waitFor(() => expect(lock.live()).toHaveLength(1));

      setVisibility('hidden');
      act(() => {
        lock.sentinels[0]?.dropByBrowser();
      });
      setVisibility('visible');

      await waitFor(() => expect(lock.request).toHaveBeenCalledTimes(2));
      expect(lock.live()).toHaveLength(1);
    });

    it('lets the screen sleep when the student leaves the page', async () => {
      const lock = installWakeLock();
      mockStudentApi();
      const router = await openClubsPage();
      await waitFor(() => expect(lock.live()).toHaveLength(1));

      await act(async () => {
        await router.navigate('/change-password');
      });

      await waitFor(() => expect(lock.live()).toHaveLength(0));
    });

    it.each([
      ['without a queue', roundFixture({ hasQueue: false })],
      ['not open yet', roundFixture({ status: 'upcoming' })],
    ])('asks for nothing in a round %s', async (_, round) => {
      const lock = installWakeLock();
      mockStudentApi({ round });

      await openClubsPage();
      await screen.findByRole('list', { name: 'รายการชุมนุม' });

      expect(lock.request).not.toHaveBeenCalled();
    });

    it('still queues in a browser that refuses the lock', async () => {
      const lock = installWakeLock();
      lock.refuse();
      const log = vi.spyOn(console, 'error');
      mockStudentApi();

      await openClubsPage();

      expect(await screen.findByRole('list', { name: 'รายการชุมนุม' })).toBeTruthy();
      expect(lock.request).toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('on my registration', () => {
    const openMyRegistration = async () => {
      const router = renderAt('/student/my-registration');
      await screen.findByRole('heading', { name: 'ภาคเรียน 2569/1 · ม.1' });
      return router;
    };

    it('keeps the screen on while the keepalive runs, and says why', async () => {
      const lock = installWakeLock();
      mockStudentApi({ ticket: waitingAt(2) });

      await openMyRegistration();
      const region = await screen.findByRole('region', { name: 'คิวเลือกชุมนุม' });

      await waitFor(() => expect(lock.live()).toHaveLength(1));
      expect(region.textContent).toContain(KEEP_OPEN);
    });

    it('asks for nothing without a live ticket', async () => {
      const lock = installWakeLock();
      const { fetchMock } = mockStudentApi();

      await openMyRegistration();
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/student/queue', expect.anything()),
      );

      expect(lock.request).not.toHaveBeenCalled();
      expect(screen.queryByText(KEEP_OPEN)).toBeNull();
    });

    it('lets the screen sleep once the ticket ends', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const lock = installWakeLock();
      const { state } = mockStudentApi({ ticket: ADMITTED });
      await openMyRegistration();
      await waitFor(() => expect(lock.live()).toHaveLength(1));

      state.ticket = { status: 'expired' };
      await beat();

      await waitFor(() => expect(screen.queryByRole('region', { name: 'คิวเลือกชุมนุม' })).toBeNull());
      expect(lock.live()).toHaveLength(0);
    });
  });
});
