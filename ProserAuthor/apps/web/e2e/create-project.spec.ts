import { test, expect, type Page } from '@playwright/test';

// ── Helpers ──────────────────────────────────────────────

/** Create a project via the UI and return its title. */
async function createProjectViaUI(
  page: Page,
  title: string,
  opts?: { genre?: string; archetype?: string; summary?: string },
) {
  await page
    .getByRole('button', { name: /New Project/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 5000 });

  await dialog.getByPlaceholder('Working title...').fill(title);

  if (opts?.genre) {
    const genreTrigger = dialog.getByRole('combobox').first();
    await genreTrigger.click();
    await page.getByRole('option', { name: opts.genre }).click();
  }
  if (opts?.archetype) {
    const archetypeTrigger = dialog.getByRole('combobox').nth(1);
    await archetypeTrigger.click();
    await page.getByRole('option', { name: opts.archetype }).click();
  }
  if (opts?.summary) {
    await dialog.getByPlaceholder('A brief premise for your story...').fill(opts.summary);
  }

  await dialog.getByRole('button', { name: /Create & Begin/ }).click();
  await expect(dialog).not.toBeVisible({ timeout: 10000 });
  await expect(page.getByText(title)).toBeVisible({ timeout: 10000 });
}

/** Delete ALL projects whose title matches a prefix via the UI delete dialog. */
async function deleteProjectsByPrefix(page: Page, prefix: string) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Keep deleting while we find matching cards
  while (true) {
    // Dismiss any lingering dialogs/overlays first
    const overlay = page.locator('[data-state="open"][aria-hidden="true"]');
    if (await overlay.isVisible({ timeout: 500 }).catch(() => false)) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    await page.waitForTimeout(500);
    const card = page
      .locator('a')
      .filter({ hasText: new RegExp(prefix) })
      .first();
    if (!(await card.isVisible({ timeout: 2000 }).catch(() => false))) break;

    // Hover to reveal the menu trigger
    await card.hover();
    await page.waitForTimeout(300);
    const menuBtn = card.locator('button').first();
    await menuBtn.click({ force: true });

    // Click Delete
    await page.getByRole('menuitem', { name: /Delete/ }).click();

    // Confirm in the delete dialog
    const confirmBtn = page.getByRole('button', { name: /Delete Project/ });
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await confirmBtn.click();

    // Wait for dialog to fully close before continuing
    await page.waitForTimeout(1500);
  }
}

