import { expect, test } from '@playwright/test';
import { ADMIN, OPEN_CLUB, STUDENTS, TERM } from '../fixtures.js';
import { STUDENT_HOME, STUDENT_LANDING, logIn } from './helpers.js';

test('a visitor without a session is sent to the login page', async ({ page }) => {
  await page.goto('/student/clubs');

  await expect(page).toHaveURL(/\/login$/);
});

test('a student who opens an admin page is sent to their own home', async ({ page }) => {
  await logIn(page, STUDENTS.browses, STUDENT_LANDING);

  await page.goto('/admin/rounds');

  await expect(page).toHaveURL(STUDENT_HOME);
});

test('an admin sees the round and its clubs', async ({ page }) => {
  await logIn(page, ADMIN, /\/admin$/);

  await page.goto('/admin/rounds');
  await expect(page.getByText(TERM).first()).toBeVisible();

  await page.goto('/admin/clubs');
  await expect(page.getByText(OPEN_CLUB.name).first()).toBeVisible();
});
