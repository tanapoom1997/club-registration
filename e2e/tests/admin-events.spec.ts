import { expect, test } from '@playwright/test';
import { ADMIN, EVENT_LOG_CLUB, STUDENTS, TERM, GRADE } from '../fixtures.js';
import { logIn } from './helpers.js';

const clubLabel = (club: { code: string; name: string }) => `${club.code} ${club.name}`;

test('an admin finds the registration of a student in the event log by their code', async ({
  browser,
  page,
}) => {
  const student = STUDENTS.inEventLog;
  // The student registers in their own browser, so the event this test looks for is its own.
  const studentContext = await browser.newContext();
  const studentPage = await studentContext.newPage();
  try {
    await logIn(studentPage, student, /\/student$/);
    await studentPage.goto('/student/clubs');
    await studentPage
      .getByRole('article', { name: EVENT_LOG_CLUB.name, exact: true })
      .getByRole('button', { name: `ลงชุมนุม ${clubLabel(EVENT_LOG_CLUB)}` })
      .click();
    await studentPage
      .getByRole('alertdialog')
      .getByRole('button', { name: 'ยืนยัน ลงชุมนุม' })
      .click();
    await expect(
      studentPage.getByText(`ลงชุมนุม ${clubLabel(EVENT_LOG_CLUB)} เรียบร้อยแล้ว`),
    ).toBeVisible();
  } finally {
    await studentContext.close();
  }

  await logIn(page, ADMIN, /\/admin$/);
  await page
    .getByRole('navigation', { name: 'เมนูหลัก' })
    .getByRole('link', {
      name: /ประวัติการลงทะเบียน/,
    })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'ประวัติการลงทะเบียน' })).toBeVisible();
  const log = page.getByRole('table', { name: 'ประวัติการลงทะเบียน' });
  await expect(log).toBeVisible();

  const eventsRequest = page.waitForRequest(
    (request) => new URL(request.url()).searchParams.get('loginId') === student.loginId,
  );
  await page.getByLabel('รหัสนักเรียน', { exact: true }).fill(student.loginId.toUpperCase());
  await page.getByRole('button', { name: 'กรอง', exact: true }).click();
  await eventsRequest;

  await expect(page.getByText(`ตัวกรองที่ใช้อยู่: นักเรียน ${student.loginId}`)).toBeVisible();
  const rows = log.getByRole('row');
  // The header and the one register event: nobody else's events, nothing else of this student's.
  await expect(rows).toHaveCount(2);
  const row = rows.nth(1);
  await expect(row).toContainText('ลงชุมนุม');
  await expect(row).toContainText(`${TERM} ม.${GRADE}`);
  await expect(row).toContainText(student.fullName);
  await expect(row).toContainText(clubLabel(EVENT_LOG_CLUB));
  await expect(row).toContainText('นักเรียนคนนี้เอง');
  await expect(page.getByText('แสดงครบแล้ว')).toBeVisible();

  // The code never reaches the page's address, so it stays out of the browser history.
  const address = page.url();
  expect(new URL(address).pathname).toBe('/admin/events');
  expect(address).not.toContain(student.loginId);
  expect(address.toLowerCase()).not.toContain(student.loginId.toLowerCase());
});
