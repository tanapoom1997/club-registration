import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/test-support/render-app';
import {
  CLUBS,
  CLUBS_PATH,
  REGISTER_PATH,
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

const openPage = async () => {
  const router = renderAt('/student/clubs');
  await screen.findByRole('list', { name: 'รายการชุมนุม' });
  return router;
};

const cardOf = (name: string) => screen.getByRole('article', { name });

const registerButton = (clubCode: string, name: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name: `ลงชุมนุม ${clubCode} ${name}` });

const joinButton = (clubCode: string, name: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name: `เข้ารายชื่อรอ ${clubCode} ${name}` });

const changeButton = (clubCode: string, name: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name: `ย้ายมาชุมนุมนี้ ${clubCode} ${name}` });

const startChange = (clubCode: string, name: string) => {
  fireEvent.click(changeButton(clubCode, name));
  return screen.getByRole('alertdialog', { name: `ยืนยันการย้ายไปชุมนุม ${clubCode} ${name}` });
};

const confirmChange = (clubCode: string, name: string) => {
  const dialog = startChange(clubCode, name);
  fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน ย้ายชุมนุม' }));
  return dialog;
};

const keysOf = (calls: ReturnType<typeof callsTo>) =>
  calls.map(([, init]) => (bodyOf(init) as { idempotencyKey: string }).idempotencyKey);

const startRegister = (clubCode: string, name: string) => {
  fireEvent.click(registerButton(clubCode, name));
  return screen.getByRole('alertdialog', { name: `ยืนยันการลงชุมนุม ${clubCode} ${name}` });
};

const confirmRegister = (clubCode: string, name: string) => {
  const dialog = startRegister(clubCode, name);
  fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน ลงชุมนุม' }));
  return dialog;
};

