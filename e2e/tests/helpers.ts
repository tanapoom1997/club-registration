import { env } from 'node:process';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import pg from 'pg';
import { DATABASE_URL_ENV } from '../fixtures.js';
import type { Account } from '../fixtures.js';

export const LOGIN_ID_LABEL = 'รหัสนักเรียน / รหัสผู้ใช้';
export const PASSWORD_LABEL = 'รหัสผ่าน';
// A student's home, where a login, the change of password and a refused admin page all lead: the
// club list (/student only redirects there).
export const STUDENT_LANDING = /\/student\/clubs$/;

export const submitLogin = async (page: Page, loginId: string, password: string): Promise<void> => {
  await page.goto('/login');
  await page.getByLabel(LOGIN_ID_LABEL).fill(loginId);
  await page.getByLabel(PASSWORD_LABEL, { exact: true }).fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
};

export const logIn = async (page: Page, account: Account, landing: RegExp): Promise<void> => {
  await submitLogin(page, account.loginId, account.password);
  await expect(page).toHaveURL(landing);
};

// What the browser's actions left in the database, read as its owner.
export const queryDatabase = async <Row extends pg.QueryResultRow>(
  sql: string,
  values: unknown[] = [],
): Promise<Row[]> => {
  const connectionString = env[DATABASE_URL_ENV];
  if (connectionString === undefined) throw new Error(`${DATABASE_URL_ENV} is not set`);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return (await client.query<Row>(sql, values)).rows;
  } finally {
    await client.end();
  }
};
