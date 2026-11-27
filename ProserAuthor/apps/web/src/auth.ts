import NextAuth, { customFetch } from 'next-auth';
import type { OIDCConfig, Provider } from 'next-auth/providers';
import GitHub from 'next-auth/providers/github';
import Credentials from 'next-auth/providers/credentials';

import {
  clearLocalAuthFailures,
  localAuthAccount,
  constantTimeLocalCredentialsMatch,
  localAuthFailureAllowed,
  localAuthSource,
  recordLocalAuthFailure,
} from '@/lib/local-auth';
import { isGitHubAccountAllowed, parseGitHubAllowedIds } from '@/lib/github-allow-list';
import {
  OATHWEAVE_PROVIDER_ID,
  oathweaveProfile,
  readOathweaveOidcConfig,
  verifyOathweaveIdToken,
  type OathweaveOidcConfig,
} from '@/lib/oathweave-oidc';

const providers: Provider[] = [];

// A rolling session is renewed on every use, so without a ceiling a stolen
// cookie never expires while it is being used.
const DAY_SECONDS = 24 * 60 * 60;
const configuredSessionLifetimeDays = Number(process.env.AUTH_SESSION_MAX_LIFETIME_DAYS);
const SESSION_MAX_LIFETIME_SECONDS =
  (Number.isFinite(configuredSessionLifetimeDays) && configuredSessionLifetimeDays >= 1
    ? configuredSessionLifetimeDays
    : 90) * DAY_SECONDS;
const isLocalAuthAllowed = process.env.LOCAL_AUTH_ENABLED === 'true';

function normalizeIamUsername(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  const atIndex = raw.indexOf('@');
  return atIndex > 0 ? raw.slice(0, atIndex) : raw;
}

let passwordSignIn = false;
function createLocalCredentialsProvider(
  authorize: NonNullable<Parameters<typeof Credentials>[0]['authorize']>,
) {
  passwordSignIn = true;
  return Credentials({
    id: 'iam',
    name: 'Proser Login',
    credentials: {
      username: { label: 'Username', type: 'text' },
      password: { label: 'Password', type: 'password' },
    },
    authorize,
  });
}

// ─── Oathweave OpenID Connect (preferred) ───────────────────────────────
// Authorization code with S256 PKCE: the password is entered at Oathweave and
// never reaches Proser. An incomplete configuration is logged and leaves OIDC
// off, so the sign-in methods below keep working.
const oidcResult = readOathweaveOidcConfig(process.env);
if (oidcResult.status === 'invalid') {
  console.error(`Oathweave OIDC sign-in is disabled: ${oidcResult.reason}.`);
}
const oidcConfig: OathweaveOidcConfig | null =
  oidcResult.status === 'configured' ? oidcResult.config : null;
if (oidcConfig) providers.push(createOathweaveProvider(oidcConfig));

function createOathweaveProvider(config: OathweaveOidcConfig): OIDCConfig<Record<string, unknown>> {
  const authorizationUrl = config.endpoints ? new URL(config.endpoints.authorization) : null;
  authorizationUrl?.searchParams.set('scope', config.scope);
  return {
    id: OATHWEAVE_PROVIDER_ID,
    name: 'Oathweave',
    type: 'oidc',
    issuer: config.issuer,
    clientId: config.clientId,
    ...(config.clientSecret
      ? {
          clientSecret: config.clientSecret,
          client: { token_endpoint_auth_method: 'client_secret_basic' },
        }
      : { client: { token_endpoint_auth_method: 'none' } }),
    // State is not among the checks: Auth.js encodes it as a JWE, which the
    // HiveXUI sign-in portal does not accept. The sign-in button sends a plain
    // random state instead. PKCE binds the callback to this browser's sign-in
    // (RFC 9700 §2.1) and the nonce binds the ID token to it.
    checks: ['pkce', 'nonce'],
    authorization: authorizationUrl
      ? { url: authorizationUrl.toString() }
      : { params: { scope: config.scope } },
    ...(config.endpoints ? { token: config.endpoints.token } : {}),
    ...(config.endpoints?.userinfo ? { userinfo: config.endpoints.userinfo } : {}),
    profile: (claims) => oathweaveProfile(claims),
    // Oathweave's browser discovery is selected with ?client_id=, which Auth.js
    // cannot derive from the issuer, so its discovery request is redirected.
    [customFetch]: (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (config.discoveryUrl && url.endsWith('/.well-known/openid-configuration')) {
        return fetch(config.discoveryUrl, init);
      }
      return fetch(input, init);
    },
  };
}

