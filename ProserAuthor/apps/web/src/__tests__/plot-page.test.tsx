import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PlotStudioPage from '@/app/plot/page';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/plot/plot-thread-workflow', () => ({
  PlotThreadWorkflow: () => <p>The Exile Returns</p>,
}));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({
    activeBookId: 'book-1',
    activeBookTitle: 'Test Book',
    activeSceneId: null,
    activeSurface: 'plot',
    lastVisitedAt: null,
    setActiveBook: vi.fn(),
    setActiveBookId: vi.fn(),
    setActiveBookTitle: vi.fn(),
    setActiveScene: vi.fn(),
    setActiveSceneId: vi.fn(),
    setActiveSurface: vi.fn(),
  }),
}));

vi.mock('@/contexts/motion-context', () => ({
  useMotion: () => ({ shouldAnimate: false, cinematicMotion: false, setCinematicMotion: vi.fn() }),
}));

vi.mock('@/hooks/queries/use-books', () => ({
  useBooks: () => ({ data: [{ id: 'book-1', title: 'Test Book', genre: 'fantasy' }] }),
}));

vi.mock('@/hooks/queries/use-plot', () => ({
  useArchetypes: () => ({
    data: [
      {
        id: 'heros-journey',
        name: "Hero's Journey",
        description: 'The classic monomyth of departure, initiation, and return.',
        genreTags: ['fantasy', 'adventure'],
        beatCount: 12,
        contentRating: 'general',
      },
      {
        id: 'save-the-cat',
        name: 'Save the Cat',
        description: 'A modern 15-beat screenwriting structure.',
        genreTags: ['thriller', 'drama'],
        beatCount: 15,
        contentRating: 'general',
      },
    ],
    isLoading: false,
  }),
  useBeatCoverage: () => ({
    data: {
      archetypeId: 'heros-journey',
      coveragePercent: 30,
      beats: [
        { key: 'call', name: 'Call to Adventure', status: 'hit', expectedPosition: 0.1 },
        {
          key: 'threshold',
          name: 'Crossing the Threshold',
          status: 'pending',
          expectedPosition: 0.25,
        },
      ],
    },
  }),
  usePlotThreads: () => ({
    data: [
      {
        id: 't1',
        bookId: 'book-1',
        threadKey: 'The Exile Returns',
        status: 'active',
        description: 'Main plot',
      },
    ],
  }),
  useUpsertPlotThread: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PlotStudioPage />
    </QueryClientProvider>,
  );
}

describe('PlotStudioPage', () => {
  it('renders the Plot Studio heading', () => {
    renderPage();
    expect(screen.getByText('Plot Studio')).toBeInTheDocument();
  });

  it('shows archetype cards', () => {
    renderPage();
    expect(screen.getByText("Hero's Journey")).toBeInTheDocument();
    expect(screen.getByText('Save the Cat')).toBeInTheDocument();
  });

  it('has tabs for Archetypes, Beat Map, and Plot Threads', () => {
    renderPage();
    expect(screen.getByText('Archetypes')).toBeInTheDocument();
    expect(screen.getByText('Beat Map')).toBeInTheDocument();
    expect(screen.getByText('Plot Threads')).toBeInTheDocument();
  });

  it('shows plot threads on tab click', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText('Plot Threads'));
    expect(screen.getByText('The Exile Returns')).toBeInTheDocument();
  });
});
