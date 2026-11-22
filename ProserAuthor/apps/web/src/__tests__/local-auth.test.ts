import { beforeEach, describe, expect, it } from 'vitest';

import {
  attachTrustedAuthSource,
  trustedProxyHopCount,
  trustedProxyPeerAllowed,
} from '../../trusted-auth-source.js';

import {
  constantTimeLocalCredentialsMatch,
  localAuthAccount,
  localAuthFailureAllowed,
  localAuthSource,
  recordLocalAuthFailure,
  resetLocalAuthFailuresForTests,
} from '@/lib/local-auth';

describe('local authentication hardening', () => {
  beforeEach(() => resetLocalAuthFailuresForTests());

  it('requires both credential comparisons to match', () => {
    expect(constantTimeLocalCredentialsMatch('author', 'author', 'secret', 'secret')).toBe(true);
    expect(constantTimeLocalCredentialsMatch('intruder', 'author', 'secret', 'secret')).toBe(false);
    expect(constantTimeLocalCredentialsMatch('author', 'author', 'wrong', 'secret')).toBe(false);
  });

  it('uses only the server-reconstructed socket source and ignores spoofable forwarding headers', () => {
    const request = new Request('https://proser.example/auth', {
      headers: {
        'x-proser-auth-source': '192.0.2.12',
        'x-forwarded-for': '192.0.2.10, 10.0.0.2',
        'x-real-ip': '198.51.100.22',
      },
    });
    const source = localAuthSource(request);
    expect(source).not.toContain('192.0.2.10');
    expect(source).toBe(
      localAuthSource(
        new Request('https://proser.example/auth', {
          headers: {
            'x-proser-auth-source': '192.0.2.12',
            'x-forwarded-for': '203.0.113.99',
          },
        }),
      ),
    );
  });

  it('overwrites client source headers from the socket unless proxy hops are explicit', () => {
    const direct = {
      socket: { remoteAddress: '192.0.2.12' },
      headers: {
        'x-proser-auth-source': 'spoofed-private-header',
        'x-forwarded-for': '192.0.2.10',
      },
    };
    attachTrustedAuthSource(direct, '0');
    expect(direct.headers['x-proser-auth-source']).toBe('192.0.2.12');

    const proxied = {
      socket: { remoteAddress: '10.0.0.3' },
      headers: {
        'x-forwarded-for': '192.0.2.10, 10.0.0.2',
        'x-proser-auth-source': '',
      },
    };
    expect(attachTrustedAuthSource(proxied, '2', '10.0.0.0/24')).toBe(true);
    expect(proxied.headers['x-proser-auth-source']).toBe('192.0.2.10');
    expect(trustedProxyHopCount('999')).toBe(5);
    expect(trustedProxyHopCount('-3')).toBe(0);
  });

  it('ignores forwarding data from unapproved direct peers', () => {
    const direct = {
      socket: { remoteAddress: '198.51.100.40' },
      headers: {
        'x-forwarded-for': '192.0.2.10, 10.0.0.2',
        'x-proser-auth-source': '',
      },
    };
    expect(attachTrustedAuthSource(direct, '2', '10.0.0.0/24')).toBe(true);
    expect(direct.headers['x-proser-auth-source']).toBe('198.51.100.40');
    expect(trustedProxyPeerAllowed('::ffff:10.0.0.3', '10.0.0.0/24')).toBe(true);
    expect(trustedProxyPeerAllowed('10.0.0.3', 'not-a-cidr')).toBe(false);
  });

  it('rejects malformed forwarding chains from approved proxy peers', () => {
    const malformed = {
      socket: { remoteAddress: '10.0.0.3' },
      headers: {
        'x-forwarded-for': 'attacker-chosen, 10.0.0.2',
        'x-proser-auth-source': '',
      },
    };
    expect(attachTrustedAuthSource(malformed, '2', '10.0.0.0/24')).toBe(false);
    expect(malformed.headers['x-proser-auth-source']).toBe('10.0.0.3');

    const tooShort = {
      socket: { remoteAddress: '10.0.0.3' },
      headers: { 'x-forwarded-for': '192.0.2.10' },
    };
    expect(attachTrustedAuthSource(tooShort, '2', '10.0.0.0/24')).toBe(false);
  });

  it('throttles both the hashed account and trusted network source', () => {
    const source = localAuthSource(
      new Request('https://proser.example/auth', {
        headers: { 'x-proser-auth-source': '192.0.2.12' },
      }),
    );
    const account = localAuthAccount('author');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(localAuthFailureAllowed(source, account, 1_000)).toBe(true);
      recordLocalAuthFailure(source, account, 1_000);
    }
    expect(localAuthFailureAllowed(source, account, 1_000)).toBe(false);
    expect(localAuthFailureAllowed(source, localAuthAccount('different'), 1_000)).toBe(false);
    expect(
      localAuthFailureAllowed(
        localAuthSource(
          new Request('https://proser.example/auth', {
            headers: { 'x-proser-auth-source': '192.0.2.13' },
          }),
        ),
        account,
        1_000,
      ),
    ).toBe(false);
    expect(localAuthFailureAllowed(source, account, 61_001)).toBe(true);
  });
});
