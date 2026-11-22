import { test, expect } from '@playwright/test';

const fixtureTitle = process.env.PLAYWRIGHT_IMPORT_FIXTURE_TITLE;
const username = process.env.PLAYWRIGHT_IAM_USERNAME;
const password = process.env.PLAYWRIGHT_IAM_PASSWORD;

test.use({
  trace: 'off',
  screenshot: 'off',
  video: 'off',
  storageState: { cookies: [], origins: [] },
});

test('a signed-in IAM user sees the imported synthetic book and its codex', async ({ page }) => {
  test.skip(
    !fixtureTitle || !username || !password,
    'Supply an isolated synthetic book and disposable IAM credentials.',
  );

  await page.goto('/auth/signin');
  await page.getByLabel('Username').fill(username!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);

  const book = await page.evaluate(async (title) => {
    const response = await fetch('/api/books');
    if (!response.ok) return { status: response.status };
    const payload = await response.json();
    const match = payload.data?.books?.find(
      (candidate: { title: string }) => candidate.title === title,
    );
    return { status: response.status, id: match?.id, wordCount: match?.wordCount };
  }, fixtureTitle);
  expect(book.status).toBe(200);
  expect(Number.isInteger(book.id), 'Expected the synthetic book in the owned book list').toBe(
    true,
  );
  expect(book.wordCount ?? 0).toBeGreaterThan(0);

  await expect(
    page.locator('a[href*="/manuscript?bookId="]').filter({ hasText: fixtureTitle }).first(),
  ).toBeVisible();
  await page.goto(`/bible?bookId=${book.id}`);
  await expect(page.getByRole('heading', { name: 'Story Bible' })).toBeVisible();
  const codex = await page.evaluate(async (bookId) => {
    const response = await fetch(`/api/books/${bookId}/codex?pageSize=10`);
    if (!response.ok) return { status: response.status, count: 0 };
    const payload = await response.json();
    return { status: response.status, count: payload.data?.entries?.length ?? 0 };
  }, book.id);
  expect(codex.status).toBe(200);
  expect(codex.count).toBeGreaterThan(0);
  await expect(page.locator('main').getByRole('heading', { level: 3 }).first()).toBeVisible();
});
