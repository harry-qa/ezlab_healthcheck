import { defineConfig, devices } from '@playwright/test';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* CI에서 1회 재시도 — 스텝 단위 재시도(gotoWithRetry 등)를 통과한 FAIL만 남기기 위한 마지막 방어선.
     재시도 런이 report-status.json을 덮어쓰므로, 기록된 FAIL은 런 전체를 두 번 돌려도 실패한 것이다. */
  retries: process.env.CI ? 1 : 0,
  /* 헬스체크는 단일 test라 병렬 실행 여지가 없다 — 워커 1개로 고정(fullyParallel은 무의미해 제거). */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [['html', { open: process.env.CI ? 'never' : 'always' }]],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    // baseURL: 'http://localhost:3000',

    /* 헬스체크는 trace 불필요 (파일 크기 문제로 CI 배포 실패 방지) */
    trace: 'off',

    /* 로컬: 브라우저 창 열림 / CI: headless 실행 */
    headless: process.env.CI ? true : false,
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // 헬스체크는 Chromium 단일 브라우저로 충분 (Firefox/WebKit 제거)
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit',  use: { ...devices['Desktop Safari']  } },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});