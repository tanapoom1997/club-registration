import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import {
  ADMIN,
  QUEUE_ADMIN_CLUB,
  QUEUE_ADMIN_GRADE,
  QUEUE_ADMIN_MAX_ACTIVE,
  QUEUE_ADMIN_STUDENTS,
  TERM,
} from '../fixtures.js';
import type { Account } from '../fixtures.js';
import { STUDENT_LANDING, logIn, queryDatabase } from './helpers.js';

const ADMIN_HOME = /\/admin$/;
const CLUB_LIST = 'รายการชุมนุม';
const QUEUE_CARD = 'คิวเลือกชุมนุม';
const ROUND_NAME = `${TERM} ม.${QUEUE_ADMIN_GRADE}`;
const clubLabel = `${QUEUE_ADMIN_CLUB.code} ${QUEUE_ADMIN_CLUB.name}`;
// A student page sees a change on its next heartbeat (every 4 s) or round read (every 5 s).
const STUDENT_POLL_TIMEOUT_MS = 15_000;
// The admin's list polls every 10 s while a round is open; a student let in by the change is let
// in on their own next heartbeat, which usually lands after the refetch that follows the save.
const ADMIN_POLL_TIMEOUT_MS = 25_000;

const JOIN_PATH = '/api/student/queue/join';
const HEARTBEAT_PATH = '/api/student/queue/heartbeat';

type Ticket = { id: number; status: string; last_seen_at: Date };

const ticketsOf = async (loginId: string): Promise<Ticket[]> =>
  await queryDatabase<Ticket>(
    `SELECT t.id, t.status, t.last_seen_at FROM queue_tickets t
     JOIN users u ON u.id = t.student_id
     WHERE u.login_id = $1 ORDER BY t.id`,
    [loginId],
  );

const statusesOf = async (loginId: string): Promise<string[]> =>
  (await ticketsOf(loginId)).map(({ status }) => status);

const THIS_ROUND = 'SELECT id FROM rounds WHERE term = $1 AND grade = $2';

const setMaxActive = async (maxActive: number | null): Promise<void> => {
  await queryDatabase(`UPDATE rounds SET max_active = $3 WHERE id = (${THIS_ROUND})`, [
    TERM,
    QUEUE_ADMIN_GRADE,
    maxActive,
  ]);
};

// Every scenario starts from the same round: max_active 1, and no live ticket left from the one
// before (a closed page's ticket stays live for the 60 s idle timeout). Tickets only move forward
// (the queue_tickets_forward_only trigger), so they are ended as expired, never deleted or moved
// back.
test.beforeEach(async () => {
  await setMaxActive(QUEUE_ADMIN_MAX_ACTIVE);
  await queryDatabase(
    `UPDATE queue_tickets SET status = 'expired'
     WHERE round_id = (${THIS_ROUND}) AND status IN ('waiting', 'admitted')`,
    [TERM, QUEUE_ADMIN_GRADE],
  );
});

// Three logins and waits sized on the 10 s admin poll do not fit the default 30 s.
test.describe.configure({ timeout: 60_000 });

type StudentPage = { context: BrowserContext; page: Page; queue: Locator; loads: () => number };

// A student in a browser of their own, on the clubs page. loads() counts full page loads after
// that, so a scenario can say the page changed without a reload.
const openClubs = async (browser: Browser, account: Account): Promise<StudentPage> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await logIn(page, account, STUDENT_LANDING);
  let loads = 0;
  page.on('load', () => {
    loads += 1;
  });
  return {
    context,
    page,
    queue: page.getByRole('region', { name: QUEUE_CARD }),
    loads: () => loads,
  };
};

// Within the default expect timeout unless the admission waits on a poll.
const expectAdmitted = async ({ page, queue }: StudentPage, timeout = 5_000): Promise<void> => {
  await expect(queue.getByRole('status')).toContainText('ถึงคิวของคุณแล้ว', { timeout });
  await expect(page.getByRole('list', { name: CLUB_LIST })).toBeVisible();
};

const expectWaitingFirst = async ({ page, queue }: StudentPage): Promise<void> => {
  await expect(queue.getByRole('status')).toHaveText('รอคิว');
  await expect(queue).toContainText('ลำดับที่ 1');
  await expect(page.getByRole('list', { name: CLUB_LIST })).toHaveCount(0);
};

