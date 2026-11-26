'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import { LogOut, Settings, Keyboard, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { Breadcrumbs, BreadcrumbItem } from '@/components/ui/breadcrumbs';

const routeLabels: Record<string, string> = {
  '': 'Dashboard',
  bible: 'Story Bible',
  plot: 'Plot Studio',
  manuscript: 'Manuscript',
  continuity: 'Continuity Radar',
  quality: 'Quality Board',
  workflows: 'Book Factory',
  editorial: 'Editorial',
  analytics: 'Analytics',
  publish: 'Publish Center',
  settings: 'Settings',
};

export function TopBar() {
  const pathname = usePathname();
  const { data: session } = useSession();

  const segments = pathname.split('/').filter(Boolean);
  const currentSection = segments[0] ?? '';
  const initials = session?.user?.name
    ? session.user.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : 'PR';

  return (
    <header
      className={cn(
        'flex h-12 shrink-0 items-center justify-between border-b border-border-muted bg-surface-sunken/50 px-6',
        'backdrop-blur-sm',
      )}
    >
      {/* ── Breadcrumb Trail ── */}
      <Breadcrumbs>
        <BreadcrumbItem href="/">Proser</BreadcrumbItem>
        {currentSection && (
          <BreadcrumbItem href={`/${currentSection}`}>
            {routeLabels[currentSection] ?? currentSection}
          </BreadcrumbItem>
        )}
        {segments.length > 1 && <BreadcrumbItem>{segments.slice(1).join(' / ')}</BreadcrumbItem>}
      </Breadcrumbs>

      {/* ── Right side ── */}
      <div className="flex items-center gap-3">
        {/* Keyboard shortcut hint */}
        <kbd className="hidden md:inline-flex items-center gap-1 rounded-[--radius-sm] border border-border-default bg-surface-raised px-2 py-0.5 font-[--font-mono] text-[10px] text-text-muted">
          <span className="text-[11px]">⌘</span>K
        </kbd>

        {/* ── User Menu ── */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-[--radius-md] p-1 transition-colors hover:bg-surface-hover cursor-pointer">
              <Avatar className="size-7">
                {session?.user?.image && <AvatarImage src={session.user.image} alt="" />}
                <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
              </Avatar>
              {session?.user?.name && (
                <span className="hidden text-[length:--text-sm] text-text-secondary md:inline">
                  {session.user.name}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-[length:--text-sm] font-medium text-text-primary">
                  {session?.user?.name ?? 'Writer'}
                </p>
                <p className="text-[length:--text-xs] text-text-muted">
                  {session?.user?.email ?? 'local session'}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <Settings className="mr-2 size-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true }));
              }}
            >
              <Keyboard className="mr-2 size-4" />
              Keyboard Shortcuts
            </DropdownMenuItem>
            <DropdownMenuItem>
              <HelpCircle className="mr-2 size-4" />
              Help & Docs
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => signOut({ callbackUrl: '/auth/signin' })}
              className="text-danger focus:text-danger"
            >
              <LogOut className="mr-2 size-4" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
