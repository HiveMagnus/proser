'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { Loader2 } from 'lucide-react';

export function SignInForm({
  callbackUrl,
  serverError,
}: {
  callbackUrl: string;
  serverError: string | null;
}) {
  const [error, setError] = useState<string | null>(
    serverError === 'CredentialsSignin'
      ? 'Invalid username or password'
      : serverError
        ? 'Something went wrong. Please try again.'
        : null,
  );
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const formData = new FormData(e.currentTarget);
    const username = formData.get('username') as string;
    const password = formData.get('password') as string;

    try {
      const result = await signIn('iam', {
        username,
        password,
        callbackUrl,
        redirect: false,
      });

      if (result?.error) {
        setError(
          result.error === 'CredentialsSignin'
            ? 'Invalid username or password'
            : 'Something went wrong. Please try again.',
        );
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

  return (
    <>
      {error && (
        <div className="mb-4 rounded-[--radius-md] border border-red-500/30 bg-red-500/10 px-3 py-2 text-[length:--text-sm] text-red-400">
          {error}
        </div>
      )}

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
    </>
  );
}
