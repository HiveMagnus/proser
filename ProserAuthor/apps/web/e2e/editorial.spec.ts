import { expect, test } from '@playwright/test';

test('authenticated editorial desktop and Quality Lab surfaces load live evidence', async ({
  page,
}) => {
  const passResponse = page.waitForResponse(
    (response) => response.url().includes('/api/editorial/pass-packs') && response.status() === 200,
  );
  await page.goto('/editorial');
  await expect(page.getByRole('heading', { name: /Edit toward evidence/i })).toBeVisible();
  await expect(page.getByText('Revision folio').first()).toBeVisible();
  await expect(page.getByText(/No checkpoint is created/i)).toBeVisible();
  const passes = await (await passResponse).json();
  expect(passes.success).toBe(true);
  expect(passes.data).toHaveLength(8);

  await page.getByRole('link', { name: /Quality Lab/i }).click();
  await expect(page).toHaveURL(/\/editorial\/quality-lab$/);
  await expect(page.getByRole('heading', { name: 'Quality Lab' })).toBeVisible();
  await expect(page.getByText('Hard invariants').first()).toBeVisible();
});

test('authenticated mobile editorial folio is reachable', async ({ page }) => {
  await page.goto('/m/editorial');
  await expect(page.getByRole('heading', { name: 'Editorial' })).toBeVisible();
  await expect(page.getByText('Revision folio').first()).toBeVisible();
  await expect(page.getByText(/No approval queue/i)).toBeVisible();
});
