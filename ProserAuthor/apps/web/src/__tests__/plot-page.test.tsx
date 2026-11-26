import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PlotStudioPage from '@/app/plot/page';

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

  it('shows only plot threads, with no archetype or beat-map panels', () => {
    renderPage();
    expect(screen.getByText('The Exile Returns')).toBeInTheDocument();
    expect(screen.queryByText('Archetypes')).not.toBeInTheDocument();
    expect(screen.queryByText('Beat Map')).not.toBeInTheDocument();
  });
});
