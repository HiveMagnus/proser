'use client';

import { Loader2, ShieldOff } from 'lucide-react';
import { useBookAiPolicy, useSetBookAiPolicy } from '@/hooks/queries/use-book-ai-policy';

/** The per-book AI switch. Factory enforces it: while it is on, nothing in
 * this book is sent to a model provider. */
export function BookAiSetting({ bookId }: { bookId: string }) {
  const policy = useBookAiPolicy(bookId);
  const save = useSetBookAiPolicy(bookId);
  const aiDisabled = save.isPending ? save.variables : (policy.data?.aiDisabled ?? false);
  const unavailable = policy.isLoading || policy.isError || save.isPending;
  const descriptionId = `book-ai-setting-${bookId}-description`;

  return (
    <section className="rounded-[--radius-md] border border-border-default p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3
            id={`book-ai-setting-${bookId}-label`}
            className="flex items-center gap-2 text-[length:--text-sm] font-medium text-text-primary"
          >
            <ShieldOff className="size-4" aria-hidden="true" />
            Keep this book away from AI
          </h3>
          <p id={descriptionId} className="mt-1 text-[length:--text-xs] text-text-muted">
            When on, Proser refuses AI writing, revision, review, workflows and image generation for
            this book, and never sends its text to a model provider. You can still write, import and
            export.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={aiDisabled}
          aria-labelledby={`book-ai-setting-${bookId}-label`}
          aria-describedby={descriptionId}
          disabled={unavailable}
          onClick={() => save.mutate(!aiDisabled)}
          className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${aiDisabled ? 'border-accent-500 bg-accent-500' : 'border-border-strong bg-surface-raised'}`}
        >
          <span
            className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${aiDisabled ? 'translate-x-6' : 'translate-x-1'}`}
          />
        </button>
      </div>
      <p className="mt-2 text-[length:--text-xs] text-text-secondary" aria-live="polite">
        {save.isPending ? (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Saving…
          </span>
        ) : policy.isError ? (
          'The AI setting could not be loaded.'
        ) : save.isError ? (
          save.error instanceof Error ? (
            save.error.message
          ) : (
            'The AI setting could not be saved.'
          )
        ) : policy.isLoading ? (
          'Loading…'
        ) : aiDisabled ? (
          'AI is off for this book.'
        ) : (
          'AI features are available for this book.'
        )}
      </p>
    </section>
  );
}
