'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BookOpen,
  LayoutDashboard,
  Map,
  PenTool,
  FileOutput,
  Settings,
  ChevronLeft,
  ChevronRight,
  Feather,
  BookOpenCheck,
  Workflow,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { useWorkspace } from '@/contexts/workspace-context';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  segment: string;
}

const navItems: NavItem[] = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard, segment: '' },
  { label: 'Story Bible', href: '/bible', icon: BookOpen, segment: 'bible' },
  { label: 'Plot Studio', href: '/plot', icon: Map, segment: 'plot' },
  { label: 'Manuscript', href: '/manuscript', icon: PenTool, segment: 'manuscript' },
  { label: 'Book Factory', href: '/workflows', icon: Workflow, segment: 'workflows' },
  { label: 'Editorial', href: '/editorial', icon: BookOpenCheck, segment: 'editorial' },
  { label: 'Publish', href: '/publish', icon: FileOutput, segment: 'publish' },
];

const bottomNavItems: NavItem[] = [
  { label: 'Settings', href: '/settings', icon: Settings, segment: 'settings' },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const { activeBookTitle } = useWorkspace();

  // Auto-collapse on small viewports
  React.useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) setCollapsed(true);
    };
    onChange(mq);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const activeSegment = pathname.split('/')[1] ?? '';

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'flex h-screen shrink-0 flex-col border-r border-border-muted bg-surface-sunken',
          'transition-all duration-[--duration-slow] ease-[--ease-out-expo]',
          collapsed ? 'w-16' : 'w-56',
        )}
      >
        {/* ── Logo ─────────────────── */}
        <div className="flex h-14 items-center gap-3 border-b border-border-muted px-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-[--radius-md] bg-accent-500/15">
            <Feather className="size-4 text-accent-400" />
          </div>
          {!collapsed && (
            <span className="font-[--font-display] text-[length:--text-lg] font-bold tracking-tight text-text-primary animate-[slide-in-left_300ms_var(--ease-out-expo)]">
              Proser
            </span>
          )}
        </div>

        {/* ── Active Book Indicator ── */}
        {activeBookTitle && !collapsed && (
          <div className="border-b border-border-muted px-4 py-2">
            <p className="text-[length:--text-xs] font-medium text-text-muted uppercase tracking-wider">
              Working on
            </p>
            <p className="text-[length:--text-sm] font-medium text-accent-300 truncate">
              {activeBookTitle}
            </p>
          </div>
        )}

        {/* ── Primary Nav ──────────── */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <ul className="space-y-0.5">
            {navItems.map((item) => {
              const active = item.segment === activeSegment;
              return (
                <li key={item.href}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        href={item.href}
                        className={cn(
                          'group flex items-center gap-3 rounded-[--radius-md] px-3 py-2 text-[length:--text-sm]',
                          'transition-all duration-[--duration-normal]',
                          active
                            ? 'bg-accent-500/10 text-accent-300 font-medium'
                            : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover',
                        )}
                      >
                        <item.icon
                          className={cn(
                            'size-4.5 shrink-0 transition-colors',
                            active
                              ? 'text-accent-400'
                              : 'text-text-muted group-hover:text-text-secondary',
                          )}
                        />
                        {!collapsed && <span>{item.label}</span>}
                      </Link>
                    </TooltipTrigger>
                    {collapsed && <TooltipContent side="right">{item.label}</TooltipContent>}
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* ── Bottom Nav ───────────── */}
        <div className="border-t border-border-muted px-2 py-3">
          <ul className="space-y-0.5">
            {bottomNavItems.map((item) => {
              const active = item.segment === activeSegment;
              return (
                <li key={item.href}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        href={item.href}
                        className={cn(
                          'group flex items-center gap-3 rounded-[--radius-md] px-3 py-2 text-[length:--text-sm]',
                          'transition-all duration-[--duration-normal]',
                          active
                            ? 'bg-accent-500/10 text-accent-300 font-medium'
                            : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover',
                        )}
                      >
                        <item.icon
                          className={cn(
                            'size-4.5 shrink-0 transition-colors',
                            active
                              ? 'text-accent-400'
                              : 'text-text-muted group-hover:text-text-secondary',
                          )}
                        />
                        {!collapsed && <span>{item.label}</span>}
                      </Link>
                    </TooltipTrigger>
                    {collapsed && <TooltipContent side="right">{item.label}</TooltipContent>}
                  </Tooltip>
                </li>
              );
            })}
          </ul>

          {/* ── Collapse toggle ──── */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={cn(
              'mt-2 flex w-full items-center justify-center rounded-[--radius-md] py-1.5',
              'text-text-muted hover:text-text-secondary hover:bg-surface-hover',
              'transition-all duration-[--duration-normal] cursor-pointer',
            )}
          >
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
