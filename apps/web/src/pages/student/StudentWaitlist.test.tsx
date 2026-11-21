import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/test-support/render-app';
import {
  CLUBS,
  CLUBS_PATH,
  LEAVE_PATH,
  ROUND_PATH,
  UUID_PATTERN,
  WAITLIST_PATH,
  apiError,
  bodyOf,
  callsTo,
  mockStudentApi,
  networkFailure,
  registrationFor,
  roundFixture,
  waitlistFor,
} from '@/test-support/student-api';
import { CLUBS_POLL_INTERVAL_MS } from './student-ui';

const [CHESS, MUSIC, ART] = [CLUBS[0]!, CLUBS[1]!, CLUBS[2]!];
// Others already wait for chess although a seat is free: the waitlist, not register, is offered.
const QUEUED_CHESS = { ...CHESS, waitlistCount: 3 };
const WITH_QUEUED_CHESS = [QUEUED_CHESS, MUSIC, ART];
const LEAVE_BUTTON = 'ออกจากรายชื่อรอ';
const PROMOTED_TO_MUSIC = 'ได้ที่ในชุมนุม B200 ชุมนุมดนตรีสมมติ จากรายชื่อรอแล้ว';
const JOINED_MUSIC = 'เข้ารายชื่อรอชุมนุม B200 ชุมนุมดนตรีสมมติ แล้ว ลำดับที่ 1';

const openClubsPage = async () => {
  renderAt('/student/clubs');
  await screen.findByRole('list', { name: 'รายการชุมนุม' });
};

const openMyRegistration = async () => {
  renderAt('/student/my-registration');
  await screen.findByRole('heading', { name: 'ภาคเรียน 2569/1 · ม.1' });
};

const cardOf = (name: string) => screen.getByRole('article', { name });

const joinButton = (clubCode: string, name: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name: `เข้ารายชื่อรอ ${clubCode} ${name}` });

const startJoin = (clubCode: string, name: string) => {
  fireEvent.click(joinButton(clubCode, name));
  return screen.getByRole('alertdialog', {
    name: `ยืนยันการเข้ารายชื่อรอชุมนุม ${clubCode} ${name}`,
  });
};

const confirmJoin = (clubCode: string, name: string) => {
  const dialog = startJoin(clubCode, name);
  fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน เข้ารายชื่อรอ' }));
  return dialog;
};

const leaveDialog = (clubCode: string, name: string) =>
  screen.getByRole('alertdialog', { name: `ยืนยันการออกจากรายชื่อรอชุมนุม ${clubCode} ${name}` });

const confirmLeave = (clubCode: string, name: string) => {
  fireEvent.click(screen.getByRole('button', { name: LEAVE_BUTTON }));
  const dialog = leaveDialog(clubCode, name);
  fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน ออกจากรายชื่อรอ' }));
  return dialog;
};

// The keyboard user's starting point for what a poll then removes.
const focusLeaveButton = () => {
  const button = screen.getByRole('button', { name: LEAVE_BUTTON });
  button.focus();
  expect(document.activeElement).toBe(button);
};

const pollOnce = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS);
  });
};

const waitlistCard = () =>
  screen.getByRole('heading', { name: 'รายชื่อรอของฉัน' }).parentElement as HTMLElement;

const keysOf = (calls: ReturnType<typeof callsTo>) =>
  calls.map(([, init]) => (bodyOf(init) as { idempotencyKey: string }).idempotencyKey);

// Fails the first request to `path` the way a lost reply does, after the server applied it.
const loseFirstReply = (
  { fetchMock }: ReturnType<typeof mockStudentApi>,
  path: string,
  applied: () => void,
) => {
  let failNext = true;
  const answer = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input: string, init?: RequestInit) => {
    if (input === path && failNext) {
      failNext = false;
      applied();
      return networkFailure();
    }
    return answer?.(input, init) ?? networkFailure();
  });
};

