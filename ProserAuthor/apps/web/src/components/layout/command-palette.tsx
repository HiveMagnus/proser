'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import {
  Search,
  X,
  BookOpen,
  BookOpenCheck,
  PenTool,
  Settings,
  BarChart3,
  Map,
  Feather,
} from 'lucide-react';
import { useProtectedRouter as useRouter } from '@/hooks/use-protected-router';
import { cn } from '@/lib/utils';

interface CommandItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  group: string;
}

const commands: CommandItem[] = [
  { label: 'Dashboard', href: '/', icon: BarChart3, group: 'Navigation' },
  { label: 'Story Bible', href: '/bible', icon: BookOpen, group: 'Navigation' },
  { label: 'Plot Studio', href: '/plot', icon: Map, group: 'Navigation' },
  { label: 'Manuscript', href: '/manuscript', icon: PenTool, group: 'Navigation' },
  { label: 'Quality Board', href: '/quality', icon: Feather, group: 'Navigation' },
  { label: 'Editorial', href: '/editorial', icon: BookOpenCheck, group: 'Navigation' },
  { label: 'Settings', href: '/settings', icon: Settings, group: 'Navigation' },
];

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const handleSelect = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-[fade-in_100ms_ease-out]"
        onClick={() => setOpen(false)}
      />

      {/* Command dialog */}
      <div className="absolute left-1/2 top-[20%] w-full max-w-lg -translate-x-1/2 animate-[fade-in-scale_200ms_var(--ease-out-expo)]">
        <CommandPrimitive
          className={cn(
            'rounded-[--radius-xl] border border-border-default bg-surface-overlay shadow-[--shadow-lg]',
            'overflow-hidden',
          )}
        >
          <div className="flex items-center border-b border-border-muted px-4">
            <Search className="mr-2 size-4 shrink-0 text-text-muted" />
            <CommandPrimitive.Input
              placeholder="Type a command or search..."
              className={cn(
                'flex h-12 w-full bg-transparent py-3 text-[length:--text-base] text-text-primary',
                'outline-none placeholder:text-text-muted',
              )}
            />
            <button
              onClick={() => setOpen(false)}
              className="ml-2 rounded-[--radius-sm] p-1 text-text-muted hover:text-text-primary transition-colors cursor-pointer"
            >
              <X className="size-4" />
            </button>
          </div>

          <CommandPrimitive.List className="max-h-72 overflow-y-auto p-2">
            <CommandPrimitive.Empty className="py-6 text-center text-[length:--text-sm] text-text-muted">
              No results found.
            </CommandPrimitive.Empty>

            {Object.entries(
              commands.reduce(
                (acc, cmd) => {
                  (acc[cmd.group] ??= []).push(cmd);
                  return acc;
                },
                {} as Record<string, CommandItem[]>,
              ),
            ).map(([group, items]) => (
              <CommandPrimitive.Group
                key={group}
                heading={group}
                className="**:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-[length:--text-xs] **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-text-muted"
              >
                {items.map((item) => (
                  <CommandPrimitive.Item
                    key={item.href}
                    value={item.label}
                    onSelect={() => handleSelect(item.href)}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-[--radius-md] px-2.5 py-2',
                      'text-[length:--text-sm] text-text-primary',
                      'aria-selected:bg-surface-hover',
                      'transition-colors duration-[--duration-fast]',
                    )}
                  >
                    <item.icon className="size-4 text-text-muted" />
                    <span>{item.label}</span>
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            ))}
          </CommandPrimitive.List>

          <div className="flex items-center justify-between border-t border-border-muted px-4 py-2 text-[length:--text-xs] text-text-muted">
            <span>Navigate with ↑↓ keys</span>
            <kbd className="rounded-[--radius-sm] border border-border-default bg-surface-raised px-1.5 py-0.5 font-[--font-mono] text-[10px]">
              ESC
            </kbd>
          </div>
        </CommandPrimitive>
      </div>
    </div>
  );
}
