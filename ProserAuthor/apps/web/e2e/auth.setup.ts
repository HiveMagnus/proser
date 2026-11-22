import { test as setup, expect } from '@playwright/test';
import path from 'path';

const authFile = path.join(__dirname, '.auth', 'user.json');
const username = process.env.PLAYWRIGHT_IAM_USERNAME;
const password = process.env.PLAYWRIGHT_IAM_PASSWORD;

if (!username || !password) {
  throw new Error(
    'Authenticated Playwright projects require PLAYWRIGHT_IAM_USERNAME and PLAYWRIGHT_IAM_PASSWORD.',
  );
}

setup('authenticate via IAM', async ({ page }) => {
  // Navigate to the sign-in page
  await page.goto('/auth/signin');
  await page.waitForLoadState('networkidle');

  // Fill in IAM credentials
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);

  // Submit the form — client-side signIn will POST to /api/auth then redirect
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for redirect away from the sign-in page after successful login.
  // The client-side signIn uses window.location.href, so we wait for any
  // non-auth URL (dashboard, mobile home, etc.)
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 30_000 });

  // Verify we're authenticated — some heading should be visible
  await expect(page.locator('h1, h2, h3').first()).toBeVisible({ timeout: 10_000 });

  // Save authentication state
  await page.context().storageState({ path: authFile });
});
