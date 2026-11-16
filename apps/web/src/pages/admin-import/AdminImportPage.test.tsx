import type { ImportPreviewResponse, Round, SessionUser } from '@club-registration/shared';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt } from '@/test-support/render-app';

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
  status: 'upcoming',
  clubCount: 0,
  totalCapacity: 0,
  totalRegistered: 0,
  ...overrides,
});

const PREVIEW: ImportPreviewResponse = {
  fileSha256: 'a'.repeat(64),
  term: '2569/2',
  students: { create: 120, update: 3, unchanged: 7 },
  clubs: { create: 4, update: 1, unchanged: 0 },
  advisors: { clubsReplaced: 5, rows: 6 },
  errors: [
    { sheet: 'students', row: 14, column: 'ชั้น', message: 'ชั้นต้องเป็น 1–6 (หรือ ม.1–ม.6)' },
    { sheet: 'advisors', row: 3, column: 'อีเมล', message: 'อีเมลไม่ถูกต้อง' },
  ],
  errorCount: 2,
};

const ROUNDS = [round({ id: 2, term: '2569/2' }), round({ id: 1, term: '2569/1' })];

const xlsxFile = (name = 'import.xlsx') =>
  new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

const previewCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => input === '/api/admin/import/preview' && init?.method === 'POST',
  );

const chooseFile = (file: File) => {
  fireEvent.change(screen.getByLabelText('ไฟล์ Excel (.xlsx)'), { target: { files: [file] } });
};

const submit = () => {
  fireEvent.click(screen.getByRole('button', { name: 'ตรวจสอบไฟล์' }));
};

describe('admin import page', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('uploads the file for the chosen term and shows the summary and every error', async () => {
    const fetchMock = mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/rounds': () => Response.json({ rounds: ROUNDS }),
      'POST /api/admin/import/preview': () => Response.json(PREVIEW),
    });
    renderAt('/admin/import');
    const termSelect = await screen.findByLabelText('ภาคเรียน');
    fireEvent.change(termSelect, { target: { value: '2569/2' } });
    const file = xlsxFile();
    chooseFile(file);

    submit();

    const summary = await screen.findByRole('table', { name: 'สรุปผลการตรวจสอบ' });
    const studentsRow = within(summary).getByRole('row', { name: /นักเรียน/ });
    expect(
      within(studentsRow)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['120', '3', '7']);
    expect(within(summary).getByRole('row', { name: /ครูที่ปรึกษา/ }).textContent).toContain(
      '5 ชุมนุม',
    );
    const errors = screen.getByRole('table', { name: 'รายการข้อผิดพลาด' });
    const errorRows = within(errors)
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      );
    expect(errorRows).toEqual([
      ['นักเรียน (students)', '14', 'ชั้น', 'ชั้นต้องเป็น 1–6 (หรือ ม.1–ม.6)'],
      ['ครูที่ปรึกษา (advisors)', '3', 'อีเมล', 'อีเมลไม่ถูกต้อง'],
    ]);
    expect(screen.getByRole('button', { name: 'ยืนยันนำเข้า' })).toHaveProperty('disabled', true);
    const [, init] = previewCalls(fetchMock)[0]!;
    const body = init?.body as FormData;
    expect(body.get('term')).toBe('2569/2');
    expect((body.get('file') as File).name).toBe('import.xlsx');
  });

  it('says so when the file has no errors', async () => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/rounds': () => Response.json({ rounds: ROUNDS }),
      'POST /api/admin/import/preview': () =>
        Response.json({ ...PREVIEW, errors: [], errorCount: 0 }),
    });
    renderAt('/admin/import');
    await screen.findByLabelText('ภาคเรียน');
    chooseFile(xlsxFile());

    submit();

    expect((await screen.findByRole('status')).textContent).toBe('ไม่พบข้อผิดพลาด');
    expect(screen.queryByRole('table', { name: 'รายการข้อผิดพลาด' })).toBeNull();
  });

  it('does not upload a file that is not .xlsx', async () => {
    const fetchMock = mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/rounds': () => Response.json({ rounds: ROUNDS }),
    });
    renderAt('/admin/import');
    await screen.findByLabelText('ภาคเรียน');
    chooseFile(xlsxFile('students.csv'));

    submit();

    expect((await screen.findByRole('alert')).textContent).toContain('รองรับเฉพาะไฟล์ .xlsx');
    expect(previewCalls(fetchMock)).toHaveLength(0);
  });

  it('explains a file the server could not open', async () => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/rounds': () => Response.json({ rounds: ROUNDS }),
      'POST /api/admin/import/preview': () =>
        Response.json({ code: 'invalid_workbook', message: 'bad' }, { status: 400 }),
    });
    renderAt('/admin/import');
    await screen.findByLabelText('ภาคเรียน');
    chooseFile(xlsxFile());

    submit();

    expect((await screen.findByRole('alert')).textContent).toContain('เปิดไฟล์นี้ไม่ได้');
    expect(screen.queryByRole('table', { name: 'สรุปผลการตรวจสอบ' })).toBeNull();
  });

  it('offers the template download and points to rounds when no term exists yet', async () => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/rounds': () => Response.json({ rounds: [] }),
    });
    renderAt('/admin/import');

    expect((await screen.findByRole('link', { name: 'สร้างรอบ' })).getAttribute('href')).toBe(
      '/admin/rounds',
    );
    expect(
      screen.getByRole('link', { name: 'ดาวน์โหลดไฟล์ตัวอย่าง (template)' }).getAttribute('href'),
    ).toBe('/api/admin/import/template');
  });
});
