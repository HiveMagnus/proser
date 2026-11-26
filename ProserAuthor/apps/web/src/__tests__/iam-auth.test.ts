import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-auth', () => ({
  CredentialsSignin: class CredentialsSignin extends Error {
    code = 'credentials';
  },
}));

import { authorizeIamCredentials, MfaInvalidError, MfaRequiredError } from '@/lib/iam-auth';
import { resetLocalAuthFailuresForTests } from '@/lib/local-auth';

const iam = 'https://iam.example.test';
const request = () =>
  new Request('https://proser.example/api/auth/callback/iam', {
    headers: { 'x-proser-auth-source': 'fixture-source' },
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const tokens = {
  accessToken: 'fixture-access',
  refreshToken: 'fixture-refresh',
  user: { id: 'u1', email: 'writer@example.test', username: 'writer', roles: ['author'] },
};

describe('Oathweave credential sign-in', () => {
  beforeEach(() => resetLocalAuthFailuresForTests());

  it('signs in an account without MFA', async () => {
    const fetchMock = vi.fn(async () => json(tokens));
    const user = await authorizeIamCredentials(
      iam,
      { username: 'writer', password: 'pw' },
      request(),
      fetchMock as unknown as typeof fetch,
    );
    expect(user?.iamUsername).toBe('writer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for the second factor instead of failing when MFA is enabled', async () => {
    const fetchMock = vi.fn(async () =>
      json({ requiresMfa: true, mfaToken: 'challenge', methods: ['totp'] }),
    );
    await expect(
      authorizeIamCredentials(
        iam,
        { username: 'writer', password: 'pw' },
        request(),
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(MfaRequiredError);
  });

  it('completes the MFA challenge with the submitted code', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/login')) {
        return json({ requiresMfa: true, mfaToken: 'challenge', methods: ['totp'] });
      }
      expect(url).toBe(`${iam}/api/v1/auth/mfa/challenge`);
      expect(JSON.parse(String(init?.body))).toEqual({ mfaToken: 'challenge', code: '123456' });
      return json(tokens);
    });
    const user = await authorizeIamCredentials(
      iam,
      { username: 'writer', password: 'pw', code: '123 456' },
      request(),
      fetchMock as unknown as typeof fetch,
    );
    expect(user?.iamUsername).toBe('writer');
    expect(JSON.stringify(user)).not.toContain('fixture-access');
  });

  it('reports a rejected code distinctly', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/login')
        ? json({ requiresMfa: true, mfaToken: 'challenge', methods: ['totp'] })
        : json({ error: 'INVALID_MFA_CODE' }, 401),
    );
    await expect(
      authorizeIamCredentials(
        iam,
        { username: 'writer', password: 'pw', code: '000000' },
        request(),
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(MfaInvalidError);
  });

  it('throttles repeated failures before contacting the IAM service', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'INVALID_CREDENTIALS' }, 401));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await authorizeIamCredentials(
          iam,
          { username: 'writer', password: 'wrong' },
          request(),
          fetchMock as unknown as typeof fetch,
        ),
      ).toBeNull();
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(
      await authorizeIamCredentials(
        iam,
        { username: 'writer', password: 'pw' },
        request(),
        fetchMock as unknown as typeof fetch,
      ),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
