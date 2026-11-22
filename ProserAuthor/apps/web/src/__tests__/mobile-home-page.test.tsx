import { documentCapabilitiesFixture } from './document-capabilities-fixture';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MobileHomePage from '@/app/m/page';
import { getAuthoringDocumentCapabilities } from '@/lib/document-api';
import { getDocumentNavigation } from '@/lib/document-navigation';
import { useBooks } from '@/hooks/queries/use-books';
import { useWorkspace } from '@/contexts/workspace-context';
import { useMobileState } from '@/contexts/mobile-state-context';
import {
  createAct,
  createBook,
  createChapter,
  createScene,
  getLatestSceneTrace,
  getStructure,
} from '@/lib/api';

const push = vi.fn();
const quickCreate = vi.fn();
const authenticated = vi.hoisted(() => ({ userId: 'author-one' as string | undefined }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: authenticated.userId ? { user: { id: authenticated.userId } } : null,
  }),
}));
vi.mock('@/lib/document-api', () => ({ getAuthoringDocumentCapabilities: vi.fn() }));
vi.mock('@/lib/document-navigation', () => ({ getDocumentNavigation: vi.fn() }));
vi.mock('@/hooks/use-document-quick-draft', () => ({
  useDocumentQuickDraft: () => ({ create: quickCreate, pending: undefined }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/hooks/queries/use-books', () => ({
  useBooks: vi.fn(),
}));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: vi.fn(),
}));

vi.mock('@/contexts/mobile-state-context', () => ({
  useMobileState: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  getStructure: vi.fn(),
  getLatestSceneTrace: vi.fn(),
  createBook: vi.fn(),
  createAct: vi.fn(),
  createChapter: vi.fn(),
  createScene: vi.fn(),
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder ?? null}</span>,
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('MobileHomePage', () => {
  beforeEach(() => {
    authenticated.userId = 'author-one';
    quickCreate.mockReset();
    vi.mocked(getAuthoringDocumentCapabilities).mockResolvedValue(
      documentCapabilitiesFixture({ enabled: false, schemaVersion: 1 }),
    );
    push.mockReset();
    vi.mocked(useBooks).mockReturnValue({
      data: [{ id: '1', title: 'The Exile Returns', genre: 'fantasy' }],
      isLoading: false,
    } as ReturnType<typeof useBooks>);
    vi.mocked(useWorkspace).mockReturnValue({
      activeBookId: '1',
      activeBookTitle: 'The Exile Returns',
      activeSceneId: '11',
      activeSurface: 'dashboard',
      lastVisitedAt: null,
      setActiveBook: vi.fn(),
      setActiveBookId: vi.fn(),
      setActiveBookTitle: vi.fn(),
      setActiveScene: vi.fn(),
      setActiveSceneId: vi.fn(),
      setActiveSurface: vi.fn(),
    });
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
                    outline: 'Open with tension',
                    prose: 'Night rain needled the stone.',
                    wordCount: 5,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    vi.mocked(getLatestSceneTrace).mockResolvedValue({
      data: {
        traceId: 'trace-1',
        status: 'ready',
        candidates: [],
        inlineFindings: [],
        compareCards: [],
        actions: [],
      } as any,
    });
    vi.mocked(createBook).mockResolvedValue({ data: { id: '2', title: 'Moonlit Kingdom' } } as any);
    vi.mocked(createAct).mockResolvedValue({
      data: { act: { id: '301', bookId: '2', actNumber: 1, chapters: [] } },
    } as any);
    vi.mocked(createChapter).mockResolvedValue({
      data: { chapter: { id: '401', actId: '301', chapterNumber: 1, scenes: [] } },
    } as any);
    vi.mocked(createScene).mockResolvedValue({
      data: {
        scene: {
          id: '501',
          chapterId: '401',
          sceneNumber: 1,
          summary: 'A disgraced heir sneaks back into the city',
          outline: 'Premise: A disgraced heir sneaks back into the city.',
          prose: '',
          wordCount: 0,
        },
      },
    });
  });
  it('removes the prior author’s draft form immediately on logout and starts a fresh form for another author', async () => {
    const { rerender } = render(<MobileHomePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Quick Draft/i }));
    const placeholder =
      'A disgraced heir sneaks back into the city the night the old wards begin to fail.';
    await userEvent.type(screen.getByPlaceholderText(placeholder), 'Private unsaved premise');
    authenticated.userId = undefined;
    rerender(<MobileHomePage />);
    expect(screen.queryByPlaceholderText(placeholder)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Authenticate');
    authenticated.userId = 'author-two';
    rerender(<MobileHomePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Quick Draft/i }));
    expect(screen.getByPlaceholderText(placeholder)).toHaveValue('');
  });

  it('uses structured metadata and an atomic quick draft when document authority is active', async () => {
    vi.mocked(getAuthoringDocumentCapabilities).mockResolvedValue(
      documentCapabilitiesFixture({ enabled: true, schemaVersion: 1 }),
    );
    vi.mocked(getDocumentNavigation).mockResolvedValue([]);
    quickCreate.mockResolvedValue({
      bookId: '1',
      sceneId: '900',
      bookTitle: 'The Exile Returns',
      outline: 'Frozen quick draft outline',
    });
    vi.mocked(getStructure).mockClear();
    vi.mocked(createAct).mockClear();
    vi.mocked(createChapter).mockClear();
    vi.mocked(createScene).mockClear();
    render(<MobileHomePage />);
    await waitFor(() => expect(getDocumentNavigation).toHaveBeenCalledWith('1'));
    await userEvent.click(screen.getByRole('button', { name: /Quick Draft/i }));
    await userEvent.type(
      screen.getByPlaceholderText(
        'A disgraced heir sneaks back into the city the night the old wards begin to fail.',
      ),
      'An owned quick draft.',
    );
    await userEvent.click(screen.getByRole('button', { name: /Create And Open Studio/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/m/studio?bookId=1&sceneId=900'));
    expect(quickCreate).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: '1', summary: 'An owned quick draft' }),
    );
    expect(getStructure).not.toHaveBeenCalled();
    expect(createAct).not.toHaveBeenCalled();
    expect(createChapter).not.toHaveBeenCalled();
    expect(createScene).not.toHaveBeenCalled();
  });

  it('shows the resume card and opens the studio for the active scene', async () => {
    render(<MobileHomePage />);

    await waitFor(() => {
      expect(screen.getByText('Phone-first drafting')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /Continue/i }));

    expect(push).toHaveBeenCalledWith('/m/studio?bookId=1&sceneId=11');
  });

  it('rejects Quick Draft when authority is inactive without creating a book, hierarchy or scene', async () => {
    render(<MobileHomePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Quick Draft/i }));
    await userEvent.click(screen.getByRole('button', { name: /New Book/i }));
    await userEvent.type(screen.getByLabelText('Book Title'), 'Moonlit Kingdom');
    await userEvent.type(screen.getByLabelText('One-sentence premise'), 'Owned exact premise.');
    await userEvent.click(screen.getByRole('button', { name: /Create And Open Studio/i }));
    expect(
      await screen.findByText(/Structured document authority is unavailable/),
    ).toBeInTheDocument();
    expect(createBook).not.toHaveBeenCalled();
    expect(createAct).not.toHaveBeenCalled();
    expect(createChapter).not.toHaveBeenCalled();
    expect(createScene).not.toHaveBeenCalled();
    expect(quickCreate).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
