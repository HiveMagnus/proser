import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { centerCaret, setWritingView, useWritingView } from '@/lib/writing-view';

const navigation = vi.hoisted(() => ({ pathname: '/manuscript' }));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSession: () => ({ data: { user: { id: 'writer-1' } } }),
  signOut: vi.fn(),
}));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => <nav>App sidebar</nav> }));
vi.mock('@/components/layout/top-bar', () => ({ TopBar: () => <header>App top bar</header> }));
vi.mock('@/components/layout/command-palette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/layout/keyboard-shortcuts', () => ({ KeyboardShortcutsDialog: () => null }));
vi.mock('@/components/layout/onboarding-banner', () => ({ OnboardingBanner: () => null }));
vi.mock('@/components/layout/generation-recovery-banner', () => ({
  GenerationRecoveryBanner: () => null,
}));

import { AppShell } from '@/components/layout/app-shell';

function Toggle() {
  const view = useWritingView();
  return (
    <button onClick={() => setWritingView({ focus: !view.focus })}>
      {view.focus ? 'Exit focus' : 'Focus'}
    </button>
  );
}

describe('focus mode', () => {
  beforeEach(() => {
    navigation.pathname = '/manuscript';
    act(() => setWritingView({ focus: false, typewriter: false }));
  });

  it('hides the sidebar and top bar around the manuscript and brings them back', async () => {
    render(
      <AppShell>
        <Toggle />
      </AppShell>,
    );
    expect(screen.getByText('App sidebar')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Focus' }));
    expect(screen.queryByText('App sidebar')).not.toBeInTheDocument();
    expect(screen.queryByText('App top bar')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('proser-writing-view') ?? '{}').focus).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Exit focus' }));
    expect(screen.getByText('App top bar')).toBeInTheDocument();
  });

  it('keeps the chrome on other pages', () => {
    navigation.pathname = '/plot';
    act(() => setWritingView({ focus: true }));
    render(
      <AppShell>
        <Toggle />
      </AppShell>,
    );
    expect(screen.getByText('App sidebar')).toBeInTheDocument();
  });
});

describe('typewriter scrolling', () => {
  it('scrolls the editor so the insertion point sits in the middle', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'scrollHeight', { value: 5000 });
    Object.defineProperty(scroller, 'clientHeight', { value: 600 });
    scroller.getBoundingClientRect = () => ({ top: 0, height: 600 }) as DOMRect;
    const input = document.createElement('textarea');
    input.className = 'ce-inputarea';
    input.getBoundingClientRect = () => ({ top: 520, height: 20 }) as DOMRect;
    scroller.append(input);
    document.body.append(scroller);
    input.focus();
    expect(centerCaret()).toBe(true);
    expect(scroller.scrollTop).toBe(230);
    input.getBoundingClientRect = () => ({ top: 300, height: 20 }) as DOMRect;
    expect(centerCaret()).toBe(false);
    scroller.remove();
  });
});
