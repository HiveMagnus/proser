'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { installDocumentHistoryTracking } from '@/lib/document-history-navigation';
import { registerServiceWorker } from '@/lib/service-worker';
import { SessionProvider } from 'next-auth/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/query-client';
import { WorkspaceProvider } from '@/contexts/workspace-context';
import { MotionProvider } from '@/contexts/motion-context';
import { MobileStateProvider } from '@/contexts/mobile-state-context';
import { isMobilePath } from '@/lib/mobile-routing';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';
import { CommandPalette } from './command-palette';
import { KeyboardShortcutsDialog } from './keyboard-shortcuts';
import { OnboardingBanner } from './onboarding-banner';
import { NextActionBanner } from './next-action-banner';
import { GenerationRecoveryBanner } from './generation-recovery-banner';
import { useNavigationShortcuts } from '@/hooks/use-navigation-shortcuts';
import { useWritingView } from '@/lib/writing-view';
import { Toaster } from 'sonner';
import { MobileShell } from '@/components/mobile/mobile-shell';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = pathname.startsWith('/auth');
  const isMobilePage = isMobilePath(pathname);
  const queryClient = getQueryClient();
  const { focus } = useWritingView();
  // Focus mode applies only to the desktop manuscript; other pages keep their chrome.
  const focused = focus && pathname === '/manuscript';
  useNavigationShortcuts(!isMobilePage);
  useEffect(() => installDocumentHistoryTracking(), []);
  useEffect(() => void registerServiceWorker(), []);

  // Auth pages render without the shell chrome
  if (isAuthPage) {
    return <SessionProvider>{children}</SessionProvider>;
  }

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <MotionProvider>
          <WorkspaceProvider>
            <MobileStateProvider>
              {isMobilePage ? (
                <MobileShell>{children}</MobileShell>
              ) : (
                <div
                  className="flex h-screen overflow-hidden bg-surface-base"
                  data-focus-mode={focused ? 'on' : undefined}
                >
                  {!focused && <Sidebar />}
                  <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                    {!focused && <TopBar />}
                    {!focused && <NextActionBanner />}
                    <GenerationRecoveryBanner />
                    <main className="flex-1 overflow-y-auto">
                      <div
                        className={
                          focused
                            ? 'mx-auto max-w-4xl p-4 sm:p-8'
                            : 'mx-auto max-w-7xl p-4 sm:p-6 lg:p-8'
                        }
                      >
                        {pathname !== '/manuscript' && <OnboardingBanner />}
                        {children}
                      </div>
                    </main>
                  </div>
                  <CommandPalette />
                  <KeyboardShortcutsDialog />
                </div>
              )}
              <Toaster
                position={isMobilePage ? 'top-center' : 'bottom-right'}
                theme="dark"
                toastOptions={{
                  style: {
                    background: 'var(--color-surface-overlay)',
                    border: '1px solid var(--color-border-default)',
                    color: 'var(--color-text-primary)',
                    fontFamily: 'var(--font-body)',
                  },
                }}
              />
            </MobileStateProvider>
          </WorkspaceProvider>
        </MotionProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}
