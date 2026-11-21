import { expect, test } from '@playwright/test';
import { ADVISOR_NAME, FULL_CLUB, OPEN_CLUB, STUDENTS } from '../fixtures.js';
import { PASSWORD_LABEL, logIn, queryDatabase, submitLogin } from './helpers.js';

const STUDENT_HOME = /\/student$/;
// A club card is named by its heading (the club's name); its buttons and messages say code and name.
const clubLabel = (club: { code: string; name: string }) => `${club.code} ${club.name}`;

test('a student registers for a club, sees it as theirs, then cancels it', async ({ page }) => {
  const student = STUDENTS.registers;
  await logIn(page, student, STUDENT_HOME);

  await page.goto('/student/clubs');
  const card = page.getByRole('article', { name: OPEN_CLUB.name, exact: true });
  await expect(card).toContainText(ADVISOR_NAME);
  await card.getByRole('button', { name: `ลงชุมนุม ${clubLabel(OPEN_CLUB)}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ยืนยัน ลงชุมนุม' }).click();

  await expect(page.getByText(`ลงชุมนุม ${clubLabel(OPEN_CLUB)} เรียบร้อยแล้ว`)).toBeVisible();
  await expect(card.getByText('ชุมนุมของฉัน')).toBeVisible();

  await page.goto('/student/my-registration');
  await expect(page.getByText(OPEN_CLUB.name)).toBeVisible();
  await page.getByRole('button', { name: 'ยกเลิกชุมนุมนี้' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ยืนยัน ยกเลิกชุมนุม' }).click();
  await expect(page.getByText('ยังไม่ได้ลงชุมนุม')).toBeVisible();

  // The whole stack, not only the page: the seat count is back, and both writes left their event
  // (CLAUDE.md rules 1 and 7).
  const [club] = await queryDatabase<{ registered: number }>(
    'SELECT registered FROM clubs WHERE club_code = $1',
    [OPEN_CLUB.code],
  );
  expect(club?.registered).toBe(0);
  const events = await queryDatabase<{ event_type: string }>(
    `SELECT e.event_type FROM registration_events e JOIN users u ON u.id = e.student_id
     WHERE u.login_id = $1 ORDER BY e.id`,
    [student.loginId],
  );
  expect(events.map(({ event_type: type }) => type)).toEqual(['register', 'cancel']);
});

test('a full club is shown as full and offers its waitlist instead of a seat', async ({ page }) => {
  await logIn(page, STUDENTS.browses, STUDENT_HOME);

  await page.goto('/student/clubs');
  const card = page.getByRole('article', { name: FULL_CLUB.name, exact: true });

  await expect(card.getByText('เต็ม', { exact: true })).toBeVisible();
  await expect(
    card.getByRole('button', { name: `เข้ารายชื่อรอ ${clubLabel(FULL_CLUB)}` }),
  ).toBeEnabled();
  await expect(card.getByRole('button', { name: `ลงชุมนุม ${clubLabel(FULL_CLUB)}` })).toHaveCount(0);
});

test('the first login asks for a new password before anything else', async ({ page }) => {
  const student = STUDENTS.firstLogin;
  const newPassword = 'e2e-student-b-chosen';
  await logIn(page, student, /\/change-password$/);
  await expect(page.getByText('เข้าสู่ระบบครั้งแรก กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งาน')).toBeVisible();

  // Every other page sends the student back here until the password is changed.
  await page.goto('/student/clubs');
  await expect(page).toHaveURL(/\/change-password$/);

  await page.getByLabel('รหัสผ่านเดิม').fill(student.password);
  await page.getByLabel(/^รหัสผ่านใหม่/).fill(newPassword);
  await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill(newPassword);
  await page.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }).click();
  await expect(page).toHaveURL(STUDENT_HOME);

  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await submitLogin(page, student.loginId, student.password);
  await expect(page.getByText('รหัสผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')).toBeVisible();
  await page.getByLabel(PASSWORD_LABEL, { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page).toHaveURL(STUDENT_HOME);
});