// The round's row in the admin's table and its cells by column name, so a count is read from its
// own column rather than found anywhere in the row.
const roundRow = async (page: Page) => {
  const table = page.getByRole('table', { name: 'รายการรอบลงทะเบียน' });
  const row = table
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: `ม.${QUEUE_ADMIN_GRADE}`, exact: true }) });
  await expect(row).toHaveCount(1);
  const headers = await table.getByRole('columnheader').allTextContents();
  const cell = (header: string) => {
    const index = headers.indexOf(header);
    if (index === -1) throw new Error(`No column ${header}`);
    return row.getByRole('cell').nth(index);
  };
  return { maxActive: cell('เข้าพร้อมกัน'), waiting: cell('รอคิว'), admitted: cell('ได้คิวแล้ว') };
};

const openRounds = async (page: Page) => {
  await logIn(page, ADMIN, ADMIN_HOME);
  await page.goto('/admin/rounds');
  return await roundRow(page);
};

// The real edit form, scoped to it: the create forms on the same page have the same fields.
const editRound = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: `แก้ไขรอบ ${ROUND_NAME}`, exact: true }).click();
  return page.getByRole('form', { name: `แก้ไขรอบ ${ROUND_NAME}` });
};

// The round is open, so saving asks once more before it reaches the students.
const saveOpenRound = async (form: Locator): Promise<void> => {
  await form.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await form.getByRole('alertdialog').getByRole('button', { name: 'ยืนยันบันทึก' }).click();
  await expect(form).toHaveCount(0);
};

test('a student waiting is let in when the admin raises max_active', async ({ browser, page }) => {
  const first = await openClubs(browser, QUEUE_ADMIN_STUDENTS.firstIn);
  try {
    await expectAdmitted(first);
    const second = await openClubs(browser, QUEUE_ADMIN_STUDENTS.raisedIn);
    try {
      await expectWaitingFirst(second);

      const counts = await openRounds(page);
      await expect(counts.waiting).toHaveText('1');
      await expect(counts.admitted).toHaveText('1');

      const form = await editRound(page);
      await form.getByLabel('จำนวนคนเข้าเลือกพร้อมกันสูงสุด').fill('2');
      await saveOpenRound(form);
      await expect(counts.maxActive).toHaveText('2');

      // The waiting page's own heartbeat lets the second student in, without a reload.
      await expectAdmitted(second, STUDENT_POLL_TIMEOUT_MS);
      expect(second.loads()).toBe(0);
      await expect(counts.waiting).toHaveText('0', { timeout: ADMIN_POLL_TIMEOUT_MS });
      await expect(counts.admitted).toHaveText('2', { timeout: ADMIN_POLL_TIMEOUT_MS });
      expect(await statusesOf(QUEUE_ADMIN_STUDENTS.raisedIn.loginId)).toEqual(['admitted']);
    } finally {
      await second.context.close();
    }
  } finally {
    await first.context.close();
  }
});

test('a waiting student gets the club list when the admin turns the queue off', async ({
  browser,
  page,
}) => {
  const student = QUEUE_ADMIN_STUDENTS.queueTurnedOff;
  // Someone holds the one place, so the student waits.
  const holder = await openClubs(browser, QUEUE_ADMIN_STUDENTS.holdsTurn);
  try {
    await expectAdmitted(holder);
    const waiting = await openClubs(browser, student);
    try {
      await expectWaitingFirst(waiting);

      const counts = await openRounds(page);
      const form = await editRound(page);
      await form.getByRole('checkbox', { name: 'ไม่มีคิว' }).check();
      await expect(form.getByText('เมื่อบันทึก รอบนี้จะไม่มีคิว')).toBeVisible();
      await saveOpenRound(form);
      await expect(counts.maxActive).toHaveText('ไม่มีคิว');

      // The round read says hasQueue false (or a heartbeat gets queue_off): the list, no card.
      await expect(waiting.page.getByRole('list', { name: CLUB_LIST })).toBeVisible({
        timeout: STUDENT_POLL_TIMEOUT_MS,
      });
      await expect(waiting.queue).toHaveCount(0);
      await expect(waiting.page.getByRole('alert')).toHaveCount(0);
      expect(waiting.loads()).toBe(0);

      // A seat without ever being let in.
      await waiting.page.getByRole('button', { name: `ลงชุมนุม ${clubLabel}` }).click();
      await waiting.page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'ยืนยัน ลงชุมนุม' })
        .click();
      await expect(waiting.page.getByText(`ลงชุมนุม ${clubLabel} เรียบร้อยแล้ว`)).toBeVisible();

      const seats = await queryDatabase<{ club_code: string }>(
        `SELECT c.club_code FROM registrations r
         JOIN clubs c ON c.id = r.club_id JOIN users u ON u.id = r.student_id
         WHERE u.login_id = $1`,
        [student.loginId],
      );
      expect(seats).toEqual([{ club_code: QUEUE_ADMIN_CLUB.code }]);
      // Its ticket was never admitted: left waiting, to expire on its own (Q4).
      expect(await statusesOf(student.loginId)).toEqual(['waiting']);
    } finally {
      await waiting.context.close();
    }
  } finally {
    await holder.context.close();
  }
});

