import { expect, test } from '@playwright/test';

test.describe('ProserFactory proxy', () => {
  test('exposes Factory readiness through the web /api proxy', async ({ request }) => {
    const res = await request.get('/api/readiness');
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.success ?? body.ok).toBeTruthy();
  });

  test('protects Factory model status from unauthenticated requests', async ({ request }) => {
    const res = await request.get('/api/models/status');
    expect(res.status()).toBe(401);

    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'AUTH_REQUIRED' }),
      }),
    );
  });

  test('protects image backend health from unauthenticated requests', async ({ request }) => {
    const res = await request.get('/api/images/health');
    expect(res.status()).toBe(401);

    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'AUTH_REQUIRED' }),
      }),
    );
  });
});
