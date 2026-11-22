import { expect, test } from '@playwright/test';

test('authenticated Author proxy supports a disposable book lifecycle', async ({ page }) => {
  const title = `Author release smoke ${Date.now()}`;
  let bookId: number | undefined;

  try {
    const models = await page.request.get('/api/models/status');
    expect(models.ok()).toBe(true);
    expect(await models.json()).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ connected: expect.any(Boolean) }),
      }),
    );

    const images = await page.request.get('/api/images/health');
    expect(images.ok()).toBe(true);
    expect(await images.json()).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          forge: 'reachable',
          status: expect.stringMatching(/^(ok|warn)$/),
        }),
      }),
    );

    const created = await page.request.post('/api/books', {
      data: {
        title,
        genre: 'fantasy',
        targetAudience: 'adult',
        summary: 'Disposable authenticated release verification.',
      },
    });
    expect(created.ok()).toBe(true);
    const createdBody = (await created.json()) as { data?: { id?: number } };
    bookId = createdBody.data?.id;
    expect(bookId).toBeTruthy();

    const read = await page.request.get(`/api/books/${bookId}`);
    expect(read.ok()).toBe(true);
    const readBody = (await read.json()) as { data?: { title?: string } };
    expect(readBody.data?.title).toBe(title);

    await page.goto('/settings');
    await page.getByRole('tab', { name: /AI Config/ }).click();
    await expect(page.getByPlaceholder('http://127.0.0.1:8000')).toBeDisabled();
    await expect(page.getByText('Default Model').locator('..').locator('input')).toBeDisabled();
    await expect(page.getByRole('button', { name: /Save Inference Settings/ })).toHaveCount(0);
  } finally {
    if (bookId) {
      const deleted = await page.request.delete(`/api/books/${bookId}`);
      expect(deleted.ok()).toBe(true);
    }
  }
});
