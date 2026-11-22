import type {
  ImportCommitResponse,
  ImportPreviewResponse,
  Round,
  SessionUser,
} from '@club-registration/shared';
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
  queueWaiting: 0,
  queueAdmitted: 0,
  ...overrides,
});

const PREVIEW: ImportPreviewResponse = {
  fileSha256: 'a'.repeat(64),
  term: '2569/2',
  students: { create: 120, update: 3, unchanged: 7 },
  clubs: { create: 4, update: 1, unchanged: 0 },
  advisors: { clubsReplaced: 5, clubsUnchanged: 0, rows: 6 },
  errors: [
    { sheet: 'students', row: 14, column: 'ชั้น', message: 'ชั้นต้องเป็น 1–6 (หรือ ม.1–ม.6)' },
    { sheet: 'advisors', row: 3, column: 'อีเมล', message: 'อีเมลไม่ถูกต้อง' },
  ],
  errorCount: 2,
};

const CLEAN_PREVIEW: ImportPreviewResponse = { ...PREVIEW, errors: [], errorCount: 0 };

const COMMITTED: ImportCommitResponse = CLEAN_PREVIEW;

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

const commitCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => input === '/api/admin/import/commit' && init?.method === 'POST',
  );

const confirmButton = () => screen.getByRole('button', { name: 'ยืนยันนำเข้า' });

// Previews a clean file and returns it, with the confirm step on screen.
const previewCleanFile = async () => {
  renderAt('/admin/import');
  fireEvent.change(await screen.findByLabelText('ภาคเรียน'), { target: { value: '2569/2' } });
  const file = xlsxFile();
  chooseFile(file);
  submit();
  await screen.findByRole('table', { name: 'สรุปผลการตรวจสอบ' });
  return file;
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
    expect(within(summary).getByRole('row', { name: /ครูที่ปรึกษา/ }).textContent).toContain('5 ชุมนุม');
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
      'POST /api/admin/import/preview': () => Response.json(CLEAN_PREVIEW),
    });
    renderAt('/admin/import');
    await screen.findByLabelText('ภาคเรียน');
    chooseFile(xlsxFile());

    submit();

    expect((await screen.findByRole('status')).textContent).toBe('ไม่พบข้อผิดพลาด');
    expect(screen.queryByRole('table', { name: 'รายการข้อผิดพลาด' })).toBeNull();
  });

  it('re-sends the previewed file with its hash and a fresh key, then shows the result', async () => {
    const fetchMock = mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/rounds': () => Response.json({ rounds: ROUNDS }),
      'POST /api/admin/import/preview': () => Response.json(CLEAN_PREVIEW),
      'POST /api/admin/import/commit': () => Response.json(COMMITTED),
    });
    const file = await previewCleanFile();
    expect(confirmButton()).toHaveProperty('disabled', false);

    fireEvent.click(confirmButton());

    const result = await screen.findByRole('table', { name: 'สรุปผลการนำเข้า' });
    const studentsRow = within(result).getByRole('row', { name: /นักเรียน/ });
    expect(
      within(studentsRow)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['120', '3', '7']);
    expect(screen.getByText(/ยังเข้าสู่ระบบไม่ได้จนกว่าจะออกรหัสผ่านเริ่มต้น/)).toBeTruthy();
    expect(confirmButton()).toHaveProperty('disabled', true);
    const [[, init]] = commitCalls(fetchMock) as [[string, RequestInit]];
    const body = init.body as FormData;
    expect(body.get('term')).toBe('2569/2');
    expect(body.get('fileSha256')).toBe(CLEAN_PREVIEW.fileSha256);
    expect(body.get('idempotencyKey')).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.get('file')).toBe(file);
  });

  it('disables the confirm button while the import is being sent', async () => {
    const fetchMock = mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/rounds': () => Response.json({ rounds: ROUNDS }),
      'POST /api/admin/import/preview': () => Response.json(CLEAN_PREVIEW),
    });
    let release: (response: Response) => void = () => undefined;
    const answer = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const routeOthers = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      input === '/api/admin/import/commit' ? await answer : await routeOthers(input, init),
    );
    await previewCleanFile();

    fireEvent.click(confirmButton());

    const pending = await screen.findByRole('button', { name: 'กำลังนำเข้า…' });
    expect(pending).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'ตรวจสอบไฟล์' })).toHaveProperty('disabled', true);
    release(Response.json(COMMITTED));
    await screen.findByRole('table', { name: 'สรุปผลการนำเข้า' });
    expect(commitCalls(fetchMock)).toHaveLength(1);
  });

  it.each([
    ['import_file_mismatch', 409, 'ไฟล์ที่ส่งไม่ตรงกับไฟล์ที่ตรวจสอบไว้'],
    ['import_invalid', 422, 'ข้อมูลในระบบเปลี่ยนไปหลังการตรวจสอบ'],
    ['import_conflict', 409, 'ข้อมูลในระบบเปลี่ยนไประหว่างนำเข้า'],
  ])('asks for a new preview after %s', async (code, status, message) => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/rounds': () => Response.json({ rounds: ROUNDS }),
      'POST /api/admin/import/preview': () => Response.json(CLEAN_PREVIEW),
      'POST /api/admin/import/commit': () =>
        Response.json({ code, message: 'x', errors: [], errorCount: 1 }, { status }),
    });
    await previewCleanFile();

    fireEvent.click(confirmButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain('“ตรวจสอบไฟล์” อีกครั้ง');
    expect(confirmButton()).toHaveProperty('disabled', true);
    expect(screen.queryByRole('table', { name: 'สรุปผลการนำเข้า' })).toBeNull();
  });

  it('lets the admin retry the confirm after an error that is not about the preview', async () => {
    const fetchMock = mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      'GET /api/admin/rounds': () => Response.json({ rounds: ROUNDS }),
      'POST /api/admin/import/preview': () => Response.json(CLEAN_PREVIEW),
      'POST /api/admin/import/commit': () =>
        Response.json({ code: 'internal_error', message: 'x' }, { status: 500 }),
    });
    await previewCleanFile();

    fireEvent.click(confirmButton());

    expect((await screen.findByRole('alert')).textContent).toContain('บันทึกไม่สำเร็จ');
    expect(confirmButton()).toHaveProperty('disabled', false);
    expect(commitCalls(fetchMock)).toHaveLength(1);
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
