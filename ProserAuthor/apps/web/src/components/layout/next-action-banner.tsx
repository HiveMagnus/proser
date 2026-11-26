'use client';

import * as React from 'react';
import Link from 'next/link';
import { X, Lightbulb, ArrowRight } from 'lucide-react';
import { useWorkspace } from '@/contexts/workspace-context';
import { useRecommendations } from '@/hooks/queries/use-writing-stats';
import { FadeIn } from '@/components/motion/primitives';

/** The most useful next step for the open book, from Factory's recommendations. */
export function NextActionBanner() {
  const { activeBookId } = useWorkspace();
  const { data: recommendations } = useRecommendations(activeBookId);
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());

  const top = (recommendations ?? []).find((item) => !dismissed.has(item.id));
  if (!top || !activeBookId) return null;

  return (
    <FadeIn>
      <div className="border-b border-border-muted bg-accent-500/5 px-4 py-2 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <Lightbulb className="size-4 shrink-0 text-accent-400" aria-hidden="true" />
          <span className="flex-1 truncate text-[length:--text-sm] text-text-secondary">
            <strong className="font-medium text-text-primary">{top.title}</strong>
            <span className="hidden sm:inline"> — {top.detail}</span>
          </span>
          <Link
            href={top.href}
            className="inline-flex shrink-0 items-center gap-1 rounded-[--radius-md] bg-accent-500/10 px-3 py-1 text-[length:--text-xs] font-medium text-accent-300 transition-colors hover:bg-accent-500/20"
          >
            Go <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
          <button
            onClick={() => setDismissed((previous) => new Set(previous).add(top.id))}
            className="shrink-0 cursor-pointer text-text-muted transition-colors hover:text-text-secondary"
            aria-label="Dismiss recommendation"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </FadeIn>
  );
}
