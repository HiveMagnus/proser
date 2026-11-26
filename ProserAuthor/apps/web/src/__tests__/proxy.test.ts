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

describe('page Content Security Policy', () => {
  const runProxy = proxy as unknown as (
    request: NextRequest & { auth: unknown },
    context: { params: Promise<Record<string, string>> },
  ) => Promise<Response | void> | Response | void;
  const visit = async (url: string, session: unknown) => {
    const request = new NextRequest(url);
    Object.defineProperty(request, 'auth', { value: session });
    return runProxy(request as NextRequest & { auth: unknown }, { params: Promise.resolve({}) });
  };

  it('sends a fresh script nonce with every page and keeps scripts and connections on this origin', async () => {
    const first = await visit('https://author.example/manuscript', { user: { id: '1' } });
    const second = await visit('https://author.example/auth/signin', null);
    const policies = [first, second].map(
      (response) => response?.headers.get('content-security-policy') ?? '',
    );
    const nonces = policies.map((policy) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1]);
    expect(nonces[0]).toBeTruthy();
    expect(nonces[1]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
    for (const policy of policies) {
      expect(policy).toContain("script-src 'self' 'nonce-");
      expect(policy).not.toContain("'unsafe-inline' 'strict-dynamic'");
      expect(policy).toMatch(/connect-src 'self'(;|$)/);
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("base-uri 'self'");
    }
    // Next.js reads the nonce for its own scripts from the forwarded request headers.
    expect(first?.headers.get('x-middleware-request-x-nonce')).toBe(nonces[0]);
  });

  it('leaves API responses to Factory', async () => {
    const response = await visit('https://author.example/api/books', { user: { id: '1' } });
    expect(response?.headers.get('content-security-policy')).toBeNull();
  });
});

describe('install manifest', () => {
  it('serves the web manifest and its icons without a session', async () => {
    const runProxy = proxy as unknown as (
      request: NextRequest & { auth: unknown },
      context: { params: Promise<Record<string, string>> },
    ) => Promise<Response | void> | Response | void;
    for (const path of ['/manifest.webmanifest', '/icon.svg', '/apple-icon']) {
      const request = new NextRequest(`https://author.example${path}`);
      Object.defineProperty(request, 'auth', { value: null });
      const response = await runProxy(request as NextRequest & { auth: unknown }, {
        params: Promise.resolve({}),
      });
      expect(response?.headers.get('location')).toBeNull();
    }
  });

  it('opens installed Proser on the mobile home', async () => {
    const { default: manifest } = await import('@/app/manifest');
    expect(manifest()).toMatchObject({ start_url: '/m', display: 'standalone' });
    expect(manifest().icons?.map((icon) => icon.src)).toEqual(['/icon.svg', '/apple-icon']);
  });
});
