import type { SessionUser } from '@club-registration/shared';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt } from '@/test-support/render-app';

// Each menu page is loaded on demand. These mocks stand in for the network: one page arrives only
// when the test says so, one fails like a chunk a deploy removed, and two count their downloads.
const pages = vi.hoisted(() => {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, released, importLoads: 0, eventsLoads: 0, studentLoads: 0 };
});

vi.mock('@/pages/admin-rounds/AdminRoundsPage', async (importOriginal) => {
  await pages.released;
  return await importOriginal();
});
vi.mock('@/pages/admin-export/AdminExportPage', () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});
vi.mock('@/pages/admin-import/AdminImportPage', async (importOriginal) => {
  pages.importLoads += 1;
  return await importOriginal();
});
vi.mock('@/pages/admin-events/AdminEventsPage', async (importOriginal) => {
  pages.eventsLoads += 1;
  return await importOriginal();
});
vi.mock('@/pages/student/StudentClubsPage', async (importOriginal) => {
  pages.studentLoads += 1;
  return await importOriginal();
});

// Made-up accounts.
const ADMIN: SessionUser = {
  id: 9,
  loginId: 'demo-admin',
  fullName: 'ผู้ดูแลสมมติ',
  role: 'admin',
  mustChangePassword: false,
};
const STUDENT: SessionUser = {
  id: 1,
  loginId: 'demo1001',
  fullName: 'นักเรียนสมมติ หนึ่ง',
  role: 'student',
  mustChangePassword: false,
};

const signedInAs = (user: SessionUser) =>
  mockApi({
    'GET /api/auth/me': () => Response.json({ user }),
    'GET /api/admin/rounds': () => Response.json({ rounds: [] }),
  });

describe('lazily loaded pages', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('says the page is loading inside the layout until it arrives', async () => {
    signedInAs(ADMIN);
    renderAt('/admin/rounds');

    expect((await screen.findByRole('status')).textContent).toBe('กำลังโหลดหน้า…');
    expect(screen.getByRole('navigation', { name: 'เมนูหลัก' })).toBeTruthy();
    pages.release();

    expect(await screen.findByRole('heading', { level: 1, name: 'รอบลงทะเบียน' })).toBeTruthy();
    expect(screen.queryByText('กำลังโหลดหน้า…')).toBeNull();
  });

  it('offers a reload when a page fails to load, keeping the menu usable', async () => {
    // React reports the caught error on the console; the page itself is what this test checks.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    signedInAs(ADMIN);
    renderAt('/admin/export');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('เปิดหน้านี้ไม่สำเร็จ');
    expect(alert.textContent).toContain('ระบบเพิ่งอัปเดตเป็นเวอร์ชันใหม่');
    expect(screen.getByRole('navigation', { name: 'เมนูหลัก' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'โหลดหน้าใหม่' }));

    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not download an admin page for a student sent back to the student home', async () => {
    signedInAs(STUDENT);
    renderAt('/admin/import');

    await screen.findByRole('heading', { name: `สวัสดี ${STUDENT.fullName}` });
    expect(pages.importLoads).toBe(0);
  });

  it('does not download the event log, which names students, for a student', async () => {
    signedInAs(STUDENT);
    renderAt('/admin/events');

    await screen.findByRole('heading', { name: `สวัสดี ${STUDENT.fullName}` });
    expect(pages.eventsLoads).toBe(0);
  });

  it('downloads the event log page for an admin who opens it', async () => {
    const fetchMock = signedInAs(ADMIN);
    renderAt('/admin/events');

    expect(await screen.findByRole('heading', { level: 1, name: 'ประวัติการลงทะเบียน' })).toBeTruthy();
    expect(pages.eventsLoads).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/events', { method: 'GET' });
  });

  it('does not download a student page for an admin sent back to the admin home', async () => {
    signedInAs(ADMIN);
    renderAt('/student/clubs');

    await screen.findByRole('heading', { name: `สวัสดี ${ADMIN.fullName}` });
    expect(pages.studentLoads).toBe(0);
  });
});
