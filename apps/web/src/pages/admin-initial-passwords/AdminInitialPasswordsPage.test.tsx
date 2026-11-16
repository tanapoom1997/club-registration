import type { ClassroomPasswordStatus, SessionUser } from '@club-registration/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt } from '@/test-support/render-app';

const ADMIN: SessionUser = {
  id: 9,
  loginId: 'demo-admin',
  fullName: 'ผู้ดูแลสมมติ',
  role: 'admin',
  mustChangePassword: false,
};

const ISSUE_PATH = '/api/admin/students/initial-passwords';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const classroomStatus = (overrides: Partial<ClassroomPasswordStatus>): ClassroomPasswordStatus => ({
  grade: 1,
  classroom: '1',
  neverIssued: 0,
  issuedPending: 0,
  changed: 0,
  lastIssuedAt: null,
  ...overrides,
});

const STATUS: ClassroomPasswordStatus[] = [
  classroomStatus({ grade: 1, classroom: '1', neverIssued: 30, issuedPending: 0, changed: 0 }),
  classroomStatus({
    grade: 1,
    classroom: '2',
    neverIssued: 2,
    issuedPending: 25,
    changed: 8,
    lastIssuedAt: '2026-11-10T03:00:00.000Z',
  }),
  classroomStatus({ grade: 2, classroom: '1', neverIssued: 40 }),
];

const fileResponse = (issuedCount: number) =>
  new Response(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]), {
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': 'attachment; filename="initial-passwords-grade-1-room-2.xlsx"',
      'x-issued-count': String(issuedCount),
    },
  });

const issueCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(([input, init]) => input === ISSUE_PATH && init?.method === 'POST');

// The app sends JSON as a string body.
const bodyOf = (call: [string, RequestInit?]) => JSON.parse(call[1]?.body as string) as unknown;

const issueButton = () => screen.getByRole('button', { name: 'ออกรหัสผ่านและดาวน์โหลด' });

const openPage = async () => {
  renderAt('/admin/initial-passwords');
  await screen.findByRole('table', { name: 'สถานะรหัสผ่านรายห้อง' });
};

const chooseClassroom2 = () => {
  fireEvent.change(screen.getByLabelText('ห้อง'), { target: { value: '2' } });
};

describe('admin initial passwords page', () => {
  let downloads: string[];

  beforeEach(() => {
    downloads = [];
    // jsdom has no object URLs and does not download; record what would have been saved. Set on
    // URL itself (not stubbed) because the revoke runs on a timer that may outlive the test.
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
  });

  it('shows the password status of every classroom', async () => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/students/password-status': () => Response.json({ classrooms: STATUS }),
    });

    await openPage();

    const table = screen.getByRole('table', { name: 'สถานะรหัสผ่านรายห้อง' });
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .slice(0, 5)
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      ['ม.1', '1', '30', '0', '0'],
      ['ม.1', '2', '2', '25', '8'],
      ['ม.2', '1', '40', '0', '0'],
    ]);
  });

  it('asks for confirmation before issuing anything', async () => {
    const fetchMock = mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/students/password-status': () => Response.json({ classrooms: STATUS }),
    });
    await openPage();

    fireEvent.click(issueButton());

    expect(screen.getByRole('alertdialog', { name: 'ยืนยันการออกรหัสผ่าน' })).toBeTruthy();
    expect(issueCalls(fetchMock)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิก' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(issueCalls(fetchMock)).toHaveLength(0);
  });

  it('warns that printed passwords stop working when re-issuing to issued students', async () => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/students/password-status': () => Response.json({ classrooms: STATUS }),
    });
    await openPage();
    chooseClassroom2();
    fireEvent.click(screen.getByLabelText(/เฉพาะนักเรียนที่ยังไม่เคยได้รหัสผ่าน/));

    fireEvent.click(issueButton());

    const dialog = screen.getByRole('alertdialog', { name: 'ยืนยันการออกรหัสผ่าน' });
    expect(dialog.textContent).toContain('ออกรหัสผ่านให้ ม.1/2 ประมาณ 27 คน?');
    expect(dialog.textContent).toContain(
      'รหัสผ่านเดิมของนักเรียน 25 คนที่พิมพ์แจกไปแล้วจะใช้ไม่ได้ทันที',
    );
  });

  it('sends the chosen scope with a fresh key and downloads the file it gets back', async () => {
    const fetchMock = mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/students/password-status': () => Response.json({ classrooms: STATUS }),
      [`POST ${ISSUE_PATH}`]: () => fileResponse(2),
    });
    await openPage();
    chooseClassroom2();
    fireEvent.click(issueButton());

    fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน ออกรหัสผ่าน' }));

    expect((await screen.findByText(/ออกรหัสผ่านให้ 2 คนแล้ว/)).textContent).toContain(
      'initial-passwords-grade-1-room-2.xlsx',
    );
    expect(downloads).toEqual(['initial-passwords-grade-1-room-2.xlsx']);
    const [call] = issueCalls(fetchMock) as [[string, RequestInit]];
    expect(bodyOf(call)).toEqual({
      grade: 1,
      classroom: '2',
      onlyUnissued: true,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    });
  });

  it('omits the classroom to issue a whole grade', async () => {
    const fetchMock = mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/students/password-status': () => Response.json({ classrooms: STATUS }),
      [`POST ${ISSUE_PATH}`]: () => fileResponse(40),
    });
    await openPage();
    fireEvent.change(screen.getByLabelText('ชั้น'), { target: { value: '2' } });
    fireEvent.click(issueButton());

    fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน ออกรหัสผ่าน' }));

    await screen.findByText(/ออกรหัสผ่านให้ 40 คนแล้ว/);
    const [call] = issueCalls(fetchMock) as [[string, RequestInit]];
    expect(bodyOf(call)).toMatchObject({ grade: 2, onlyUnissued: true });
    expect(bodyOf(call)).not.toHaveProperty('classroom');
  });

  it('disables the buttons and shows progress while the passwords are being made', async () => {
    const fetchMock = mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/students/password-status': () => Response.json({ classrooms: STATUS }),
    });
    let release: (response: Response) => void = () => undefined;
    const answer = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const routeOthers = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      input === ISSUE_PATH ? await answer : await routeOthers(input, init),
    );
    await openPage();
    fireEvent.click(issueButton());

    fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน ออกรหัสผ่าน' }));

    const pending = await screen.findByRole('button', { name: 'กำลังสร้างรหัสผ่าน…' });
    expect(pending).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'ยกเลิก' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toContain('อย่าปิดหน้านี้');
    release(fileResponse(30));
    await screen.findByText(/ออกรหัสผ่านให้ 30 คนแล้ว/);
  });

  it('explains a refusal when nobody in the scope can get a password any more', async () => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/students/password-status': () => Response.json({ classrooms: STATUS }),
      [`POST ${ISSUE_PATH}`]: () =>
        Response.json({ code: 'nothing_to_issue', message: 'x' }, { status: 409 }),
    });
    await openPage();
    fireEvent.click(issueButton());

    fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน ออกรหัสผ่าน' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'ไม่มีนักเรียนที่ออกรหัสผ่านได้ในขอบเขตนี้แล้ว',
      );
    });
    expect(downloads).toEqual([]);
  });

  it('disables issuing when the scope has nobody left to issue', async () => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/students/password-status': () =>
        Response.json({ classrooms: [classroomStatus({ issuedPending: 5, changed: 3 })] }),
    });

    await openPage();

    expect(issueButton()).toHaveProperty('disabled', true);
  });
});
