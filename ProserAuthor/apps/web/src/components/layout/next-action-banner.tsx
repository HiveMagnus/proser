'use client';

import * as React from 'react';
import Link from 'next/link';
import { X, Lightbulb, ArrowRight } from 'lucide-react';
import { useWorkspace } from '@/contexts/workspace-context';
import { useRecommendations } from '@/hooks/queries/use-recommendations';
import { FadeIn } from '@/components/motion/primitives';

export function NextActionBanner() {
  const { activeBookId } = useWorkspace();
  const { data: recommendations } = useRecommendations(activeBookId);
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());

  const visible = (recommendations ?? []).filter((r) => !dismissed.has(r.action));
  const top = visible[0];

  if (!top || !activeBookId) return null;

  return (
    <FadeIn>
      <div className="border-b border-border-muted bg-accent-500/5 px-4 py-2 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <Lightbulb className="size-4 shrink-0 text-accent-400" />
          <span className="flex-1 text-[length:--text-sm] text-text-secondary truncate">
            <strong className="font-medium text-text-primary">{top.label}</strong>
            <span className="hidden sm:inline"> — {top.description}</span>
          </span>
          <Link
            href={top.href}
            className="inline-flex items-center gap-1 rounded-[--radius-md] bg-accent-500/10 px-3 py-1 text-[length:--text-xs] font-medium text-accent-300 hover:bg-accent-500/20 transition-colors shrink-0"
          >
            Go <ArrowRight className="size-3" />
          </Link>
          <button
            onClick={() => setDismissed((prev) => new Set(prev).add(top.action))}
            className="text-text-muted hover:text-text-secondary transition-colors cursor-pointer shrink-0"
            aria-label="Dismiss recommendation"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </FadeIn>
  );
}
