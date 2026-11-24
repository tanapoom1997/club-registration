import type { Round, SessionUser } from '@club-registration/shared';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt } from '@/test-support/render-app';

// Every name below is made up.
const ADMIN: SessionUser = {
  id: 9,
  loginId: 'demo-admin',
  fullName: 'ผู้ดูแลสมมติ',
  role: 'admin',
  mustChangePassword: false,
};

const round = (overrides: Partial<Round>): Round => ({
  id: 1,
  term: '2569/1',
  grade: 1,
  opensAt: '2026-12-01T01:00:00.000Z',
  closesAt: '2026-12-01T09:00:00.000Z',
  maxActive: 150,
  status: 'open',
  clubCount: 10,
  totalCapacity: 300,
  totalRegistered: 120,
  queueWaiting: 40,
  queueAdmitted: 150,
  studentCount: 0,
  studentsWithoutClub: 0,
  ...overrides,
});

const OVERVIEW = 'รอบที่เปิดอยู่และกำลังจะเปิด';

const openHome = (rounds: () => Response) => {
  const fetchMock = mockApi({
    'GET /api/auth/me': () => Response.json({ user: ADMIN }),
    'GET /api/admin/rounds': rounds,
  });
  renderAt('/admin');
  return fetchMock;
};

const overview = async () => await screen.findByRole('region', { name: OVERVIEW });

describe("the admin home's round overview (U8)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows each open and upcoming round with its seats and queue, and leaves closed ones out', async () => {
    openHome(() =>
      Response.json({
        rounds: [
          round({ id: 1, grade: 1, status: 'closed' }),
          round({ id: 2, grade: 2 }),
          round({ id: 3, grade: 3, status: 'upcoming', maxActive: null, totalCapacity: 0 }),
        ],
      }),
    );

    const list = await screen.findByRole('list', { name: OVERVIEW });
    const cards = within(list).getAllByRole('listitem');
    expect(cards.map((card) => within(card).getByRole('heading').textContent)).toEqual([
      'ม.2 · 2569/1',
      'ม.3 · 2569/1',
    ]);
    const [open, upcoming] = cards as [HTMLElement, HTMLElement];
    expect(within(open).getByText('เปิดอยู่')).toBeTruthy();
    expect(open.textContent).toContain('ลงแล้ว 120 / 300 คน');
    expect(open.textContent).toContain('เหลือ 180 ที่');
    expect(open.textContent).toContain('รอคิว 40 คน · ได้คิวแล้ว 150 / 150 คน');
    expect(within(upcoming).getByText('ยังไม่เปิด')).toBeTruthy();
    expect(upcoming.textContent).toContain('ยังไม่มีชุมนุมในรอบนี้');
    expect(upcoming.textContent).toContain('ไม่มีคิว');
  });

  // Seats taken are not students done: the card says who in the grade still has no club.
  it('says how many students of the grade still have no club', async () => {
    openHome(() =>
      Response.json({
        rounds: [
          round({ id: 1, grade: 4, studentCount: 420, studentsWithoutClub: 213 }),
          round({ id: 2, grade: 5, studentCount: 380, studentsWithoutClub: 0 }),
          round({ id: 3, grade: 6, status: 'upcoming' }),
        ],
      }),
    );

    const list = await screen.findByRole('list', { name: OVERVIEW });
    const [missing, done, empty] = within(list).getAllByRole('listitem') as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(missing.textContent).toContain('ยังไม่มีชุมนุม 213 จาก 420 คน');
    expect(done.textContent).toContain('นักเรียนได้ชุมนุมครบทุกคนแล้ว (380 คน)');
    // No students in the grade yet: most likely the import has not been done.
    expect(empty.textContent).toContain('ยังไม่มีนักเรียน ม.6 ในระบบ');
  });

  it('says so when no round is open or upcoming', async () => {
    openHome(() => Response.json({ rounds: [round({ status: 'closed' })] }));

    const region = await overview();

    expect(await within(region).findByText('ไม่มีรอบที่เปิดอยู่หรือกำลังจะเปิด')).toBeTruthy();
    expect(within(region).queryByRole('list')).toBeNull();
  });

  it('leads to the rounds page', async () => {
    openHome(() => Response.json({ rounds: [] }));

    const link = within(await overview()).getByRole('link', { name: 'จัดการรอบลงทะเบียน' });

    expect(link.getAttribute('href')).toBe('/admin/rounds');
  });

  it('offers a retry when the rounds cannot be loaded, keeping the menu', async () => {
    let fail = true;
    const fetchMock = openHome(() =>
      fail
        ? Response.json({ code: 'internal', message: 'x' }, { status: 500 })
        : Response.json({ rounds: [round({})] }),
    );

    const region = await overview();
    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('โหลดภาพรวมรอบไม่สำเร็จ');
    expect(screen.getByRole('link', { name: /รอบลงทะเบียน\s*สร้างรอบ/ })).toBeTruthy();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'ลองใหม่' }));

    expect(await within(region).findByRole('list', { name: OVERVIEW })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/admin/rounds')).toHaveLength(2);
  });
});
