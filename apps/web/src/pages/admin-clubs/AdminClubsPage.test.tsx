import type { AdminClub, Round, SessionUser } from '@club-registration/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt } from '@/test-support/render-app';
import { CLUBS_POLL_INTERVAL_MS } from './club-ui';

const ADMIN: SessionUser = {
  id: 9,
  loginId: 'demo-admin',
  fullName: 'ผู้ดูแลสมมติ',
  role: 'admin',
  mustChangePassword: false,
};

const roundFixture = (overrides: Partial<Round> = {}): Round => ({
  id: 1,
  term: '2569/1',
  grade: 1,
  opensAt: '2026-12-01T01:00:00.000Z',
  closesAt: '2026-12-01T09:00:00.000Z',
  maxActive: 150,
  status: 'upcoming',
  clubCount: 2,
  totalCapacity: 50,
  totalRegistered: 18,
  queueWaiting: 0,
  queueAdmitted: 0,
  ...overrides,
});

// Every name and contact below is made up.
const CLUBS: AdminClub[] = [
  {
    id: 11,
    roundId: 1,
    clubCode: 'A100',
    name: 'ชุมนุมหมากรุกสมมติ',
    description: 'เล่น <b>หมากรุก</b>\nทุกวันศุกร์',
    capacity: 30,
    registered: 12,
    remaining: 18,
    advisors: [
      {
        id: 1,
        fullName: 'ครูสมมติ ใจดี',
        phone: '080-000-0001',
        email: 'fictional.teacher@example.com',
        lineId: 'fictional.line',
      },
    ],
  },
  {
    id: 12,
    roundId: 1,
    clubCode: 'B200',
    name: 'ชุมนุมดนตรีสมมติ',
    description: '',
    capacity: 20,
    registered: 20,
    remaining: 0,
    advisors: [],
  },
];

const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

const CLUBS_PATH = '/api/admin/rounds/1/clubs';

const fetchCalls = (fetchMock: ReturnType<typeof mockApi>, method: string, path: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => input === path && (init?.method ?? 'GET') === method,
  );

// A tiny in-memory stand-in for the clubs API, so the page's refetch shows what was saved.
const mockClubsApi = (round: Round, extra: Parameters<typeof mockApi>[0] = {}) => {
  let clubs = [...CLUBS];
  return mockApi({
    'GET /api/auth/me': () => Response.json({ user: ADMIN }),
    'GET /api/admin/rounds': () => Response.json({ rounds: [round] }),
    [`GET ${CLUBS_PATH}`]: () => Response.json({ round, clubs }),
    ...Object.fromEntries(
      CLUBS.map((club) => [
        `PATCH /api/admin/clubs/${club.id}`,
        (init: RequestInit | undefined) => {
          const merged = { ...club, ...(bodyOf(init) as Partial<AdminClub>) };
          const updated = { ...merged, remaining: merged.capacity - merged.registered };
          clubs = clubs.map((existing) => (existing.id === club.id ? updated : existing));
          return Response.json({ club: updated });
        },
      ]),
    ),
    ...extra,
  });
};

// One round whose status a test changes, as the clock would, between two answers.
const mockLiveRoundApi = (initial: Round) => {
  const state = { round: initial };
  const fetchMock = mockApi({
    'GET /api/auth/me': () => Response.json({ user: ADMIN }),
    'GET /api/admin/rounds': () => Response.json({ rounds: [state.round] }),
    [`GET ${CLUBS_PATH}`]: () => Response.json({ round: state.round, clubs: CLUBS }),
  });
  return { fetchMock, state };
};

// The page preselects a round, so with a single round its table appears without a choice.
const openTable = async () => await screen.findByRole('table', { name: 'รายการชุมนุม' });

const roundPicker = () => screen.getByLabelText<HTMLSelectElement>('รอบลงทะเบียน');

const chooseRound = async (label: string) => {
  const option = await screen.findByRole('option', { name: new RegExp(`^${label}`) });
  fireEvent.change(roundPicker(), { target: { value: option.getAttribute('value') } });
};

const clubsPathOf = (roundId: number) => `/api/admin/rounds/${roundId}/clubs`;

