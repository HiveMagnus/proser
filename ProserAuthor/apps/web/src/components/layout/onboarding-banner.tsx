'use client';

import * as React from 'react';
import { X, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

interface OnboardingTip {
  id: string;
  title: string;
  description: string;
}

const tips: OnboardingTip[] = [
  {
    id: 'command-palette',
    title: 'Quick navigation',
    description: 'Press ⌘K (or Ctrl+K) to open the command palette and jump anywhere instantly.',
  },
  {
    id: 'story-bible',
    title: 'Build your world first',
    description:
      'Start with the Story Bible to define characters, locations, and lore — AI uses these for consistent prose.',
  },
  {
    id: 'plot-structure',
    title: 'Structure your story',
    description:
      'Use Plot Studio to define your narrative archetype, plot threads, and story beats before writing.',
  },
  {
    id: 'ai-generation',
    title: 'AI-assisted writing',
    description:
      'In the Manuscript editor, highlight text and use AI to rewrite, expand, or continue your prose.',
  },
  {
    id: 'keyboard-shortcuts',
    title: 'Keyboard shortcuts',
    description: 'Press ⌘/ (or Ctrl+/) to see all available keyboard shortcuts.',
  },
];

const STORAGE_KEY = 'proser-onboarding-dismissed';

function getDismissed(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function setDismissed(ids: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

export function OnboardingBanner() {
  const [dismissed, setDismissedState] = React.useState<string[]>([]);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setDismissedState(getDismissed());
    setMounted(true);
  }, []);

  const activeTips = tips.filter((t) => !dismissed.includes(t.id));

  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissedState(next);
    setDismissed(next);
  };

  const dismissAll = () => {
    const next = tips.map((t) => t.id);
    setDismissedState(next);
    setDismissed(next);
  };

  if (!mounted || activeTips.length === 0) return null;

  const tip = activeTips[0]!;

  return (
    <div className="animate-[slide-down_300ms_var(--ease-out-expo)]">
      <div
        className={cn(
          'flex items-start gap-3 rounded-[--radius-lg] border border-accent-500/20 bg-accent-500/5 px-4 py-3',
        )}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-[--radius-md] bg-accent-500/10">
          <Sparkles className="size-4 text-accent-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[length:--text-sm] font-medium text-text-primary">{tip.title}</p>
          <p className="mt-0.5 text-[length:--text-xs] text-text-secondary">{tip.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {activeTips.length > 1 && (
            <span className="text-[length:--text-xs] text-text-muted">
              {tips.length - activeTips.length + 1}/{tips.length}
            </span>
          )}
          {activeTips.length > 1 && (
            <button
              onClick={dismissAll}
              className="text-[length:--text-xs] text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
            >
              Skip all
            </button>
          )}
          <button
            onClick={() => dismiss(tip.id)}
            className="rounded-[--radius-sm] p-1 text-text-muted hover:text-text-primary transition-colors cursor-pointer"
            aria-label="Dismiss tip"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
