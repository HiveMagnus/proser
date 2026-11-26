import { CredentialsSignin } from 'next-auth';

import {
  clearLocalAuthFailures,
  localAuthAccount,
  localAuthFailureAllowed,
  localAuthSource,
  recordLocalAuthFailure,
} from '@/lib/local-auth';

/** The password was accepted and the account needs its second factor. */
export class MfaRequiredError extends CredentialsSignin {
  code = 'mfa_required';
}

/** The second-factor code was rejected. */
export class MfaInvalidError extends CredentialsSignin {
  code = 'mfa_invalid';
}

export interface IamCredentials {
  username?: unknown;
  password?: unknown;
  code?: unknown;
}

export interface IamSignInUser {
  id: string;
  name: string;
  email: string;
  image: null;
  iamAccessToken: string;
  iamRefreshToken: string | null;
  iamUsername: string;
  iamRoles: string[];
}

interface IamTokenResponse {
  accessToken?: string;
  refreshToken?: string;
  requiresMfa?: boolean;
  mfaToken?: string;
  user?: {
    id: string;
    email: string;
    username: string;
    displayName?: string | null;
    roles?: string[];
  };
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<{ ok: boolean; data: IamTokenResponse }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, data: {} };
  return { ok: true, data: (await res.json()) as IamTokenResponse };
}

function signedInUser(data: IamTokenResponse): IamSignInUser | null {
  if (!data.accessToken || !data.user) return null;
  return {
    id: data.user.id,
    name: data.user.displayName || data.user.username,
    email: data.user.email,
    image: null,
    // Stash IAM info for the jwt callback
    iamAccessToken: data.accessToken,
    iamRefreshToken: data.refreshToken ?? null,
    iamUsername: data.user.username,
    iamRoles: data.user.roles ?? [],
  };
}

/**
 * Sign in through Oathweave's password login. Accounts with MFA get a
 * short-lived challenge token instead of tokens; the form then resubmits the
 * password with the authenticator or recovery code, which completes the
 * challenge. Failed passwords and codes share the local failure throttle.
 */
export async function authorizeIamCredentials(
  iamCoreUrl: string,
  credentials: IamCredentials | undefined,
  request: Request,
  fetchImpl: typeof fetch = fetch,
): Promise<IamSignInUser | null> {
  const username = String(credentials?.username ?? '').trim();
  const password = String(credentials?.password ?? '');
  const code = String(credentials?.code ?? '').replace(/\s+/g, '');
  if (!username || !password) return null;

  const source = localAuthSource(request);
  const account = localAuthAccount(username.toLowerCase());
  if (!localAuthFailureAllowed(source, account)) return null;

  let login: { ok: boolean; data: IamTokenResponse };
  try {
    login = await postJson(fetchImpl, `${iamCoreUrl}/api/v1/auth/login`, { username, password });
  } catch {
    return null;
  }
  if (!login.ok) {
    recordLocalAuthFailure(source, account);
    return null;
  }

  if (login.data.requiresMfa && login.data.mfaToken) {
    if (!code) throw new MfaRequiredError();
    let challenge: { ok: boolean; data: IamTokenResponse };
    try {
      challenge = await postJson(fetchImpl, `${iamCoreUrl}/api/v1/auth/mfa/challenge`, {
        mfaToken: login.data.mfaToken,
        code,
      });
    } catch {
      return null;
    }
    const user = challenge.ok ? signedInUser(challenge.data) : null;
    if (!user) {
      recordLocalAuthFailure(source, account);
      throw new MfaInvalidError();
    }
    clearLocalAuthFailures(source, account);
    return user;
  }

  const user = signedInUser(login.data);
  if (user) clearLocalAuthFailures(source, account);
  return user;
}