describe('student clubs page', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the round with its status and Thai opening and closing times', async () => {
    mockStudentApi();

    await openPage();

    const heading = screen.getByRole('heading', { name: 'ภาคเรียน 2569/1 · ม.1' });
    const header = heading.closest('div')?.parentElement as HTMLElement;
    expect(within(header).getByText('เปิดอยู่')).toBeTruthy();
    expect(header.textContent).toContain('เปิด1 ธ.ค. 2569 08:00 น.');
    expect(header.textContent).toContain('ปิด1 ธ.ค. 2569 16:00 น.');
  });

  it('lists each club with advisors, seats left and the description as plain text', async () => {
    mockStudentApi();

    await openPage();

    const chess = cardOf(CHESS.name);
    expect(chess.textContent).toContain('A100');
    expect(chess.textContent).toContain('ครูสมมติ ใจดี, ครูสมมติ ใจเย็น');
    expect(chess.textContent).toContain('เหลือ 18 ที่');
    expect(chess.textContent).toContain('รับ 30 คน');
    const description = within(chess).getByText(/เล่น <b>หมากรุก<\/b>/);
    expect(description.textContent).toBe('เล่น <b>หมากรุก</b>\nทุกวันศุกร์');
    expect(chess.querySelector('b')).toBeNull();
    const music = cardOf(MUSIC.name);
    expect(within(music).getByText('เต็ม')).toBeTruthy();
    expect(music.textContent).toContain('ครูที่ปรึกษา: ยังไม่ระบุ');
  });

  it('offers register for a club with seats left and the waitlist for a full one', async () => {
    mockStudentApi();

    await openPage();

    expect(registerButton(CHESS.clubCode, CHESS.name).disabled).toBe(false);
    expect(
      screen.queryByRole('button', { name: `ลงชุมนุม ${MUSIC.clubCode} ${MUSIC.name}` }),
    ).toBeNull();
    expect(joinButton(MUSIC.clubCode, MUSIC.name).disabled).toBe(false);
  });

  // README waitlist rule 9: capacity 0 takes no one, so the card offers nothing at all.
  it('shows a club with capacity 0 as not accepting, with no button', async () => {
    mockStudentApi({ clubs: [CHESS, { ...MUSIC, capacity: 0, remaining: 0 }, ART] });

    await openPage();

    const music = cardOf(MUSIC.name);
    expect(within(music).getByText('ไม่เปิดรับ')).toBeTruthy();
    expect(within(music).queryByText('เต็ม')).toBeNull();
    expect(within(music).queryByRole('button')).toBeNull();
  });

  it('offers the waitlist, not register, for a club with a free seat that others wait for', async () => {
    mockStudentApi({ clubs: [{ ...CHESS, waitlistCount: 2 }, MUSIC, ART] });

    await openPage();

    expect(
      screen.queryByRole('button', { name: `ลงชุมนุม ${CHESS.clubCode} ${CHESS.name}` }),
    ).toBeNull();
    expect(joinButton(CHESS.clubCode, CHESS.name).disabled).toBe(false);
    expect(cardOf(CHESS.name).textContent).toContain('มีคนรอ 2 คน');
  });

  it('disables every action button while the round is upcoming', async () => {
    mockStudentApi({ round: roundFixture({ status: 'upcoming' }) });

    await openPage();

    expect(registerButton(CHESS.clubCode, CHESS.name).disabled).toBe(true);
    expect(registerButton(ART.clubCode, ART.name).disabled).toBe(true);
    expect(joinButton(MUSIC.clubCode, MUSIC.name).disabled).toBe(true);
  });

  describe('a closed round', () => {
    const ACTION = /^(ลงชุมนุม|ย้ายมาชุมนุมนี้|เข้ารายชื่อรอ|ออกจากรายชื่อรอ) /;

    it('shows no action button, only the final counts', async () => {
      mockStudentApi({
        round: roundFixture({ status: 'closed' }),
        clubs: [CHESS, { ...MUSIC, waitlistCount: 2 }, { ...ART, capacity: 0, remaining: 0 }],
      });

      await openPage();

      expect(screen.getByText(/รอบนี้ปิดรับลงทะเบียนแล้ว/).textContent).toContain(
        'จำนวนด้านล่างคือจำนวนที่ลงไว้ตอนปิดรอบ',
      );
      expect(screen.queryAllByRole('button', { name: ACTION })).toEqual([]);
      expect(cardOf(CHESS.name).textContent).toContain('ลงแล้ว 12 / รับ 30 คน');
      expect(cardOf(CHESS.name).textContent).not.toContain('เหลือ');
      expect(cardOf(MUSIC.name).textContent).toContain('ลงแล้ว 20 / รับ 20 คน');
      expect(cardOf(MUSIC.name).textContent).not.toContain('มีคนรอ');
      expect(cardOf(ART.name).textContent).toContain('ไม่เปิดรับ');
    });

    it('offers search but no "ยังรับ" filter', async () => {
      mockStudentApi({ round: roundFixture({ status: 'closed' }) });

      await openPage();

      expect(screen.getByRole('searchbox', { name: 'ค้นหาชุมนุม' })).toBeTruthy();
      expect(screen.queryByRole('radio', { name: 'ยังรับ' })).toBeNull();
    });

    it('drops the one-club rule from the held club and links to the result only', async () => {
      mockStudentApi({
        round: roundFixture({ status: 'closed' }),
        registration: registrationFor(ART),
      });

      await openPage();

      const held = screen.getByRole('heading', { name: 'ชุมนุมของฉัน' }).parentElement as HTMLElement;
      expect(held.textContent).not.toContain('ลงได้ 1 ชุมนุมต่อรอบ');
      expect(within(held).getByRole('link', { name: 'ดูผลของฉัน' })).toBeTruthy();
    });
  });

  it('shows the club the student holds at the top and offers no register button', async () => {
    mockStudentApi({ registration: registrationFor(ART) });

    await openPage();

    const held = screen.getByRole('heading', { name: 'ชุมนุมของฉัน' }).parentElement as HTMLElement;
    expect(held.textContent).toContain('C300 ชุมนุมวาดภาพสมมติ');
    expect(held.textContent).toContain('ลงเมื่อ 1 ธ.ค. 2569 08:05 น.');
    expect(within(held).getByRole('link', { name: 'ดูผลของฉันและยกเลิก' }).getAttribute('href')).toBe(
      '/student/my-registration',
    );
    expect(within(cardOf(ART.name)).getByText('ชุมนุมของฉัน')).toBeTruthy();
    // The held-club card explains how to change, so no card shows a button that cannot work.
    expect(screen.queryByRole('button', { name: /^ลงชุมนุม / })).toBeNull();
  });

  it.each(['upcoming', 'closed'] as const)(
    'offers no register button to a student holding a club while the round is %s',
    async (status) => {
      mockStudentApi({ round: roundFixture({ status }), registration: registrationFor(ART) });

      await openPage();

      expect(screen.queryByRole('button', { name: /^ลงชุมนุม / })).toBeNull();
    },
  );

  it.each(['upcoming', 'closed'] as const)(
    'links the held club to the result without offering a cancel while the round is %s',
    async (status) => {
      mockStudentApi({ round: roundFixture({ status }), registration: registrationFor(ART) });

      await openPage();

      const held = screen.getByRole('heading', { name: 'ชุมนุมของฉัน' }).parentElement as HTMLElement;
      const link = within(held).getByRole('link');
      expect(link.textContent).toBe('ดูผลของฉัน');
      expect(link.getAttribute('href')).toBe('/student/my-registration');
      expect(held.textContent).not.toContain('ยกเลิก');
    },
  );

  it('registers after confirmation with a new idempotency key and shows the held club', async () => {
    const { fetchMock } = mockStudentApi();
    await openPage();

    const dialog = startRegister(CHESS.clubCode, CHESS.name);
    expect(dialog.textContent).toContain('ลงชุมนุม A100 ชุมนุมหมากรุกสมมติ?');
    expect(callsTo(fetchMock, 'POST', REGISTER_PATH)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน ลงชุมนุม' }));

    expect(await screen.findByText('ลงชุมนุม A100 ชุมนุมหมากรุกสมมติ เรียบร้อยแล้ว')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'POST', REGISTER_PATH);
    expect(bodyOf(call?.[1])).toEqual({
      clubId: CHESS.id,
      idempotencyKey: expect.stringMatching(UUID_PATTERN) as unknown,
    });
    expect(screen.getByRole('heading', { name: 'ชุมนุมของฉัน' })).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(cardOf(CHESS.name).textContent).toContain('เหลือ 17 ที่'));
    expect(screen.queryByRole('button', { name: /^ลงชุมนุม / })).toBeNull();
  });

  it('sends nothing when the student backs out of the confirmation', async () => {
    const { fetchMock } = mockStudentApi();
    await openPage();

    const dialog = startRegister(CHESS.clubCode, CHESS.name);
    fireEvent.click(within(dialog).getByRole('button', { name: 'ไม่ลง' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(callsTo(fetchMock, 'POST', REGISTER_PATH)).toHaveLength(0);
  });

  it('closes the confirmation with Escape and returns focus to the register button', async () => {
    const { fetchMock } = mockStudentApi();
    await openPage();
    const dialog = startRegister(CHESS.clubCode, CHESS.name);

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(registerButton(CHESS.clubCode, CHESS.name));
    expect(callsTo(fetchMock, 'POST', REGISTER_PATH)).toHaveLength(0);
  });

  it('disables the register buttons while the request is on its way', async () => {
    mockStudentApi({}, { [`POST ${REGISTER_PATH}`]: () => new Promise<Response>(() => {}) });
    await openPage();

    const dialog = confirmRegister(CHESS.clubCode, CHESS.name);

    expect(await within(dialog).findByText('กำลังลงทะเบียน…')).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'ยืนยัน ลงชุมนุม' }).disabled,
    ).toBe(true);
    expect(registerButton(ART.clubCode, ART.name).disabled).toBe(true);
    // Escape does not close it either: the answer must stay where the student can see it.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBe(dialog);
  });

  it.each([
    [409, 'club_full', 'ชุมนุมนี้เต็มแล้วหรือมีคนรอที่ว่างอยู่ เข้ารายชื่อรอของชุมนุมนี้ได้ หรือเลือกชุมนุมอื่น'],
    [409, 'already_registered', 'คุณลงชุมนุมอื่นในรอบนี้ไว้แล้ว ถ้าจะเปลี่ยน กด "ย้ายมาชุมนุมนี้" ที่ชุมนุมที่ยังมีที่ว่าง'],
    [409, 'round_not_open', 'ตอนนี้ไม่อยู่ในช่วงเปิดลงทะเบียน (ยังไม่เปิดหรือปิดไปแล้ว)'],
    [409, 'idempotency_key_reused', 'คำขอนี้ซ้ำกับคำขอก่อนหน้า กรุณากดใหม่อีกครั้ง'],
    [429, 'rate_limited', 'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'],
    [404, 'not_found', 'ไม่พบชุมนุมนี้แล้ว รายการอาจเปลี่ยนไป กรุณาดูรายการล่าสุด'],
    [400, 'validation_error', 'ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'],
  ])('explains a %i %s refusal in Thai and refreshes the list', async (status, code, message) => {
    const { fetchMock } = mockStudentApi({}, { [`POST ${REGISTER_PATH}`]: apiError(status, code) });
    await openPage();
    expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(1);

    const dialog = confirmRegister(CHESS.clubCode, CHESS.name);

    expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
    expect(within(dialog).queryByRole('button', { name: 'ลองอีกครั้ง' })).toBeNull();
    await waitFor(() => expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(2));
  });

  it('tells a student without a profile to contact an admin when registering', async () => {
    mockStudentApi({}, { [`POST ${REGISTER_PATH}`]: apiError(403, 'student_profile_missing') });
    await openPage();

    const dialog = confirmRegister(CHESS.clubCode, CHESS.name);

    expect((await within(dialog).findByRole('alert')).textContent).toContain('กรุณาติดต่อผู้ดูแลระบบ');
  });

  it('retries a request whose answer was lost with the same idempotency key', async () => {
    const { fetchMock, state } = mockStudentApi();
    let failNext = true;
    const answer = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input === REGISTER_PATH && failNext) {
        failNext = false;
        // The server applied the request; only the reply was lost on the way back.
        state.registration = registrationFor(CHESS);
        return networkFailure();
      }
      return answer?.(input, init) ?? networkFailure();
    });
    await openPage();

    const dialog = confirmRegister(CHESS.clubCode, CHESS.name);
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'ยังไม่รู้ว่าลงทะเบียนสำเร็จหรือไม่',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'ลองอีกครั้ง' }));

    expect(await screen.findByText('ลงชุมนุม A100 ชุมนุมหมากรุกสมมติ เรียบร้อยแล้ว')).toBeTruthy();
    const keys = callsTo(fetchMock, 'POST', REGISTER_PATH).map(
      ([, init]) => (bodyOf(init) as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(UUID_PATTERN);
    expect(keys[1]).toBe(keys[0]);
  });

  it('uses a new idempotency key for a new confirmation after a refusal', async () => {
    let refuse = true;
    const { fetchMock } = mockStudentApi(
      {},
      {
        [`POST ${REGISTER_PATH}`]: () => {
          if (refuse) {
            refuse = false;
            return apiError(429, 'rate_limited')();
          }
          return Response.json({ registration: registrationFor(CHESS), adminChange: null });
        },
      },
    );
    await openPage();
    const first = confirmRegister(CHESS.clubCode, CHESS.name);
    await within(first).findByRole('alert');
    fireEvent.click(within(first).getByRole('button', { name: 'ปิด' }));

    confirmRegister(CHESS.clubCode, CHESS.name);

    await screen.findByText('ลงชุมนุม A100 ชุมนุมหมากรุกสมมติ เรียบร้อยแล้ว');
    const keys = callsTo(fetchMock, 'POST', REGISTER_PATH).map(
      ([, init]) => (bodyOf(init) as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('keeps refreshing the seats while the round is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchMock } = mockStudentApi();
    await openPage();
    expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS);
    });

    await waitFor(() => expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(2));
  });

  it('does not poll a closed round', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchMock } = mockStudentApi({ round: roundFixture({ status: 'closed' }) });
    await openPage();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(1);
  });

  it('switches an upcoming round to open when its opening time passes, without a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const opensAt = new Date(Date.now() + 20_000).toISOString();
    const { fetchMock, state } = mockStudentApi({
      round: roundFixture({ status: 'upcoming', opensAt }),
    });
    await openPage();
    expect(registerButton(CHESS.clubCode, CHESS.name).disabled).toBe(true);
    expect(screen.getByText(/หน้านี้จะเปิดให้ลงเอง ไม่ต้องโหลดใหม่/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(1);
    state.round = roundFixture({ status: 'open', opensAt });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });

    await waitFor(() => expect(registerButton(CHESS.clubCode, CHESS.name).disabled).toBe(false));
    expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(2);
  });

  it('says so when the student grade has no round', async () => {
    mockStudentApi({ round: null });
    renderAt('/student/clubs');

    expect(await screen.findByText(/ยังไม่มีรอบลงทะเบียนของชั้นนี้/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'รายการชุมนุม' })).toBeNull();
  });

  it('tells a student whose account has no profile to contact an admin', async () => {
    mockStudentApi({}, { [`GET ${CLUBS_PATH}`]: apiError(403, 'student_profile_missing') });
    renderAt('/student/clubs');

    expect((await screen.findByRole('alert')).textContent).toContain(
      'กรุณาติดต่อผู้ดูแลระบบหรือครูที่ดูแลการลงทะเบียน',
    );
  });
  describe('changing club', () => {
    it('offers a move to every other club with a free seat and nobody waiting', async () => {
      mockStudentApi({ registration: registrationFor(ART) });

      await openPage();

      expect(changeButton(CHESS.clubCode, CHESS.name).disabled).toBe(false);
      expect(joinButton(MUSIC.clubCode, MUSIC.name).disabled).toBe(false);
      expect(within(cardOf(ART.name)).queryByRole('button')).toBeNull();
      const held = screen.getByRole('heading', { name: 'ชุมนุมของฉัน' }).parentElement as HTMLElement;
      expect(held.textContent).toContain('ย้ายมาชุมนุมนี้');
    });

    it('offers no move to a student without a club', async () => {
      mockStudentApi();

      await openPage();

      expect(screen.queryByRole('button', { name: /^ย้ายมาชุมนุมนี้ / })).toBeNull();
    });

    it('shows the move as a secondary button once the student holds a club', async () => {
      mockStudentApi({ registration: registrationFor(ART) });

      await openPage();

      expect(changeButton(CHESS.clubCode, CHESS.name).dataset.variant).toBe('outline');
    });

    it('keeps a first seat as the main button for a student without a club', async () => {
      mockStudentApi();

      await openPage();

      expect(registerButton(CHESS.clubCode, CHESS.name).dataset.variant).toBe('primary');
    });

    it('keeps the register confirmation primary, not destructive', async () => {
      mockStudentApi();
      await openPage();

      const dialog = startRegister(CHESS.clubCode, CHESS.name);

      const confirm = within(dialog).getByRole('button', { name: 'ยืนยัน ลงชุมนุม' });
      expect(confirm.dataset.variant).toBe('primary');
    });

    it.each(['upcoming', 'closed'] as const)(
      'offers no move and no waitlist to a student holding a club while the round is %s',
      async (status) => {
        mockStudentApi({ round: roundFixture({ status }), registration: registrationFor(ART) });

        await openPage();

        expect(screen.queryByRole('button', { name: /^ย้ายมาชุมนุมนี้ / })).toBeNull();
        expect(screen.queryByRole('button', { name: /^เข้ารายชื่อรอ / })).toBeNull();
        const held = screen.getByRole('heading', { name: 'ชุมนุมของฉัน' })
          .parentElement as HTMLElement;
        expect(held.textContent).not.toContain('ย้ายมาชุมนุมนี้');
      },
    );

    it('says the student leaves their club only once the new seat is theirs', async () => {
      const { fetchMock } = mockStudentApi({ registration: registrationFor(ART) });
      await openPage();

      const dialog = startChange(CHESS.clubCode, CHESS.name);

      expect(dialog.textContent).toContain(
        'ย้ายจากชุมนุม C300 ชุมนุมวาดภาพสมมติ ไปชุมนุม A100 ชุมนุมหมากรุกสมมติ?',
      );
      expect(dialog.textContent).toContain('คุณจะออกจากชุมนุมเดิมก็ต่อเมื่อได้ที่ในชุมนุมใหม่แล้วเท่านั้น');
      expect(dialog.textContent).toContain('ถ้าชุมนุมใหม่เต็มก่อน คุณยังอยู่ชุมนุมเดิม');
      expect(callsTo(fetchMock, 'PUT', REGISTER_PATH)).toHaveLength(0);
    });

    it('moves after confirmation with a new key and shows the new club as held', async () => {
      const { fetchMock } = mockStudentApi({ registration: registrationFor(ART) });
      await openPage();

      confirmChange(CHESS.clubCode, CHESS.name);

      const notice = await screen.findByText('ย้ายมาชุมนุม A100 ชุมนุมหมากรุกสมมติ เรียบร้อยแล้ว');
      expect(document.activeElement).toBe(notice);
      const [call] = callsTo(fetchMock, 'PUT', REGISTER_PATH);
      expect(bodyOf(call?.[1])).toEqual({
        clubId: CHESS.id,
        idempotencyKey: expect.stringMatching(UUID_PATTERN) as unknown,
      });
      const held = screen.getByRole('heading', { name: 'ชุมนุมของฉัน' }).parentElement as HTMLElement;
      expect(held.textContent).toContain('A100 ชุมนุมหมากรุกสมมติ');
      await waitFor(() => expect(cardOf(CHESS.name).textContent).toContain('เหลือ 17 ที่'));
      expect(cardOf(ART.name).textContent).toContain('เหลือ 23 ที่');
      expect(changeButton(ART.clubCode, ART.name).disabled).toBe(false);
      expect(callsTo(fetchMock, 'GET', CLUBS_PATH).length).toBeGreaterThanOrEqual(2);
    });

    it('closes with Escape, sends nothing and returns focus to the move button', async () => {
      const { fetchMock } = mockStudentApi({ registration: registrationFor(ART) });
      await openPage();
      const dialog = startChange(CHESS.clubCode, CHESS.name);
      expect(document.activeElement).toBe(dialog);

      fireEvent.keyDown(dialog, { key: 'Escape' });

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(changeButton(CHESS.clubCode, CHESS.name));
      expect(callsTo(fetchMock, 'PUT', REGISTER_PATH)).toHaveLength(0);
    });

    it('keeps the student where they are on club_full and offers the waitlist', async () => {
      const { fetchMock, state } = mockStudentApi({ registration: registrationFor(ART) });
      await openPage();
      // The last seat went to someone else while the student was deciding.
      state.clubs = state.clubs.map((club) =>
        club.id === CHESS.id ? { ...club, registered: 30, remaining: 0 } : club,
      );

      const dialog = confirmChange(CHESS.clubCode, CHESS.name);

      expect((await within(dialog).findByRole('alert')).textContent).toBe(
        'ย้ายไม่สำเร็จ เพราะชุมนุมนี้เต็มแล้วหรือมีคนรอที่ว่างอยู่ คุณยังอยู่ชุมนุมเดิม ถ้ายังอยากได้ชุมนุมนี้ เข้ารายชื่อรอได้',
      );
      expect(within(dialog).queryByRole('button', { name: 'ลองอีกครั้ง' })).toBeNull();
      const held = screen.getByRole('heading', { name: 'ชุมนุมของฉัน' }).parentElement as HTMLElement;
      expect(held.textContent).toContain('C300 ชุมนุมวาดภาพสมมติ');

      fireEvent.click(within(dialog).getByRole('button', { name: 'เข้ารายชื่อรอชุมนุมนี้' }));

      const join = screen.getByRole('alertdialog', {
        name: `ยืนยันการเข้ารายชื่อรอชุมนุม ${CHESS.clubCode} ${CHESS.name}`,
      });
      expect(document.activeElement).toBe(join);
      fireEvent.click(within(join).getByRole('button', { name: 'ยืนยัน เข้ารายชื่อรอ' }));
      expect(
        await screen.findByText('เข้ารายชื่อรอชุมนุม A100 ชุมนุมหมากรุกสมมติ แล้ว ลำดับที่ 1'),
      ).toBeTruthy();
      const keys = [
        ...keysOf(callsTo(fetchMock, 'PUT', REGISTER_PATH)),
        ...keysOf(callsTo(fetchMock, 'POST', WAITLIST_PATH)),
      ];
      expect(keys).toHaveLength(2);
      expect(keys[1]).not.toBe(keys[0]);
    });

    it('returns focus to the card button, now the waitlist one, when a club_full is dismissed', async () => {
      const { state } = mockStudentApi({ registration: registrationFor(ART) });
      await openPage();
      state.clubs = state.clubs.map((club) =>
        club.id === CHESS.id ? { ...club, waitlistCount: 1 } : club,
      );
      const dialog = confirmChange(CHESS.clubCode, CHESS.name);
      await within(dialog).findByRole('alert');
      await waitFor(() => expect(cardOf(CHESS.name).textContent).toContain('มีคนรอ 1 คน'));

      fireEvent.click(within(dialog).getByRole('button', { name: 'ปิด' }));

      expect(document.activeElement).toBe(joinButton(CHESS.clubCode, CHESS.name));
    });

    it.each([
      [
        409,
        'not_registered',
        'คุณยังไม่มีชุมนุมในรอบนี้ (อาจยกเลิกไปแล้ว) กรุณาดูรายการล่าสุดแล้วกด "ลงชุมนุม" แทน',
      ],
      [409, 'round_not_open', 'ตอนนี้ไม่อยู่ในช่วงเปิดลงทะเบียน (ยังไม่เปิดหรือปิดไปแล้ว)'],
      [404, 'not_found', 'ไม่พบชุมนุมนี้แล้ว รายการอาจเปลี่ยนไป กรุณาดูรายการล่าสุด'],
      [409, 'idempotency_key_reused', 'คำขอนี้ซ้ำกับคำขอก่อนหน้า กรุณากดใหม่อีกครั้ง'],
      [400, 'validation_error', 'ย้ายชุมนุมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'],
    ])('explains a %i %s refusal of a move in Thai', async (status, code, message) => {
      const { fetchMock } = mockStudentApi(
        { registration: registrationFor(ART) },
        { [`PUT ${REGISTER_PATH}`]: apiError(status, code) },
      );
      await openPage();

      const dialog = confirmChange(CHESS.clubCode, CHESS.name);

      expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
      expect(within(dialog).queryByRole('button', { name: 'ลองอีกครั้ง' })).toBeNull();
      expect(within(dialog).queryByRole('button', { name: 'เข้ารายชื่อรอชุมนุมนี้' })).toBeNull();
      await waitFor(() => expect(callsTo(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(2));
    });

    it.each([
      ['a lost connection', networkFailure],
      ['a 502 from the proxy', () => new Response('Bad Gateway', { status: 502 })],
    ])('retries a move after %s with the same key', async (_, failure) => {
      const { fetchMock, state } = mockStudentApi({ registration: registrationFor(ART) });
      let failNext = true;
      const answer = fetchMock.getMockImplementation();
      fetchMock.mockImplementation((input: string, init?: RequestInit) => {
        if (input === REGISTER_PATH && init?.method === 'PUT' && failNext) {
          failNext = false;
          // The server applied the move; only the reply was lost on the way back.
          state.registration = registrationFor(CHESS);
          return Promise.resolve(failure());
        }
        return answer?.(input, init) ?? networkFailure();
      });
      await openPage();

      const dialog = confirmChange(CHESS.clubCode, CHESS.name);
      expect((await within(dialog).findByRole('alert')).textContent).toContain(
        'ยังไม่รู้ว่าย้ายชุมนุมสำเร็จหรือไม่',
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'ลองอีกครั้ง' }));

      expect(await screen.findByText('ย้ายมาชุมนุม A100 ชุมนุมหมากรุกสมมติ เรียบร้อยแล้ว')).toBeTruthy();
      const keys = keysOf(callsTo(fetchMock, 'PUT', REGISTER_PATH));
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(UUID_PATTERN);
      expect(keys[1]).toBe(keys[0]);
    });

    it('uses a new key for a new move after a refusal', async () => {
      let refuse = true;
      const { fetchMock } = mockStudentApi(
        { registration: registrationFor(ART) },
        {
          [`PUT ${REGISTER_PATH}`]: () => {
            if (refuse) {
              refuse = false;
              return apiError(429, 'rate_limited')();
            }
            return Response.json({ registration: registrationFor(CHESS), adminChange: null });
          },
        },
      );
      await openPage();
      const first = confirmChange(CHESS.clubCode, CHESS.name);
      await within(first).findByRole('alert');
      fireEvent.click(within(first).getByRole('button', { name: 'ปิด' }));

      confirmChange(CHESS.clubCode, CHESS.name);

      await screen.findByText('ย้ายมาชุมนุม A100 ชุมนุมหมากรุกสมมติ เรียบร้อยแล้ว');
      const keys = keysOf(callsTo(fetchMock, 'PUT', REGISTER_PATH));
      expect(keys).toHaveLength(2);
      expect(keys[1]).not.toBe(keys[0]);
    });

    it('disables every button on the page while a move is on its way', async () => {
      mockStudentApi(
        { registration: registrationFor(ART), waitlist: waitlistFor(MUSIC) },
        { [`PUT ${REGISTER_PATH}`]: () => new Promise<Response>(() => {}) },
      );
      await openPage();

      const dialog = confirmChange(CHESS.clubCode, CHESS.name);

      expect(await within(dialog).findByText('กำลังย้ายชุมนุม…')).toBeTruthy();
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'ออกจากรายชื่อรอ' }).disabled,
      ).toBe(true);
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.getByRole('alertdialog')).toBe(dialog);
    });

    it('says when a move cascaded into a seat off the student own waitlist entry', async () => {
      const promoted = { ...registrationFor(MUSIC), promotedFromWaitlist: true };
      const api = mockStudentApi(
        { registration: registrationFor(ART), waitlist: waitlistFor(MUSIC) },
        {
          [`PUT ${REGISTER_PATH}`]: () => {
            // A held ART, waited for MUSIC; the move freed ART, whose head of queue came from
            // MUSIC, and MUSIC's freed seat went to A in the same transaction.
            api.state.registration = promoted;
            api.state.waitlist = null;
            return Response.json({ registration: promoted, adminChange: null });
          },
        },
      );
      await openPage();

      confirmChange(CHESS.clubCode, CHESS.name);

      expect(await screen.findByText('ย้ายชุมนุมแล้ว และได้ที่จากรายชื่อรอต่อ')).toBeTruthy();
      expect(screen.getByText('ได้ที่ในชุมนุม B200 ชุมนุมดนตรีสมมติ จากรายชื่อรอแล้ว')).toBeTruthy();
    });
  });
});
