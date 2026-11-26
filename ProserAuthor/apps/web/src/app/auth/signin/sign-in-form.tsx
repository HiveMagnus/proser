'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { Loader2 } from 'lucide-react';

/**
 * A random `state` for the Oathweave redirect. The HiveXUI sign-in portal
 * requires one made of URL-safe characters; PKCE and the nonce carry the
 * security checks (see `auth.ts`).
 */
function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function initialError(serverError: string | null): string | null {
  if (!serverError) return null;
  if (serverError === 'CredentialsSignin') return 'Invalid username or password';
  if (serverError === 'AccessDenied') return 'Oathweave did not confirm this sign-in. Try again.';
  return 'Something went wrong. Please try again.';
}

export function SignInForm({
  callbackUrl,
  serverError,
  methods = { oathweave: false, password: true },
}: {
  callbackUrl: string;
  serverError: string | null;
  /** Which sign-in methods this installation offers. */
  methods?: { oathweave: boolean; password: boolean };
}) {
  const [error, setError] = useState<string | null>(initialError(serverError));
  const [redirecting, setRedirecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const formData = new FormData(e.currentTarget);
    const username = formData.get('username') as string;
    const password = formData.get('password') as string;
    const code = needsCode ? String(formData.get('code') ?? '') : '';

    try {
      const result = await signIn('iam', {
        username,
        password,
        ...(code ? { code } : {}),
        callbackUrl,
        redirect: false,
      });

      if (result?.error) {
        if (result.code === 'mfa_required') {
          setNeedsCode(true);
          setError(
            needsCode ? 'Enter the code from your authenticator app or a recovery code.' : null,
          );
        } else if (result.code === 'mfa_invalid') {
          setNeedsCode(true);
          setError('That authentication code was not accepted. Try again.');
        } else {
          setError(
            result.error === 'CredentialsSignin'
              ? 'Invalid username or password'
              : 'Something went wrong. Please try again.',
          );
        }
        setSubmitting(false);
        return;
      }

      // Successful — redirect manually so it works on all browsers
      window.location.href = result?.url || callbackUrl;
    } catch {
      setError('Unable to reach the authentication service. Please try again.');
      setSubmitting(false);
    }
  }

  async function signInWithOathweave() {
    setError(null);
    setRedirecting(true);
    try {
      await signIn('oathweave', { redirectTo: callbackUrl }, { state: randomState() });
    } catch {
      setError('Unable to reach the authentication service. Please try again.');
      setRedirecting(false);
    }
  }

  return (
    <>
      {error && (
        <div className="mb-4 rounded-[--radius-md] border border-red-500/30 bg-red-500/10 px-3 py-2 text-[length:--text-sm] text-red-400">
          {error}
        </div>
      )}

      {methods.oathweave && (
        <button
          type="button"
          onClick={signInWithOathweave}
          disabled={redirecting || submitting}
          className="flex w-full items-center justify-center gap-2 rounded-[--radius-md] bg-accent-600 px-4 py-2.5 text-[length:--text-sm] font-medium text-white hover:bg-accent-500 transition-colors duration-[--duration-normal] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {redirecting && <Loader2 className="size-4 animate-spin" />}
          Sign in with Oathweave
        </button>
      )}

      {methods.oathweave && methods.password && (
        <div className="my-4 flex items-center gap-3 text-[length:--text-xs] text-text-muted">
          <span className="h-px flex-1 bg-border-default" />
          or use your password
          <span className="h-px flex-1 bg-border-default" />
        </div>
      )}

      {methods.password && (
        <form onSubmit={handleSubmit}>
          <div className="space-y-3">
            <div>
              <label
                htmlFor="username"
                className="block text-[length:--text-sm] font-medium text-text-secondary mb-1"
              >
                Username
              </label>
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                required
                disabled={submitting}
                className="w-full rounded-[--radius-md] border border-border-default bg-surface-sunken px-3 py-2 text-[length:--text-sm] text-text-primary placeholder:text-text-muted focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 transition-colors duration-[--duration-normal]"
                placeholder="Enter your username"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="block text-[length:--text-sm] font-medium text-text-secondary mb-1"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={submitting}
                className="w-full rounded-[--radius-md] border border-border-default bg-surface-sunken px-3 py-2 text-[length:--text-sm] text-text-primary placeholder:text-text-muted focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 transition-colors duration-[--duration-normal]"
                placeholder="Enter your password"
              />
            </div>
            {needsCode && (
              <div>
                <label
                  htmlFor="code"
                  className="block text-[length:--text-sm] font-medium text-text-secondary mb-1"
                >
                  Authentication code
                </label>
                <p className="mb-1 text-[length:--text-xs] text-text-muted">
                  Your account uses two-step verification. Enter the code from your authenticator
                  app, or a recovery code.
                </p>
                <input
                  id="code"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  disabled={submitting}
                  className="w-full rounded-[--radius-md] border border-border-default bg-surface-sunken px-3 py-2 text-[length:--text-sm] text-text-primary placeholder:text-text-muted focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 transition-colors duration-[--duration-normal]"
                  placeholder="123456"
                />
              </div>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-[--radius-md] bg-accent-600 px-4 py-2.5 text-[length:--text-sm] font-medium text-white hover:bg-accent-500 transition-colors duration-[--duration-normal] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
