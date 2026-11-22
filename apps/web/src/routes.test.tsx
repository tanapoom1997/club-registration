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

const ADMIN: SessionUser = {
  id: 2,
  loginId: 'demo-admin',
  fullName: 'ผู้ดูแลสมมติ',
  role: 'admin',
  mustChangePassword: false,
};

const NO_ROUND = { round: null, registration: null, waitlist: null, adminChange: null };

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

  it('sends a signed-in user who opens the login page to their own landing page', async () => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: { ...STUDENT, mustChangePassword: true } }),
    });

    const router = renderAt('/login');

    await screen.findByRole('heading', { name: 'เปลี่ยนรหัสผ่าน' });
    expect(router.state.location.pathname).toBe('/change-password');
  });

  // README Phase 4, P4c (U16).
  it('shows the password on request without sending the form', async () => {
    const fetchMock = mockApi({ 'GET /api/auth/me': unauthorized });
    renderAt('/login');
    await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' });
    const password = screen.getByLabelText<HTMLInputElement>('รหัสผ่าน');
    expect(password.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'แสดงรหัสผ่าน' }));

    expect(password.type).toBe('text');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    expect(screen.getByRole('button', { name: 'ซ่อนรหัสผ่าน' })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/auth/login')).toEqual([]);
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

    expect(await screen.findByText('เข้าสู่ระบบครั้งแรก กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งาน')).toBeTruthy();
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

  it('takes a student from login straight to the club list', async () => {
    mockApi({
      'GET /api/auth/me': unauthorized,
      'POST /api/auth/login': () => Response.json({ user: STUDENT }),
      'GET /api/student/round': () => Response.json(NO_ROUND),
    });
    const router = renderAt('/login');
    await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' });

    fillLogin('demo1001', 'chosen-password');

    expect(await screen.findByRole('heading', { level: 1, name: 'ชุมนุมในชั้นของฉัน' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/student/clubs');
  });

  it('takes an admin from login to the admin home', async () => {
    mockApi({
      'GET /api/auth/me': unauthorized,
      'POST /api/auth/login': () => Response.json({ user: ADMIN }),
    });
    const router = renderAt('/login');
    await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' });

    fillLogin('demo-admin', 'chosen-password');

    expect(await screen.findByRole('heading', { name: `สวัสดี ${ADMIN.fullName}` })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/admin');
  });

  it('opens the club list for a signed-in student at the site root', async () => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: STUDENT }),
      'GET /api/student/round': () => Response.json(NO_ROUND),
    });

    const router = renderAt('/');

    expect(await screen.findByRole('heading', { level: 1, name: 'ชุมนุมในชั้นของฉัน' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/student/clubs');
  });

  it('gives the admin home one h1, with each menu card a level 2 heading under it', async () => {
    mockApi({ 'GET /api/auth/me': () => Response.json({ user: ADMIN }) });

    renderAt('/admin');

    await screen.findByRole('heading', { level: 1, name: `สวัสดี ${ADMIN.fullName}` });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const menus = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(menus).toContain('นำเข้า Excel');
    expect(menus).toContain('รอบลงทะเบียน');
  });

  it('makes the login card title the page h1', async () => {
    mockApi({ 'GET /api/auth/me': unauthorized });

    renderAt('/login');

    await screen.findByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows a student only the student menu on the student home', async () => {
    mockApi({ 'GET /api/auth/me': () => Response.json({ user: STUDENT }) });

    renderAt('/student');

    expect(await screen.findByRole('heading', { name: `สวัสดี ${STUDENT.fullName}` })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'เมนูหลัก' });
    expect(nav.textContent).toContain('ชุมนุมในชั้นของฉัน');
    expect(nav.textContent).not.toContain('นำเข้า Excel');
  });

  it.each([
    ['/student/clubs', 'ชุมนุมในชั้นของฉัน'],
    ['/student/my-registration', 'ผลของฉัน'],
  ])('renders the real student page at %s, not a placeholder', async (path, heading) => {
    mockApi({
      'GET /api/auth/me': () => Response.json({ user: STUDENT }),
      'GET /api/student/clubs': () =>
        Response.json({
          round: null,
          registration: null,
          waitlist: null,
          adminChange: null,
          clubs: [],
        }),
      'GET /api/student/round': () =>
        Response.json({ round: null, registration: null, waitlist: null, adminChange: null }),
    });

    renderAt(path);

    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
    expect(await screen.findByText(/ยังไม่มีรอบลงทะเบียนของชั้นนี้/)).toBeTruthy();
    expect(screen.queryByText('ยังไม่เปิดใช้งาน')).toBeNull();
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
