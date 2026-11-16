import type { SessionUser } from '@club-registration/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt, unauthorized } from '@/test-support/render-app';

const STUDENT: SessionUser = {
  id: 1,
  loginId: 'demo1001',
  fullName: 'นักเรียนสมมติ หนึ่ง',
  role: 'student',
  mustChangePassword: false,
};

const fillLogin = (loginId: string, password: string) => {
  fireEvent.change(screen.getByLabelText('รหัสนักเรียน / รหัสผู้ใช้'), {
    target: { value: loginId },
  });
  fireEvent.change(screen.getByLabelText('รหัสผ่าน'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));
};

describe('auth routes', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends a visitor without a session to the login page', async () => {
    mockApi({ 'GET /api/auth/me': unauthorized });

    const router = renderAt('/admin/rounds');

    expect(await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('shows an error when the credentials are wrong', async () => {
    mockApi({
      'GET /api/auth/me': unauthorized,
      'POST /api/auth/login': () =>
        Response.json(
          { code: 'invalid_credentials', message: 'Invalid login ID or password' },
          { status: 401 },
        ),
    });
    renderAt('/login');
    await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' });

    fillLogin('demo1001', 'wrong-password');

    expect((await screen.findByRole('alert')).textContent).toBe('รหัสผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  });

  it('takes a first-time user from login straight to the change-password page', async () => {
    mockApi({
      'GET /api/auth/me': unauthorized,
      'POST /api/auth/login': () =>
        Response.json({ user: { ...STUDENT, mustChangePassword: true } }),
    });
    const router = renderAt('/login');
    await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' });

    fillLogin('demo1001', 'initial-password');

    expect(
      await screen.findByText('เข้าสู่ระบบครั้งแรก กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งาน'),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe('/change-password');
  });

  it('keeps a user with a pending password change off every other page', async () => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: { ...STUDENT, mustChangePassword: true } }),
    });

    const router = renderAt('/student/clubs');

    await screen.findByRole('heading', { name: 'เปลี่ยนรหัสผ่าน' });
    expect(router.state.location.pathname).toBe('/change-password');
  });

  it('shows a student only the student menu', async () => {
    mockApi({ 'GET /api/auth/me': () => Response.json({ user: STUDENT }) });

    renderAt('/');

    expect(await screen.findByRole('heading', { name: `สวัสดี ${STUDENT.fullName}` })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'เมนูหลัก' });
    expect(nav.textContent).toContain('ชุมนุมในชั้นของฉัน');
    expect(nav.textContent).not.toContain('นำเข้า Excel');
  });

  it('redirects a student who opens an admin page back to the student home', async () => {
    mockApi({ 'GET /api/auth/me': () => Response.json({ user: STUDENT }) });

    const router = renderAt('/admin/import');

    await screen.findByRole('heading', { name: `สวัสดี ${STUDENT.fullName}` });
    expect(router.state.location.pathname).toBe('/student');
  });

  it('lets a user stuck on the forced password change log out instead', async () => {
    const fetchMock = mockApi({
      'GET /api/auth/me': () => Response.json({ user: { ...STUDENT, mustChangePassword: true } }),
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });
    const router = renderAt('/change-password');
    await screen.findByRole('heading', { name: 'เปลี่ยนรหัสผ่าน' });

    fireEvent.click(screen.getByRole('button', { name: 'ออกจากระบบ' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
  });

  it('does not send a password change when the confirmation does not match', async () => {
    const fetchMock = mockApi({ 'GET /api/auth/me': () => Response.json({ user: STUDENT }) });
    renderAt('/change-password');
    await screen.findByRole('heading', { name: 'เปลี่ยนรหัสผ่าน' });

    fireEvent.change(screen.getByLabelText('รหัสผ่านเดิม'), { target: { value: 'old-password' } });
    fireEvent.change(screen.getByLabelText(/^รหัสผ่านใหม่/), {
      target: { value: 'new-password-1' },
    });
    fireEvent.change(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), {
      target: { value: 'new-password-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }));

    expect((await screen.findByRole('alert')).textContent).toBe('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
    expect(fetchMock).not.toHaveBeenCalledWith('/api/auth/change-password', expect.anything());
  });

  it('logs out through the API and returns to the login page', async () => {
    const fetchMock = mockApi({
      'GET /api/auth/me': () => Response.json({ user: STUDENT }),
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });
    const router = renderAt('/student');
    await screen.findByRole('heading', { name: `สวัสดี ${STUDENT.fullName}` });

    fireEvent.click(screen.getByRole('button', { name: 'ออกจากระบบ' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
  });
});
