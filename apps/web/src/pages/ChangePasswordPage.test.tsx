import type { SessionUser } from '@club-registration/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt, unauthorized } from '@/test-support/render-app';
import type { Handler } from '@/test-support/render-app';

const STUDENT: SessionUser = {
  id: 1,
  loginId: 'demo1001',
  fullName: 'นักเรียนสมมติ หนึ่ง',
  role: 'student',
  mustChangePassword: true,
};
const ADMIN: SessionUser = {
  id: 9,
  loginId: 'demo-admin',
  fullName: 'ผู้ดูแลสมมติ',
  role: 'admin',
  mustChangePassword: false,
};

const CHANGE_PASSWORD = 'POST /api/auth/change-password';

const apiError = (status: number, code: string) => () =>
  Response.json({ code, message: code }, { status });

const openPage = async (user: SessionUser, changePassword: Handler) => {
  const fetchMock = mockApi({
    'GET /api/auth/me': () => Response.json({ user }),
    [CHANGE_PASSWORD]: changePassword,
  });
  const router = renderAt('/change-password');
  await screen.findByRole('heading', { name: 'เปลี่ยนรหัสผ่าน' });
  return { fetchMock, router };
};

const submit = ({
  current = 'initial-password',
  next = 'chosen-password',
  confirm = next,
}: { current?: string; next?: string; confirm?: string } = {}) => {
  fireEvent.change(screen.getByLabelText('รหัสผ่านเดิม'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText(/^รหัสผ่านใหม่/), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }));
};

const changeRequests = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(([input]) => input === '/api/auth/change-password');

describe('change password page', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends both passwords and then opens the home page of the role', async () => {
    const { fetchMock, router } = await openPage(STUDENT, () =>
      Response.json({ user: { ...STUDENT, mustChangePassword: false } }),
    );

    submit();

    await screen.findByRole('heading', { name: `สวัสดี ${STUDENT.fullName}` });
    expect(router.state.location.pathname).toBe('/student');
    const [[, init]] = changeRequests(fetchMock) as [[string, RequestInit]];
    expect(JSON.parse(init.body as string)).toEqual({
      currentPassword: 'initial-password',
      newPassword: 'chosen-password',
    });
  });

  it.each([
    [
      'the current password is wrong',
      apiError(400, 'invalid_current_password'),
      'รหัสผ่านเดิมไม่ถูกต้อง',
    ],
    [
      'there were too many attempts',
      apiError(429, 'rate_limited'),
      'ลองหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่',
    ],
    ['the server fails', apiError(500, 'internal_error'), 'เปลี่ยนรหัสผ่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'],
  ])('stays on the page and says so when %s', async (_case, handler, message) => {
    const { router } = await openPage(STUDENT, handler);

    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(router.state.location.pathname).toBe('/change-password');
  });

  it('sends a user whose session has ended back to the login page', async () => {
    const { router } = await openPage(STUDENT, unauthorized);

    submit();

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it.each([
    ['leaves the current password empty', { current: '' }, 'กรุณากรอกรหัสผ่านเดิม'],
    [
      'has a new password that is too short',
      { next: 'short', confirm: 'short' },
      'รหัสผ่านต้องยาวอย่างน้อย 8 ตัว',
    ],
    [
      'repeats the current password',
      { current: 'same-password', next: 'same-password' },
      'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม',
    ],
  ])('does not send a change that %s', async (_case, values, message) => {
    const { fetchMock } = await openPage(STUDENT, () => Response.json({ user: STUDENT }));

    submit(values);

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(changeRequests(fetchMock)).toEqual([]);
  });

  it('disables the button while the change is being saved', async () => {
    await openPage(STUDENT, () => new Promise<Response>(() => undefined));

    submit();

    const button = await screen.findByRole('button', { name: 'กำลังบันทึก…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers a link to the home of the role when the change is not forced', async () => {
    await openPage(ADMIN, () => Response.json({ user: ADMIN }));

    expect(screen.getByText('ตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ออกจากระบบ' })).toBeNull();
    // The href, not where a click lands: the role guard would also turn /student into /admin.
    expect(screen.getByRole('link', { name: 'กลับหน้าแรก' }).getAttribute('href')).toBe('/admin');
  });
});
