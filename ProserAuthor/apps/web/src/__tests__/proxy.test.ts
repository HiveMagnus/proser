import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/auth', () => ({
  auth: (handler: (request: NextRequest & { auth: unknown }) => Response) => handler,
}));

import proxy from '@/proxy';

describe('web authentication proxy', () => {
  it('preserves the path and query string in the sign-in callback', async () => {
    const request = new NextRequest('https://author.example/plot/7?view=threads&sort=recent');
    Object.defineProperty(request, 'auth', { value: null });

    const runProxy = proxy as unknown as (
      request: NextRequest & { auth: unknown },
      context: { params: Promise<Record<string, string>> },
    ) => Promise<Response | void> | Response | void;
    const response = await runProxy(request as NextRequest & { auth: unknown }, {
      params: Promise.resolve({}),
    });

    expect(response?.headers.get('location')).toBe(
      'https://author.example/auth/signin?callbackUrl=%2Fplot%2F7%3Fview%3Dthreads%26sort%3Drecent',
    );
  });
});
