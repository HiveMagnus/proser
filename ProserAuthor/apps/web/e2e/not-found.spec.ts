import { test, expect } from '@playwright/test';

test.describe('404 / Not Found', () => {
  test('unknown route returns 404 status', async ({ page }) => {
    const response = await page.goto('/this-page-does-not-exist');
    expect(response?.status()).toBe(404);
  });

  test('404 page still renders HTML', async ({ page }) => {
    await page.goto('/this-page-does-not-exist');
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });
});
