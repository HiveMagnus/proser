'use client';

import { Feather, MonitorSmartphone } from 'lucide-react';
import { useProtectedRouter as useRouter } from '@/hooks/use-protected-router';

import { MobileBottomNav } from './mobile-bottom-nav';
import { MOBILE_VIEW_COOKIE } from '@/lib/mobile-routing';
import { useMobileState } from '@/contexts/mobile-state-context';

export function MobileShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { setShellPreference } = useMobileState();

  function openDesktop() {
    document.cookie = `${MOBILE_VIEW_COOKIE}=desktop; Path=/; Max-Age=31536000; SameSite=Lax`;
    setShellPreference('desktop');
    router.push('/');
  }

  return (
    <div className="min-h-screen bg-surface-base text-text-primary">
      <header className="sticky top-0 z-30 border-b border-border-muted/60 bg-surface-base/90 px-4 backdrop-blur-lg">
        <div className="mx-auto flex max-w-md items-center justify-between gap-3 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-[--radius-md] bg-accent-500/15">
              <Feather className="size-4 text-accent-400" />
            </div>
            <div className="leading-tight">
              <p className="font-[--font-display] text-[length:--text-sm] font-semibold">
                Proser Mobile
              </p>
              <p className="text-[length:--text-[10px]] text-text-muted">
                Revise and read on mobile
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={openDesktop}
            className="flex items-center gap-1.5 rounded-full bg-surface-sunken/80 px-3 py-1.5 text-[length:--text-[10px]] font-medium text-text-secondary transition-all duration-200 hover:bg-surface-hover hover:text-text-primary active:scale-95"
          >
            <MonitorSmartphone className="size-3.5" />
            Desktop
          </button>
        </div>
      </header>

      <main className="mobile-page-enter mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-md flex-col px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-4">
        {children}
      </main>

      <MobileBottomNav />
    </div>
  );
}
