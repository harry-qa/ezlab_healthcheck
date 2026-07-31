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
  /* 전체 재시도 없음. 예전엔 CI에서 1회 재시도로 오탐을 걸렀는데, 그러면 오류 1건 때문에
     9개 STEP이 통째로 다시 돌아 서버가 불안정한 시점에 요청이 두 배가 됐다(예산 가드도
     시도별로 초기화돼 최악 8.5분 × 2회). 오탐 방어는 두 겹으로 대체한다.
       1) STEP 단위 재시도(gotoWithRetry / refetchWithRetry)가 단발 hiccup을 이미 흡수한다.
       2) report-status.json의 failFingerprints로 '같은 장애가 연속인지'를 판별해
          서로 다른 단발 오류 두 개가 연속 장애로 묶이는 것을 막는다(notify_slack.py). */
  retries: 0,
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