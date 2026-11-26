import { describe, expect, it } from 'vitest';

import { unsafeRequestFromAllowedOrigin } from '@/lib/request-origin';

const allowed = (method: string, headers: Record<string, string>, env = {}) =>
  unsafeRequestFromAllowedOrigin(method, new Headers(headers), env);

describe('unsafe request origin check', () => {
  it('never blocks reads', () => {
    expect(allowed('GET', { origin: 'https://evil.example' })).toBe(true);
    expect(allowed('HEAD', { 'sec-fetch-site': 'cross-site' })).toBe(true);
  });

  it('accepts the configured Auth.js origin even when the request host differs', () => {
    const env = { AUTH_URL: 'https://proser.example.net/' };
    expect(
      allowed('POST', { origin: 'https://proser.example.net', host: 'author:3000' }, env),
    ).toBe(true);
    expect(
      allowed(
        'DELETE',
        { origin: 'https://proser.example.net', host: 'author:3000' },
        {
          NEXTAUTH_URL: 'https://proser.example.net',
        },
      ),
    ).toBe(true);
    expect(allowed('POST', { origin: 'http://proser.example.net', host: 'author:3000' }, env)).toBe(
      false,
    );
  });

  it('rejects sibling hosts, opaque origins and malformed values', () => {
    const env = { AUTH_URL: 'https://proser.example.net' };
    const host = 'proser.example.net';
    expect(allowed('POST', { origin: 'https://wiki.example.net', host }, env)).toBe(false);
    expect(allowed('PUT', { origin: 'null', host }, env)).toBe(false);
    expect(allowed('PATCH', { origin: 'not a url', host }, env)).toBe(false);
    expect(allowed('POST', { 'sec-fetch-site': 'same-site', host }, env)).toBe(false);
    expect(allowed('POST', { 'sec-fetch-site': 'cross-site', host }, env)).toBe(false);
  });

  it('accepts same-origin browser requests and clients without browser headers', () => {
    expect(allowed('POST', { origin: 'http://192.0.2.4:3000', host: '192.0.2.4:3000' })).toBe(true);
    expect(allowed('POST', { 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(allowed('POST', {})).toBe(true);
  });
});
