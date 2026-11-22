import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  ADMIN,
  ADMIN_FROM_CLUB,
  ADMIN_TO_CLUB,
  ADMIN_WAITLIST_CLUB,
  NOTICE_FROM_CLUB,
  NOTICE_TO_CLUB,
  STUDENTS,
} from '../fixtures.js';
import { logIn, queryDatabase } from './helpers.js';

type Club = { code: string; name: string };

const clubLabel = (club: Club) => `${club.code} ${club.name}`;

const openMembers = async (page: Page, club: Club) => {
  await page.goto('/admin/clubs');
  await page.getByRole('button', { name: `รายชื่อชุมนุม ${club.code}`, exact: true }).click();
  return page.getByRole('region', { name: `รายชื่อชุมนุม ${clubLabel(club)}` });
};

const assign = async (page: Page, club: Club, loginId: string) => {
  const panel = await openMembers(page, club);
  await panel.getByLabel('รหัสนักเรียน', { exact: true }).fill(loginId);
  await panel.getByRole('button', { name: 'เพิ่มเข้าชุมนุม' }).click();
  return panel;
};

// The panel's result notice. Matched by its text, not as the panel's only status: while a removal
// is on its way the confirmation shows its own "กำลัง…" status too, and on a slow runner the check
// can look while both are there.
const expectNotice = async (panel: Locator, text: string) => {
  await expect(panel.getByRole('status').filter({ hasText: text })).toHaveText(text);
};

const clubIdOf = async (code: string): Promise<number | undefined> =>
  (await queryDatabase<{ id: number }>('SELECT id FROM clubs WHERE club_code = $1', [code]))[0]?.id;

const seatsOf = async (code: string): Promise<number | undefined> =>
  (
    await queryDatabase<{ registered: number }>(
      'SELECT registered FROM clubs WHERE club_code = $1',
      [code],
    )
  )[0]?.registered;

type EventRow = { event_type: string; from_club_id: number | null; actor: string };

const eventsOf = async (loginId: string): Promise<EventRow[]> =>
  await queryDatabase<EventRow>(
    `SELECT e.event_type, e.from_club_id, a.login_id AS actor
     FROM registration_events e
     JOIN users s ON s.id = e.student_id
     JOIN users a ON a.id = e.actor_id
     WHERE s.login_id = $1 ORDER BY e.id`,
    [loginId],
  );

