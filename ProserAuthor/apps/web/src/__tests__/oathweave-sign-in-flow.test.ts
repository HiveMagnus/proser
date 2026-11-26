// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';

/**
 * Drives Auth.js through the real sign-in routes with a fake Oathweave: the
 * authorization redirect, the code exchange with PKCE, ID-token checks and
 * the resulting session. Local accounts are exercised through the same
 * handlers to show they keep working next to OIDC, and Oathweave passwords are
 * shown never to be relayed.
 */

const ORIGIN = 'https://proser.example.test';
const ISSUER = 'https://identity.example.test';
const CLIENT_ID = 'hivexui-proser';
const IAM = 'https://iam.example.test';
const STATE = 'Fixture-state-value_0123456789abcdefghijkl';

const baseEnvironment = {
  AUTH_SECRET: 'fixture-session-secret-0123456789abcdef',
  AUTH_URL: ORIGIN,
  OATHWEAVE_OIDC_ISSUER: ISSUER,
  OATHWEAVE_OIDC_CLIENT_ID: CLIENT_ID,
  OATHWEAVE_OIDC_AUTHORIZATION_URL: `${ISSUER}/auth/authorize`,
  OATHWEAVE_OIDC_TOKEN_URL: `${ISSUER}/api/oathweave/oauth/token`,
  OATHWEAVE_OIDC_JWKS_URL: `${ISSUER}/api/oathweave/oauth/jwks`,
};
const managedNames = [
  ...Object.keys(baseEnvironment),
  'NEXTAUTH_URL',
  'IAM_CORE_URL',
  'OATHWEAVE_PASSWORD_RELAY',
  'LOCAL_AUTH_ENABLED',
  'LOCAL_AUTH_USERNAME',
  'LOCAL_AUTH_PASSWORD',
  'OATHWEAVE_OIDC_DISCOVERY_URL',
];

type Jar = Map<string, string>;
function remember(jar: Jar, response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}
const cookieHeader = (jar: Jar) => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
const sessionCookie = (jar: Jar) => [...jar.keys()].find((name) => name.includes('session-token'));

async function loadAuth(environment: Record<string, string>) {
  for (const name of managedNames) delete process.env[name];
  Object.assign(process.env, environment);
  vi.resetModules();
  return import('@/auth');
}

type Handlers = Awaited<ReturnType<typeof loadAuth>>['handlers'];

async function call(
  handlers: Handlers,
  jar: Jar,
  path: string,
  init: { method?: 'GET' | 'POST'; form?: Record<string, string> } = {},
) {
  const method = init.method ?? 'GET';
  const request = new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: {
      cookie: cookieHeader(jar),
      ...(init.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      'x-proser-auth-source': 'fixture-source',
    },
    ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
  });
  const response = await (method === 'GET' ? handlers.GET : handlers.POST)(request);
  remember(jar, response);
  return response;
}

