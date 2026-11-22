import { test, expect } from '@playwright/test';

// ── Continuity Radar ─────────────────────────────────────
test.describe('Continuity Radar', () => {
  test.beforeEach(async ({ page }) => {
    // Visit dashboard first to auto-select a book in workspace context
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.goto('/continuity');
    await page.waitForLoadState('networkidle');
  });

  test('page loads with heading and stats', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Continuity Radar' })).toBeVisible({
      timeout: 10000,
    });
    // Stats cards or empty state should be visible
    const hasStats = await page
      .getByText('Critical')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    const hasNoBook = await page
      .getByText(/No book selected/)
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    expect(hasStats || hasNoBook).toBe(true);
  });

  test('severity tabs are present and clickable', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Continuity Radar' })).toBeVisible({
      timeout: 10000,
    });

    // Only test tabs if a book is selected (tabs render after content loads)
    const tabList = page.getByRole('tablist');
    if (await tabList.isVisible({ timeout: 5000 }).catch(() => false)) {
      const allTab = page.getByRole('tab', { name: /^All/ });
      const criticalTab = page.getByRole('tab', { name: /Critical/ });

      await expect(allTab).toBeVisible();
      await expect(criticalTab).toBeVisible();

      await criticalTab.click();
      await expect(page.getByRole('tabpanel')).toBeVisible();
    }
  });

  test('Run Scan button shows loading state', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Continuity Radar' })).toBeVisible({
      timeout: 10000,
    });

    const scanBtn = page.getByRole('button', { name: /Run Scan/ });
    await expect(scanBtn).toBeVisible();

    // Only click if enabled (book is selected)
    if (await scanBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
      await scanBtn.click();
      await expect(page.getByRole('button', { name: /Scanning/ })).toBeVisible({ timeout: 3000 });
      await expect(page.getByRole('button', { name: /Scanning/ })).toBeDisabled();
    }
  });

  test('tab panel shows issues or empty state', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Continuity Radar' })).toBeVisible({
      timeout: 10000,
    });

    // Tab panel or empty state should be visible
    const tabPanel = page.getByRole('tabpanel');
    const hasTabPanel = await tabPanel.isVisible({ timeout: 5000 }).catch(() => false);
    const hasEmptyState = await page
      .getByText(/no.*issue|run.*scan|no.*book/i)
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    expect(hasTabPanel || hasEmptyState).toBe(true);
  });

  test('issue cards expand when clicked', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Continuity Radar' })).toBeVisible({
      timeout: 10000,
    });

    const tabPanel = page.getByRole('tabpanel');
    const firstButton = tabPanel.getByRole('button').first();

    // Only test expansion if issues exist
    if (await firstButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstButton.click();
      // After expanding, should see either suggestion, confidence, or resolve button
      const hasDetails = await page
        .getByRole('button', { name: /Mark Resolved|Unresolve/ })
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      const hasConfidence = await page
        .getByText(/%/)
        .first()
        .isVisible({ timeout: 2000 })
        .catch(() => false);
      expect(hasDetails || hasConfidence).toBe(true);
    }
  });
});
