import { expect, test } from '@playwright/test';
import { ADMIN, OPEN_CLUB, STUDENTS, TERM } from '../fixtures.js';
import { LOGIN_ID_LABEL, PASSWORD_LABEL, STUDENT_LANDING, logIn } from './helpers.js';

test('a visitor without a session is sent to the login page', async ({ page }) => {
  await page.goto('/student/clubs');

  await expect(page).toHaveURL(/\/login$/);
});

// Y1: a bookmarked page, or one whose session ran out, is where logging in leads back to.
test('logging in from a page that asked for it goes back to that page', async ({ page }) => {
  await page.goto('/admin/clubs');
  await expect(page).toHaveURL(/\/login$/);

  // Filled on the page it was sent to (submitLogin would open /login afresh, without the page).
  await page.getByLabel(LOGIN_ID_LABEL).fill(ADMIN.loginId);
  await page.getByLabel(PASSWORD_LABEL, { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();

  await expect(page).toHaveURL(/\/admin\/clubs$/);
  await expect(page.getByText(OPEN_CLUB.name).first()).toBeVisible();
});

test('a student who opens an admin page is sent to their own home', async ({ page }) => {
  await logIn(page, STUDENTS.browses, STUDENT_LANDING);

  await page.goto('/admin/rounds');

  await expect(page).toHaveURL(STUDENT_LANDING);
});

test('an admin sees the round and its clubs', async ({ page }) => {
  await logIn(page, ADMIN, /\/admin$/);

  await page.goto('/admin/rounds');
  await expect(page.getByText(TERM).first()).toBeVisible();

  await page.goto('/admin/clubs');
  await expect(page.getByText(OPEN_CLUB.name).first()).toBeVisible();
});
