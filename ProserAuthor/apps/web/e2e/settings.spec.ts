import { test, expect, type Page } from '@playwright/test';

async function openWritingTab(page: Page) {
  await page.getByRole('tab', { name: /Writing/ }).click();
  await expect(page.getByText('Writing Preferences')).toBeVisible({ timeout: 5000 });
}

async function openAiTab(page: Page) {
  await page.getByRole('tab', { name: /AI Config/ }).click();
  await expect(page.getByText('Inference Connection')).toBeVisible({ timeout: 5000 });
}

// ── Settings Page ────────────────────────────────────────
test.describe('Settings — Profile Tab', () => {
  test('displays profile form with editable fields', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('User Profile')).toBeVisible();

    // Display name is editable
    const nameInput = page.getByPlaceholder('Your name');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Test Author');
    await expect(nameInput).toHaveValue('Test Author');

    // Email is disabled
    const emailInput = page.getByPlaceholder('you@example.com');
    await expect(emailInput).toBeDisabled();
  });

  test('profile saves and persists after reload', async ({ page }) => {
    const suffix = Date.now().toString().slice(-6);
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    const displayName = `Test Author ${suffix}`;
    const nameInput = page.getByPlaceholder('Your name');
    await nameInput.fill(displayName);

    const saveBtn = page.getByRole('button', { name: /Save Profile/ });
    await saveBtn.click();
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 3000 });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByPlaceholder('Your name')).toHaveValue(displayName);
  });
});

test.describe('Settings — AI Config Tab', () => {
  test.describe.configure({ mode: 'serial' });

  test('switches to AI Config tab and shows connection settings', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    await page.getByRole('tab', { name: /AI Config/ }).click();
    await expect(page.getByText('Inference Connection')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Cloud API Keys')).toBeVisible();
  });

  test('inference URL and model are read-only runtime status', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: /AI Config/ }).click();

    const urlInput = page.getByPlaceholder('http://127.0.0.1:8000');
    await expect(urlInput).toBeVisible();
    await expect(urlInput).toBeDisabled();
    await expect(urlInput).toHaveValue(/^https?:\/\/[^ ]+$/);

    await expect(page.getByText('Default Model')).toBeVisible();
    await expect(page.getByText('Default Model').locator('..').locator('input')).toBeDisabled();
    await expect(page.getByRole('button', { name: /Save Inference Settings/ })).toHaveCount(0);
  });

  test('test connection button has loading state', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: /AI Config/ }).click();

    const testBtn = page.getByRole('button', { name: /Test Connection/ });
    await expect(testBtn).toBeVisible();
    await testBtn.click();

    // Button should be disabled during test
    await expect(testBtn).toBeDisabled({ timeout: 2000 });
  });

  test('API key inputs accept values', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: /AI Config/ }).click();

    const openaiInput = page.getByPlaceholder('sk-...');
    await openaiInput.fill('sk-test-key');
    await expect(openaiInput).toHaveValue('sk-test-key');

    const anthropicInput = page.getByPlaceholder('sk-ant-...');
    await anthropicInput.fill('sk-ant-test-key');
    await expect(anthropicInput).toHaveValue('sk-ant-test-key');
  });

  test('cloud key settings persist after reload', async ({ page }) => {
    const suffix = Date.now().toString().slice(-6);
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await openAiTab(page);

    const openaiValue = `sk-test-${suffix}`;
    const anthropicValue = `sk-ant-test-${suffix}`;
    await page.getByPlaceholder('sk-...').fill(openaiValue);
    await page.getByPlaceholder('sk-ant-...').fill(anthropicValue);
    await page.getByRole('button', { name: /Save Keys/ }).click();
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 3000 });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await openAiTab(page);

    await expect(page.getByPlaceholder('sk-...')).toHaveValue(openaiValue);
    await expect(page.getByPlaceholder('sk-ant-...')).toHaveValue(anthropicValue);
  });
});

test.describe('Settings — Writing Tab', () => {
  test('switches to Writing tab and shows preference fields', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    await page.getByRole('tab', { name: /Writing/ }).click();
    await expect(page.getByText('Writing Preferences')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Default Genre', { exact: true })).toBeVisible();
    await expect(page.getByText('Target Audience', { exact: true })).toBeVisible();
  });

  test('genre select works', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: /Writing/ }).click();

    // Click genre trigger
    const genreTrigger = page.getByRole('combobox').first();
    await genreTrigger.click();
    await page.getByRole('option', { name: 'Sci-Fi' }).click();
    await expect(genreTrigger).toContainText('Sci-Fi');
  });

  test('audience select works', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: /Writing/ }).click();

    // Click audience trigger
    const audienceTrigger = page.getByRole('combobox').nth(1);
    await audienceTrigger.click();
    await page.getByRole('option', { name: 'Young Adult' }).click();
    await expect(audienceTrigger).toContainText('Young Adult');
  });

  test('writing style textarea accepts input', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: /Writing/ }).click();

    const textarea = page.getByPlaceholder('Describe your preferred writing style...');
    await textarea.fill('Lyrical prose with vivid imagery');
    await expect(textarea).toHaveValue('Lyrical prose with vivid imagery');
  });

  test('writing preferences persist after reload', async ({ page }) => {
    const suffix = Date.now().toString().slice(-6);
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await openWritingTab(page);

    const genreTrigger = page.getByRole('combobox').first();
    await genreTrigger.click();
    await page.getByRole('option', { name: 'Fantasy' }).click();

    const audienceTrigger = page.getByRole('combobox').nth(1);
    await audienceTrigger.click();
    await page.getByRole('option', { name: 'Adult', exact: true }).click();

    const styleValue = `Lyrical prose ${suffix}`;
    await page.getByPlaceholder('Describe your preferred writing style...').fill(styleValue);

    const saveBtn = page.getByRole('button', { name: /Save Preferences/ });
    await saveBtn.click();
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 3000 });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await openWritingTab(page);

    await expect(page.getByRole('combobox').first()).toContainText('Fantasy');
    await expect(page.getByRole('combobox').nth(1)).toContainText('Adult');
    await expect(page.getByPlaceholder('Describe your preferred writing style...')).toHaveValue(
      styleValue,
    );
  });
});