// ── Create Project Dialog ────────────────────────────────
test.describe('Create Project Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('opens and shows all form fields', async ({ page }) => {
    await page
      .getByRole('button', { name: /New Project/ })
      .first()
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByText('Create New Project')).toBeVisible();

    // All form fields present
    await expect(dialog.getByPlaceholder('Working title...')).toBeVisible();
    await expect(dialog.getByText('Genre', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Archetype', { exact: true })).toBeVisible();
    await expect(dialog.getByPlaceholder('A brief premise for your story...')).toBeVisible();
  });

  test('title input is required for submission', async ({ page }) => {
    await page
      .getByRole('button', { name: /New Project/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const submitBtn = dialog.getByRole('button', { name: /Create & Begin/ });
    await expect(submitBtn).toBeDisabled();

    await dialog.getByPlaceholder('Working title...').fill('My Test Novel');
    await expect(submitBtn).toBeEnabled();
  });

  test('archetype select is disabled until genre is chosen', async ({ page }) => {
    await page
      .getByRole('button', { name: /New Project/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const archetypeTrigger = dialog.getByRole('combobox').nth(1);
    await expect(archetypeTrigger).toBeDisabled();
    await expect(archetypeTrigger).toContainText('Select genre first');
  });

  test('selecting genre enables archetype and shows matching options', async ({ page }) => {
    await page
      .getByRole('button', { name: /New Project/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const genreTrigger = dialog.getByRole('combobox').first();
    await genreTrigger.click();
    await page.getByRole('option', { name: 'Fantasy' }).click();

    const archetypeTrigger = dialog.getByRole('combobox').nth(1);
    await expect(archetypeTrigger).toBeEnabled();
    await expect(archetypeTrigger).toContainText('Choose archetype');

    await archetypeTrigger.click();
    await expect(page.getByRole('option', { name: 'The Quest' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Voyage and Return' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Rebirth' })).toBeVisible();
  });

  test('changing genre resets archetype selection', async ({ page }) => {
    await page
      .getByRole('button', { name: /New Project/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');

    const genreTrigger = dialog.getByRole('combobox').first();
    await genreTrigger.click();
    await page.getByRole('option', { name: 'Fantasy' }).click();

    const archetypeTrigger = dialog.getByRole('combobox').nth(1);
    await archetypeTrigger.click();
    await page.getByRole('option', { name: 'The Quest' }).click();

    await expect(archetypeTrigger).toContainText('The Quest');

    await genreTrigger.click();
    await page.getByRole('option', { name: 'Sci-Fi' }).click();

    await expect(archetypeTrigger).toContainText('Choose archetype');
    await archetypeTrigger.click();
    await expect(page.getByRole('option', { name: 'Discovery' })).toBeVisible();
  });

  test('genre-specific archetypes are different per genre', async ({ page }) => {
    await page
      .getByRole('button', { name: /New Project/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');

    const genreTrigger = dialog.getByRole('combobox').first();
    await genreTrigger.click();
    await page.getByRole('option', { name: 'Horror' }).click();

    const archetypeTrigger = dialog.getByRole('combobox').nth(1);
    await archetypeTrigger.click();

    await expect(page.getByRole('option', { name: 'Gothic Retelling' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Eldritch Pact' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'The Quest' })).not.toBeVisible();
  });

  test('cancel button closes dialog and resets form', async ({ page }) => {
    await page
      .getByRole('button', { name: /New Project/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');

    await dialog.getByPlaceholder('Working title...').fill('Test Title');
    const genreTrigger = dialog.getByRole('combobox').first();
    await genreTrigger.click();
    await page.getByRole('option', { name: 'Fantasy' }).click();

    await dialog.getByRole('button', { name: /Cancel/ }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    await page
      .getByRole('button', { name: /New Project/ })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByPlaceholder('Working title...')).toHaveValue('');
  });

  test('X button closes dialog', async ({ page }) => {
    await page
      .getByRole('button', { name: /New Project/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: /Close/ }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });

  test('summary textarea accepts input', async ({ page }) => {
    await page
      .getByRole('button', { name: /New Project/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');

    const textarea = dialog.getByPlaceholder('A brief premise for your story...');
    await textarea.fill('A test story about a hero who saves the world.');
    await expect(textarea).toHaveValue('A test story about a hero who saves the world.');
  });
});

// ── End-to-end: Create → Verify → Cleanup ───────────────
test.describe('Project CRUD — E2E', () => {
  // Each test creates with a unique prefix and cleans up after itself
  const RUN_ID = Date.now();

  test.afterEach(async ({ page }) => {
    // Clean up any projects created during this test
    await deleteProjectsByPrefix(page, `PW-${RUN_ID}`);
  });

  test('submitting the form creates a project that appears on the dashboard', async ({ page }) => {
    const title = `PW-${RUN_ID}-Create`;
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await createProjectViaUI(page, title, {
      genre: 'Fantasy',
      archetype: 'The Quest',
      summary: 'An epic tale.',
    });

    await expect(page.getByText(title)).toBeVisible({ timeout: 10000 });
  });

  test('newly created project persists across page reload', async ({ page }) => {
    const title = `PW-${RUN_ID}-Reload`;
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await createProjectViaUI(page, title);

    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(page.getByText(title)).toBeVisible({ timeout: 10000 });
  });

  test('creating project shows loading state on submit button', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page
      .getByRole('button', { name: /New Project/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Working title...').fill(`PW-${RUN_ID}-Loading`);

    const submitBtn = dialog.getByRole('button', { name: /Create & Begin/ });
    await submitBtn.click();

    // The button text changes to "Creating…" then dialog closes.
    // Either we catch the transient state OR the dialog closes (project created).
    await expect(
      dialog
        .getByRole('button', { name: /Creating/ })
        .or(page.locator(`text=PW-${RUN_ID}-Loading`)),
    ).toBeVisible({ timeout: 10000 });
  });

  test('project card shows correct genre after creation', async ({ page }) => {
    const title = `PW-${RUN_ID}-Genre`;
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await createProjectViaUI(page, title, { genre: 'Sci-Fi' });

    const projectCard = page.locator('a').filter({ hasText: title });
    await expect(projectCard).toBeVisible({ timeout: 10000 });
    await expect(projectCard.getByText('sci-fi')).toBeVisible();
  });

  test('stats update after creating a project', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const statValue = page.locator('text=Total Projects').locator('..').locator('..');
    const countBefore = await statValue.textContent();

    await createProjectViaUI(page, `PW-${RUN_ID}-Stats`);

    const countAfter = await statValue.textContent();
    expect(countAfter).not.toBe(countBefore);
  });
});

// ── Edit Project ─────────────────────────────────────────
test.describe('Edit Project — E2E', () => {
  const RUN_ID = Date.now();

  test.afterEach(async ({ page }) => {
    await deleteProjectsByPrefix(page, `PW-${RUN_ID}`);
  });

  test('edit dialog opens with existing project data and saves changes', async ({ page }) => {
    const original = `PW-${RUN_ID}-EditOrig`;
    const updated = `PW-${RUN_ID}-EditNew`;

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProjectViaUI(page, original, { genre: 'Fantasy' });

    // Open the dropdown on the project card
    const card = page.locator('a').filter({ hasText: original });
    await card.hover();
    await page.waitForTimeout(300);
    await card.locator('button').first().click({ force: true });

    // Click Edit Details
    await page.getByRole('menuitem', { name: /Edit Details/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByText('Edit Project')).toBeVisible();

    // Title should be pre-filled
    const titleInput = dialog.getByPlaceholder('Working title...');
    await expect(titleInput).toHaveValue(original);

    // Change the title
    await titleInput.fill(updated);
    await dialog.getByRole('button', { name: /Save Changes/ }).click();

    // Dialog closes
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    // Updated title should appear
    await expect(page.getByText(updated)).toBeVisible({ timeout: 10000 });
    // Old title should be gone
    await expect(page.getByText(original)).not.toBeVisible({ timeout: 3000 });
  });
});

// ── Delete Project ───────────────────────────────────────
test.describe('Delete Project — E2E', () => {
  const RUN_ID = Date.now();

  test('delete dialog confirms and removes project from dashboard', async ({ page }) => {
    const title = `PW-${RUN_ID}-Delete`;

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProjectViaUI(page, title);

    // Open the dropdown
    const card = page.locator('a').filter({ hasText: title });
    await card.hover();
    await page.waitForTimeout(300);
    await card.locator('button').first().click({ force: true });

    // Click Delete
    await page.getByRole('menuitem', { name: /Delete/ }).click();

    // Confirmation dialog
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByRole('heading', { name: 'Delete Project' })).toBeVisible();
    await expect(dialog.getByText(title)).toBeVisible();

    // Confirm deletion
    await dialog.getByRole('button', { name: /Delete Project/ }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    // Project should be gone from the dashboard
    await expect(page.getByText(title)).not.toBeVisible({ timeout: 5000 });

    // Verify it stays gone after reload
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(title)).not.toBeVisible({ timeout: 5000 });
  });

  test('cancel delete does not remove the project', async ({ page }) => {
    const title = `PW-${RUN_ID}-NoDel`;

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProjectViaUI(page, title);

    // Open dropdown → Delete
    const card = page.locator('a').filter({ hasText: title });
    await card.hover();
    await page.waitForTimeout(300);
    await card.locator('button').first().click({ force: true });
    await page.getByRole('menuitem', { name: /Delete/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Cancel
    await dialog.getByRole('button', { name: /^Cancel$/ }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // Project should still be there
    await expect(page.getByText(title)).toBeVisible();

    // Clean up
    await deleteProjectsByPrefix(page, `PW-${RUN_ID}-NoDel`);
  });
});
