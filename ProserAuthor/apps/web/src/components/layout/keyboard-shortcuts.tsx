'use client';

import * as React from 'react';
import { X, Keyboard } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ShortcutGroup {
  label: string;
  shortcuts: { keys: string[]; description: string }[];
}

const shortcutGroups: ShortcutGroup[] = [
  {
    label: 'General',
    shortcuts: [
      { keys: ['⌘', 'K'], description: 'Open command palette' },
      { keys: ['⌘', '/'], description: 'Keyboard shortcuts reference' },
      { keys: ['Esc'], description: 'Close dialog / dismiss' },
    ],
  },
  {
    label: 'Navigation',
    shortcuts: [
      { keys: ['⌘', '1'], description: 'Go to Dashboard' },
      { keys: ['⌘', '2'], description: 'Go to Story Bible' },
      { keys: ['⌘', '3'], description: 'Go to Plot Studio' },
      { keys: ['⌘', '4'], description: 'Go to Manuscript' },
      { keys: ['⌘', '5'], description: 'Go to Continuity Radar' },
      { keys: ['⌘', '6'], description: 'Go to Quality Board' },
      { keys: ['⌘', '7'], description: 'Go to Analytics' },
      { keys: ['⌘', '8'], description: 'Go to Publish Center' },
    ],
  },
  {
    label: 'Editor',
    shortcuts: [
      { keys: ['⌘', 'S'], description: 'Save current scene' },
      { keys: ['⌘', 'B'], description: 'Bold' },
      { keys: ['⌘', 'I'], description: 'Italic' },
      { keys: ['⌘', 'Z'], description: 'Undo' },
      { keys: ['⌘', '⇧', 'Z'], description: 'Redo' },
    ],
  },
];

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === '/' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-[fade-in_100ms_ease-out]"
        onClick={() => setOpen(false)}
      />

      <div className="absolute left-1/2 top-[10%] w-full max-w-lg -translate-x-1/2 animate-[fade-in-scale_200ms_var(--ease-out-expo)]">
        <div
          className={cn(
            'rounded-[--radius-xl] border border-border-default bg-surface-overlay shadow-[--shadow-lg]',
            'overflow-hidden',
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border-muted px-5 py-3.5">
            <div className="flex items-center gap-2.5">
              <Keyboard className="size-4 text-text-muted" />
              <h2 className="text-[length:--text-base] font-semibold text-text-primary">
                Keyboard Shortcuts
              </h2>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-[--radius-sm] p-1 text-text-muted hover:text-text-primary transition-colors cursor-pointer"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Content */}
          <div className="max-h-[60vh] overflow-y-auto p-5 space-y-6">
            {shortcutGroups.map((group) => (
              <div key={group.label}>
                <h3 className="mb-2.5 text-[length:--text-xs] font-medium uppercase tracking-wider text-text-muted">
                  {group.label}
                </h3>
                <div className="space-y-1">
                  {group.shortcuts.map((shortcut) => (
                    <div
                      key={shortcut.description}
                      className="flex items-center justify-between rounded-[--radius-md] px-2.5 py-1.5 hover:bg-surface-hover transition-colors"
                    >
                      <span className="text-[length:--text-sm] text-text-primary">
                        {shortcut.description}
                      </span>
                      <div className="flex items-center gap-1">
                        {shortcut.keys.map((key) => (
                          <kbd
                            key={key}
                            className="inline-flex min-w-6 items-center justify-center rounded-[--radius-sm] border border-border-default bg-surface-raised px-1.5 py-0.5 font-[--font-mono] text-[10px] text-text-secondary"
                          >
                            {key}
                          </kbd>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="border-t border-border-muted px-5 py-2.5 text-[length:--text-xs] text-text-muted">
            Tip: On Linux/Windows, use{' '}
            <kbd className="rounded-[--radius-sm] border border-border-default bg-surface-raised px-1 py-px font-[--font-mono] text-[10px]">
              Ctrl
            </kbd>{' '}
            instead of{' '}
            <kbd className="rounded-[--radius-sm] border border-border-default bg-surface-raised px-1 py-px font-[--font-mono] text-[10px]">
              ⌘
            </kbd>
          </div>
        </div>
      </div>
    </div>
  );
}
