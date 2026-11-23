import type { SessionUser } from '@club-registration/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt, unauthorized } from '@/test-support/render-app';

// Every name below is made up.
const STUDENT: SessionUser = {
  id: 1,
  loginId: 'demo1001',
  fullName: 'นักเรียนสมมติ หนึ่ง',
  role: 'student',
  mustChangePassword: false,
};

const NO_ROUND = { round: null, registration: null, waitlist: null, adminChange: null };

// The result page with no round: the club list, the student's home, would bring in the queue.
const openStudentPage = async () => {
  mockApi({
    'GET /api/auth/me': () => Response.json({ user: STUDENT }),
    'GET /api/student/round': () => Response.json(NO_ROUND),
    'GET /api/student/clubs': () => Response.json({ ...NO_ROUND, clubs: [] }),
  });
  renderAt('/student/my-registration');
  return await screen.findByRole('heading', { level: 1, name: 'ผลของฉัน' });
};

describe('moving between pages (U2)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.title = '';
  });

  it('names the tab after the page, then the system', async () => {
    await openStudentPage();

    expect(document.title).toBe('ผลของฉัน · ลงทะเบียนชุมนุม');
  });

  it('names the login page in the tab', async () => {
    mockApi({ 'GET /api/auth/me': unauthorized });
    renderAt('/login');

    await screen.findByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' });

    expect(document.title).toBe('เข้าสู่ระบบ · ลงทะเบียนชุมนุม');
  });

  it('leaves focus alone when the app first opens', async () => {
    const heading = await openStudentPage();

    expect(document.activeElement).not.toBe(heading);
  });

  it('moves focus to the new page heading after a menu link, and renames the tab', async () => {
    await openStudentPage();
    const nav = screen.getByRole('navigation', { name: 'เมนูหลัก' });

    fireEvent.click(within(nav).getByRole('link', { name: 'ชุมนุมในชั้นของฉัน' }));

    const heading = await screen.findByRole('heading', { level: 1, name: 'ชุมนุมในชั้นของฉัน' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(document.title).toBe('ชุมนุมในชั้นของฉัน · ลงทะเบียนชุมนุม');
  });
});
