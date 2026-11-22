import type { SessionUser } from '@club-registration/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt } from '@/test-support/render-app';

// Every name below is made up.
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

const openHome = async (user: SessionUser) => {
  const fetchMock = mockApi({
    'GET /api/auth/me': () => Response.json({ user }),
    'POST /api/auth/logout': () => new Response(null, { status: 204 }),
  });
  const router = renderAt(`/${user.role}`);
  await screen.findByRole('heading', { name: `สวัสดี ${user.fullName}` });
  return { fetchMock, router };
};

const header = () => screen.getByRole('banner');
const accountButton = () => within(header()).getByRole('button', { name: 'บัญชี' });
// What the account button shows and hides on a phone (always shown from sm up).
const accountPanel = () => {
  const id = accountButton().getAttribute('aria-controls');
  const panel = id === null ? null : document.getElementById(id);
  if (panel === null) throw new Error('the account button controls nothing');
  return panel;
};

describe('the compact app header (U4)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    [STUDENT, 'นักเรียน'],
    [ADMIN, 'ผู้ดูแลระบบ'],
  ])('names the user and their role', async (user, role) => {
    await openHome(user);

    expect(header().textContent).toContain(`${user.fullName} · ${role}`);
  });

  it('keeps the system name as the home link, though a phone shows only the mark', async () => {
    await openHome(STUDENT);

    const home = within(header()).getByRole('link', { name: 'ระบบลงทะเบียนชุมนุม' });
    expect(home.getAttribute('href')).toBe('/student');
  });

  it('puts change password and logout behind the account button, closed at first', async () => {
    await openHome(STUDENT);

    expect(accountButton().getAttribute('aria-expanded')).toBe('false');
    const panel = accountPanel();
    expect(within(panel).getByRole('link', { name: 'เปลี่ยนรหัสผ่าน' }).getAttribute('href')).toBe(
      '/change-password',
    );
    expect(within(panel).getByRole('button', { name: 'ออกจากระบบ' })).toBeTruthy();
  });

  it('opens and closes the account panel', async () => {
    await openHome(STUDENT);

    fireEvent.click(accountButton());
    expect(accountButton().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(accountButton());
    expect(accountButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('leads to the password change from the account panel', async () => {
    const { router } = await openHome(STUDENT);
    fireEvent.click(accountButton());

    fireEvent.click(within(accountPanel()).getByRole('link', { name: 'เปลี่ยนรหัสผ่าน' }));

    await screen.findByRole('heading', { name: 'เปลี่ยนรหัสผ่าน' });
    expect(router.state.location.pathname).toBe('/change-password');
  });

  it('logs out from the account panel', async () => {
    const { fetchMock, router } = await openHome(STUDENT);
    fireEvent.click(accountButton());

    fireEvent.click(within(accountPanel()).getByRole('button', { name: 'ออกจากระบบ' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
  });

  it("scrolls the admin's menu row to the current page when it is out of view", async () => {
    // jsdom lays nothing out: the menu row is 300 px wide and each item 100 px, side by side.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return [...(this.parentElement?.children ?? [])].indexOf(this) * 100;
    });
    const scrolled = vi.spyOn(Element.prototype, 'scrollLeft', 'set');
    mockApi({ 'GET /api/auth/me': () => Response.json({ user: ADMIN }) });

    renderAt('/admin/events');
    await screen.findByRole('heading', { level: 1 });

    const nav = screen.getByRole('navigation', { name: 'เมนูหลัก' });
    const current = within(nav).getByRole('link', { name: 'ประวัติการลงทะเบียน' });
    expect(current.getAttribute('aria-current')).toBe('page');
    // Its right edge (5 × 100 + 100) at the row's right edge.
    expect(scrolled).toHaveBeenCalledWith(300);
  });

  it('keeps one main menu with every page of the role', async () => {
    await openHome(STUDENT);

    const nav = screen.getByRole('navigation', { name: 'เมนูหลัก' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['หน้าแรก', 'ชุมนุมในชั้นของฉัน', 'ผลของฉัน']);
  });
});
