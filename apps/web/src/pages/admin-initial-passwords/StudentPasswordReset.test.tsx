import type { ClassroomPasswordStatus, SessionUser } from '@club-registration/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt, unauthorized } from '@/test-support/render-app';
import type { Handler } from '@/test-support/render-app';

// The card on /admin/initial-passwords that resets one student's password. Every value is made up.

const ADMIN: SessionUser = {
  id: 9,
  loginId: 'demo-admin',
  fullName: 'ผู้ดูแลสมมติ',
  role: 'admin',
  mustChangePassword: false,
};

const RESET_PATH = '/api/admin/students/password-reset';
const STATUS_PATH = '/api/admin/students/password-status';
const PASSWORD = 'kq7m3xp9tw';

const STATUS: ClassroomPasswordStatus[] = [
  {
    grade: 1,
    classroom: '1/2',
    neverIssued: 0,
    issuedPending: 0,
    changed: 30,
    lastIssuedAt: '2026-11-10T03:00:00.000Z',
  },
];

const RESET_ANSWER = {
  student: {
    loginId: 'demo1001',
    fullName: 'นักเรียนสมมติ ทดสอบ',
    grade: 1,
    classroom: '1/2',
    seatNo: 7,
  },
  password: PASSWORD,
};

const api = (reset?: Handler) =>
  mockApi({
    'GET /api/auth/me': () => Response.json({ user: ADMIN }),
    [`GET ${STATUS_PATH}`]: () => Response.json({ classrooms: STATUS }),
    'GET /api/admin/rounds': () => Response.json({ rounds: [] }),
    ...(reset ? { [`POST ${RESET_PATH}`]: reset } : {}),
  });

const resetCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(([input, init]) => input === RESET_PATH && init?.method === 'POST');

// The app sends JSON as a string body.
const bodyOf = (call: [input: string, init?: RequestInit | undefined]) =>
  JSON.parse(call[1]?.body as string) as { loginId: string; idempotencyKey: string };

const card = () => screen.getByRole('form', { name: 'รีเซ็ตรหัสผ่านรายคน' });

const openPage = async () => {
  renderAt('/admin/initial-passwords');
  await screen.findByRole('table', { name: 'สถานะรหัสผ่านรายห้อง' });
};

const askToReset = (loginId: string) => {
  fireEvent.change(within(card()).getByLabelText('รหัสนักเรียน'), { target: { value: loginId } });
  fireEvent.click(within(card()).getByRole('button', { name: 'รีเซ็ตรหัสผ่าน' }));
};

const confirm = () => {
  fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน รีเซ็ตรหัสผ่าน' }));
};