async function csrf(handlers: Handlers, jar: Jar) {
  const response = await call(handlers, jar, '/api/auth/csrf');
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

async function session(handlers: Handlers, jar: Jar) {
  return (await (await call(handlers, jar, '/api/auth/session')).json()) as {
    user?: Record<string, unknown>;
  } | null;
}

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

describe('Oathweave OIDC sign-in through Auth.js', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwks: { keys: Record<string, unknown>[] };
  let signingKey: CryptoKey;
  let tokenRequests: URLSearchParams[];
  let tokenHeaders: Headers[];
  let issuedNonce = '';
  let codeChallenge = '';

  beforeEach(async () => {
    keys = await generateKeyPair('RS256', { extractable: true });
    const publicJwk = await exportJWK(keys.publicKey);
    const kid = await calculateJwkThumbprint(publicJwk);
    jwks = { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] };
    signingKey = keys.privateKey;
    tokenRequests = [];
    tokenHeaders = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === baseEnvironment.OATHWEAVE_OIDC_JWKS_URL) return Response.json(jwks);
        if (url === baseEnvironment.OATHWEAVE_OIDC_TOKEN_URL) {
          const body = new URLSearchParams(String(init?.body ?? ''));
          tokenRequests.push(body);
          tokenHeaders.push(new Headers(init?.headers));
          const idToken = await new SignJWT({
            preferred_username: 'Writer',
            name: 'A Writer',
            email: 'writer@example.test',
            nonce: issuedNonce,
          })
            .setProtectedHeader({ alg: 'RS256', kid: String(jwks.keys[0]?.kid) })
            .setIssuer(ISSUER)
            .setAudience(CLIENT_ID)
            .setSubject('oathweave-user-uuid')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(signingKey);
          return Response.json({
            access_token: 'fixture-access-token',
            token_type: 'Bearer',
            expires_in: 900,
            id_token: idToken,
          });
        }
        throw new Error(`Unexpected request to ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const name of managedNames) delete process.env[name];
  });

  async function startSignIn(handlers: Handlers, jar: Jar) {
    const csrfToken = await csrf(handlers, jar);
    const response = await call(handlers, jar, `/api/auth/signin/oathweave?state=${STATE}`, {
      method: 'POST',
      form: { csrfToken, callbackUrl: '/books' },
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    issuedNonce = location.searchParams.get('nonce') ?? '';
    codeChallenge = location.searchParams.get('code_challenge') ?? '';
    return location;
  }

  it('redirects to Oathweave with S256 PKCE, a nonce and the portal-compatible state', async () => {
    const { handlers, signInMethods } = await loadAuth(baseEnvironment);
    expect(signInMethods).toEqual({ oathweave: true, password: false });
    const location = await startSignIn(handlers, new Map());

    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/auth/authorize`);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: `${ORIGIN}/api/auth/callback/oathweave`,
      scope: 'openid profile email',
      state: STATE,
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('exchanges the code with the PKCE verifier and signs the writer in keyed on the subject', async () => {
    const { handlers } = await loadAuth(baseEnvironment);
    const jar: Jar = new Map();
    await startSignIn(handlers, jar);

    const callback = await call(
      handlers,
      jar,
      `/api/auth/callback/oathweave?code=fixture-code&state=${STATE}&iss=${encodeURIComponent(ISSUER)}`,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${ORIGIN}/books`);

    const exchange = tokenRequests[0]!;
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('fixture-code');
    expect(exchange.get('client_id')).toBe(CLIENT_ID);
    expect(exchange.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/oathweave`);
    const verifier = exchange.get('code_verifier')!;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    expect(base64url(digest)).toBe(codeChallenge);
    // A public client: no client secret is sent.
    expect(tokenHeaders[0]!.get('authorization')).toBeNull();
    expect(exchange.has('client_secret')).toBe(false);

    expect(sessionCookie(jar)).toBeDefined();
    const signedIn = await session(handlers, jar);
    expect(signedIn?.user).toMatchObject({
      id: 'oathweave-user-uuid',
      username: 'writer',
      provider: 'oathweave',
      oathweaveSubject: 'oathweave-user-uuid',
    });
    // Oathweave's tokens never enter the session.
    expect(JSON.stringify(signedIn)).not.toContain('fixture-access-token');
  });

  it('authenticates a confidential client with its secret', async () => {
    const { handlers } = await loadAuth({
      ...baseEnvironment,
      OATHWEAVE_OIDC_CLIENT_SECRET: 'fixture-client-secret',
    });
    const jar: Jar = new Map();
    await startSignIn(handlers, jar);
    await call(handlers, jar, `/api/auth/callback/oathweave?code=fixture-code&state=${STATE}`);
    expect(tokenHeaders[0]!.get('authorization')).toBe(
      `Basic ${btoa(`${CLIENT_ID}:fixture-client-secret`)}`,
    );
    expect(sessionCookie(jar)).toBeDefined();
  });

  it('refuses an ID token not signed with a published Oathweave key', async () => {
    const { handlers } = await loadAuth(baseEnvironment);
    const jar: Jar = new Map();
    await startSignIn(handlers, jar);
    signingKey = (await generateKeyPair('RS256')).privateKey;

    const callback = await call(
      handlers,
      jar,
      `/api/auth/callback/oathweave?code=fixture-code&state=${STATE}`,
    );
    expect(callback.headers.get('location')).toContain('/auth/signin?error=AccessDenied');
    expect(sessionCookie(jar)).toBeUndefined();
  });

  it('refuses a callback whose ID token nonce belongs to another sign-in', async () => {
    const { handlers } = await loadAuth(baseEnvironment);
    const jar: Jar = new Map();
    await startSignIn(handlers, jar);
    issuedNonce = 'another-sign-in-nonce';

    const callback = await call(
      handlers,
      jar,
      `/api/auth/callback/oathweave?code=fixture-code&state=${STATE}`,
    );
    expect(callback.headers.get('location')).toContain('/auth/signin?error=');
    expect(sessionCookie(jar)).toBeUndefined();
  });

  async function passwordSignIn(handlers: Handlers, username: string, password: string) {
    const jar: Jar = new Map();
    const csrfToken = await csrf(handlers, jar);
    await call(handlers, jar, '/api/auth/callback/iam', {
      method: 'POST',
      form: { csrfToken, username, password, callbackUrl: '/' },
    });
    return { jar, signedIn: await session(handlers, jar) };
  }

  const iamRequests = () =>
    vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith(IAM));

  it('never posts a password to Oathweave on an Oathweave installation', async () => {
    const { handlers, signInMethods } = await loadAuth({ ...baseEnvironment, IAM_CORE_URL: IAM });
    expect(signInMethods).toEqual({ oathweave: true, password: false });
    const { jar, signedIn } = await passwordSignIn(handlers, 'writer', 'fixture-password');
    expect(signedIn).toBeNull();
    expect(sessionCookie(jar)).toBeUndefined();
    expect(iamRequests()).toEqual([]);
  });

  it('ignores the retired OATHWEAVE_PASSWORD_RELAY setting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { handlers, signInMethods } = await loadAuth({
      ...baseEnvironment,
      IAM_CORE_URL: IAM,
      OATHWEAVE_PASSWORD_RELAY: 'true',
    });
    expect(signInMethods).toEqual({ oathweave: true, password: false });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('OATHWEAVE_PASSWORD_RELAY is no longer used'),
    );
    const { jar } = await passwordSignIn(handlers, 'writer', 'fixture-password');
    expect(sessionCookie(jar)).toBeUndefined();
    expect(iamRequests()).toEqual([]);
  });

  it('offers no password sign-in and logs why when IAM_CORE_URL is set without OIDC', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handlers, signInMethods } = await loadAuth({
      IAM_CORE_URL: IAM,
      OATHWEAVE_OIDC_ISSUER: ISSUER,
      AUTH_SECRET: baseEnvironment.AUTH_SECRET,
      AUTH_URL: ORIGIN,
    });
    expect(signInMethods).toEqual({ oathweave: false, password: false });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Oathweave OIDC sign-in is not configured'),
    );
    const { jar } = await passwordSignIn(handlers, 'writer', 'fixture-password');
    expect(sessionCookie(jar)).toBeUndefined();
    expect(iamRequests()).toEqual([]);
  });

  it('leaves local accounts unchanged next to OIDC', async () => {
    const { handlers, signInMethods } = await loadAuth({
      ...baseEnvironment,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USERNAME: 'author',
      LOCAL_AUTH_PASSWORD: 'fixture-local-password',
    });
    expect(signInMethods).toEqual({ oathweave: true, password: true });
    const { signedIn } = await passwordSignIn(handlers, 'author', 'fixture-local-password');
    expect(signedIn?.user).toMatchObject({
      id: 'local-author',
      username: 'author',
      provider: 'iam',
    });
    expect(signedIn?.user?.oathweaveSubject).toBeUndefined();
    expect((await passwordSignIn(handlers, 'author', 'wrong')).signedIn).toBeNull();
  });
});