// Several rounds, each answering with its own copy of the clubs.
const mockRoundsApi = (rounds: Round[], extra: Parameters<typeof mockApi>[0] = {}) =>
  mockApi({
    'GET /api/auth/me': () => Response.json({ user: ADMIN }),
    'GET /api/admin/rounds': () => Response.json({ rounds }),
    ...Object.fromEntries(
      rounds.map((round) => [
        `GET ${clubsPathOf(round.id)}`,
        () =>
          Response.json({ round, clubs: CLUBS.map((club) => ({ ...club, roundId: round.id })) }),
      ]),
    ),
    ...extra,
  });

// Fictional rounds of one term, one per grade so each has its own label in the picker.
const OPEN_LATE = roundFixture({
  id: 21,
  grade: 1,
  status: 'open',
  opensAt: '2026-11-17T01:00:00.000Z',
  closesAt: '2026-11-19T09:00:00.000Z',
});
const OPEN_SOON = roundFixture({
  id: 22,
  grade: 2,
  status: 'open',
  opensAt: '2026-11-17T02:00:00.000Z',
  closesAt: '2026-11-18T09:00:00.000Z',
});
const UPCOMING_LATE = roundFixture({
  id: 23,
  grade: 3,
  status: 'upcoming',
  opensAt: '2026-12-08T01:00:00.000Z',
  closesAt: '2026-12-08T09:00:00.000Z',
});
const UPCOMING_SOON = roundFixture({
  id: 24,
  grade: 4,
  status: 'upcoming',
  opensAt: '2026-12-01T01:00:00.000Z',
  closesAt: '2026-12-01T09:00:00.000Z',
});
const CLOSED_EARLY = roundFixture({
  id: 25,
  grade: 5,
  status: 'closed',
  opensAt: '2026-11-01T01:00:00.000Z',
  closesAt: '2026-11-01T09:00:00.000Z',
});
const CLOSED_LATE = roundFixture({
  id: 26,
  grade: 6,
  status: 'closed',
  opensAt: '2026-11-10T01:00:00.000Z',
  closesAt: '2026-11-10T09:00:00.000Z',
});

const rowOf = (table: HTMLElement, clubCode: string) =>
  within(table).getByText(clubCode).closest('tr') as HTMLElement;

const openEditor = (clubCode: string) => {
  fireEvent.click(screen.getByRole('button', { name: `แก้ไขชุมนุม ${clubCode}` }));
  return screen.getByRole('form', { name: `แก้ไขชุมนุม ${clubCode}` });
};

