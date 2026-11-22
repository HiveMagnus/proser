import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MobileStateProvider,
  useMobileState,
  mobileStateStorageKey,
} from '@/contexts/mobile-state-context';
const identity = vi.hoisted(() => ({ userId: 'author-one' as string | undefined }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: identity.userId ? { user: { id: identity.userId } } : null }),
}));
beforeEach(() => {
  identity.userId = 'author-one';
  localStorage.clear();
});
function Consumer() {
  const state = useMobileState();
  return (
    <>
      <p data-testid="brief">{state.draftBrief || 'empty'}</p>
      <p data-testid="target">{state.lastSceneId ?? 'none'}</p>
      <button
        onClick={() => {
          state.setDraftBrief('Private owned premise');
          state.setLastDraftTarget('1', '2');
        }}
      >
        Keep draft brief
      </button>
    </>
  );
}
describe('mobile state ownership', () => {
  it('hides private draft context on logout and restores it only for the same authenticated author', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <MobileStateProvider>
        <Consumer />
      </MobileStateProvider>,
    );
    await user.click(screen.getByRole('button'));
    expect(screen.getByTestId('brief')).toHaveTextContent('Private owned premise');
    expect(JSON.parse(localStorage.getItem(mobileStateStorageKey('author-one'))!).userId).toBe(
      'author-one',
    );
    identity.userId = undefined;
    rerender(
      <MobileStateProvider>
        <Consumer />
      </MobileStateProvider>,
    );
    expect(screen.getByTestId('brief')).toHaveTextContent('empty');
    identity.userId = 'author-two';
    rerender(
      <MobileStateProvider>
        <Consumer />
      </MobileStateProvider>,
    );
    expect(screen.getByTestId('target')).toHaveTextContent('none');
    identity.userId = 'author-one';
    rerender(
      <MobileStateProvider>
        <Consumer />
      </MobileStateProvider>,
    );
    expect(screen.getByTestId('brief')).toHaveTextContent('Private owned premise');
  });
  it('preserves but does not reveal unscoped legacy context or a mismatched stored identity', () => {
    localStorage.setItem(
      'proser-mobile-state',
      JSON.stringify({ draftBrief: 'Unscoped private draft' }),
    );
    localStorage.setItem(
      mobileStateStorageKey('author-one'),
      JSON.stringify({
        schemaVersion: 1,
        userId: 'author-two',
        state: { draftBrief: 'Other author draft' },
      }),
    );
    render(
      <MobileStateProvider>
        <Consumer />
      </MobileStateProvider>,
    );
    expect(screen.getByTestId('brief')).toHaveTextContent('empty');
    expect(localStorage.getItem('proser-mobile-state')).toContain('Unscoped private draft');
  });
});
