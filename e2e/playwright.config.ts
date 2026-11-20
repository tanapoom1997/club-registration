import { env } from 'node:process';
import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './fixtures.js';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  outputDir: './test-results/artifacts',
  // One shared stack and a handful of scenarios: running them one at a time keeps them readable
  // and keeps the per-account login rate limit far away.
  workers: 1,
  fullyParallel: false,
  forbidOnly: env.CI !== undefined,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL: WEB_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    // Recording every test costs CPU on a shared runner; turn on with --trace on to debug.
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