describe('admin clubs page', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lists the chosen round clubs with seats, advisors and the description as plain text', async () => {
    mockClubsApi(roundFixture());
    renderAt('/admin/clubs');

    const table = await openTable();

    const chess = rowOf(table, 'A100');
    expect(chess.textContent).toContain('ชุมนุมหมากรุกสมมติ');
    expect(chess.textContent).toContain('ครูสมมติ ใจดี');
    expect(chess.textContent).toContain('080-000-0001');
    expect(chess.textContent).toContain('fictional.teacher@example.com');
    expect(chess.textContent).toContain('LINE fictional.line');
    expect(within(chess).getByText(/เล่น <b>หมากรุก<\/b>/)).toBeTruthy();
    expect(chess.querySelector('b')).toBeNull();
    const cells = within(chess)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(cells.slice(3, 6)).toEqual(['30', '12', '18']);
    const music = rowOf(table, 'B200');
    expect(music.textContent).toContain('ยังไม่มีครู');
    expect(music.textContent).toContain('เต็ม');
    expect(screen.getByText('2 ชุมนุม · ลงแล้ว 18 / รับ 50')).toBeTruthy();
  });

  it.each([
    [
      'the open round closing soonest',
      [CLOSED_LATE, UPCOMING_SOON, OPEN_LATE, OPEN_SOON, CLOSED_EARLY],
      OPEN_SOON,
    ],
    [
      'the upcoming round opening soonest when none is open',
      [CLOSED_LATE, UPCOMING_LATE, UPCOMING_SOON],
      UPCOMING_SOON,
    ],
    [
      'the most recently closed round when all are closed',
      [CLOSED_EARLY, CLOSED_LATE],
      CLOSED_LATE,
    ],
  ])('preselects %s', async (_, rounds, expected) => {
    const fetchMock = mockRoundsApi(rounds);
    renderAt('/admin/clubs');

    await openTable();

    expect(roundPicker().value).toBe(String(expected.id));
    expect(screen.queryByRole('option', { name: 'เลือกรอบ' })).toBeNull();
    const clubLists = fetchMock.mock.calls
      .map(([input]) => input)
      .filter((input) => input.endsWith('/clubs'));
    expect(clubLists).toEqual([clubsPathOf(expected.id)]);
  });

  it('keeps the round the admin picked when the rounds list is reloaded', async () => {
    const fetchMock = mockRoundsApi([OPEN_SOON, CLOSED_LATE], {
      'PATCH /api/admin/clubs/11': () => Response.json({ club: { ...CLUBS[0], roundId: 26 } }),
    });
    renderAt('/admin/clubs');
    await openTable();

    await chooseRound('2569/1 ม.6');
    await openTable();
    expect(fetchCalls(fetchMock, 'GET', clubsPathOf(CLOSED_LATE.id))).toHaveLength(1);
    const form = openEditor('A100');
    fireEvent.change(within(form).getByLabelText('จำนวนรับ'), { target: { value: '35' } });
    fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));
    await screen.findByRole('status');

    // Saving reloads the rounds list, which still lists an open round the page would preselect.
    await waitFor(() => expect(fetchCalls(fetchMock, 'GET', '/api/admin/rounds')).toHaveLength(2));
    expect(roundPicker().value).toBe(String(CLOSED_LATE.id));
  });

  it('saves only the changed capacity and shows the new numbers', async () => {
    const fetchMock = mockClubsApi(roundFixture());
    renderAt('/admin/clubs');
    await openTable();
    const form = openEditor('A100');

    fireEvent.change(within(form).getByLabelText('จำนวนรับ'), { target: { value: '35' } });
    fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));

    expect((await screen.findByRole('status')).textContent).toBe('บันทึกชุมนุม A100 แล้ว');
    expect(screen.queryByRole('form', { name: 'แก้ไขชุมนุม A100' })).toBeNull();
    const [, init] = fetchCalls(fetchMock, 'PATCH', '/api/admin/clubs/11')[0]!;
    expect(bodyOf(init)).toEqual({ capacity: 35 });
    await waitFor(() => {
      const cells = within(rowOf(screen.getByRole('table'), 'A100'))
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
      expect(cells.slice(3, 6)).toEqual(['35', '12', '23']);
    });
  });

  // README Phase 4, P4c (U6): the editor opens below a table that may be long.
  it('brings the editor into view with focus on its heading, and back to the button on close', async () => {
    mockClubsApi(roundFixture());
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    renderAt('/admin/clubs');
    await openTable();
    const opener = screen.getByRole('button', { name: 'แก้ไขชุมนุม A100' });

    const form = openEditor('A100');

    const heading = screen.getByRole('heading', { name: 'แก้ไขชุมนุม A100' });
    expect(document.activeElement).toBe(heading);
    expect(scroll.mock.contexts).toEqual([heading]);

    // A second click on the same button, after the admin moved on, brings it back into view.
    within(form).getByLabelText('ชื่อชุมนุม').focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(heading);
    expect(scroll).toHaveBeenCalledTimes(2);

    fireEvent.click(within(form).getByRole('button', { name: 'ปิด' }));

    expect(screen.queryByRole('form', { name: 'แก้ไขชุมนุม A100' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('gives focus back to the edit button after a save', async () => {
    mockClubsApi(roundFixture());
    renderAt('/admin/clubs');
    await openTable();
    const opener = screen.getByRole('button', { name: 'แก้ไขชุมนุม A100' });
    const form = openEditor('A100');

    fireEvent.change(within(form).getByLabelText('จำนวนรับ'), { target: { value: '35' } });
    fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));

    await screen.findByText('บันทึกชุมนุม A100 แล้ว');
    expect(document.activeElement).toBe(opener);
  });

  it('saves a new name and description', async () => {
    const fetchMock = mockClubsApi(roundFixture());
    renderAt('/admin/clubs');
    await openTable();
    const form = openEditor('B200');

    fireEvent.change(within(form).getByLabelText('ชื่อชุมนุม'), {
      target: { value: 'ชุมนุมดนตรีไทยสมมติ' },
    });
    fireEvent.change(within(form).getByLabelText('รายละเอียด'), {
      target: { value: 'ซ้อมวันพุธ' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));

    await screen.findByRole('status');
    const [, init] = fetchCalls(fetchMock, 'PATCH', '/api/admin/clubs/12')[0]!;
    expect(bodyOf(init)).toEqual({ name: 'ชุมนุมดนตรีไทยสมมติ', description: 'ซ้อมวันพุธ' });
    expect(await screen.findByText('ชุมนุมดนตรีไทยสมมติ')).toBeTruthy();
  });

  it('explains in Thai why a capacity below the registered count was refused', async () => {
    mockClubsApi(roundFixture(), {
      'PATCH /api/admin/clubs/11': () =>
        Response.json(
          { code: 'capacity_below_registered', message: 'below registered' },
          { status: 409 },
        ),
    });
    renderAt('/admin/clubs');
    await openTable();
    const form = openEditor('A100');

    fireEvent.change(within(form).getByLabelText('จำนวนรับ'), { target: { value: '5' } });
    fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));

    expect((await within(form).findByRole('alert')).textContent).toContain(
      'ลดจำนวนรับให้น้อยกว่าจำนวนนักเรียนที่ลงทะเบียนแล้วไม่ได้',
    );
    expect(screen.getByRole('form', { name: 'แก้ไขชุมนุม A100' })).toBeTruthy();
  });

  it('does not send a blank name', async () => {
    const fetchMock = mockClubsApi(roundFixture());
    renderAt('/admin/clubs');
    await openTable();
    const form = openEditor('A100');

    fireEvent.change(within(form).getByLabelText('ชื่อชุมนุม'), { target: { value: '  ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));

    expect((await within(form).findByRole('alert')).textContent).toBe('กรุณากรอกชื่อชุมนุม');
    expect(fetchCalls(fetchMock, 'PATCH', '/api/admin/clubs/11')).toHaveLength(0);
  });

  it('keeps refreshing the clubs while the round is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockClubsApi(roundFixture({ status: 'open' }));
    renderAt('/admin/clubs');
    await openTable();
    expect(fetchCalls(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS);
    });

    await waitFor(() => expect(fetchCalls(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(2));
  });

  it('does not poll a closed round', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockClubsApi(roundFixture({ status: 'closed' }));
    renderAt('/admin/clubs');
    await openTable();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(fetchCalls(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(1);
  });

  it('starts polling by itself when an upcoming round opens, without a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const opensAt = new Date(Date.now() + 20_000).toISOString();
    const { fetchMock, state } = mockLiveRoundApi(roundFixture({ status: 'upcoming', opensAt }));
    renderAt('/admin/clubs');
    await openTable();
    expect(screen.getByText(/ตัวเลขจะเริ่มอัปเดตเองโดยไม่ต้องโหลดหน้าใหม่/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchCalls(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(1);
    state.round = { ...state.round, status: 'open' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });

    await waitFor(() => expect(fetchCalls(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(2));
    expect(await screen.findByText(/รอบนี้เปิดอยู่ ตัวเลขอัปเดตอัตโนมัติ/)).toBeTruthy();
    // The picker label follows the new status too.
    expect(await screen.findByRole('option', { name: '2569/1 ม.1 (เปิดอยู่)' })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(fetchCalls(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(3));
  });

  it('stops polling once the server says the round has closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchMock, state } = mockLiveRoundApi(roundFixture({ status: 'open' }));
    renderAt('/admin/clubs');
    await openTable();

    state.round = { ...state.round, status: 'closed' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(fetchCalls(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(fetchCalls(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(2);
    expect(screen.getByText('ปิดแล้ว')).toBeTruthy();
  });
});