describe('student waitlist', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('joining on the clubs page', () => {
    it('joins a full club after confirmation and shows the place in its queue', async () => {
      const { fetchMock } = mockStudentApi();
      await openClubsPage();

      const dialog = startJoin(MUSIC.clubCode, MUSIC.name);
      expect(dialog.textContent).toContain('เข้ารายชื่อรอชุมนุม B200 ชุมนุมดนตรีสมมติ?');
      expect(dialog.textContent).toContain('ตอนนี้มีคนรอ 0 คน');
      expect(dialog.textContent).toContain('แจ้งผลที่หน้านี้เท่านั้น');
      expect(dialog.textContent).not.toContain('ลำดับเดิมจะหายไป');
      expect(dialog.textContent).not.toContain('ระบบจะย้ายคุณออกจากชุมนุม');
      expect(callsTo(fetchMock, 'POST', WAITLIST_PATH)).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน เข้ารายชื่อรอ' }));

      const notice = await screen.findByText('เข้ารายชื่อรอชุมนุม B200 ชุมนุมดนตรีสมมติ แล้ว ลำดับที่ 1');
      expect(document.activeElement).toBe(notice);
      const [call] = callsTo(fetchMock, 'POST', WAITLIST_PATH);
      expect(bodyOf(call?.[1])).toEqual({
        clubId: MUSIC.id,
        idempotencyKey: expect.stringMatching(UUID_PATTERN) as unknown,
      });
      const card = waitlistCard();
      expect(card.textContent).toContain('B200 ชุมนุมดนตรีสมมติ');
      expect(card.textContent).toContain('ลำดับที่ 1');
      expect(card.textContent).toContain('เข้ารายชื่อรอเมื่อ 1 ธ.ค. 2569 09:30 น.');
      expect(card.textContent).toContain('ระบบจะลงชุมนุมนี้ให้เองตามลำดับ');
      await waitFor(() => expect(cardOf(MUSIC.name).textContent).toContain('มีคนรอ 1 คน'));
      expect(within(cardOf(MUSIC.name)).getByText('รออยู่ ลำดับที่ 1')).toBeTruthy();
      expect(within(cardOf(MUSIC.name)).queryByRole('button')).toBeNull();
    });

    it('offers the waitlist of a club others wait for and shows how many wait', async () => {
      const { fetchMock } = mockStudentApi({ clubs: WITH_QUEUED_CHESS });
      await openClubsPage();
      expect(cardOf(CHESS.name).textContent).toContain('มีคนรอ 3 คน');

      const dialog = confirmJoin(CHESS.clubCode, CHESS.name);

      expect(dialog.textContent).toContain('ตอนนี้มีคนรอ 3 คน');
      expect(
        await screen.findByText('เข้ารายชื่อรอชุมนุม A100 ชุมนุมหมากรุกสมมติ แล้ว ลำดับที่ 4'),
      ).toBeTruthy();
      expect(callsTo(fetchMock, 'POST', WAITLIST_PATH)).toHaveLength(1);
    });

    it('tells a student holding a club that a seat moves them out of it', async () => {
      mockStudentApi({ registration: registrationFor(ART) });
      await openClubsPage();

      const dialog = startJoin(MUSIC.clubCode, MUSIC.name);

      expect(dialog.textContent).toContain(
        'ถ้าได้ที่ ระบบจะย้ายคุณออกจากชุมนุม C300 ชุมนุมวาดภาพสมมติ มาชุมนุมนี้ทันที',
      );
      expect(dialog.textContent).not.toContain('ลำดับเดิมจะหายไป');
    });

    it('warns a student waiting elsewhere that their place there is lost', async () => {
      const { state } = mockStudentApi({
        clubs: [QUEUED_CHESS, { ...MUSIC, waitlistCount: 2 }, ART],
        waitlist: waitlistFor(MUSIC, 2),
      });
      await openClubsPage();

      const dialog = startJoin(CHESS.clubCode, CHESS.name);
      expect(dialog.textContent).toContain(
        'คุณรอชุมนุม B200 ชุมนุมดนตรีสมมติ อยู่ (ลำดับที่ 2) รอได้ทีละ 1 ชุมนุม ถ้าเข้ารายชื่อรอชุมนุมนี้ ลำดับเดิมจะหายไป',
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน เข้ารายชื่อรอ' }));

      await screen.findByText('เข้ารายชื่อรอชุมนุม A100 ชุมนุมหมากรุกสมมติ แล้ว ลำดับที่ 4');
      expect(state.waitlist?.club.id).toBe(CHESS.id);
      await waitFor(() => expect(cardOf(MUSIC.name).textContent).toContain('มีคนรอ 1 คน'));
      expect(joinButton(MUSIC.clubCode, MUSIC.name).disabled).toBe(false);
      expect(waitlistCard().textContent).toContain('A100 ชุมนุมหมากรุกสมมติ');
    });

    it('gives both warnings to a student who holds a club and waits for another', async () => {
      mockStudentApi({
        clubs: WITH_QUEUED_CHESS,
        registration: registrationFor(ART),
        waitlist: waitlistFor(MUSIC),
      });
      await openClubsPage();

      // A free seat others wait for is theirs first: a holder is offered its waitlist, not a move.
      expect(screen.queryByRole('button', { name: /^ย้ายมาชุมนุมนี้ A100/ })).toBeNull();
      const dialog = startJoin(CHESS.clubCode, CHESS.name);

      expect(dialog.textContent).toContain('ระบบจะย้ายคุณออกจากชุมนุม C300 ชุมนุมวาดภาพสมมติ');
      expect(dialog.textContent).toContain('ลำดับเดิมจะหายไป');
    });

    it('closes the join confirmation with Escape and returns focus to its button', async () => {
      const { fetchMock } = mockStudentApi();
      await openClubsPage();
      const dialog = startJoin(MUSIC.clubCode, MUSIC.name);
      expect(document.activeElement).toBe(dialog);

      fireEvent.keyDown(dialog, { key: 'Escape' });

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(joinButton(MUSIC.clubCode, MUSIC.name));
      expect(callsTo(fetchMock, 'POST', WAITLIST_PATH)).toHaveLength(0);
    });

    it('offers the waitlist after a register refused as full', async () => {
      const { state } = mockStudentApi();
      await openClubsPage();
      state.clubs = state.clubs.map((club) =>
        club.id === CHESS.id ? { ...club, registered: 30, remaining: 0 } : club,
      );
      fireEvent.click(
        screen.getByRole('button', { name: `ลงชุมนุม ${CHESS.clubCode} ${CHESS.name}` }),
      );
      const dialog = screen.getByRole('alertdialog', {
        name: `ยืนยันการลงชุมนุม ${CHESS.clubCode} ${CHESS.name}`,
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน ลงชุมนุม' }));
      await within(dialog).findByRole('alert');

      fireEvent.click(within(dialog).getByRole('button', { name: 'เข้ารายชื่อรอชุมนุมนี้' }));

      expect(
        screen.getByRole('alertdialog', {
          name: `ยืนยันการเข้ารายชื่อรอชุมนุม ${CHESS.clubCode} ${CHESS.name}`,
        }),
      ).toBeTruthy();
    });

    it.each([
      [409, 'already_in_club', 'คุณอยู่ในชุมนุมนี้แล้ว ไม่ต้องเข้ารายชื่อรอ'],
      [409, 'waitlist_not_needed', 'ชุมนุมนี้มีที่ว่างแล้ว ไม่ต้องรอ กรุณาดูรายการล่าสุดแล้วลงหรือย้ายมาชุมนุมนี้ได้เลย'],
      [409, 'round_not_open', 'เข้ารายชื่อรอไม่ได้ เพราะตอนนี้ไม่อยู่ในช่วงเปิดลงทะเบียน'],
      [404, 'not_found', 'ไม่พบชุมนุมนี้แล้ว รายการอาจเปลี่ยนไป กรุณาดูรายการล่าสุด'],
      [429, 'rate_limited', 'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'],
      [400, 'validation_error', 'เข้ารายชื่อรอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'],
    ])('explains a %i %s refusal of a join in Thai', async (status, code, message) => {
      const { fetchMock } = mockStudentApi(
        {},
        { [`POST ${WAITLIST_PATH}`]: apiError(status, code) },
      );
      await openClubsPage();

      const dialog = confirmJoin(MUSIC.clubCode, MUSIC.name);

      expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
      expect(within(dialog).queryByRole('button', { name: 'ลองอีกครั้ง' })).toBeNull();
      expect(within(dialog).queryByRole('button', { name: 'เข้ารายชื่อรอชุมนุมนี้' })).toBeNull();
      await waitFor(() => expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(2));
    });

    it('retries a join whose answer was lost with the same key', async () => {
      const api = mockStudentApi();
      loseFirstReply(api, WAITLIST_PATH, () => {
        api.state.waitlist = waitlistFor(MUSIC);
      });
      await openClubsPage();

      const dialog = confirmJoin(MUSIC.clubCode, MUSIC.name);
      expect((await within(dialog).findByRole('alert')).textContent).toContain(
        'ยังไม่รู้ว่าเข้ารายชื่อรอสำเร็จหรือไม่',
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'ลองอีกครั้ง' }));

      await screen.findByText('เข้ารายชื่อรอชุมนุม B200 ชุมนุมดนตรีสมมติ แล้ว ลำดับที่ 1');
      const keys = keysOf(callsTo(api.fetchMock, 'POST', WAITLIST_PATH));
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(UUID_PATTERN);
      expect(keys[1]).toBe(keys[0]);
    });

    it('uses a new key for a new join after a refusal', async () => {
      let refuse = true;
      const api = mockStudentApi(
        {},
        {
          [`POST ${WAITLIST_PATH}`]: () => {
            if (refuse) {
              refuse = false;
              return apiError(500, 'internal_error')();
            }
            api.state.waitlist = waitlistFor(MUSIC);
            return Response.json({ waitlist: api.state.waitlist });
          },
        },
      );
      await openClubsPage();
      const first = confirmJoin(MUSIC.clubCode, MUSIC.name);
      // A 500 is an unknown outcome too: the panel offers the same key again; closing it instead
      // and confirming anew is a new request.
      await within(first).findByRole('button', { name: 'ลองอีกครั้ง' });
      fireEvent.click(within(first).getByRole('button', { name: 'ปิด' }));

      confirmJoin(MUSIC.clubCode, MUSIC.name);

      await screen.findByText('เข้ารายชื่อรอชุมนุม B200 ชุมนุมดนตรีสมมติ แล้ว ลำดับที่ 1');
      const keys = keysOf(callsTo(api.fetchMock, 'POST', WAITLIST_PATH));
      expect(keys).toHaveLength(2);
      expect(keys[1]).not.toBe(keys[0]);
    });

    it('says so when a replayed join finds the student no longer waiting', async () => {
      mockStudentApi({}, { [`POST ${WAITLIST_PATH}`]: () => Response.json({ waitlist: null }) });
      await openClubsPage();

      confirmJoin(MUSIC.clubCode, MUSIC.name);

      expect(await screen.findByText('ไม่ได้อยู่ในรายชื่อรอ กรุณาดูรายการล่าสุดแล้วลองใหม่')).toBeTruthy();
    });
  });

  describe('the waitlist entry', () => {
    it('shows the entry near the held club with a holder what a seat would do', async () => {
      mockStudentApi({ registration: registrationFor(ART), waitlist: waitlistFor(MUSIC, 2) });
      await openClubsPage();

      const card = waitlistCard();
      expect(card.textContent).toContain('B200 ชุมนุมดนตรีสมมติ');
      expect(card.textContent).toContain('ลำดับที่ 2');
      expect(card.textContent).toContain('เข้ารายชื่อรอเมื่อ 1 ธ.ค. 2569 08:10 น.');
      expect(card.textContent).toContain(
        'ถ้าได้ที่ ระบบจะย้ายคุณออกจากชุมนุม C300 ชุมนุมวาดภาพสมมติ มาชุมนุมนี้ให้เอง',
      );
      expect(within(card).getByRole('button', { name: LEAVE_BUTTON })).toBeTruthy();
    });

    it.each(['upcoming', 'closed'] as const)(
      'offers no leave button while the round is %s',
      async (status) => {
        mockStudentApi({ round: roundFixture({ status }), waitlist: waitlistFor(MUSIC) });
        await openClubsPage();

        expect(waitlistCard().textContent).toContain('ลำดับที่ 1');
        expect(screen.queryByRole('button', { name: LEAVE_BUTTON })).toBeNull();
      },
    );

    it('says a closed round gives no more seats off the waitlist', async () => {
      mockStudentApi({ round: roundFixture({ status: 'closed' }), waitlist: waitlistFor(MUSIC) });
      await openMyRegistration();

      expect(waitlistCard().textContent).toContain('รอบนี้ปิดแล้ว จะไม่มีการให้ที่จากรายชื่อรออีก');
    });

    it('leaves the waitlist from the clubs page after confirmation', async () => {
      const { fetchMock } = mockStudentApi({
        clubs: [CHESS, { ...MUSIC, waitlistCount: 1 }, ART],
        waitlist: waitlistFor(MUSIC),
      });
      await openClubsPage();

      fireEvent.click(screen.getByRole('button', { name: LEAVE_BUTTON }));
      const dialog = leaveDialog(MUSIC.clubCode, MUSIC.name);
      expect(dialog.textContent).toContain('ลำดับที่ของคุณจะหายไปทันที');
      expect(callsTo(fetchMock, 'POST', LEAVE_PATH)).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน ออกจากรายชื่อรอ' }));

      const notice = await screen.findByText('ออกจากรายชื่อรอแล้ว');
      expect(document.activeElement).toBe(notice);
      const [call] = callsTo(fetchMock, 'POST', LEAVE_PATH);
      expect(bodyOf(call?.[1])).toEqual({
        idempotencyKey: expect.stringMatching(UUID_PATTERN) as unknown,
      });
      expect(screen.queryByRole('heading', { name: 'รายชื่อรอของฉัน' })).toBeNull();
      await waitFor(() => expect(cardOf(MUSIC.name).textContent).not.toContain('มีคนรอ'));
      expect(joinButton(MUSIC.clubCode, MUSIC.name).disabled).toBe(false);
    });

    it.each([
      [
        'the dismiss button',
        (dialog: HTMLElement) => {
          fireEvent.click(within(dialog).getByRole('button', { name: 'ไม่ออก' }));
        },
      ],
      [
        'Escape',
        (dialog: HTMLElement) => {
          fireEvent.keyDown(dialog, { key: 'Escape' });
        },
      ],
    ])('returns focus to the leave button when backing out with %s', async (_, backOut) => {
      const { fetchMock } = mockStudentApi({ waitlist: waitlistFor(MUSIC) });
      await openClubsPage();
      fireEvent.click(screen.getByRole('button', { name: LEAVE_BUTTON }));
      const dialog = leaveDialog(MUSIC.clubCode, MUSIC.name);
      expect(document.activeElement).toBe(dialog);

      backOut(dialog);

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: LEAVE_BUTTON }));
      expect(callsTo(fetchMock, 'POST', LEAVE_PATH)).toHaveLength(0);
    });

    it('shows the waitlist entry and leaves it on my-registration too', async () => {
      const { fetchMock } = mockStudentApi({
        registration: registrationFor(ART),
        waitlist: waitlistFor(MUSIC, 3),
      });
      await openMyRegistration();
      expect(waitlistCard().textContent).toContain('ลำดับที่ 3');

      confirmLeave(MUSIC.clubCode, MUSIC.name);

      const notice = await screen.findByText('ออกจากรายชื่อรอแล้ว');
      expect(document.activeElement).toBe(notice);
      expect(screen.queryByRole('heading', { name: 'รายชื่อรอของฉัน' })).toBeNull();
      expect(screen.getByRole('button', { name: 'ยกเลิกชุมนุมนี้' })).toBeTruthy();
      await waitFor(() => expect(callsTo(fetchMock, 'GET', ROUND_PATH)).toHaveLength(2));
    });

    it('returns focus to the leave button when a refusal on my-registration is dismissed', async () => {
      mockStudentApi(
        { waitlist: waitlistFor(MUSIC) },
        { [`POST ${LEAVE_PATH}`]: apiError(429, 'rate_limited') },
      );
      await openMyRegistration();
      const dialog = confirmLeave(MUSIC.clubCode, MUSIC.name);
      await within(dialog).findByRole('alert');

      fireEvent.click(within(dialog).getByRole('button', { name: 'ปิด' }));

      expect(document.activeElement).toBe(screen.getByRole('button', { name: LEAVE_BUTTON }));
    });

    it.each([
      [409, 'not_waitlisted', 'คุณไม่ได้อยู่ในรายชื่อรอของรอบนี้แล้ว (อาจได้ที่แล้วหรือออกไปแล้ว) กรุณาดูสถานะล่าสุด'],
      [409, 'round_not_open', 'ออกจากรายชื่อรอไม่ได้ เพราะรอบนี้ไม่ได้เปิดอยู่แล้ว'],
      [409, 'idempotency_key_reused', 'คำขอนี้ซ้ำกับคำขอก่อนหน้า กรุณากดใหม่อีกครั้ง'],
      [400, 'validation_error', 'ออกจากรายชื่อรอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'],
    ])('explains a %i %s refusal of a leave in Thai', async (status, code, message) => {
      const { fetchMock } = mockStudentApi(
        { waitlist: waitlistFor(MUSIC) },
        { [`POST ${LEAVE_PATH}`]: apiError(status, code) },
      );
      await openMyRegistration();

      const dialog = confirmLeave(MUSIC.clubCode, MUSIC.name);

      expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
      expect(within(dialog).queryByRole('button', { name: 'ลองอีกครั้ง' })).toBeNull();
      await waitFor(() => expect(callsTo(fetchMock, 'GET', ROUND_PATH)).toHaveLength(2));
    });

    it('keeps the refusal on screen when the refetch shows the entry gone', async () => {
      const api = mockStudentApi(
        { waitlist: waitlistFor(MUSIC) },
        {
          [`POST ${LEAVE_PATH}`]: () => {
            // Promoted, or removed by an admin, just before the leave arrived.
            api.state.waitlist = null;
            return apiError(409, 'not_waitlisted')();
          },
        },
      );
      await openClubsPage();

      const dialog = confirmLeave(MUSIC.clubCode, MUSIC.name);

      await within(dialog).findByRole('alert');
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'รายชื่อรอของฉัน' })).toBeNull(),
      );
      expect(
        within(leaveDialog(MUSIC.clubCode, MUSIC.name)).getByRole('alert').textContent,
      ).toContain('คุณไม่ได้อยู่ในรายชื่อรอของรอบนี้แล้ว');
      fireEvent.click(within(dialog).getByRole('button', { name: 'ปิด' }));
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'ชุมนุมในชั้นของฉัน' }));
    });

    it('retries a leave whose answer was lost with the same key', async () => {
      let loseReply = true;
      const api = mockStudentApi(
        { waitlist: waitlistFor(MUSIC) },
        {
          [`POST ${LEAVE_PATH}`]: () => {
            if (loseReply) {
              loseReply = false;
              // The server applied the leave; only the reply was lost on the way back.
              api.state.waitlist = null;
              return networkFailure();
            }
            // The same key replays: the answer is the state now, not not_waitlisted.
            return Response.json({ waitlist: null });
          },
        },
      );
      await openMyRegistration();

      const dialog = confirmLeave(MUSIC.clubCode, MUSIC.name);
      expect((await within(dialog).findByRole('alert')).textContent).toContain(
        'ยังไม่รู้ว่าออกจากรายชื่อรอสำเร็จหรือไม่',
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'ลองอีกครั้ง' }));

      expect(await screen.findByText('ออกจากรายชื่อรอแล้ว')).toBeTruthy();
      const keys = keysOf(callsTo(api.fetchMock, 'POST', LEAVE_PATH));
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(UUID_PATTERN);
      expect(keys[1]).toBe(keys[0]);
    });
  });

  describe('promotion off the waitlist', () => {
    it.each([
      ['clubs page', openClubsPage],
      ['my-registration page', openMyRegistration],
    ])('says the seat came from the waitlist on the %s', async (_, open) => {
      mockStudentApi({
        registration: { ...registrationFor(MUSIC), promotedFromWaitlist: true },
      });

      await open();

      const notice = screen.getByText(PROMOTED_TO_MUSIC);
      expect(notice.closest('[role="status"]')).toBeTruthy();
      expect(document.activeElement).not.toBe(notice);
    });

    it('says nothing of the waitlist for a seat the student took themselves', async () => {
      mockStudentApi({ registration: registrationFor(MUSIC) });

      await openClubsPage();

      expect(screen.queryByText(/จากรายชื่อรอแล้ว/)).toBeNull();
    });

    it('shows the notice on the clubs page once a poll brings the promotion', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = mockStudentApi({
        registration: registrationFor(ART),
        waitlist: waitlistFor(MUSIC),
      });
      await openClubsPage();
      expect(screen.queryByText(PROMOTED_TO_MUSIC)).toBeNull();
      // Already mounted, so a screen reader announces what a poll puts in it.
      const region = screen.getAllByRole('status');

      state.registration = { ...registrationFor(MUSIC), promotedFromWaitlist: true };
      state.waitlist = null;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS);
      });

      const notice = await screen.findByText(PROMOTED_TO_MUSIC);
      expect(region.some((status) => status.contains(notice))).toBe(true);
      expect(screen.queryByRole('heading', { name: 'รายชื่อรอของฉัน' })).toBeNull();
      expect(within(cardOf(MUSIC.name)).getByText('ชุมนุมของฉัน')).toBeTruthy();
    });

    it('polls my-registration every 5 seconds while the student waits', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock, state } = mockStudentApi({ waitlist: waitlistFor(MUSIC) });
      await openMyRegistration();
      expect(screen.getByText('ยังไม่ได้ลงชุมนุม')).toBeTruthy();

      state.registration = { ...registrationFor(MUSIC), promotedFromWaitlist: true };
      state.waitlist = null;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS);
      });

      expect(await screen.findByText(PROMOTED_TO_MUSIC)).toBeTruthy();
      expect(callsTo(fetchMock, 'GET', ROUND_PATH)).toHaveLength(2);
      expect(screen.queryByRole('heading', { name: 'รายชื่อรอของฉัน' })).toBeNull();
    });

    it('does not poll my-registration every 5 seconds when the student waits for nothing', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { fetchMock } = mockStudentApi({
        round: roundFixture({ closesAt: new Date(Date.now() + 3_600_000).toISOString() }),
        registration: registrationFor(ART),
      });
      await openMyRegistration();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS * 2);
      });

      expect(callsTo(fetchMock, 'GET', ROUND_PATH)).toHaveLength(1);
    });

    it('drops the join notice once a poll shows the seat came from the waitlist', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = mockStudentApi();
      await openClubsPage();
      confirmJoin(MUSIC.clubCode, MUSIC.name);
      await screen.findByText(JOINED_MUSIC);

      state.registration = { ...registrationFor(MUSIC), promotedFromWaitlist: true };
      state.waitlist = null;
      await pollOnce();

      expect(await screen.findByText(PROMOTED_TO_MUSIC)).toBeTruthy();
      expect(screen.queryByText(JOINED_MUSIC)).toBeNull();
    });

    it('drops the join notice once a poll shows the entry removed without a seat', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = mockStudentApi();
      await openClubsPage();
      confirmJoin(MUSIC.clubCode, MUSIC.name);
      await screen.findByText(JOINED_MUSIC);

      // An admin removed the entry.
      state.waitlist = null;
      await pollOnce();

      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'รายชื่อรอของฉัน' })).toBeNull(),
      );
      expect(screen.queryByText(JOINED_MUSIC)).toBeNull();
      expect(screen.queryByText(/จากรายชื่อรอแล้ว/)).toBeNull();
    });

    it('moves focus from the join notice to the promoted notice when the join notice goes', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = mockStudentApi();
      await openClubsPage();
      confirmJoin(MUSIC.clubCode, MUSIC.name);
      await waitFor(() => expect(document.activeElement).toBe(screen.getByText(JOINED_MUSIC)));

      state.registration = { ...registrationFor(MUSIC), promotedFromWaitlist: true };
      state.waitlist = null;
      await pollOnce();

      expect(document.activeElement).toBe(await screen.findByText(PROMOTED_TO_MUSIC));
    });

    it('focuses the promoted notice when the seat came before the join answer showed', async () => {
      const api = mockStudentApi(
        {},
        {
          [`POST ${WAITLIST_PATH}`]: () => {
            // The join went through, then a seat freed at once: the refetch shows the seat.
            api.state.registration = { ...registrationFor(MUSIC), promotedFromWaitlist: true };
            return Response.json({ waitlist: waitlistFor(MUSIC) });
          },
        },
      );
      await openClubsPage();

      confirmJoin(MUSIC.clubCode, MUSIC.name);

      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(document.activeElement).toBe(screen.getByText(PROMOTED_TO_MUSIC));
      expect(screen.queryByText(JOINED_MUSIC)).toBeNull();
    });

    it.each([
      ['clubs page', openClubsPage],
      ['my-registration page', openMyRegistration],
    ])('moves focus from the leave button to the promoted notice on the %s', async (_, open) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = mockStudentApi({
        registration: registrationFor(ART),
        waitlist: waitlistFor(MUSIC),
      });
      await open();
      focusLeaveButton();

      state.registration = { ...registrationFor(MUSIC), promotedFromWaitlist: true };
      state.waitlist = null;
      await pollOnce();

      expect(document.activeElement).toBe(await screen.findByText(PROMOTED_TO_MUSIC));
    });

    it.each([
      ['clubs page', 'an admin removed the entry', openClubsPage, 'ชุมนุมในชั้นของฉัน'],
      ['clubs page', 'the round closed', openClubsPage, 'ชุมนุมในชั้นของฉัน'],
      ['my-registration page', 'an admin removed the entry', openMyRegistration, 'ผลของฉัน'],
      ['my-registration page', 'the round closed', openMyRegistration, 'ผลของฉัน'],
    ])(
      'moves focus from the leave button to the heading of the %s when %s',
      async (_, cause, open, heading) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { state } = mockStudentApi({ waitlist: waitlistFor(MUSIC) });
        await open();
        focusLeaveButton();

        if (cause === 'the round closed') state.round = roundFixture({ status: 'closed' });
        else state.waitlist = null;
        await pollOnce();

        await waitFor(() =>
          expect(screen.queryByRole('button', { name: LEAVE_BUTTON })).toBeNull(),
        );
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: heading }));
      },
    );

    it('does not move focus when the leave button goes without having it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { state } = mockStudentApi({ waitlist: waitlistFor(MUSIC) });
      await openClubsPage();
      expect(document.activeElement).toBe(document.body);

      state.registration = { ...registrationFor(MUSIC), promotedFromWaitlist: true };
      state.waitlist = null;
      await pollOnce();

      await screen.findByText(PROMOTED_TO_MUSIC);
      expect(document.activeElement).toBe(document.body);
    });

    it('gives focus to the leave confirmation opened from the focused leave button', async () => {
      mockStudentApi({ waitlist: waitlistFor(MUSIC) });
      await openClubsPage();
      focusLeaveButton();

      fireEvent.click(screen.getByRole('button', { name: LEAVE_BUTTON }));

      // Opening it removes the button on purpose: the panel keeps focus, not the heading.
      await waitFor(() =>
        expect(document.activeElement).toBe(leaveDialog(MUSIC.clubCode, MUSIC.name)),
      );
    });

    it('names the new seat when a cancel cascaded back to the student', async () => {
      const promoted = { ...registrationFor(MUSIC), promotedFromWaitlist: true };
      const api = mockStudentApi(
        { registration: registrationFor(ART), waitlist: waitlistFor(MUSIC) },
        {
          'POST /api/student/registration/cancel': () => {
            api.state.registration = promoted;
            api.state.waitlist = null;
            return Response.json({ registration: promoted });
          },
        },
      );
      await openMyRegistration();
      fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกชุมนุมนี้' }));
      fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน ยกเลิกชุมนุม' }));

      const notice = await screen.findByText('ยกเลิกชุมนุมเดิมแล้ว');
      expect(document.activeElement).toBe(notice);
      expect(screen.getByText(PROMOTED_TO_MUSIC)).toBeTruthy();
    });
  });
});
