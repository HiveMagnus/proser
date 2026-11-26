import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const authFile = path.join(__dirname, 'e2e', '.auth', 'user.json');

export default defineConfig({
  testDir: './e2e',
  // The authenticated projects intentionally share one disposable account.
  // Serial execution prevents cross-test data races and dev-server chunk churn.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    trace: 'off',
    ignoreHTTPSErrors: process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS === 'true',
  },
  projects: [
    // Unauthenticated tests — run BEFORE setup to avoid server-side caching
    {
      name: 'unauthenticated',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /auth-flow\.spec\.ts/,
    },
    {
      name: 'factory-proxy',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /factory-proxy\.spec\.ts/,
    },
    // Auth setup — runs after unauthenticated tests, saves session state
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      dependencies: ['unauthenticated'],
    },
    {
      name: 'authenticated',
      use: {
        ...devices['Desktop Chrome'],
        storageState: authFile,
      },
      dependencies: ['setup'],
      testMatch: /release-authenticated\.spec\.ts/,
    },
    // Tests that require authentication
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: authFile,
      },
      dependencies: ['setup'],
      testIgnore: [
        /auth\.setup\.ts/,
        /auth-flow\.spec\.ts/,
        /factory-proxy\.spec\.ts/,
        /production-smoke\.spec\.ts/,
        /release-authenticated\.spec\.ts/,
        /ui-improvements\.spec\.ts/,
        /mobile-e2e\.spec\.ts/,
        /mobile-mode\.spec\.ts/,
      ],
    },
    // Mobile Chrome — authenticated tests for /m site on phone-class Chromium
    {
      name: 'mobile-chrome',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        storageState: authFile,
      },
      dependencies: ['setup'],
      testMatch: /mobile-e2e\.spec\.ts/,
    },
    // Mobile Safari — authenticated tests for /m site on WebKit (iOS Safari)
    {
      name: 'mobile-safari',
      use: {
        ...devices['iPhone 13'],
        storageState: authFile,
      },
      dependencies: ['setup'],
      testMatch: /mobile-e2e\.spec\.ts/,
    },
    // Smoke tests — no auth required (pages render even without login when auth secret missing)
    {
      name: 'smoke',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /production-smoke\.spec\.ts/,
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'pnpm --filter @hivemagnus/proser-web dev',
        env: {
          ...process.env,
          AUTH_SECRET:
            process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || 'playwright-secret',
          NEXTAUTH_SECRET:
            process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || 'playwright-secret',
          FACTORY_AUTH_SECRET: process.env.FACTORY_AUTH_SECRET || 'playwright-factory-secret',
          FACTORY_URL: process.env.FACTORY_URL || 'http://127.0.0.1:3001',
          LOCAL_AUTH_ENABLED: process.env.LOCAL_AUTH_ENABLED || 'true',
          LOCAL_AUTH_USERNAME: process.env.PLAYWRIGHT_IAM_USERNAME || '',
          LOCAL_AUTH_PASSWORD: process.env.PLAYWRIGHT_IAM_PASSWORD || '',
        },
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
