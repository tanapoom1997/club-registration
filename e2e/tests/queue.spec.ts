import { expect, test } from '@playwright/test';
import { QUEUE_CLUB, QUEUE_STUDENTS } from '../fixtures.js';
import { STUDENT_LANDING, logIn, queryDatabase } from './helpers.js';

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
    await logIn(first, QUEUE_STUDENTS.first, STUDENT_LANDING);
    const firstQueue = first.getByRole('region', { name: QUEUE_CARD });
    await expect(firstQueue.getByRole('status')).toContainText('ถึงคิวของคุณแล้ว เลือกชุมนุมได้ถึง');
    await expect(first.getByRole('article', { name: QUEUE_CLUB.name, exact: true })).toBeVisible();

    // max_active 1: the second student is next in line and sees no club list.
    await logIn(page, QUEUE_STUDENTS.second, STUDENT_LANDING);
    const queue = page.getByRole('region', { name: QUEUE_CARD });
    await expect(queue.getByRole('status')).toHaveText('รอคิว');
    await expect(queue).toContainText('ลำดับที่ 1');
    await expect(page.getByRole('list', { name: CLUB_LIST })).toHaveCount(0);
    // The page waits on the round read, not on a club list the API now refuses (Q2): no error.
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('โหลดข้อมูลไม่สำเร็จ')).toHaveCount(0);
    // The API itself keeps the list from a student out of turn, whatever the page does.
    const outOfTurn = await page.request.get('/api/student/clubs');
    expect(outOfTurn.status()).toBe(403);
    expect(((await outOfTurn.json()) as { code: string }).code).toBe('queue_required');

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
