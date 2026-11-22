import { test, expect } from '@playwright/test';

test.describe('Homepage', () => {
  test('renders dashboard heading', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
    await expect(h1).toHaveText('Dashboard');
  });

  test('has correct page title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Proser — AI Fiction Studio');
  });

  test('has correct meta description', async ({ page }) => {
    await page.goto('/');
    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute(
      'content',
      'An AI-native fiction writing studio for producing publisher-ready manuscripts.',
    );
  });

  test('uses dark theme', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveClass(/dark/);
  });

  test('shows sidebar navigation', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Sidebar should be visible with key nav items
    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible();
  });

  test('no console errors on load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Filter out expected warnings (NextAuth, etc.)
    const realErrors = errors.filter(
      (e) => !e.includes('next-auth') && !e.includes('Failed to fetch'),
    );
    expect(realErrors).toEqual([]);
  });

  test('returns 200 status', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('loads without JavaScript errors', async ({ page }) => {
    const jsErrors: Error[] = [];
    page.on('pageerror', (error) => jsErrors.push(error));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(jsErrors).toEqual([]);
  });
});
