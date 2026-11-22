import { expect, test } from '@playwright/test';
import { QUEUE_CLUB, QUEUE_STUDENTS } from '../fixtures.js';
import { logIn, queryDatabase } from './helpers.js';

const STUDENT_HOME = /\/student$/;
const CLUB_LIST = 'รายการชุมนุม';
const QUEUE_CARD = 'คิวเลือกชุมนุม';
// Heartbeats go every 4 seconds, and the one after the release lets the next student in.
const POLL_TIMEOUT_MS = 15_000;

const ticketsOf = async (loginId: string): Promise<string[]> =>
  (
    await queryDatabase<{ status: string }>(
      `SELECT t.status FROM queue_tickets t JOIN users u ON u.id = t.student_id
       WHERE u.login_id = $1 ORDER BY t.id`,
      [loginId],
    )
  ).map(({ status }) => status);

test('the second student waits for the one place until the first releases it', async ({
  browser,
  page,
}) => {
  // The first student, in their own browser, is let in at once and sees the clubs.
  const firstContext = await browser.newContext();
  const first = await firstContext.newPage();
  try {
    await logIn(first, QUEUE_STUDENTS.first, STUDENT_HOME);
    await first.goto('/student/clubs');
    const firstQueue = first.getByRole('region', { name: QUEUE_CARD });
    await expect(firstQueue.getByRole('status')).toContainText('ถึงคิวของคุณแล้ว เลือกชุมนุมได้ถึง');
    await expect(first.getByRole('article', { name: QUEUE_CLUB.name, exact: true })).toBeVisible();

    // max_active 1: the second student is next in line and sees no club list.
    await logIn(page, QUEUE_STUDENTS.second, STUDENT_HOME);
    await page.goto('/student/clubs');
    const queue = page.getByRole('region', { name: QUEUE_CARD });
    await expect(queue.getByRole('status')).toHaveText('รอคิว');
    await expect(queue).toContainText('ลำดับที่ 1');
    await expect(page.getByRole('list', { name: CLUB_LIST })).toHaveCount(0);

    await first.getByRole('button', { name: 'เสร็จแล้ว ปล่อยคิว' }).click();
    await expect(firstQueue.getByRole('status')).toHaveText('ปล่อยคิวแล้ว');
    await expect(first.getByRole('list', { name: CLUB_LIST })).toHaveCount(0);

    // No reload: the waiting page's heartbeat lets the second student in.
    await expect(page.getByRole('list', { name: CLUB_LIST })).toBeVisible({
      timeout: POLL_TIMEOUT_MS,
    });
    await expect(queue.getByRole('status')).toContainText('ถึงคิวของคุณแล้ว');
    await expect(page.getByRole('article', { name: QUEUE_CLUB.name, exact: true })).toBeVisible();

    expect(await ticketsOf(QUEUE_STUDENTS.first.loginId)).toEqual(['done']);
    expect(await ticketsOf(QUEUE_STUDENTS.second.loginId)).toEqual(['admitted']);
  } finally {
    await firstContext.close();
  }
});
