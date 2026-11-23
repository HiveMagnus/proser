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

const providers: Provider[] = [];
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
    },
    authorize,
  });
}

// ─── IAM Credentials Provider (primary) ─────────────────────────────────
// Authenticates against Magnus IAM Core API
const iamCoreUrl = process.env.IAM_CORE_URL;
if (iamCoreUrl) {
  providers.push(
    createIamCredentialsProvider(async (credentials) => {
      if (!credentials?.username || !credentials?.password) return null;

      try {
        const res = await fetch(`${iamCoreUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: credentials.username,
            password: credentials.password,
          }),
        });

        if (!res.ok) return null;

        const data = await res.json();
        if (!data.accessToken || !data.user) return null;

        return {
          id: data.user.id,
          name: data.user.displayName || data.user.username,
          email: data.user.email,
          image: null,
          // Stash IAM info for the jwt callback
          iamAccessToken: data.accessToken,
          iamRefreshToken: data.refreshToken,
          iamUsername: data.user.username,
          iamRoles: data.user.roles,
        };
      } catch {
        return null;
      }
    }),
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
        iamAccessToken: 'local-dev-token',
        iamRefreshToken: null,
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

        if (account?.provider === 'iam') {
          // Store IAM-specific data in the token
          token.iamAccessToken = user.iamAccessToken;
          token.iamRefreshToken = user.iamRefreshToken;
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
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? '';
        session.user.username = typeof token.username === 'string' ? token.username : undefined;
        session.user.roles = Array.isArray(token.roles) ? (token.roles as string[]) : undefined;
        session.user.provider = typeof token.provider === 'string' ? token.provider : undefined;
      }
      return session;
    },
  },
  pages: {
    signIn: '/auth/signin',
  },
});
