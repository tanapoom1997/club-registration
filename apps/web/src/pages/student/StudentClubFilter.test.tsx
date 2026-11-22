import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudentClub } from '@club-registration/shared';
import { renderAt } from '@/test-support/render-app';
import {
  CLUBS,
  CLUBS_PATH,
  callsTo,
  mockStudentApi,
  registrationFor,
  waitlistFor,
} from '@/test-support/student-api';
import { CLUBS_POLL_INTERVAL_MS } from './student-ui';

// A100 chess: 18 seats left. B200 music: full. C300 painting: 22 seats left.
const [CHESS, MUSIC, ART] = [CLUBS[0]!, CLUBS[1]!, CLUBS[2]!];
// A seat is free but others already wait for it: the waitlist is what the card offers.
const QUEUED_ART: StudentClub = { ...ART, waitlistCount: 2 };
const FULL_ART: StudentClub = { ...ART, registered: 25, remaining: 0 };

const openPage = async () => {
  renderAt('/student/clubs');
  return await screen.findByRole('list', { name: 'รายการชุมนุม' });
};

const shownClubs = () =>
  within(screen.getByRole('list', { name: 'รายการชุมนุม' }))
    .queryAllByRole('article')
    .map((card) => card.querySelector('h3')?.textContent);

const searchBox = () => screen.getByRole<HTMLInputElement>('searchbox', { name: 'ค้นหาชุมนุม' });
const search = (text: string) => {
  fireEvent.change(searchBox(), { target: { value: text } });
};
const showOnly = (label: 'ทั้งหมด' | 'ยังรับ') => {
  fireEvent.click(screen.getByRole('radio', { name: label }));
};
// The polite line inside the search area: what a screen reader hears.
const announcement = () =>
  within(screen.getByRole('search', { name: 'ค้นหาชุมนุม' })).getByRole('status').textContent;

// The visible line under the filter (the polite one in the search area says the same once).
const summary = () =>
  screen
    .getAllByText(/^(แสดง|ไม่พบ)/)
    .find((element) => element.closest('[role="search"]') === null);

const pollOnce = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS);
  });
};

