import { beforeEach, describe, expect, it } from 'vitest';

import {
  attachTrustedAuthSource,
  trustedProxyHopCount,
  trustedProxyPeerAllowed,
} from '../../trusted-auth-source.js';

import {
  clearLocalAuthFailures,
  constantTimeLocalCredentialsMatch,
  localAuthAccount,
  localAuthFailureAllowed,
  localAuthFailureTableSizeForTests,
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

  it('keeps the failure table bounded when one blocked source cycles usernames', () => {
    const source = localAuthSource(
      new Request('https://proser.example/auth', {
        headers: { 'x-proser-auth-source': '192.0.2.44' },
      }),
    );
    for (let attempt = 0; attempt < 12_000; attempt += 1) {
      const account = localAuthAccount(`guess-${attempt}`);
      localAuthFailureAllowed(source, account, 1_000);
      recordLocalAuthFailure(source, account, 1_000);
    }
    expect(localAuthFailureTableSizeForTests()).toBeLessThanOrEqual(10_000);
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

  it('refills one failed attempt at a time and clears both keys after a success', () => {
    const source = localAuthSource(
      new Request('https://proser.example/auth', {
        headers: { 'x-proser-auth-source': '192.0.2.20' },
      }),
    );
    const account = localAuthAccount('author');
    for (let attempt = 0; attempt < 5; attempt += 1) recordLocalAuthFailure(source, account, 1_000);
    expect(localAuthFailureAllowed(source, account, 12_999)).toBe(false);
    // Five attempts per minute: one more every 12 seconds.
    expect(localAuthFailureAllowed(source, account, 13_000)).toBe(true);
    recordLocalAuthFailure(source, account, 13_000);
    expect(localAuthFailureAllowed(source, account, 13_000)).toBe(false);
    clearLocalAuthFailures(source, account);
    expect(localAuthFailureAllowed(source, account, 13_000)).toBe(true);
  });

  it('keeps a blocked source blocked while it cycles usernames past the table bound', () => {
    const source = localAuthSource(
      new Request('https://proser.example/auth', {
        headers: { 'x-proser-auth-source': '192.0.2.45' },
      }),
    );
    for (let attempt = 0; attempt < 12_000; attempt += 1) {
      recordLocalAuthFailure(source, localAuthAccount(`guess-${attempt}`), 1_000);
    }
    expect(localAuthFailureAllowed(source, localAuthAccount('fresh'), 1_000)).toBe(false);
  });

  it('groups IPv6 sources by /64 and keeps IPv4 sources apart', () => {
    const sourceOf = (address: string) =>
      localAuthSource(
        new Request('https://proser.example/auth', {
          headers: { 'x-proser-auth-source': address },
        }),
      );
    expect(sourceOf('2001:db8:1:2::1')).toBe(sourceOf('2001:db8:1:2:ffff::9'));
    expect(sourceOf('2001:db8:1:2::1')).not.toBe(sourceOf('2001:db8:1:3::1'));
    expect(sourceOf('192.0.2.1')).not.toBe(sourceOf('192.0.2.2'));
  });

  it('counts exactly the configured hops, so client-written entries further left are never used', () => {
    const proxied = (forwardedFor: string, remoteAddress = '10.0.0.3') => ({
      socket: { remoteAddress },
      headers: { 'x-forwarded-for': forwardedFor, 'x-proser-auth-source': '' } as Record<
        string,
        string
      >,
    });
    const forged = proxied('203.0.113.99, 192.0.2.10');
    expect(attachTrustedAuthSource(forged, '1', '10.0.0.0/24')).toBe(true);
    expect(forged.headers['x-proser-auth-source']).toBe('192.0.2.10');

    // A hop inside the allowlist is still one of the counted hops, not skipped.
    const inRange = proxied('192.0.2.10, 10.0.0.2');
    expect(attachTrustedAuthSource(inRange, '1', '10.0.0.0/24')).toBe(true);
    expect(inRange.headers['x-proser-auth-source']).toBe('10.0.0.2');

    const mapped = proxied('::ffff:192.0.2.10', '::ffff:10.0.0.3');
    expect(attachTrustedAuthSource(mapped, '1', '10.0.0.0/24')).toBe(true);
    expect(mapped.headers['x-proser-auth-source']).toBe('192.0.2.10');

    expect(
      attachTrustedAuthSource(proxied('garbage, 192.0.2.10, 10.0.0.2'), '2', '10.0.0.0/24'),
    ).toBe(false);
    expect(attachTrustedAuthSource(proxied('192.0.2.10'), '1', '')).toBe(true);
  });

  it('accepts IPv6 and named ranges in the peer allowlist and trusts nothing for an invalid list', () => {
    expect(trustedProxyPeerAllowed('::1', '127.0.0.1, ::1')).toBe(true);
    expect(trustedProxyPeerAllowed('fd00::5', 'fc00::/7')).toBe(true);
    expect(trustedProxyPeerAllowed('172.18.0.1', 'private')).toBe(true);
    expect(trustedProxyPeerAllowed('172.18.0.1', 'private, 10.0.0.0/33')).toBe(false);
    expect(trustedProxyPeerAllowed('172.18.0.1', '172.18.0.0/16/1')).toBe(false);
    expect(trustedProxyPeerAllowed('not-an-address', '0.0.0.0/0')).toBe(false);
  });
});