describe('resetting one student password', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('asks for confirmation, with a red button, before sending anything', async () => {
    const fetchMock = api(() => Response.json(RESET_ANSWER));
    await openPage();

    askToReset(' Demo1001 ');

    const dialog = screen.getByRole('alertdialog', { name: 'ยืนยันการรีเซ็ตรหัสผ่าน' });
    expect(dialog.textContent).toContain('รีเซ็ตรหัสผ่านของนักเรียนรหัส demo1001?');
    expect(dialog.textContent).toContain('ออกจากระบบทุกเครื่อง');
    expect(within(dialog).getByRole('button', { name: 'ยืนยัน รีเซ็ตรหัสผ่าน' }).dataset.variant).toBe(
      'destructive',
    );
    expect(resetCalls(fetchMock)).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'ยกเลิก' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(resetCalls(fetchMock)).toHaveLength(0);
  });

  it('refuses a malformed student code without asking or sending', async () => {
    const fetchMock = api();
    await openPage();

    askToReset('นักเรียน');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('กรุณากรอกรหัสนักเรียนให้ถูกต้อง');
    expect(resetCalls(fetchMock)).toHaveLength(0);
  });

  it('sends the normalised code with a key and shows the new password once', async () => {
    const fetchMock = api(() => Response.json(RESET_ANSWER));
    await openPage();
    askToReset(' Demo1001 ');

    confirm();

    const result = await screen.findByRole('region', { name: 'รีเซ็ตรหัสผ่านแล้ว' });
    const [call] = resetCalls(fetchMock);
    const body = bodyOf(call!);
    expect(body.loginId).toBe('demo1001');
    expect(body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(within(result).getByText(PASSWORD)).toBeTruthy();
    expect(result.textContent).toContain('demo1001');
    expect(result.textContent).toContain('นักเรียนสมมติ ทดสอบ');
    expect(result.textContent).toContain('ม.1 ห้อง 1/2 เลขที่ 7');
    expect(result.textContent).toContain('รหัสผ่านนี้แสดงครั้งเดียว ดูซ้ำไม่ได้อีก');
    expect(screen.getAllByText(PASSWORD)).toHaveLength(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(result).getByRole('heading', { name: 'รีเซ็ตรหัสผ่านแล้ว' }),
      ),
    );
  });

  it('shows the password and focuses it without waiting for the refreshed status', async () => {
    let statusCalls = 0;
    let releaseRefetch = () => {};
    const refetch = new Promise<Response>((resolve) => {
      releaseRefetch = () => resolve(Response.json({ classrooms: STATUS }));
    });
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      [`GET ${STATUS_PATH}`]: () => {
        statusCalls += 1;
        return statusCalls === 1 ? Response.json({ classrooms: STATUS }) : refetch;
      },
      [`POST ${RESET_PATH}`]: () => Response.json(RESET_ANSWER),
    });
    await openPage();
    askToReset('demo1001');

    confirm();

    try {
      const result = await screen.findByRole('region', { name: 'รีเซ็ตรหัสผ่านแล้ว' });
      expect(statusCalls).toBe(2);
      expect(screen.queryByRole('button', { name: 'รีเซ็ตรหัสผ่าน' })).toBeNull();
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(result).getByRole('heading', { name: 'รีเซ็ตรหัสผ่านแล้ว' }),
        ),
      );
    } finally {
      releaseRefetch();
    }
  });

  it('keeps the password out of the URL and browser storage', async () => {
    api(() => Response.json(RESET_ANSWER));
    const router = renderAt('/admin/initial-passwords');
    await screen.findByRole('table', { name: 'สถานะรหัสผ่านรายห้อง' });
    askToReset('demo1001');

    confirm();

    await screen.findByText(PASSWORD);
    const { pathname, search, hash } = router.state.location;
    expect(`${pathname}${search}${hash}`).toBe('/admin/initial-passwords');
    const stored = [localStorage, sessionStorage].flatMap((storage) =>
      Object.keys(storage).map((key) => storage.getItem(key) ?? ''),
    );
    expect(stored.some((value) => value.includes(PASSWORD) || value.includes('demo1001'))).toBe(
      false,
    );
  });

  it('removes the password from the page on "เสร็จแล้ว" and is ready for the next student', async () => {
    api(() => Response.json(RESET_ANSWER));
    await openPage();
    askToReset('demo1001');
    confirm();
    await screen.findByText(PASSWORD);

    fireEvent.click(screen.getByRole('button', { name: 'เสร็จแล้ว' }));

    await waitFor(() => expect(screen.queryByText(PASSWORD)).toBeNull());
    expect(screen.queryByRole('region', { name: 'รีเซ็ตรหัสผ่านแล้ว' })).toBeNull();
    const field = within(card()).getByLabelText<HTMLInputElement>('รหัสนักเรียน');
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
  });

  it('removes the password when the admin leaves the page', async () => {
    api(() => Response.json(RESET_ANSWER));
    const router = renderAt('/admin/initial-passwords');
    await screen.findByRole('table', { name: 'สถานะรหัสผ่านรายห้อง' });
    askToReset('demo1001');
    confirm();
    await screen.findByText(PASSWORD);

    await router.navigate('/admin/import');
    await screen.findByRole('heading', { name: 'นำเข้า Excel' });
    expect(screen.queryByText(PASSWORD)).toBeNull();
    await router.navigate('/admin/initial-passwords');

    await screen.findByRole('table', { name: 'สถานะรหัสผ่านรายห้อง' });
    expect(screen.queryByText(PASSWORD)).toBeNull();
  });

  it('says so when no student has that code', async () => {
    api(() => Response.json({ code: 'not_found', message: 'x' }, { status: 404 }));
    await openPage();
    askToReset('demo9999');

    confirm();

    const dialog = screen.getByRole('alertdialog', { name: 'ยืนยันการรีเซ็ตรหัสผ่าน' });
    expect((await within(dialog).findByRole('alert')).textContent).toBe('ไม่พบนักเรียนรหัสนี้');
    expect(within(dialog).queryByRole('button', { name: 'ลองอีกครั้ง' })).toBeNull();
  });

  it('retries a lost answer with the same key, then explains a reset already done', async () => {
    let calls = 0;
    const fetchMock = api(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Response.json({ code: 'idempotency_key_reused', message: 'x' }, { status: 409 });
    });
    await openPage();
    askToReset('demo1001');

    confirm();

    const dialog = screen.getByRole('alertdialog', { name: 'ยืนยันการรีเซ็ตรหัสผ่าน' });
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'ไม่ทราบว่ารีเซ็ตแล้วหรือยัง',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'ลองอีกครั้ง' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toContain('คำขอก่อนหน้ารีเซ็ตรหัสผ่านไปแล้ว'),
    );
    const [first, second] = resetCalls(fetchMock).map(bodyOf);
    expect(second).toEqual(first);
  });

  it('uses a new key for a new attempt after a refusal', async () => {
    const fetchMock = api(() =>
      Response.json({ code: 'not_found', message: 'x' }, { status: 404 }),
    );
    await openPage();
    askToReset('demo1001');
    confirm();
    const dialog = screen.getByRole('alertdialog', { name: 'ยืนยันการรีเซ็ตรหัสผ่าน' });
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ปิด' }));

    askToReset('demo1001');
    confirm();

    await waitFor(() => expect(resetCalls(fetchMock)).toHaveLength(2));
    const [first, second] = resetCalls(fetchMock).map(bodyOf);
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });

  it('goes back to the login page when the session has expired', async () => {
    api(unauthorized);
    await openPage();
    askToReset('demo1001');

    confirm();

    expect(await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeTruthy();
  });

  it('can still reset when the classroom status failed to load', async () => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: ADMIN }),
      [`GET ${STATUS_PATH}`]: () =>
        Response.json({ code: 'internal_error', message: 'x' }, { status: 500 }),
      [`POST ${RESET_PATH}`]: () => Response.json(RESET_ANSWER),
    });
    renderAt('/admin/initial-passwords');
    await screen.findByText('โหลดสถานะรหัสผ่านไม่สำเร็จ');
    askToReset('demo1001');

    confirm();

    expect(await screen.findByText(PASSWORD)).toBeTruthy();
  });
});
