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

const chooseRound = async (label = '2569/1 ม.1') => {
  const option = await screen.findByRole('option', { name: new RegExp(`^${label}`) });
  fireEvent.change(screen.getByLabelText('รอบลงทะเบียน'), {
    target: { value: option.getAttribute('value') },
  });
  return await screen.findByRole('table', { name: 'รายการชุมนุม' });
};

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

    const table = await chooseRound();

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

  it('saves only the changed capacity and shows the new numbers', async () => {
    const fetchMock = mockClubsApi(roundFixture());
    renderAt('/admin/clubs');
    await chooseRound();
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

  it('saves a new name and description', async () => {
    const fetchMock = mockClubsApi(roundFixture());
    renderAt('/admin/clubs');
    await chooseRound();
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
    await chooseRound();
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
    await chooseRound();
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
    await chooseRound();
    expect(fetchCalls(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS);
    });

    await waitFor(() => expect(fetchCalls(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(2));
  });

  it.each(['upcoming', 'closed'] as const)('does not poll a round that is %s', async (status) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockClubsApi(roundFixture({ status }));
    renderAt('/admin/clubs');
    await chooseRound();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS * 3);
    });

    expect(fetchCalls(fetchMock, 'GET', CLUBS_PATH)).toHaveLength(1);
  });
});
