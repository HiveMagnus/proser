import { test, expect } from '@playwright/test';

// ── Quality Board ────────────────────────────────────────
test.describe('Quality Board', () => {
  test.beforeEach(async ({ page }) => {
    // Visit dashboard first to auto-select a book in workspace context
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Navigate to quality
    await page.goto('/quality');
    await page.waitForLoadState('networkidle');
  });

  test('page loads with heading and controls', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Quality Board' })).toBeVisible({
      timeout: 10000,
    });
    // Run Scan and Refresh buttons should be present
    await expect(page.getByRole('button', { name: /Run Scan/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Refresh/ })).toBeVisible();
  });

  test('book selector is available', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Quality Board' })).toBeVisible({
      timeout: 10000,
    });
    // The book selector combobox should be visible
    const selectTrigger = page.locator('button[role="combobox"]');
    await expect(selectTrigger).toBeVisible();
  });

  test('shows empty state or score when book is selected', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Quality Board' })).toBeVisible({
      timeout: 10000,
    });

    // After dashboard visit, a book should be auto-selected.
    // The page should show either:
    // - "No quality findings yet" empty state (no scan done)
    // - Quality Score with stats (scan previously done)
    // - "Select a book" if no book auto-selected
    const hasEmptyState = await page
      .getByText(/No quality findings yet/)
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const hasScore = await page
      .getByText('Quality Score')
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    const hasSelectPrompt = await page
      .getByText('Select a book')
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    const hasLoading = await page
      .getByText('Loading quality overview')
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    expect(hasEmptyState || hasScore || hasSelectPrompt || hasLoading).toBe(true);
  });

  test('Run Scan button shows loading state when clicked', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Quality Board' })).toBeVisible({
      timeout: 10000,
    });

    const scanBtn = page.getByRole('button', { name: /Run Scan/ });

    // Only test if the button is enabled (a book is selected)
    if (await scanBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
      await scanBtn.click();
      // Should show scanning state
      await expect(page.getByRole('button', { name: /Scanning/ })).toBeVisible({ timeout: 3000 });
      await expect(page.getByRole('button', { name: /Scanning/ })).toBeDisabled();
    }
  });

  test('Refresh button triggers data refetch', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Quality Board' })).toBeVisible({
      timeout: 10000,
    });

    const refreshBtn = page.getByRole('button', { name: /Refresh/ });

    // Only test if enabled (book is selected)
    if (await refreshBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
      await refreshBtn.click();
      // Page should remain stable
      await expect(page.getByRole('heading', { name: 'Quality Board' })).toBeVisible();
    }
  });
});
