import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/test-support/render-app';
import {
  CLUBS,
  CLUBS_PATH,
  REGISTER_PATH,
  UUID_PATTERN,
  apiError,
  bodyOf,
  callsTo,
  mockStudentApi,
  networkFailure,
  registrationFor,
  roundFixture,
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

  it('lets a student register only for a club with seats left while the round is open', async () => {
    mockStudentApi();

    await openPage();

    expect(registerButton(CHESS.clubCode, CHESS.name).disabled).toBe(false);
    expect(registerButton(MUSIC.clubCode, MUSIC.name).disabled).toBe(true);
  });

  it.each(['upcoming', 'closed'] as const)(
    'disables every register button while the round is %s',
    async (status) => {
      mockStudentApi({ round: roundFixture({ status }) });

      await openPage();

      CLUBS.forEach((club) => expect(registerButton(club.clubCode, club.name).disabled).toBe(true));
    },
  );

  it('shows the club the student holds at the top and blocks registering for another', async () => {
    mockStudentApi({ registration: registrationFor(ART) });

    await openPage();

    const held = screen.getByRole('heading', { name: 'ชุมนุมของฉัน' }).parentElement as HTMLElement;
    expect(held.textContent).toContain('C300 ชุมนุมวาดภาพสมมติ');
    expect(held.textContent).toContain('ลงเมื่อ 1 ธ.ค. 2569 08:05 น.');
    expect(
      within(held).getByRole('link', { name: 'ดูผลของฉันและยกเลิก' }).getAttribute('href'),
    ).toBe('/student/my-registration');
    expect(within(cardOf(ART.name)).getByText('ชุมนุมของฉัน')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `ลงชุมนุม C300 ${ART.name}` })).toBeNull();
    expect(registerButton(CHESS.clubCode, CHESS.name).disabled).toBe(true);
  });

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
    expect(registerButton(ART.clubCode, ART.name).disabled).toBe(true);
  });

  it('sends nothing when the student backs out of the confirmation', async () => {
    const { fetchMock } = mockStudentApi();
    await openPage();

    const dialog = startRegister(CHESS.clubCode, CHESS.name);
    fireEvent.click(within(dialog).getByRole('button', { name: 'ไม่ลง' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
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
  });

  it.each([
    [409, 'club_full', 'ชุมนุมนี้เต็มแล้ว กรุณาเลือกชุมนุมอื่น'],
    [
      409,
      'already_registered',
      'คุณลงชุมนุมอื่นในรอบนี้ไว้แล้ว ถ้าจะเปลี่ยนต้องยกเลิกชุมนุมเดิมที่หน้า "ผลของฉัน" ก่อน',
    ],
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

    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'กรุณาติดต่อผู้ดูแลระบบ',
    );
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
          return Response.json({ registration: registrationFor(CHESS) });
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
});
