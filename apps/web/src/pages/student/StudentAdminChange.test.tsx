import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { StudentAdminChange } from '@club-registration/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/test-support/render-app';
import {
  CLUBS,
  CLUBS_PATH,
  adminChangeFor,
  callsTo,
  mockStudentApi,
  registrationFor,
  roundFixture,
  waitingAt,
  waitlistFor,
} from '@/test-support/student-api';
import type { StudentState } from '@/test-support/student-api';
import { CLUBS_POLL_INTERVAL_MS } from './student-ui';

// The notice of what an admin last did to the student's seat or waitlist place (README Phase 4,
// P3), on both student pages. Every name below is made up.

const [CHESS, MUSIC, ART] = [CLUBS[0]!, CLUBS[1]!, CLUBS[2]!];
const AT = 'เมื่อ 1 ธ.ค. 2569 09:20 น.';
const CHOOSE_AGAIN = 'ตอนนี้คุณยังไม่มีชุมนุมในรอบนี้ เลือกชุมนุมใหม่ได้ระหว่างที่รอบยังเปิดอยู่';
const ASSIGNED = `ผู้ดูแลระบบจัดให้คุณอยู่ชุมนุม A100 ชุมนุมหมากรุกสมมติ ${AT}`;
const MOVED = `ผู้ดูแลระบบย้ายคุณจากชุมนุม C300 ชุมนุมวาดภาพสมมติ ไปชุมนุม A100 ชุมนุมหมากรุกสมมติ ${AT}`;
const REMOVED = `ผู้ดูแลระบบนำคุณออกจากชุมนุม A100 ชุมนุมหมากรุกสมมติ ${AT} ${CHOOSE_AGAIN}`;
const WAITLIST_REMOVED = `ผู้ดูแลระบบนำคุณออกจากรายชื่อรอของชุมนุม B200 ชุมนุมดนตรีสมมติ ${AT} ถ้ายังอยากได้ชุมนุมนี้ เข้ารายชื่อรอใหม่ได้ระหว่างที่รอบยังเปิดอยู่ (จะได้ลำดับท้ายคิว)`;

// Each kind with the state the admin left behind it and what the student reads.
const CASES: readonly [StudentAdminChange['kind'], Partial<StudentState>, string][] = [
  [
    'assigned',
    { registration: registrationFor(CHESS), adminChange: adminChangeFor('assigned', CHESS) },
    ASSIGNED,
  ],
  [
    'moved',
    { registration: registrationFor(CHESS), adminChange: adminChangeFor('moved', CHESS, ART) },
    MOVED,
  ],
  ['removed', { adminChange: adminChangeFor('removed', CHESS) }, REMOVED],
  [
    'waitlist_removed',
    { adminChange: adminChangeFor('waitlist_removed', MUSIC) },
    WAITLIST_REMOVED,
  ],
];

const PAGES = [
  ['ผลของฉัน', '/student/my-registration'],
  ['ชุมนุมในชั้นของฉัน', '/student/clubs'],
] as const;

