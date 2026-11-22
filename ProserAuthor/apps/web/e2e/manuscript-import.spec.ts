import { test, expect } from '@playwright/test';

const fixtureTitle = process.env.PLAYWRIGHT_IMPORT_FIXTURE_TITLE;

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('opens an imported synthetic manuscript with multiple scenes', async ({ page }) => {
  test.skip(!fixtureTitle, 'Set PLAYWRIGHT_IMPORT_FIXTURE_TITLE to a seeded synthetic book.');

  await page.goto('/');
  const bookCard = page
    .locator('a[href*="/manuscript?bookId="]')
    .filter({ hasText: fixtureTitle })
    .first();
  await expect(bookCard).toBeVisible();
  await bookCard.click();
  await expect(page).toHaveURL(/\/manuscript\?bookId=/);

  const navigation = page.getByRole('navigation', { name: 'Manuscript navigation' });
  await expect(navigation).toBeVisible();
  const nextScene = navigation.getByRole('button', { name: 'Next scene' });
  await expect(nextScene).toBeEnabled();
  await nextScene.click();
  await expect(page.getByText('Internal server error')).toHaveCount(0);
});