// ─── Oathweave installations ────────────────────────────────────────────
// Oathweave writers sign in only through OIDC above, so Proser never sees
// their password. IAM_CORE_URL marks an Oathweave installation: it offers no
// local password sign-in. Proser no longer relays passwords to Oathweave's
// login API; OATHWEAVE_PASSWORD_RELAY has no effect.
const oathweaveInstallation = Boolean(process.env.IAM_CORE_URL?.trim());
if (
  process.env.OATHWEAVE_PASSWORD_RELAY !== undefined &&
  process.env.OATHWEAVE_PASSWORD_RELAY !== ''
) {
  console.warn(
    'OATHWEAVE_PASSWORD_RELAY is no longer used: Proser never relays passwords to Oathweave. Remove the setting.',
  );
}
if (oathweaveInstallation && !oidcConfig) {
  console.error(
    'IAM_CORE_URL is set but Oathweave OIDC sign-in is not configured, so Oathweave writers cannot sign in. Proser no longer relays passwords to Oathweave: configure OATHWEAVE_OIDC_* (docs/OATHWEAVE_OIDC.md).',
  );
}
if (oathweaveInstallation) {
  // Oathweave accounts sign in through OIDC only.
} else if (isLocalAuthAllowed) {
  const localAuthUsername = normalizeIamUsername(process.env.LOCAL_AUTH_USERNAME);
  const localAuthPassword = process.env.LOCAL_AUTH_PASSWORD || '';

  if (!localAuthUsername || !localAuthPassword) {
    throw new Error(
      'LOCAL_AUTH_ENABLED=true requires LOCAL_AUTH_USERNAME and LOCAL_AUTH_PASSWORD.',
    );
  }

  providers.push(
    createLocalCredentialsProvider(async (credentials, request) => {
      const username = normalizeIamUsername(credentials?.username);
      const password = String(credentials?.password ?? '');
      const source = localAuthSource(request);
      const account = localAuthAccount(username);
      const allowed = localAuthFailureAllowed(source, account);
      const matches = constantTimeLocalCredentialsMatch(
        username,
        localAuthUsername,
        password,
        localAuthPassword,
      );
      if (!allowed || !matches) {
        recordLocalAuthFailure(source, account);
        return null;
      }
      clearLocalAuthFailures(source, account);

      return {
        id: `local-${username}`,
        name: username,
        email: `${username}@local.proser`,
        image: null,
        iamUsername: username,
        iamRoles: ['developer'],
      };
    }),
  );
}

// ─── GitHub OAuth Provider (optional) ───────────────────────────────────
// GitHub sign-in is open to every GitHub account unless it is restricted, so
// the provider is registered only with an explicit list of numeric account IDs.
const allowedGitHubIds = parseGitHubAllowedIds(process.env.GITHUB_ALLOWED_IDS);
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  if (allowedGitHubIds.size === 0) {
    console.warn(
      'GitHub sign-in is disabled: set GITHUB_ALLOWED_IDS to the numeric GitHub account IDs that may sign in.',
    );
  } else {
    providers.push(
      GitHub({
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
      }),
    );
  }
}

/**
 * On an Oathweave installation the `iam` callback was the retired password
 * relay. It now answers 410 Gone without reading the request.
 */
export const passwordRelayRetired = oathweaveInstallation;

/** Which sign-in controls the sign-in page shows. */
export const signInMethods = {
  oathweave: oidcConfig !== null,
  password: passwordSignIn,
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  trustHost: true,
  session: { strategy: 'jwt' },
  callbacks: {
    async signIn({ account }) {
      if (account?.provider === OATHWEAVE_PROVIDER_ID) {
        if (!oidcConfig || typeof account.id_token !== 'string') return false;
        try {
          const claims = await verifyOathweaveIdToken(oidcConfig, account.id_token);
          return claims.sub === account.providerAccountId;
        } catch (error) {
          console.warn(
            `Oathweave sign-in refused: ${error instanceof Error ? error.message : 'ID token not verified'}.`,
          );
          return false;
        }
      }
      if (account?.provider !== 'github') return true;
      return isGitHubAccountAllowed(account.providerAccountId, allowedGitHubIds);
    },
    jwt({ token, user, account, profile }) {
      if (user) {
        token.sub = user.id;
        // Fixed at sign-in and never renewed: Factory compares it with the
        // account's revocation time, and it bounds the session's total life.
        token.sessionIssuedAt = Math.floor(Date.now() / 1000);

        if (account?.provider === 'iam') {
          // Oathweave's own tokens are not kept: nothing in Author uses them,
          // and the session cookie should not carry them.
          token.username = normalizeIamUsername(user.iamUsername ?? user.email ?? user.name);
          token.roles = user.iamRoles;
          token.provider = 'iam';
        } else if (account?.provider === OATHWEAVE_PROVIDER_ID) {
          // Neither the ID token nor the access token is kept in the session.
          token.sub = account.providerAccountId;
          token.username = normalizeIamUsername(user.iamUsername);
          token.roles = user.iamRoles;
          token.provider = OATHWEAVE_PROVIDER_ID;
          token.oathweaveSubject = account.providerAccountId;
        } else if (account?.provider === 'github') {
          // Auth.js assigns a random user id on every OAuth sign-in when no
          // database adapter is configured. The provider account id is the
          // stable identity; the display name is free text and never is.
          token.sub = account.providerAccountId;
          token.username =
            typeof profile?.login === 'string' && profile.login
              ? profile.login
              : `github-${account.providerAccountId}`;
          token.provider = 'github';
        }
      }
      if (
        typeof token.sessionIssuedAt === 'number' &&
        Date.now() / 1000 - token.sessionIssuedAt > SESSION_MAX_LIFETIME_SECONDS
      ) {
        return null;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? '';
        session.user.username = typeof token.username === 'string' ? token.username : undefined;
        session.user.roles = Array.isArray(token.roles) ? (token.roles as string[]) : undefined;
        session.user.provider = typeof token.provider === 'string' ? token.provider : undefined;
        session.user.oathweaveSubject =
          typeof token.oathweaveSubject === 'string' ? token.oathweaveSubject : undefined;
        session.user.sessionIssuedAt =
          typeof token.sessionIssuedAt === 'number' ? token.sessionIssuedAt : undefined;
      }
      return session;
    },
  },
  pages: {
    signIn: '/auth/signin',
    // A refused Oathweave or GitHub sign-in returns to the sign-in page with
    // the error code, instead of Auth.js's own error page.
    error: '/auth/signin',
  },
});
