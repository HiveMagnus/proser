import { expect, test } from '@playwright/test';

test.describe('Production smoke', () => {
  test('unauthenticated root request reaches the sign-in flow', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(/\/auth\/signin/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 10000 });
  });

  test('sign-in page renders the credential fields', async ({ page }) => {
    const response = await page.goto('/auth/signin');
    expect(response?.ok()).toBeTruthy();

    await expect(page.getByLabel('Username')).toBeVisible({ timeout: 10000 });
    await expect(page.getByLabel('Password')).toBeVisible();
  });
});
