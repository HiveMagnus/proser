import { test, expect } from '@playwright/test';

/**
 * Auth flow tests — run in the 'unauthenticated' project BEFORE the auth
 * setup to avoid Next.js server-side page caching from authenticated requests.
 */
test.describe('Auth Flow', () => {
  test('sign-in page renders', async ({ page }) => {
    await page.goto('/auth/signin');
    await page.waitForLoadState('networkidle');
    const heading = page.locator('h1, h2, h3').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('unauthenticated user redirects to sign-in', async ({ page }) => {
    await page.goto('/plot');
    await page.waitForLoadState('networkidle');
    expect(page.url()).toMatch(/auth/);
  });

  test('sign-in page has username and password fields', async ({ page }) => {
    await page.goto('/auth/signin');
    await page.waitForLoadState('networkidle');

    await expect(page.getByLabel('Username')).toBeVisible({ timeout: 10000 });
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});
