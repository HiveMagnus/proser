import { documentCapabilitiesFixture } from './document-capabilities-fixture';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MobileStudioPage from '@/app/m/studio/page';
import { getDocumentCapabilities } from '@/lib/document-api';
const state = vi.hoisted(() => ({
  userId: 'studio-owner' as string | undefined,
  status: 'authenticated',
  query: new URLSearchParams('bookId=1&sceneId=11'),
  setBook: vi.fn(),
  setScene: vi.fn(),
  setSurface: vi.fn(),
  setTarget: vi.fn(),
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: state.userId ? { user: { id: state.userId } } : null,
    status: state.status,
  }),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => state.query }));
vi.mock('@/hooks/queries/use-books', () => ({
  useBooks: () => ({ data: [{ id: '1', title: 'Owned fixture' }] }),
}));
vi.mock('@/contexts/mobile-state-context', () => ({
  useMobileState: () => ({
    lastBookId: '1',
    lastSceneId: '11',
    setLastDraftTarget: state.setTarget,
  }),
}));
vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({
    activeBookId: '1',
    activeSceneId: '11',
    setActiveBook: state.setBook,
    setActiveSceneId: state.setScene,
    setActiveSurface: state.setSurface,
  }),
}));
vi.mock('@/lib/document-api', () => ({
  getDocumentCapabilities: vi.fn(),
  getAuthoringDocumentCapabilities: vi.fn(),
}));
vi.mock('@/components/editor/document-studio', () => ({
  DocumentStudio: ({
    bookId,
    sceneId,
    onTargetChange,
  }: {
    bookId: string;
    sceneId: string;
    onTargetChange(target: { bookId: string; sceneId: string; title: string }): void;
  }) => (
    <div>
      Canonical mobile studio {bookId}/{sceneId}
      <button
        onClick={() => onTargetChange({ bookId: '1', sceneId: '12', title: 'Owned fixture' })}
      >
        Choose next scene
      </button>
    </div>
  ),
}));
beforeEach(() => {
  state.userId = 'studio-owner';
  state.status = 'authenticated';
  state.query = new URLSearchParams('bookId=1&sceneId=11');
  vi.clearAllMocks();
  vi.mocked(getDocumentCapabilities).mockResolvedValue(documentCapabilitiesFixture());
});
describe('mobile structured studio boundary', () => {
  it('opens the canonical route and retains trusted workspace navigation identities', async () => {
    render(<MobileStudioPage />);
    expect(await screen.findByText('Canonical mobile studio 1/11')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Choose next scene' }));
    expect(state.setBook).toHaveBeenCalledWith('1', 'Owned fixture');
    expect(state.setScene).toHaveBeenCalledWith('12');
    expect(state.setTarget).toHaveBeenCalledWith('1', '12');
    expect(state.setSurface).toHaveBeenCalledWith('manuscript');
  });
  it('keeps editing unavailable instead of reopening the retired prose writer', async () => {
    vi.mocked(getDocumentCapabilities).mockResolvedValue(
      documentCapabilitiesFixture({ enabled: false }),
    );
    render(<MobileStudioPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('document authority is inactive');
    expect(screen.queryByText('Canonical mobile studio 1/11')).not.toBeInTheDocument();
  });
  it('fails closed when the structured schema or typed operation contract is unsupported', async () => {
    vi.mocked(getDocumentCapabilities).mockResolvedValue(
      documentCapabilitiesFixture({ passageOperations: undefined }),
    );
    render(<MobileStudioPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('schema is unsupported');
    expect(screen.queryByText('Canonical mobile studio 1/11')).not.toBeInTheDocument();
  });
  it('removes the previous account surface before a late capability response arrives', async () => {
    let resolve!: (value: ReturnType<typeof documentCapabilitiesFixture>) => void;
    vi.mocked(getDocumentCapabilities).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { rerender } = render(<MobileStudioPage />);
    state.userId = undefined;
    rerender(<MobileStudioPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Sign in');
    await act(async () => resolve(documentCapabilitiesFixture()));
    expect(screen.queryByText('Canonical mobile studio 1/11')).not.toBeInTheDocument();
  });
});
