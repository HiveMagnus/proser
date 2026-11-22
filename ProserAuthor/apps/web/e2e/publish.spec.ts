import { test, expect } from '@playwright/test';

// ── Publish Center ───────────────────────────────────────
test.describe('Publish — Export Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/publish');
    await page.waitForLoadState('networkidle');
  });

  test('publish page loads with export formats', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Publish Center' })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText('EPUB')).toBeVisible();
    await expect(page.getByText('PDF')).toBeVisible();
    await expect(page.getByText('DOCX')).toBeVisible();
    await expect(page.getByText('Markdown')).toBeVisible();
    await expect(page.getByText('HTML')).toBeVisible();
  });

  test('selecting a format shows export options', async ({ page }) => {
    // Export options should NOT be visible before selection
    await expect(page.getByText('Export Options')).not.toBeVisible();

    // Click EPUB format card
    await page.getByText('EPUB').click();

    // Export options should now appear
    await expect(page.getByText('Export Options')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Include metadata')).toBeVisible();
    await expect(page.getByText('Include codex appendix')).toBeVisible();

    // Export button should appear
    await expect(page.getByRole('button', { name: /Export as EPUB/ })).toBeVisible();
  });

  test('export options checkboxes toggle', async ({ page }) => {
    await page.getByText('EPUB').click();

    // "Include metadata" checkbox should be checked by default
    const metadataCheckbox = page.locator('input[type="checkbox"]').first();
    await expect(metadataCheckbox).toBeChecked();

    // Toggle it off
    await metadataCheckbox.uncheck();
    await expect(metadataCheckbox).not.toBeChecked();
  });

  test('switching format cards highlights the selected one', async ({ page }) => {
    // Click PDF
    await page.getByText('PDF').first().click();
    await expect(page.getByRole('button', { name: /Export as PDF/ })).toBeVisible();

    // Now click DOCX
    await page.getByText('DOCX').first().click();
    await expect(page.getByRole('button', { name: /Export as DOCX/ })).toBeVisible();
  });

  test('export button shows loading state on click', async ({ page }) => {
    await page.getByText('EPUB').click();

    const exportBtn = page.getByRole('button', { name: /Export as EPUB/ });
    await exportBtn.click();

    // Button should show "Exporting…" state (even briefly)
    await expect(page.getByRole('button', { name: /Exporting/ })).toBeVisible({ timeout: 2000 });
  });
});

// ── Synopsis Tab ─────────────────────────────────────────
test.describe('Publish — Synopsis Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/publish');
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: /Synopsis/ }).click();
  });

  test('synopsis tab loads with existing text', async ({ page }) => {
    const textarea = page.getByPlaceholder('Write or generate your synopsis here...');
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await expect(textarea).not.toBeEmpty();
  });

  test('synopsis textarea is editable', async ({ page }) => {
    const textarea = page.getByPlaceholder('Write or generate your synopsis here...');
    await textarea.fill('A completely new synopsis text.');
    await expect(textarea).toHaveValue('A completely new synopsis text.');
  });

  test('save synopsis button shows saved feedback', async ({ page }) => {
    const saveBtn = page.getByRole('button', { name: /Save Synopsis/ });
    await saveBtn.click();
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 3000 });
  });

  test('AI generate button has loading state', async ({ page }) => {
    const genBtn = page.getByRole('button', { name: /AI Generate/ });
    await genBtn.click();
    // Should show loading state
    await expect(page.getByRole('button', { name: /Generating/ })).toBeVisible({ timeout: 2000 });
  });
});

// ── History Tab ──────────────────────────────────────────
test.describe('Publish — History Tab', () => {
  test('history tab shows export entries', async ({ page }) => {
    await page.goto('/publish');
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: /History/ }).click();

    await expect(page.getByText('EPUB')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('1.2 MB')).toBeVisible();
  });
});
