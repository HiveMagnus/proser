import NextAuth from 'next-auth';
import type { Provider } from 'next-auth/providers';
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
import { authorizeIamCredentials } from '@/lib/iam-auth';

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

function createIamCredentialsProvider(
  authorize: NonNullable<Parameters<typeof Credentials>[0]['authorize']>,
) {
  return Credentials({
    id: 'iam',
    name: 'Proser Login',
    credentials: {
      username: { label: 'Username', type: 'text' },
      password: { label: 'Password', type: 'password' },
      code: { label: 'Authentication code', type: 'text' },
    },
    authorize,
  });
}

// ─── IAM Credentials Provider (primary) ─────────────────────────────────
// Authenticates against the Oathweave IAM API, including its MFA challenge
const iamCoreUrl = process.env.IAM_CORE_URL;
if (iamCoreUrl) {
  providers.push(
    createIamCredentialsProvider((credentials, request) =>
      authorizeIamCredentials(iamCoreUrl, credentials, request),
    ),
  );
} else if (isLocalAuthAllowed) {
  const localAuthUsername = normalizeIamUsername(process.env.LOCAL_AUTH_USERNAME);
  const localAuthPassword = process.env.LOCAL_AUTH_PASSWORD || '';

  if (!localAuthUsername || !localAuthPassword) {
    throw new Error(
      'LOCAL_AUTH_ENABLED=true requires LOCAL_AUTH_USERNAME and LOCAL_AUTH_PASSWORD.',
    );
  }

  providers.push(
    createIamCredentialsProvider(async (credentials, request) => {
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

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  trustHost: true,
  session: { strategy: 'jwt' },
  callbacks: {
    signIn({ account }) {
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
        session.user.sessionIssuedAt =
          typeof token.sessionIssuedAt === 'number' ? token.sessionIssuedAt : undefined;
      }
      return session;
    },
  },
  pages: {
    signIn: '/auth/signin',
  },
});
