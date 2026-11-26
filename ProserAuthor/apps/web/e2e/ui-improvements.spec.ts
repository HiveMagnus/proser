import { test, expect } from '@playwright/test';

test.describe('UI Improvement Plan – Page Navigation', () => {
  test('dashboard loads with heading', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10000 });
  });

  test('plot page loads', async ({ page }) => {
    await page.goto('/plot');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Plot Studio' })).toBeVisible({
      timeout: 10000,
    });
  });

  test('continuity page loads', async ({ page }) => {
    await page.goto('/continuity');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /continuity/i })).toBeVisible({
      timeout: 10000,
    });
  });

  test('publish page loads', async ({ page }) => {
    await page.goto('/publish');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /publish/i })).toBeVisible({ timeout: 10000 });
  });

  test('quality page loads', async ({ page }) => {
    await page.goto('/quality');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /quality/i })).toBeVisible({ timeout: 10000 });
  });

  test('bible page loads', async ({ page }) => {
    await page.goto('/bible');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /story bible/i })).toBeVisible({
      timeout: 10000,
    });
  });

  test('manuscript page loads', async ({ page }) => {
    await page.goto('/manuscript');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /ProserFactory Authoring/i })).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe('UI Improvement Plan – Sidebar Navigation', () => {
  test('sidebar has links to all surfaces', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const nav = page.locator('nav');
    await expect(nav.getByText('Manuscript')).toBeVisible({ timeout: 10000 });
    await expect(nav.getByText('Plot')).toBeVisible();
    await expect(nav.getByText('Continuity')).toBeVisible();
    await expect(nav.getByText('Story Bible')).toBeVisible();
  });

  test('clicking sidebar nav changes page', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const nav = page.locator('nav');
    await nav.getByText('Plot').click();
    await expect(page).toHaveURL(/\/plot/);
    await expect(page.getByRole('heading', { name: 'Plot Studio' })).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe('UI Improvement Plan – Mobile Responsive', () => {
  test('dashboard is usable on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10000 });
  });

  test('plot page is usable on tablet viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/plot');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Plot Studio' })).toBeVisible({
      timeout: 10000,
    });
  });
});