test('a student browsing joins the queue once when the admin turns it back on', async ({
  browser,
  page,
}) => {
  const student = QUEUE_ADMIN_STUDENTS.queueTurnedOn;
  await setMaxActive(null);
  const browsing = await openClubs(browser, student);
  try {
    const joins: string[] = [];
    const heartbeats: string[] = [];
    browsing.page.on('request', (request) => {
      if (request.method() !== 'POST') return;
      const { pathname } = new URL(request.url());
      if (pathname === JOIN_PATH) joins.push(pathname);
      if (pathname === HEARTBEAT_PATH) heartbeats.push(pathname);
    });
    await expect(browsing.page.getByRole('list', { name: CLUB_LIST })).toBeVisible();
    await expect(browsing.queue).toHaveCount(0);

    const counts = await openRounds(page);
    await expect(counts.maxActive).toHaveText('ไม่มีคิว');
    const form = await editRound(page);
    await form.getByRole('checkbox', { name: 'ไม่มีคิว' }).uncheck();
    // The reset left no live ticket in the round, so the one place is the student's: admitted.
    await form.getByLabel('จำนวนคนเข้าเลือกพร้อมกันสูงสุด').fill('1');
    await expect(form.getByText('เมื่อบันทึก รอบนี้จะมีคิว')).toBeVisible();
    await saveOpenRound(form);
    await expect(counts.maxActive).toHaveText('1');

    await expectAdmitted(browsing, STUDENT_POLL_TIMEOUT_MS);
    expect(browsing.loads()).toBe(0);
    // A second join would answer the same live ticket and leave no second row, so the requests
    // are counted too, once heartbeats have followed the join for a while.
    await expect
      .poll(() => heartbeats.length, { timeout: STUDENT_POLL_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(2);
    expect(joins).toHaveLength(1);
    expect(await statusesOf(student.loginId)).toEqual(['admitted']);
  } finally {
    await browsing.context.close();
  }
});

test('a student keeps their turn on the result page and comes back to the list', async ({
  browser,
}) => {
  const student = QUEUE_ADMIN_STUDENTS.keepsTurn;
  const admitted = await openClubs(browser, student);
  try {
    const { page } = admitted;
    await expectAdmitted(admitted);
    const [ticket] = await ticketsOf(student.loginId);
    if (ticket === undefined) throw new Error('No ticket after being let in');

    await page
      .getByRole('navigation', { name: 'เมนูหลัก' })
      .getByRole('link', { name: 'ผลของฉัน', exact: true })
      .click();
    const note = page.getByRole('region', { name: QUEUE_CARD });
    await expect(note.getByRole('status')).toContainText('ถึงคิวของคุณแล้ว เลือกชุมนุมได้ถึง');

    // The note came from a read, which never touches last_seen_at. The clubs page stopped with
    // the visit, so a heartbeat sent after this point is the result page's own, and the value it
    // leaves is later than the one read here.
    const seenAt = (await ticketsOf(student.loginId))[0]?.last_seen_at.getTime();
    const heartbeat = await page.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname === HEARTBEAT_PATH,
      { timeout: STUDENT_POLL_TIMEOUT_MS },
    );
    expect((await heartbeat.response())?.status()).toBe(200);
    const [kept] = await ticketsOf(student.loginId);
    expect(kept).toMatchObject({ id: ticket.id, status: 'admitted' });
    expect(kept?.last_seen_at.getTime()).toBeGreaterThan(seenAt ?? Number.POSITIVE_INFINITY);

    // Back to the list on the same ticket, not at the back of the queue.
    await note.getByRole('link', { name: 'ไปเลือกชุมนุม' }).click();
    await expectAdmitted(admitted);
    await expect(
      page.getByRole('article', { name: QUEUE_ADMIN_CLUB.name, exact: true }),
    ).toBeVisible();
    expect(await ticketsOf(student.loginId)).toMatchObject([{ id: ticket.id, status: 'admitted' }]);
  } finally {
    await admitted.context.close();
  }
});
