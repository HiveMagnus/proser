import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceProvider, useWorkspace, workspaceStorageKey } from '@/contexts/workspace-context';
const identity = vi.hoisted(() => ({ userId: 'author-one' as string | undefined }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: identity.userId ? { user: { id: identity.userId } } : null }),
}));

// Mock localStorage
const storage = new Map<string, string>();
beforeEach(() => {
  identity.userId = 'author-one';
  storage.clear();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => storage.get(key) ?? null);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => {
    storage.set(key, val);
  });
});

function TestConsumer() {
  const ws = useWorkspace();
  return (
    <div>
      <p data-testid="bookId">{ws.activeBookId ?? 'none'}</p>
      <p data-testid="bookTitle">{ws.activeBookTitle ?? 'none'}</p>
      <p data-testid="sceneId">{ws.activeSceneId ?? 'none'}</p>
      <p data-testid="surface">{ws.activeSurface}</p>
      <button onClick={() => ws.setActiveBook('b1', 'My Book')}>setBook</button>
      <button onClick={() => ws.setActiveBookId('b2')}>setBookId</button>
      <button onClick={() => ws.setActiveBookTitle('New Title')}>setBookTitle</button>
      <button onClick={() => ws.setActiveScene('s1')}>setScene</button>
      <button onClick={() => ws.setActiveSurface('manuscript')}>setSurface</button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <WorkspaceProvider>
      <TestConsumer />
    </WorkspaceProvider>,
  );
}

describe('WorkspaceContext', () => {
  it('provides default values', () => {
    renderWithProvider();
    expect(screen.getByTestId('bookId')).toHaveTextContent('none');
    expect(screen.getByTestId('surface')).toHaveTextContent('dashboard');
  });

  it('setActiveBook updates both bookId and title', async () => {
    const user = userEvent.setup();
    renderWithProvider();
    await user.click(screen.getByText('setBook'));
    expect(screen.getByTestId('bookId')).toHaveTextContent('b1');
    expect(screen.getByTestId('bookTitle')).toHaveTextContent('My Book');
  });

  it('setActiveBookId updates only bookId', async () => {
    const user = userEvent.setup();
    renderWithProvider();
    await user.click(screen.getByText('setBookId'));
    expect(screen.getByTestId('bookId')).toHaveTextContent('b2');
  });

  it('setActiveBookTitle updates only title', async () => {
    const user = userEvent.setup();
    renderWithProvider();
    await user.click(screen.getByText('setBook'));
    await user.click(screen.getByText('setBookTitle'));
    expect(screen.getByTestId('bookTitle')).toHaveTextContent('New Title');
  });

  it('setActiveScene updates sceneId', async () => {
    const user = userEvent.setup();
    renderWithProvider();
    await user.click(screen.getByText('setScene'));
    expect(screen.getByTestId('sceneId')).toHaveTextContent('s1');
  });

  it('switching books clears scene', async () => {
    const user = userEvent.setup();
    renderWithProvider();
    await user.click(screen.getByText('setScene'));
    expect(screen.getByTestId('sceneId')).toHaveTextContent('s1');
    await user.click(screen.getByText('setBookId'));
    expect(screen.getByTestId('sceneId')).toHaveTextContent('none');
  });

  it('persists to localStorage', async () => {
    const user = userEvent.setup();
    renderWithProvider();
    await user.click(screen.getByText('setBook'));
    expect(storage.has(workspaceStorageKey('author-one'))).toBe(true);
    const parsed = JSON.parse(storage.get(workspaceStorageKey('author-one'))!);
    expect(parsed.userId).toBe('author-one');
    expect(parsed.state.activeBookId).toBe('b1');
  });

  it('setActiveSurface updates surface', async () => {
    const user = userEvent.setup();
    renderWithProvider();
    await user.click(screen.getByText('setSurface'));
    expect(screen.getByTestId('surface')).toHaveTextContent('manuscript');
  });
  it('removes prior author state on logout/account change and restores only that author’s scoped preferences', async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProvider();
    await user.click(screen.getByText('setBook'));
    identity.userId = undefined;
    rerender(
      <WorkspaceProvider>
        <TestConsumer />
      </WorkspaceProvider>,
    );
    expect(screen.getByTestId('bookTitle')).toHaveTextContent('none');
    identity.userId = 'author-two';
    rerender(
      <WorkspaceProvider>
        <TestConsumer />
      </WorkspaceProvider>,
    );
    expect(screen.getByTestId('bookId')).toHaveTextContent('none');
    identity.userId = 'author-one';
    rerender(
      <WorkspaceProvider>
        <TestConsumer />
      </WorkspaceProvider>,
    );
    expect(screen.getByTestId('bookTitle')).toHaveTextContent('My Book');
  });
  it('does not adopt identity-free legacy storage into the authenticated author’s workspace', () => {
    storage.set(
      'proser-workspace',
      JSON.stringify({ activeBookId: 'other-book', activeBookTitle: 'Private legacy title' }),
    );
    renderWithProvider();
    expect(screen.getByTestId('bookTitle')).toHaveTextContent('none');
    expect(storage.get('proser-workspace')).toContain('Private legacy title');
  });
});