const openPage = async (path: string) => {
  const router = renderAt(path);
  await screen.findByRole('heading', { name: 'ภาคเรียน 2569/1 · ม.1' });
  return router;
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const noticeOf = (text: string) => screen.getByText(text);
const anyAdminNotice = () => screen.queryByText(/^ผู้ดูแลระบบ/);

describe('notice of an admin change', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe.each(PAGES)('on %s', (_name, path) => {
    it.each(CASES)('says what an admin did: %s', async (_kind, state, text) => {
      mockStudentApi(state);

      await openPage(path);

      const notice = noticeOf(text);
      // Inside a polite live region that is always there, so its arrival is announced.
      expect(notice.parentElement?.getAttribute('role')).toBe('status');
      expect(notice.textContent).not.toMatch(/admin|ดูแลสมมติ/);
    });

    it('shows nothing when no admin changed anything', async () => {
      mockStudentApi({ registration: registrationFor(CHESS), waitlist: waitlistFor(MUSIC) });

      await openPage(path);

      expect(anyAdminNotice()).toBeNull();
    });

    it.each([
      ['closed', 'รอบนี้ปิดแล้ว ถ้ามีข้อสงสัยกรุณาติดต่อครูที่ดูแลการลงทะเบียน'],
      ['upcoming', 'ตอนนี้คุณยังไม่มีชุมนุมในรอบนี้ เลือกชุมนุมได้เมื่อรอบเปิด'],
    ] as const)('tells a student removed in a %s round what to do', async (status, hint) => {
      mockStudentApi({
        round: roundFixture({ status }),
        adminChange: adminChangeFor('removed', CHESS),
      });

      await openPage(path);

      expect(noticeOf(`ผู้ดูแลระบบนำคุณออกจากชุมนุม A100 ชุมนุมหมากรุกสมมติ ${AT} ${hint}`)).toBeTruthy();
    });
  });

  it('shows in the queue waiting view, which reads the round only', async () => {
    const { fetchMock } = mockStudentApi({
      joinTicket: waitingAt(4),
      adminChange: adminChangeFor('removed', CHESS),
    });

    await openPage('/student/clubs');

    const queue = screen.getByRole('region', { name: 'คิวเลือกชุมนุม' });
    expect(await within(queue).findByText('4')).toBeTruthy();
    expect(noticeOf(REMOVED)).toBeTruthy();
    expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(0);
  });

  describe('as polls bring it', () => {
    it('appears, is replaced by the next change, then goes', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = mockStudentApi({ registration: registrationFor(ART) });
      await openPage('/student/clubs');
      await screen.findByRole('list', { name: 'รายการชุมนุม' });
      expect(anyAdminNotice()).toBeNull();

      state.registration = registrationFor(CHESS);
      state.adminChange = adminChangeFor('moved', CHESS, ART);
      await advance(CLUBS_POLL_INTERVAL_MS);
      expect(await screen.findByText(MOVED)).toBeTruthy();

      state.registration = null;
      state.adminChange = adminChangeFor('removed', CHESS);
      await advance(CLUBS_POLL_INTERVAL_MS);
      expect(await screen.findByText(REMOVED)).toBeTruthy();
      expect(screen.queryByText(MOVED)).toBeNull();

      // Here, a register by the student in another tab: the change is no longer the latest.
      state.registration = registrationFor(ART);
      state.adminChange = null;
      await advance(CLUBS_POLL_INTERVAL_MS);
      await waitFor(() => expect(anyAdminNotice()).toBeNull());
    });

    it('stays the same node with the same text when a poll brings the same change', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock } = mockStudentApi({
        registration: registrationFor(CHESS),
        adminChange: adminChangeFor('assigned', CHESS),
      });
      await openPage('/student/clubs');
      const notice = noticeOf(ASSIGNED);
      const reads = fetchMock.mock.calls.length;

      await advance(2 * CLUBS_POLL_INTERVAL_MS);

      expect(fetchMock.mock.calls.length).toBeGreaterThan(reads);
      expect(noticeOf(ASSIGNED)).toBe(notice);
    });
  });

  it('goes as soon as the student cancels the seat the admin gave', async () => {
    mockStudentApi({
      registration: registrationFor(ART),
      adminChange: adminChangeFor('assigned', ART),
    });
    await openPage('/student/my-registration');
    expect(anyAdminNotice()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกชุมนุมนี้' }));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน ยกเลิกชุมนุม' }));

    expect(await screen.findByText(/^ยกเลิกชุมนุมแล้ว/)).toBeTruthy();
    expect(anyAdminNotice()).toBeNull();
  });

  describe('focus, when the change removes the focused element', () => {
    it('moves from the cancel button to the notice on ผลของฉัน', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      // Waiting in an open round, so the page polls.
      const { state } = mockStudentApi({
        registration: registrationFor(ART),
        waitlist: waitlistFor(MUSIC),
      });
      await openPage('/student/my-registration');
      screen.getByRole('button', { name: 'ยกเลิกชุมนุมนี้' }).focus();

      state.registration = null;
      state.adminChange = adminChangeFor('removed', ART);
      await advance(CLUBS_POLL_INTERVAL_MS);

      const notice = await screen.findByText(/^ผู้ดูแลระบบนำคุณออกจากชุมนุม C300/);
      await waitFor(() => expect(document.activeElement).toBe(notice));
    });

    it('moves from the leave button to the notice on the clubs page', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = mockStudentApi({ waitlist: waitlistFor(MUSIC) });
      await openPage('/student/clubs');
      screen.getByRole('button', { name: 'ออกจากรายชื่อรอ' }).focus();

      state.waitlist = null;
      state.adminChange = adminChangeFor('waitlist_removed', MUSIC);
      await advance(CLUBS_POLL_INTERVAL_MS);

      const notice = await screen.findByText(WAITLIST_REMOVED);
      await waitFor(() => expect(document.activeElement).toBe(notice));
    });

    it('moves from the link in the held club card to the notice on the clubs page', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = mockStudentApi({ registration: registrationFor(CHESS) });
      await openPage('/student/clubs');
      await screen.findByRole('list', { name: 'รายการชุมนุม' });
      screen.getByRole('link', { name: 'ดูผลของฉันและยกเลิก' }).focus();

      state.registration = null;
      state.adminChange = adminChangeFor('removed', CHESS);
      await advance(CLUBS_POLL_INTERVAL_MS);

      const notice = await screen.findByText(REMOVED);
      await waitFor(() => expect(document.activeElement).toBe(notice));
    });
  });
});
