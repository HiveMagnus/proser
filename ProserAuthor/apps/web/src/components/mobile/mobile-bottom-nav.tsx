'use client';

import { usePathname } from 'next/navigation';
import { BookOpenCheck, BookOpenText, Home, Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';

const navItems = [
  { href: '/m', label: 'Home', icon: Home },
  { href: '/m/studio', label: 'Studio', icon: Sparkles },
  { href: '/m/read', label: 'Read', icon: BookOpenText },
  { href: '/m/editorial', label: 'Edit', icon: BookOpenCheck },
];

export function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-1">
      <div className="mx-auto flex max-w-md items-center justify-around rounded-2xl border border-border-muted/40 bg-surface-overlay/90 px-2 py-1.5 shadow-lg shadow-black/20 backdrop-blur-xl">
        {navItems.map((item) => {
          const active = pathname === item.href;
          return (
            <a
              key={item.href}
              href={item.href}
              className={cn(
                'mobile-nav-item relative flex flex-col items-center gap-0.5 rounded-xl px-5 py-1.5 text-[length:--text-[10px]] font-medium transition-all duration-300',
                active
                  ? 'text-accent-300'
                  : 'text-text-secondary hover:text-text-primary active:scale-95',
              )}
            >
              {active && (
                <span className="absolute inset-0 rounded-xl bg-accent-500/12 mobile-nav-pill" />
              )}
              <item.icon
                className={cn(
                  'relative z-10 size-4.5 transition-transform duration-300',
                  active && 'scale-110',
                )}
              />
              <span className="relative z-10">{item.label}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
