import { test, expect } from '@playwright/test';

test.describe('Accessibility Basics', () => {
  test('html has lang attribute', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', 'en');
  });

  test('page has exactly one h1', async ({ page }) => {
    await page.goto('/');
    const headings = page.locator('h1');
    expect(await headings.count()).toBe(1);
  });

  test('viewport meta tag exists', async ({ page }) => {
    await page.goto('/');
    const viewport = page.locator('meta[name="viewport"]');
    await expect(viewport).toHaveAttribute('content', /width=device-width/);
  });
});

test.describe('Responsive Layout', () => {
  test('homepage renders on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
    await expect(h1).toHaveText('Dashboard');
  });

  test('homepage renders on tablet viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
  });

  test('homepage renders on wide desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
  });
});

test.describe('Performance', () => {
  test('homepage loads within 5 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto('/', { waitUntil: 'networkidle' });
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(5000);
  });

  test('no failed network requests on homepage', async ({ page }) => {
    const failedRequests: string[] = [];
    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.method()} ${req.url()} - ${req.failure()?.errorText}`);
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    expect(failedRequests).toEqual([]);
  });
});
