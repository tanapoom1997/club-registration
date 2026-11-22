import type {
  AdminClub,
  Round,
  RoundClassroomsResponse,
  SessionUser,
} from '@club-registration/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt, unauthorized } from '@/test-support/render-app';

const ADMIN: SessionUser = {
  id: 9,
  loginId: 'demo-admin',
  fullName: 'ผู้ดูแลสมมติ',
  role: 'admin',
  mustChangePassword: false,
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ROUND: Round = {
  id: 1,
  term: '2569/1',
  grade: 1,
  opensAt: '2026-12-01T01:00:00.000Z',
  closesAt: '2026-12-01T09:00:00.000Z',
  maxActive: 150,
  status: 'closed',
  clubCount: 2,
  totalCapacity: 50,
  totalRegistered: 32,
  queueWaiting: 0,
  queueAdmitted: 0,
};

// Every name below is made up.
const club = (overrides: Partial<AdminClub>): AdminClub => ({
  id: 11,
  roundId: 1,
  clubCode: 'A100',
  name: 'ชุมนุมหมากรุกสมมติ',
  description: '',
  capacity: 30,
  registered: 12,
  remaining: 18,
  advisors: [],
  ...overrides,
});

const CLUBS: AdminClub[] = [
  club({}),
  club({ id: 12, clubCode: 'B200', name: 'ชุมนุมดนตรีสมมติ', capacity: 20, registered: 20 }),
];

const CLASSROOMS: RoundClassroomsResponse = {
  round: ROUND,
  classrooms: [
    { classroom: '2', studentCount: 40, registeredCount: 30 },
    { classroom: '3/1', studentCount: 38, registeredCount: 2 },
  ],
};

const EXPORT_PREFIX = '/api/admin/rounds/1/export?';

const fileResponse = (filename: string, contentType = XLSX_MIME) =>
  new Response(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]), {
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });

const baseApi = {
  'GET /api/auth/me': () => Response.json({ user: ADMIN }),
  'GET /api/admin/rounds': () => Response.json({ rounds: [ROUND] }),
  'GET /api/admin/rounds/1/clubs': () => Response.json({ round: ROUND, clubs: CLUBS }),
  'GET /api/admin/rounds/1/classrooms': () => Response.json(CLASSROOMS),
};

const exportCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.map(([input]) => input).filter((input) => input.startsWith(EXPORT_PREFIX));

const downloadButton = () => screen.getByRole('button', { name: 'ดาวน์โหลดรายชื่อ' });

const openPageWithRound = async () => {
  renderAt('/admin/export');
  fireEvent.change(await screen.findByLabelText('รอบลงทะเบียน'), { target: { value: '1' } });
  await screen.findByLabelText('ขอบเขต');
};

