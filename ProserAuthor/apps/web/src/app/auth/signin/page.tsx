import { Feather } from 'lucide-react';
import { signInMethods } from '@/auth';
import { safeCallbackPath } from '@/lib/safe-callback-path';
import { SignInForm } from './sign-in-form';

export default async function SignInPage(props: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const searchParams = await props.searchParams;
  const error = searchParams.error ?? null;
  const requestedCallback = searchParams.callbackUrl || '/';
  const callbackUrl = safeCallbackPath(requestedCallback);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-base">
      {/* Atmospheric background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -left-1/4 w-full h-full rounded-full bg-accent-900/20 blur-[120px]" />
        <div className="absolute -bottom-1/4 -right-1/4 w-3/4 h-3/4 rounded-full bg-accent-800/10 blur-[100px]" />
      </div>

      <div className="relative z-10 w-full max-w-sm animate-[fade-in-scale_500ms_var(--ease-out-expo)]">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center">
          <div className="flex size-14 items-center justify-center rounded-[--radius-xl] bg-accent-500/15 shadow-[--shadow-glow]">
            <Feather className="size-7 text-accent-400" />
          </div>
          <h1 className="mt-4 font-[--font-display] text-[length:--text-3xl] font-bold tracking-tight text-text-primary">
            Proser
          </h1>
          <p className="mt-1 text-[length:--text-sm] text-text-muted">AI-native fiction studio</p>
        </div>

        {/* Card */}
        <div className="rounded-[--radius-xl] border border-border-default bg-surface-overlay/80 p-8 backdrop-blur-sm shadow-[--shadow-lg]">
          <div className="text-center mb-6">
            <h2 className="text-[length:--text-lg] font-semibold text-text-primary">
              Welcome back
            </h2>
            <p className="mt-1 text-[length:--text-sm] text-text-muted">
              Sign in to continue writing
            </p>
          </div>

          <SignInForm callbackUrl={callbackUrl} serverError={error} methods={signInMethods} />

          <div className="mt-6 text-center">
            <p className="text-[length:--text-xs] text-text-muted">
              {signInMethods.oathweave
                ? 'Authenticated via Oathweave'
                : 'Authenticated with a local account'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