describe('finding a club on the clubs page', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows every club and announces nothing before the student filters', async () => {
    mockStudentApi();

    await openPage();

    expect(shownClubs()).toEqual([CHESS.name, MUSIC.name, ART.name]);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'ทั้งหมด' }).checked).toBe(true);
    expect(announcement()).toBe('');
    expect(screen.queryByText(/^แสดง /)).toBeNull();
    expect(screen.queryByRole('button', { name: 'ล้างตัวกรอง' })).toBeNull();
  });

  it('finds a club by part of its name, ignoring spaces', async () => {
    mockStudentApi();
    await openPage();

    search(' ดน ตรี ');

    expect(shownClubs()).toEqual([MUSIC.name]);
  });

  it('finds a club by its code, ignoring case and spaces', async () => {
    mockStudentApi();
    await openPage();

    search('c 3');

    expect(shownClubs()).toEqual([ART.name]);
  });

  it('finds a club by its code and name typed together', async () => {
    mockStudentApi();
    await openPage();

    search('a100 ชุมนุมหมาก');

    expect(shownClubs()).toEqual([CHESS.name]);
  });

  it('matches sara am however it was typed', async () => {
    const dance: StudentClub = { ...ART, id: 14, clubCode: 'D400', name: 'ชุมนุมรำไทยสมมติ' };
    mockStudentApi({ clubs: [CHESS, dance] });
    await openPage();

    // Nikhahit + sara aa: what some keyboards give for sara am.
    search('รําไทย');

    expect(shownClubs()).toEqual([dance.name]);
  });

  it('shows only clubs with a seat the student can take under "ยังรับ"', async () => {
    mockStudentApi({ clubs: [CHESS, MUSIC, QUEUED_ART] });
    await openPage();

    showOnly('ยังรับ');

    expect(shownClubs()).toEqual([CHESS.name]);
    showOnly('ทั้งหมด');
    expect(shownClubs()).toEqual([CHESS.name, MUSIC.name, ART.name]);
  });

  it('combines the search with "ยังรับ"', async () => {
    mockStudentApi();
    await openPage();

    search('ชุมนุม');
    showOnly('ยังรับ');

    expect(shownClubs()).toEqual([CHESS.name, ART.name]);
  });

  it('shows and announces how many clubs match', async () => {
    mockStudentApi();
    await openPage();

    search('หมาก');

    expect(summary()?.textContent).toBe('แสดง 1 จาก 3 ชุมนุม');
    expect(announcement()).toBe('แสดง 1 จาก 3 ชุมนุม');
    // The list heading still counts the whole round.
    expect(screen.getByRole('heading', { name: 'รายการชุมนุม (3)' })).toBeTruthy();
  });

  it('says nothing matched and clears the filter from there', async () => {
    mockStudentApi();
    await openPage();
    showOnly('ยังรับ');
    search('ดนตรี');

    expect(summary()?.textContent).toBe('ไม่พบชุมนุมที่ยังรับที่ตรงกับ "ดนตรี"');
    expect(announcement()).toBe('ไม่พบชุมนุมที่ยังรับที่ตรงกับ "ดนตรี"');
    // The list stays in place, empty, so nothing below it moves in the tree.
    expect(shownClubs()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'ล้างตัวกรอง' }));

    expect(shownClubs()).toEqual([CHESS.name, MUSIC.name, ART.name]);
    expect(searchBox().value).toBe('');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'ทั้งหมด' }).checked).toBe(true);
    expect(announcement()).toBe('แสดงทั้งหมด 3 ชุมนุม');
    expect(document.activeElement).toBe(searchBox());
  });

  it('says no club has a seat when "ยังรับ" alone leaves none', async () => {
    mockStudentApi({ clubs: [MUSIC] });
    await openPage();

    showOnly('ยังรับ');

    expect(summary()?.textContent).toBe('ไม่พบชุมนุมที่ยังรับ');
  });

  it('keeps the same list element while the filter changes', async () => {
    mockStudentApi();
    const list = await openPage();

    search('ไม่มีชุมนุมนี้');
    search('');

    expect(screen.getByRole('list', { name: 'รายการชุมนุม' })).toBe(list);
  });

  it('keeps the held club and the waitlist place on screen whatever the filter', async () => {
    mockStudentApi({ registration: registrationFor(CHESS), waitlist: waitlistFor(MUSIC, 2) });
    await openPage();

    search('วาดภาพ');
    showOnly('ยังรับ');

    expect(shownClubs()).toEqual([ART.name]);
    expect(screen.getByRole('heading', { name: 'ชุมนุมของฉัน' }).parentElement?.textContent).toContain(
      `${CHESS.clubCode} ${CHESS.name}`,
    );
    expect(
      screen.getByRole('heading', { name: 'รายชื่อรอของฉัน' }).parentElement?.textContent,
    ).toContain(`${MUSIC.clubCode} ${MUSIC.name}`);
    expect(screen.getByRole('button', { name: 'ออกจากรายชื่อรอ' })).toBeTruthy();
  });

  it('does not announce again when a poll changes the counts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state, fetchMock } = mockStudentApi();
    await openPage();
    showOnly('ยังรับ');
    expect(announcement()).toBe('แสดง 2 จาก 3 ชุมนุม');
    const reads = callsTo(fetchMock, 'GET', CLUBS_PATH).length;

    state.clubs = [CHESS, MUSIC, FULL_ART];
    await pollOnce();

    await waitFor(() =>
      expect(callsTo(fetchMock, 'GET', CLUBS_PATH).length).toBeGreaterThan(reads),
    );
    await waitFor(() => expect(shownClubs()).toEqual([CHESS.name]));
    // The visible line follows the data; the announcement waits for the student's next change.
    expect(summary()?.textContent).toBe('แสดง 1 จาก 3 ชุมนุม');
    expect(announcement()).toBe('แสดง 2 จาก 3 ชุมนุม');
  });

  it('moves focus to the count when a poll filters out the focused club', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state } = mockStudentApi();
    await openPage();
    showOnly('ยังรับ');
    const button = screen.getByRole('button', { name: `ลงชุมนุม ${ART.clubCode} ${ART.name}` });
    button.focus();
    expect(document.activeElement).toBe(button);

    state.clubs = [CHESS, MUSIC, FULL_ART];
    await pollOnce();

    await waitFor(() => expect(shownClubs()).toEqual([CHESS.name]));
    expect(document.activeElement).toBe(summary());
    expect(summary()?.textContent).toBe('แสดง 1 จาก 3 ชุมนุม');
  });

  it('moves focus to the list heading when a poll removes the focused club unfiltered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state } = mockStudentApi();
    await openPage();
    screen.getByRole('button', { name: `ลงชุมนุม ${ART.clubCode} ${ART.name}` }).focus();

    state.clubs = [CHESS, MUSIC];
    await pollOnce();

    await waitFor(() => expect(shownClubs()).toEqual([CHESS.name, MUSIC.name]));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'รายการชุมนุม (2)' }));
  });

  it('does not take focus from elsewhere when a poll filters out a club', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state } = mockStudentApi();
    await openPage();
    showOnly('ยังรับ');
    const radio = screen.getByRole('radio', { name: 'ยังรับ' });
    radio.focus();

    state.clubs = [CHESS, MUSIC, FULL_ART];
    await pollOnce();

    await waitFor(() => expect(shownClubs()).toEqual([CHESS.name]));
    expect(document.activeElement).toBe(radio);
  });

  it('keeps an open confirmation on screen when its club fills under "ยังรับ"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state } = mockStudentApi();
    await openPage();
    showOnly('ยังรับ');
    fireEvent.click(screen.getByRole('button', { name: `ลงชุมนุม ${ART.clubCode} ${ART.name}` }));
    const dialog = screen.getByRole('alertdialog', {
      name: `ยืนยันการลงชุมนุม ${ART.clubCode} ${ART.name}`,
    });

    state.clubs = [CHESS, MUSIC, FULL_ART];
    await pollOnce();

    await waitFor(() =>
      expect(within(screen.getByRole('article', { name: ART.name })).getByText('เต็ม')).toBeTruthy(),
    );
    expect(dialog.isConnected).toBe(true);
    expect(shownClubs()).toEqual([CHESS.name, ART.name]);
  });

  it('keeps the filter when the student registers', async () => {
    mockStudentApi();
    await openPage();
    search('วาด');
    fireEvent.click(screen.getByRole('button', { name: `ลงชุมนุม ${ART.clubCode} ${ART.name}` }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'ยืนยัน ลงชุมนุม' }),
    );

    await screen.findByText(`ลงชุมนุม ${ART.clubCode} ${ART.name} เรียบร้อยแล้ว`, { exact: false });
    expect(searchBox().value).toBe('วาด');
    expect(shownClubs()).toEqual([ART.name]);
  });
});
