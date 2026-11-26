import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
  oathweaveJwksUrl,
  oathweaveProfile,
  readOathweaveOidcConfig,
  resetOathweaveOidcCachesForTests,
  verifyOathweaveIdToken,
  type OathweaveOidcConfig,
} from '@/lib/oathweave-oidc';

const issuer = 'https://identity.example.test';
const base = { OATHWEAVE_OIDC_ISSUER: issuer, OATHWEAVE_OIDC_CLIENT_ID: 'hivexui-proser' };
const config = (environment: Record<string, string>) => {
  const result = readOathweaveOidcConfig(environment as unknown as NodeJS.ProcessEnv);
  if (result.status !== 'configured') throw new Error(`not configured: ${JSON.stringify(result)}`);
  return result.config;
};

describe('Oathweave OIDC configuration', () => {
  it('stays off without settings', () => {
    expect(readOathweaveOidcConfig({} as unknown as NodeJS.ProcessEnv)).toEqual({
      status: 'unconfigured',
    });
  });

  it('uses issuer discovery with the default scopes and a public client', () => {
    expect(config(base)).toEqual({
      issuer,
      clientId: 'hivexui-proser',
      scope: 'openid profile email',
    });
  });

  it('accepts a discovery URL with a client selection query', () => {
    const discoveryUrl = `${issuer}/api/oathweave/oauth/.well-known/openid-configuration?client_id=hivexui-proser`;
    expect(config({ ...base, OATHWEAVE_OIDC_DISCOVERY_URL: discoveryUrl }).discoveryUrl).toBe(
      discoveryUrl,
    );
  });

  it('accepts explicit endpoints so discovery is not needed', () => {
    const explicit = config({
      ...base,
      OATHWEAVE_OIDC_CLIENT_SECRET: 'confidential-fixture',
      OATHWEAVE_OIDC_AUTHORIZATION_URL: `${issuer}/auth/authorize`,
      OATHWEAVE_OIDC_TOKEN_URL: `${issuer}/api/oathweave/oauth/token`,
      OATHWEAVE_OIDC_JWKS_URL: `${issuer}/api/oathweave/oauth/jwks`,
      OATHWEAVE_OIDC_USERINFO_URL: `${issuer}/api/oathweave/oauth/userinfo`,
    });
    expect(explicit.clientSecret).toBe('confidential-fixture');
    expect(explicit.endpoints).toEqual({
      authorization: `${issuer}/auth/authorize`,
      token: `${issuer}/api/oathweave/oauth/token`,
      jwks: `${issuer}/api/oathweave/oauth/jwks`,
      userinfo: `${issuer}/api/oathweave/oauth/userinfo`,
    });
  });

  it.each([
    [{ OATHWEAVE_OIDC_CLIENT_ID: 'x' }, 'OATHWEAVE_OIDC_ISSUER is required'],
    [{ OATHWEAVE_OIDC_ISSUER: issuer }, 'OATHWEAVE_OIDC_CLIENT_ID is required'],
    [{ ...base, OATHWEAVE_OIDC_ISSUER: 'http://identity.example.test' }, 'must use HTTPS'],
    [{ ...base, OATHWEAVE_OIDC_TOKEN_URL: `${issuer}/token` }, 'together'],
    [{ ...base, OATHWEAVE_OIDC_SCOPES: 'openid email' }, 'must include profile'],
    [{ ...base, OATHWEAVE_OIDC_SCOPES: 'profile email' }, 'must include openid'],
  ])('reports an incomplete or unsafe configuration instead of using it', (environment, reason) => {
    const result = readOathweaveOidcConfig(environment as unknown as NodeJS.ProcessEnv);
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.reason).toContain(reason);
  });

  it('allows plain HTTP only on a loopback address', () => {
    expect(config({ ...base, OATHWEAVE_OIDC_ISSUER: 'http://127.0.0.1:4200' }).issuer).toBe(
      'http://127.0.0.1:4200',
    );
  });
});

describe('Oathweave profile', () => {
  it('maps the ID token claims and keeps the subject as the user ID', () => {
    expect(
      oathweaveProfile({
        sub: 'user-uuid',
        preferred_username: 'Writer',
        name: 'A Writer',
        email: 'writer@example.test',
        roles: ['author', 7],
      }),
    ).toEqual({
      id: 'user-uuid',
      name: 'A Writer',
      email: 'writer@example.test',
      image: null,
      iamUsername: 'writer',
      iamRoles: ['author'],
      oathweaveSubject: 'user-uuid',
    });
  });

  it('refuses claims without a subject or username', () => {
    expect(() => oathweaveProfile({ preferred_username: 'writer' })).toThrow(/subject/);
    expect(() => oathweaveProfile({ sub: 'user-uuid' })).toThrow(/preferred_username/);
  });
});

describe('ID token signature', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwks: { keys: Record<string, unknown>[] };
  const oidc: OathweaveOidcConfig = { issuer, clientId: 'hivexui-proser', scope: 'openid profile' };
  const sign = (claims: Record<string, unknown>, key = keys.privateKey, kid = 'k1') =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(issuer)
      .setAudience('hivexui-proser')
      .setSubject('user-uuid')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);

  beforeEach(async () => {
    resetOathweaveOidcCachesForTests();
    keys = await generateKeyPair('RS256');
    jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256' }] };
  });

  it('accepts a token signed with a published key', async () => {
    const claims = await verifyOathweaveIdToken(oidc, await sign({ preferred_username: 'w' }), {
      keys: createLocalJWKSet(jwks as never),
    });
    expect(claims.sub).toBe('user-uuid');
  });

  it('refuses a token signed with another key', async () => {
    const other = await generateKeyPair('RS256');
    await expect(
      verifyOathweaveIdToken(oidc, await sign({}, other.privateKey), {
        keys: createLocalJWKSet(jwks as never),
      }),
    ).rejects.toThrow();
  });

  it('refuses a token for another client', async () => {
    await expect(
      verifyOathweaveIdToken({ ...oidc, clientId: 'hivexui-other' }, await sign({}), {
        keys: createLocalJWKSet(jwks as never),
      }),
    ).rejects.toThrow();
  });

  it('finds the key set through discovery and checks the discovered issuer', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ issuer, jwks_uri: `${issuer}/api/v1/oauth/jwks` }),
    );
    await expect(oathweaveJwksUrl(oidc, fetchMock as unknown as typeof fetch)).resolves.toBe(
      `${issuer}/api/v1/oauth/jwks`,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${issuer}/.well-known/openid-configuration`,
      expect.anything(),
    );

    resetOathweaveOidcCachesForTests();
    const wrong = vi.fn(async () =>
      Response.json({ issuer: 'https://other.example.test', jwks_uri: `${issuer}/jwks` }),
    );
    await expect(oathweaveJwksUrl(oidc, wrong as unknown as typeof fetch)).rejects.toThrow(
      /different issuer/,
    );
  });
});
