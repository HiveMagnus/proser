import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MobileReadPage from '@/app/m/read/page';
import { useBooks } from '@/hooks/queries/use-books';
import { useMobileState } from '@/contexts/mobile-state-context';
import { useWorkspace } from '@/contexts/workspace-context';
import { getStructure, listImages } from '@/lib/api';
import { getDocumentCapabilities } from '@/lib/document-api';

const push = vi.fn();
const replace = vi.fn();
let searchParams = new URLSearchParams('bookId=1&sceneId=11');
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'reader-user' } }, status: 'authenticated' }),
}));
vi.mock('@/lib/document-api', () => ({
  getDocumentCapabilities: vi.fn().mockResolvedValue({ enabled: false, schemaVersion: 1 }),
}));
vi.mock('@/components/mobile/document-reader', () => ({
  DocumentReader: ({ bookId, sceneId }: { bookId: string; sceneId: string | null }) => (
    <p>{`Saved reader ${bookId}:${sceneId ?? 'first'}`}</p>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => searchParams,
}));

vi.mock('@/hooks/queries/use-books', () => ({
  useBooks: vi.fn(),
}));

vi.mock('@/contexts/mobile-state-context', () => ({
  useMobileState: vi.fn(),
}));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  getStructure: vi.fn(),
  listImages: vi.fn(),
}));

describe('MobileReadPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    push.mockReset();
    replace.mockReset();
    vi.mocked(getDocumentCapabilities).mockResolvedValue({
      enabled: false,
      schemaVersion: 1,
    } as Awaited<ReturnType<typeof getDocumentCapabilities>>);
    searchParams = new URLSearchParams('bookId=1&sceneId=11');
    window.history.replaceState(null, '', '/m/read?bookId=1&sceneId=11');
    vi.mocked(useBooks).mockReturnValue({
      data: [{ id: '1', title: 'The Exile Returns', genre: 'fantasy' }],
      isLoading: false,
    } as ReturnType<typeof useBooks>);
    vi.mocked(useMobileState).mockReturnValue({
      shellPreference: 'auto',
      lastBookId: '1',
      lastSceneId: '11',
      activeTraceId: null,
      draftBrief: '',
      pendingCommand: '',
      setShellPreference: vi.fn(),
      setLastDraftTarget: vi.fn(),
      setActiveTraceId: vi.fn(),
      setDraftBrief: vi.fn(),
      setPendingCommand: vi.fn(),
      resetTransientState: vi.fn(),
    });
    vi.mocked(useWorkspace).mockReturnValue({
      activeBookId: '1',
      activeBookTitle: 'The Exile Returns',
      activeSceneId: '11',
      activeSurface: 'manuscript',
      lastVisitedAt: null,
      setActiveBook: vi.fn(),
      setActiveBookId: vi.fn(),
      setActiveBookTitle: vi.fn(),
      setActiveScene: vi.fn(),
      setActiveSceneId: vi.fn(),
      setActiveSurface: vi.fn(),
    });
    vi.mocked(getStructure).mockResolvedValue({
      data: {
        acts: [
          {
            id: '101',
            bookId: '1',
            actNumber: 1,
            title: 'Act I',
            chapters: [
              {
                id: '201',
                actId: '101',
                chapterNumber: 1,
                title: 'Mobile Drafts',
                scenes: [
                  {
                    id: '11',
                    chapterId: '201',
                    sceneNumber: 1,
                    summary: 'Return to the burning city',
                    prose: 'Night rain needled the stone.',
                    wordCount: 5,
                  },
                  {
                    id: '12',
                    chapterId: '201',
                    sceneNumber: 2,
                    summary: 'Slip through the market',
                    prose: 'Lanterns guttered over the market stalls.',
                    wordCount: 6,
                  },
                ],
              },
            ],
          },
        ],
      },
    } as any);
    vi.mocked(listImages).mockResolvedValue({ items: [], total: 0 });
  });

  it('switches reader modes and navigates between scenes', async () => {
    render(<MobileReadPage />);

    await screen.findByText('Read');
    expect(screen.getByText('Night rain needled the stone.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Ch' }));
    expect(screen.getByText('Lanterns guttered over the market stalls.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Next scene' }));
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/m/read?bookId=1&sceneId=12');
    });
  });

  it('renders scene navigation controls for the current scene', async () => {
    render(<MobileReadPage />);

    await screen.findByText('Read');
    expect(screen.getByRole('button', { name: 'Previous scene' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next scene' })).toBeEnabled();
  });

  it('redirects to the first available scene when opened without a sceneId', async () => {
    searchParams = new URLSearchParams('bookId=1');
    window.history.replaceState(null, '', '/m/read?bookId=1');

    render(<MobileReadPage />);

    await waitFor(() => {
      expect(window.location.pathname + window.location.search).toBe('/m/read?bookId=1&sceneId=11');
    });
  });
  it('does not reuse another book’s remembered scene in the structured reader', async () => {
    searchParams = new URLSearchParams('bookId=2');
    vi.mocked(getDocumentCapabilities).mockResolvedValue({
      enabled: true,
      schemaVersion: 1,
    } as Awaited<ReturnType<typeof getDocumentCapabilities>>);
    render(<MobileReadPage />);
    await screen.findByText('Saved reader 2:first');
    expect(getStructure).not.toHaveBeenCalled();
    expect(listImages).not.toHaveBeenCalled();
  });
});
