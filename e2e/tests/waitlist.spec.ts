import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { CHANGE_FROM_CLUB, CHANGE_TO_CLUB, ONE_SEAT_CLUB, STUDENTS } from '../fixtures.js';
import { STUDENT_LANDING, logIn, queryDatabase } from './helpers.js';

const clubLabel = (club: { code: string; name: string }) => `${club.code} ${club.name}`;
// The page polls every 5 seconds while the round is open; a few polls' worth of slack.
const POLL_TIMEOUT_MS = 15_000;

const eventTypesOf = async (loginId: string): Promise<string[]> =>
  (
    await queryDatabase<{ event_type: string }>(
      `SELECT e.event_type FROM registration_events e JOIN users u ON u.id = e.student_id
       WHERE u.login_id = $1 ORDER BY e.id`,
      [loginId],
    )
  ).map(({ event_type: type }) => type);

const seatsOf = async (code: string): Promise<number | undefined> =>
  (
    await queryDatabase<{ registered: number }>(
      'SELECT registered FROM clubs WHERE club_code = $1',
      [code],
    )
  )[0]?.registered;

const register = async (page: Page, club: { code: string; name: string }) => {
  await page.goto('/student/clubs');
  const card = page.getByRole('article', { name: club.name, exact: true });
  await card.getByRole('button', { name: `ลงชุมนุม ${clubLabel(club)}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ยืนยัน ลงชุมนุม' }).click();
  await expect(page.getByText(`ลงชุมนุม ${clubLabel(club)} เรียบร้อยแล้ว`)).toBeVisible();
};

test('a student waits for a full club and gets the seat when its holder cancels', async ({
  browser,
  page,
}) => {
  // The holder takes the one seat in their own browser.
  const holderContext = await browser.newContext();
  const holder = await holderContext.newPage();
  try {
    await logIn(holder, STUDENTS.holdsSeat, STUDENT_LANDING);
    await register(holder, ONE_SEAT_CLUB);

    await logIn(page, STUDENTS.waits, STUDENT_LANDING);
    const card = page.getByRole('article', { name: ONE_SEAT_CLUB.name, exact: true });
    await expect(card.getByText('เต็ม', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: `เข้ารายชื่อรอ ${clubLabel(ONE_SEAT_CLUB)}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'ยืนยัน เข้ารายชื่อรอ' }).click();
    const joinNotice = page.getByText(`เข้ารายชื่อรอชุมนุม ${clubLabel(ONE_SEAT_CLUB)} แล้ว ลำดับที่ 1`);
    await expect(joinNotice).toBeVisible();
    await expect(joinNotice).toBeFocused();
    await expect(card.getByText('รออยู่ ลำดับที่ 1')).toBeVisible();
    // A keyboard user moves on to the leave button, which the promotion below removes. Checked,
    // so the test cannot pass on the join notice's own focus fallback instead.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'ออกจากรายชื่อรอ' })).toBeFocused();

    await holder.goto('/student/my-registration');
    await holder.getByRole('button', { name: 'ยกเลิกชุมนุมนี้' }).click();
    await holder.getByRole('alertdialog').getByRole('button', { name: 'ยืนยัน ยกเลิกชุมนุม' }).click();
    await expect(holder.getByText('ยังไม่ได้ลงชุมนุม')).toBeVisible();

    // No reload: the waiting student's page learns of the promotion by polling. Focus goes from
    // the removed leave button to the notice rather than to <body>, and the join notice, which
    // would now contradict it, is gone.
    const promotedNotice = page.getByText(`ได้ที่ในชุมนุม ${clubLabel(ONE_SEAT_CLUB)} จากรายชื่อรอแล้ว`);
    await expect(promotedNotice).toBeVisible({ timeout: POLL_TIMEOUT_MS });
    await expect(promotedNotice).toBeFocused();
    await expect(joinNotice).toBeHidden();
    await expect(card.getByText('ชุมนุมของฉัน')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'รายชื่อรอของฉัน' })).toHaveCount(0);

    // The whole stack: the seat changed hands once, and each write left its event.
    expect(await seatsOf(ONE_SEAT_CLUB.code)).toBe(1);
    expect(await eventTypesOf(STUDENTS.holdsSeat.loginId)).toEqual(['register', 'cancel']);
    expect(await eventTypesOf(STUDENTS.waits.loginId)).toEqual([
      'waitlist_join',
      'waitlist_promote',
    ]);
  } finally {
    await holderContext.close();
  }
});

test('a student moves to another club in one step', async ({ page }) => {
  const student = STUDENTS.changes;
  await logIn(page, student, STUDENT_LANDING);
  await register(page, CHANGE_FROM_CLUB);

  const card = page.getByRole('article', { name: CHANGE_TO_CLUB.name, exact: true });
  await card.getByRole('button', { name: `ย้ายมาชุมนุมนี้ ${clubLabel(CHANGE_TO_CLUB)}` }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('ถ้าชุมนุมใหม่เต็มก่อน คุณยังอยู่ชุมนุมเดิม');
  await dialog.getByRole('button', { name: 'ยืนยัน ย้ายชุมนุม' }).click();

  await expect(page.getByText(`ย้ายมาชุมนุม ${clubLabel(CHANGE_TO_CLUB)} เรียบร้อยแล้ว`)).toBeVisible();
  await expect(card.getByText('ชุมนุมของฉัน')).toBeVisible();
  await expect(
    page
      .getByRole('article', { name: CHANGE_FROM_CLUB.name, exact: true })
      .getByRole('button', { name: `ย้ายมาชุมนุมนี้ ${clubLabel(CHANGE_FROM_CLUB)}` }),
  ).toBeEnabled();

  expect(await seatsOf(CHANGE_FROM_CLUB.code)).toBe(0);
  expect(await seatsOf(CHANGE_TO_CLUB.code)).toBe(1);
  expect(await eventTypesOf(student.loginId)).toEqual(['register', 'change']);
});