test('an admin seats a student, moves them to another club, then removes them', async ({
  page,
}) => {
  const student = STUDENTS.seatedByAdmin;
  await logIn(page, ADMIN, /\/admin$/);

  const from = await assign(page, ADMIN_FROM_CLUB, student.loginId.toUpperCase());
  const seated = `บันทึกแล้ว: ${student.loginId} ${student.fullName} อยู่ในชุมนุม`;
  await expectNotice(from, `${seated} ${clubLabel(ADMIN_FROM_CLUB)}`);
  await expect(
    from.getByRole('table', { name: `สมาชิกชุมนุม ${ADMIN_FROM_CLUB.code}` }),
  ).toContainText(student.fullName);

  const to = await assign(page, ADMIN_TO_CLUB, student.loginId);
  await expectNotice(to, `${seated} ${clubLabel(ADMIN_TO_CLUB)}`);
  expect(await seatsOf(ADMIN_FROM_CLUB.code)).toBe(0);
  expect(await seatsOf(ADMIN_TO_CLUB.code)).toBe(1);

  await to.getByRole('button', { name: `นำออก ${student.loginId} ${student.fullName}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ยืนยัน นำออกจากชุมนุม' }).click();
  await expectNotice(to, `นำ ${student.loginId} ออกจากชุมนุม ${clubLabel(ADMIN_TO_CLUB)} แล้ว`);
  await expect(to.getByText('ยังไม่มีสมาชิก')).toBeVisible();

  expect(await seatsOf(ADMIN_TO_CLUB.code)).toBe(0);
  const fromId = await clubIdOf(ADMIN_FROM_CLUB.code);
  expect(await eventsOf(student.loginId)).toEqual([
    { event_type: 'admin_assign', from_club_id: null, actor: ADMIN.loginId },
    { event_type: 'admin_assign', from_club_id: fromId, actor: ADMIN.loginId },
    { event_type: 'admin_remove', from_club_id: null, actor: ADMIN.loginId },
  ]);
});

test('an admin removes a student from a waitlist', async ({ browser, page }) => {
  const student = STUDENTS.removedFromWaitlist;
  // The student joins the waitlist of the club with no seats in their own browser.
  const studentContext = await browser.newContext();
  const studentPage = await studentContext.newPage();
  try {
    await logIn(studentPage, student, /\/student$/);
    await studentPage.goto('/student/clubs');
    await studentPage
      .getByRole('button', { name: `เข้ารายชื่อรอ ${clubLabel(ADMIN_WAITLIST_CLUB)}` })
      .click();
    await studentPage
      .getByRole('alertdialog')
      .getByRole('button', { name: 'ยืนยัน เข้ารายชื่อรอ' })
      .click();
    await expect(
      studentPage.getByText(`เข้ารายชื่อรอชุมนุม ${clubLabel(ADMIN_WAITLIST_CLUB)} แล้ว`),
    ).toBeVisible();
  } finally {
    await studentContext.close();
  }

  await logIn(page, ADMIN, /\/admin$/);
  const panel = await openMembers(page, ADMIN_WAITLIST_CLUB);
  const queue = panel.getByRole('table', { name: `รายชื่อรอชุมนุม ${ADMIN_WAITLIST_CLUB.code}` });
  await expect(queue).toContainText(student.fullName);
  await queue.getByRole('button', { name: `นำออก ${student.loginId} ${student.fullName}` }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('ไม่ทำให้ใครได้ที่');
  await dialog.getByRole('button', { name: 'ยืนยัน นำออกจากรายชื่อรอ' }).click();

  await expectNotice(
    panel,
    `นำ ${student.loginId} ออกจากรายชื่อรอชุมนุม ${clubLabel(ADMIN_WAITLIST_CLUB)} แล้ว`,
  );
  await expect(panel.getByText('ไม่มีคนรอ')).toBeVisible();
  const entries = await queryDatabase(
    `SELECT w.id FROM waitlist_entries w JOIN users u ON u.id = w.student_id
     WHERE u.login_id = $1`,
    [student.loginId],
  );
  expect(entries).toHaveLength(0);
  expect(await eventsOf(student.loginId)).toEqual([
    { event_type: 'waitlist_join', from_club_id: null, actor: student.loginId },
    { event_type: 'waitlist_leave', from_club_id: null, actor: ADMIN.loginId },
  ]);
});

// README Phase 4, P3: the student learns from their own pages what an admin did, and the notice
// goes once they act themselves.
test('a student sees that an admin moved them, until they act themselves', async ({
  browser,
  page,
}) => {
  const student = STUDENTS.movedByAdmin;
  await logIn(page, ADMIN, /\/admin$/);
  const from = await assign(page, NOTICE_FROM_CLUB, student.loginId);
  await expectNotice(
    from,
    `บันทึกแล้ว: ${student.loginId} ${student.fullName} อยู่ในชุมนุม ${clubLabel(NOTICE_FROM_CLUB)}`,
  );
  const to = await assign(page, NOTICE_TO_CLUB, student.loginId);
  await expectNotice(
    to,
    `บันทึกแล้ว: ${student.loginId} ${student.fullName} อยู่ในชุมนุม ${clubLabel(NOTICE_TO_CLUB)}`,
  );

  const studentContext = await browser.newContext();
  const studentPage = await studentContext.newPage();
  try {
    await logIn(studentPage, student, /\/student$/);
    await studentPage.goto('/student/my-registration');
    const moved = `ผู้ดูแลระบบย้ายคุณจากชุมนุม ${clubLabel(NOTICE_FROM_CLUB)} ไปชุมนุม ${clubLabel(NOTICE_TO_CLUB)} เมื่อ`;
    const notice = studentPage.getByRole('status').filter({ hasText: moved });
    await expect(notice).toBeVisible();
    await expect(notice).not.toContainText(ADMIN.loginId);
    await expect(notice).not.toContainText(ADMIN.fullName);
    await expect(
      studentPage.getByRole('heading', { name: 'ชุมนุมของฉัน' }).locator('..'),
    ).toContainText(clubLabel(NOTICE_TO_CLUB));

    await studentPage.getByRole('button', { name: 'ยกเลิกชุมนุมนี้' }).click();
    await studentPage
      .getByRole('alertdialog')
      .getByRole('button', { name: 'ยืนยัน ยกเลิกชุมนุม' })
      .click();
    await expect(studentPage.getByText(/^ยกเลิกชุมนุมแล้ว/)).toBeVisible();
    await expect(studentPage.getByText(/^ผู้ดูแลระบบ/)).toHaveCount(0);
    await studentPage.reload();
    await expect(studentPage.getByText('ยังไม่ได้ลงชุมนุม')).toBeVisible();
    await expect(studentPage.getByText(/^ผู้ดูแลระบบ/)).toHaveCount(0);
  } finally {
    await studentContext.close();
  }

  expect((await eventsOf(student.loginId)).map(({ event_type: type }) => type)).toEqual([
    'admin_assign',
    'admin_assign',
    'cancel',
  ]);
});