describe('admin export page', () => {
  let downloads: string[];

  beforeEach(() => {
    downloads = [];
    // jsdom has no object URLs and does not download; record what would have been saved.
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('downloads every club of the chosen round by default', async () => {
    const fetchMock = mockApi({
      ...baseApi,
      [`GET ${EXPORT_PREFIX}view=club&format=xlsx`]: () =>
        fileResponse('club-list-round-1-grade-1.xlsx'),
    });
    await openPageWithRound();

    expect(screen.getByText('ลงแล้ว 32 / รับ 50 คน')).toBeTruthy();
    fireEvent.click(downloadButton());

    expect((await screen.findByRole('status')).textContent).toBe(
      'ดาวน์โหลดไฟล์ club-list-round-1-grade-1.xlsx แล้ว',
    );
    expect(exportCalls(fetchMock)).toEqual([`${EXPORT_PREFIX}view=club&format=xlsx`]);
    expect(downloads).toEqual(['club-list-round-1-grade-1.xlsx']);
  });

  it('downloads the list of one chosen club', async () => {
    const fetchMock = mockApi({
      ...baseApi,
      [`GET ${EXPORT_PREFIX}view=club&clubId=12&format=xlsx`]: () =>
        fileResponse('club-list-round-1-grade-1-B200.xlsx'),
    });
    await openPageWithRound();

    fireEvent.change(screen.getByLabelText('ขอบเขต'), { target: { value: '12' } });
    expect(screen.getByText('ลงแล้ว 20 / รับ 20 คน')).toBeTruthy();
    fireEvent.click(downloadButton());

    await waitFor(() => {
      expect(downloads).toEqual(['club-list-round-1-grade-1-B200.xlsx']);
    });
    expect(exportCalls(fetchMock)).toEqual([`${EXPORT_PREFIX}view=club&clubId=12&format=xlsx`]);
  });

  it('offers the classrooms of the round grade with who has not registered', async () => {
    const fetchMock = mockApi({
      ...baseApi,
      [`GET ${EXPORT_PREFIX}view=classroom&classroom=3%2F1&format=xlsx`]: () =>
        fileResponse('classroom-list-round-1-grade-1-room-3-1.xlsx'),
    });
    await openPageWithRound();

    fireEvent.click(screen.getByRole('radio', { name: /รายห้อง/ }));
    const scope = await screen.findByLabelText('ขอบเขต');
    expect(screen.getByText('ลงแล้ว 32 / ทั้งหมด 78 คน (ยังไม่ลง 46 คน)')).toBeTruthy();
    expect([...(scope as HTMLSelectElement).options].map(({ textContent }) => textContent)).toEqual(
      ['ทั้งรอบ (ทุกห้องของ ม.1, 1 ชีตต่อห้อง)', 'ม.1/2', 'ม.1/3/1'],
    );
    fireEvent.change(scope, { target: { value: '3/1' } });
    expect(screen.getByText('ลงแล้ว 2 / ทั้งห้อง 38 คน (ยังไม่ลง 36 คน)')).toBeTruthy();
    fireEvent.click(downloadButton());

    await waitFor(() => {
      expect(downloads).toEqual(['classroom-list-round-1-grade-1-room-3-1.xlsx']);
    });
    expect(exportCalls(fetchMock)).toEqual([
      `${EXPORT_PREFIX}view=classroom&classroom=3%2F1&format=xlsx`,
    ]);
  });

  it('offers Excel and PDF, Excel chosen first', async () => {
    mockApi(baseApi);
    await openPageWithRound();

    const excel = screen.getByRole('radio', { name: /Excel \(\.xlsx\)/ });
    const pdf = screen.getByRole('radio', { name: /PDF/ });
    expect((excel as HTMLInputElement).checked).toBe(true);
    expect((pdf as HTMLInputElement).checked).toBe(false);
  });

  it('downloads the chosen classroom as a PDF named by the server', async () => {
    const fetchMock = mockApi({
      ...baseApi,
      [`GET ${EXPORT_PREFIX}view=classroom&classroom=2&format=pdf`]: () =>
        fileResponse('classroom-list-round-1-grade-1-room-2.pdf', 'application/pdf'),
    });
    await openPageWithRound();

    fireEvent.click(screen.getByRole('radio', { name: /รายห้อง/ }));
    fireEvent.change(await screen.findByLabelText('ขอบเขต'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('radio', { name: /PDF/ }));
    fireEvent.click(downloadButton());

    expect((await screen.findByRole('status')).textContent).toBe(
      'ดาวน์โหลดไฟล์ classroom-list-round-1-grade-1-room-2.pdf แล้ว',
    );
    expect(downloads).toEqual(['classroom-list-round-1-grade-1-room-2.pdf']);
    expect(exportCalls(fetchMock)).toEqual([
      `${EXPORT_PREFIX}view=classroom&classroom=2&format=pdf`,
    ]);
  });

  it('describes a whole-round PDF as a new page per club', async () => {
    const fetchMock = mockApi({
      ...baseApi,
      [`GET ${EXPORT_PREFIX}view=club&format=pdf`]: () =>
        new Response(null, {
          headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment' },
        }),
    });
    await openPageWithRound();

    fireEvent.click(screen.getByRole('radio', { name: /PDF/ }));
    const scope = screen.getByLabelText<HTMLSelectElement>('ขอบเขต');
    expect(scope.options[0]?.textContent).toBe('ทั้งรอบ (2 ชุมนุม, หน้าใหม่ต่อชุมนุม)');
    fireEvent.click(downloadButton());

    // A file the server did not name still downloads, as a .pdf.
    await waitFor(() => {
      expect(downloads).toEqual(['name-list.pdf']);
    });
    expect(exportCalls(fetchMock)).toEqual([`${EXPORT_PREFIX}view=club&format=pdf`]);
  });

  it('shows a Thai error for a refused PDF export', async () => {
    mockApi({
      ...baseApi,
      [`GET ${EXPORT_PREFIX}view=club&format=pdf`]: () =>
        Response.json(
          { code: 'nothing_to_export', message: 'The round has no clubs' },
          { status: 404 },
        ),
    });
    await openPageWithRound();

    fireEvent.click(screen.getByRole('radio', { name: /PDF/ }));
    fireEvent.click(downloadButton());

    expect((await screen.findByRole('alert')).textContent).toBe(
      'ยังไม่มีข้อมูลให้ส่งออก (รอบนี้ยังไม่มีชุมนุม หรือชั้นนี้ยังไม่มีนักเรียน)',
    );
    expect(downloads).toEqual([]);
  });

  it('shows a Thai error and saves nothing when the export is refused', async () => {
    mockApi({
      ...baseApi,
      [`GET ${EXPORT_PREFIX}view=club&clubId=11&format=xlsx`]: () =>
        Response.json({ code: 'not_found', message: 'Club not found' }, { status: 404 }),
    });
    await openPageWithRound();

    fireEvent.change(screen.getByLabelText('ขอบเขต'), { target: { value: '11' } });
    fireEvent.click(downloadButton());

    expect((await screen.findByRole('alert')).textContent).toBe(
      'ไม่พบรอบ ชุมนุม หรือห้องที่เลือก (อาจถูกลบหรือนักเรียนถูกย้ายไปแล้ว) กรุณาโหลดหน้านี้ใหม่',
    );
    expect(downloads).toEqual([]);
  });

  it('says so and offers no download for a round without clubs', async () => {
    const fetchMock = mockApi({
      ...baseApi,
      'GET /api/admin/rounds/1/clubs': () => Response.json({ round: ROUND, clubs: [] }),
    });
    renderAt('/admin/export');

    fireEvent.change(await screen.findByLabelText('รอบลงทะเบียน'), { target: { value: '1' } });

    expect(await screen.findByText('รอบนี้ยังไม่มีชุมนุม เพิ่มได้จากการนำเข้า Excel')).toBeTruthy();
    expect((downloadButton() as HTMLButtonElement).disabled).toBe(true);
    expect(exportCalls(fetchMock)).toEqual([]);
  });

  it('sends the admin back to the login page when the session has expired', async () => {
    let sessionAlive = true;
    mockApi({
      ...baseApi,
      'GET /api/auth/me': () => (sessionAlive ? Response.json({ user: ADMIN }) : unauthorized()),
      [`GET ${EXPORT_PREFIX}view=club&format=xlsx`]: () => {
        sessionAlive = false;
        return unauthorized();
      },
    });
    await openPageWithRound();

    fireEvent.click(downloadButton());

    expect(await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeTruthy();
    expect(downloads).toEqual([]);
  });
});
