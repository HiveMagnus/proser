import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * Oathweave sign-in through OpenID Connect (authorization code with S256 PKCE).
 *
 * Proser redirects the browser to Oathweave, receives a one-time code at
 * `/api/auth/callback/oathweave` and exchanges it on the server. The writer's
 * password never passes through Proser. Accounts are keyed on the ID token's
 * `sub`; Factory links a first OIDC sign-in to the account the former password
 * relay created for the same Oathweave username.
 */

export const OATHWEAVE_PROVIDER_ID = 'oathweave';

export interface OathweaveOidcConfig {
  issuer: string;
  clientId: string;
  /** Absent for a public client, which authenticates with PKCE alone. */
  clientSecret?: string;
  scope: string;
  /** Replaces `<issuer>/.well-known/openid-configuration` when set. */
  discoveryUrl?: string;
  /** All three are set together; discovery is then not used. */
  endpoints?: {
    authorization: string;
    token: string;
    jwks: string;
    userinfo?: string;
  };
}

export type OidcConfigResult =
  | { status: 'unconfigured' }
  | { status: 'invalid'; reason: string }
  | { status: 'configured'; config: OathweaveOidcConfig };

const DEFAULT_SCOPE = 'openid profile email';

function value(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = environment[name]?.trim();
  return raw ? raw : undefined;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** HTTPS, or HTTP on a loopback address, with no credentials or fragment. */
function checkedUrl(name: string, raw: string, allowQuery = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
    throw new Error(`${name} must use HTTPS`);
  if (url.username || url.password || url.hash)
    throw new Error(`${name} must not carry credentials or a fragment`);
  if (!allowQuery && url.search) throw new Error(`${name} must not carry a query`);
  return raw;
}

/**
 * Read the OIDC settings. Missing settings leave OIDC off; an incomplete or
 * malformed set is reported and also leaves it off, so a typo never removes
 * the sign-in methods that already work.
 */
export function readOathweaveOidcConfig(
  environment: NodeJS.ProcessEnv = process.env,
): OidcConfigResult {
  const issuer = value(environment, 'OATHWEAVE_OIDC_ISSUER');
  const clientId = value(environment, 'OATHWEAVE_OIDC_CLIENT_ID');
  const names = [
    'OATHWEAVE_OIDC_ISSUER',
    'OATHWEAVE_OIDC_CLIENT_ID',
    'OATHWEAVE_OIDC_CLIENT_SECRET',
    'OATHWEAVE_OIDC_DISCOVERY_URL',
    'OATHWEAVE_OIDC_AUTHORIZATION_URL',
    'OATHWEAVE_OIDC_TOKEN_URL',
    'OATHWEAVE_OIDC_USERINFO_URL',
    'OATHWEAVE_OIDC_JWKS_URL',
    'OATHWEAVE_OIDC_SCOPES',
  ];
  if (!names.some((name) => value(environment, name))) return { status: 'unconfigured' };
  try {
    if (!issuer) throw new Error('OATHWEAVE_OIDC_ISSUER is required');
    if (!clientId) throw new Error('OATHWEAVE_OIDC_CLIENT_ID is required');
    checkedUrl('OATHWEAVE_OIDC_ISSUER', issuer);
    const scope = (value(environment, 'OATHWEAVE_OIDC_SCOPES') ?? DEFAULT_SCOPE)
      .split(/\s+/)
      .filter(Boolean);
    if (!scope.includes('openid')) throw new Error('OATHWEAVE_OIDC_SCOPES must include openid');
    if (!scope.includes('profile'))
      throw new Error('OATHWEAVE_OIDC_SCOPES must include profile (for preferred_username)');

    const authorization = value(environment, 'OATHWEAVE_OIDC_AUTHORIZATION_URL');
    const token = value(environment, 'OATHWEAVE_OIDC_TOKEN_URL');
    const jwks = value(environment, 'OATHWEAVE_OIDC_JWKS_URL');
    const userinfo = value(environment, 'OATHWEAVE_OIDC_USERINFO_URL');
    const discoveryUrl = value(environment, 'OATHWEAVE_OIDC_DISCOVERY_URL');
    const explicit = [authorization, token, jwks].filter(Boolean).length;
    if (explicit !== 0 && explicit !== 3)
      throw new Error(
        'Set OATHWEAVE_OIDC_AUTHORIZATION_URL, OATHWEAVE_OIDC_TOKEN_URL and OATHWEAVE_OIDC_JWKS_URL together',
      );
    if (userinfo && explicit === 0)
      throw new Error('OATHWEAVE_OIDC_USERINFO_URL needs the other explicit endpoints');
    if (discoveryUrl && explicit === 3)
      throw new Error('Use OATHWEAVE_OIDC_DISCOVERY_URL or explicit endpoints, not both');

    const clientSecret = value(environment, 'OATHWEAVE_OIDC_CLIENT_SECRET');
    return {
      status: 'configured',
      config: {
        issuer,
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        scope: scope.join(' '),
        ...(discoveryUrl
          ? { discoveryUrl: checkedUrl('OATHWEAVE_OIDC_DISCOVERY_URL', discoveryUrl, true) }
          : {}),
        ...(explicit === 3
          ? {
              endpoints: {
                // The sign-in portal may carry fixed query parameters.
                authorization: checkedUrl('OATHWEAVE_OIDC_AUTHORIZATION_URL', authorization!, true),
                token: checkedUrl('OATHWEAVE_OIDC_TOKEN_URL', token!),
                jwks: checkedUrl('OATHWEAVE_OIDC_JWKS_URL', jwks!),
                ...(userinfo
                  ? { userinfo: checkedUrl('OATHWEAVE_OIDC_USERINFO_URL', userinfo) }
                  : {}),
              },
            }
          : {}),
      },
    };
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The discovery document location Auth.js derives from the issuer. */
export function issuerDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
let discoveryCache: { url: string; jwksUri: string; fetchedAt: number } | null = null;

export function resetOathweaveOidcCachesForTests(): void {
  discoveryCache = null;
  jwksCache.clear();
}

/** The URL serving the ID-token signing keys, from configuration or discovery. */
export async function oathweaveJwksUrl(
  config: OathweaveOidcConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (config.endpoints) return config.endpoints.jwks;
  const url = config.discoveryUrl ?? issuerDiscoveryUrl(config.issuer);
  if (discoveryCache?.url === url && Date.now() - discoveryCache.fetchedAt < DISCOVERY_TTL_MS)
    return discoveryCache.jwksUri;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Oathweave discovery answered ${response.status}`);
  const document = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
  if (document.issuer !== config.issuer)
    throw new Error('Oathweave discovery names a different issuer');
  if (typeof document.jwks_uri !== 'string') throw new Error('Oathweave discovery has no jwks_uri');
  const jwksUri = checkedUrl('jwks_uri', document.jwks_uri);
  discoveryCache = { url, jwksUri, fetchedAt: Date.now() };
  return jwksUri;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Auth.js checks the ID token's issuer, audience, expiry and nonce but not its
 * signature. Proser also verifies the signature against Oathweave's published
 * keys before accepting the sign-in.
 */
export async function verifyOathweaveIdToken(
  config: OathweaveOidcConfig,
  idToken: string,
  options: { fetchImpl?: typeof fetch; keys?: Parameters<typeof jwtVerify>[1] } = {},
): Promise<JWTPayload> {
  let keys = options.keys;
  if (!keys) {
    const jwksUrl = await oathweaveJwksUrl(config, options.fetchImpl);
    let remote = jwksCache.get(jwksUrl);
    if (!remote) {
      remote = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 10_000 });
      jwksCache.set(jwksUrl, remote);
    }
    keys = remote;
  }
  const { payload } = await jwtVerify(idToken, keys as Parameters<typeof jwtVerify>[1] & object, {
    issuer: config.issuer,
    audience: config.clientId,
    algorithms: ['RS256'],
  });
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('ID token has no subject');
  return payload;
}

export function normalizeOathweaveUsername(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  const atIndex = raw.indexOf('@');
  return atIndex > 0 ? raw.slice(0, atIndex) : raw;
}

export interface OathweaveProfileUser {
  id: string;
  name: string;
  email: string | null;
  image: null;
  iamUsername: string;
  iamRoles: string[];
  oathweaveSubject: string;
}

/** Map ID-token (or UserInfo) claims to the Auth.js user. */
export function oathweaveProfile(claims: Record<string, unknown>): OathweaveProfileUser {
  const subject = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!subject || subject.length > 255) throw new Error('Oathweave sign-in returned no subject');
  const username = normalizeOathweaveUsername(claims.preferred_username);
  if (!username)
    throw new Error('Oathweave sign-in returned no preferred_username; request the profile scope');
  const roles = Array.isArray(claims.roles)
    ? claims.roles.filter((role): role is string => typeof role === 'string')
    : [];
  return {
    // Oathweave's user ID, which the former password relay also used as the
    // session user ID, so drafts kept in the browser stay with the same writer.
    id: subject,
    name: typeof claims.name === 'string' && claims.name ? claims.name : username,
    email: typeof claims.email === 'string' ? claims.email : null,
    image: null,
    iamUsername: username,
    iamRoles: roles,
    oathweaveSubject: subject,
  };
}
