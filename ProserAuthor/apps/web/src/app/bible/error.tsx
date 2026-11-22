'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function BibleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Story Bible error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center animate-[fade-in_300ms_var(--ease-out-expo)]">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-[--radius-xl] bg-danger/10">
          <AlertTriangle className="size-8 text-danger" />
        </div>
        <h2 className="font-[--font-display] text-[length:--text-2xl] font-bold text-text-primary">
          Story Bible unavailable
        </h2>
        <p className="mt-2 text-[length:--text-sm] text-text-muted">
          {error.message || 'Failed to load your codex entries. The API may be unreachable.'}
        </p>
        {error.digest && (
          <p className="mt-1 font-[--font-mono] text-[length:--text-xs] text-text-muted/60">
            Error ID: {error.digest}
          </p>
        )}
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button variant="secondary" onClick={reset}>
            <RotateCcw className="mr-2 size-4" /> Retry
          </Button>
          <Button variant="ghost" asChild>
            <a href="/">
              <Home className="mr-2 size-4" /> Dashboard
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
