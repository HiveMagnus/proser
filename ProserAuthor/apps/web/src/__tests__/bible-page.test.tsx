import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StoryBiblePage from '@/app/bible/page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/bible',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({
    activeBookId: 'book-1',
    activeBookTitle: 'Test Book',
    activeSceneId: null,
    activeSurface: 'bible',
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
  useBooks: () => ({ data: [{ id: 'book-1', title: 'Test Book' }] }),
}));

const mockEntries = [
  {
    id: '1',
    bookId: 'book-1',
    entryType: 'character',
    entryName: 'Kael Ashborne',
    entryDescription: 'An exiled prince.',
    attributes: '{"role":"Protagonist"}',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: '2',
    bookId: 'book-1',
    entryType: 'location',
    entryName: 'The Citadel',
    entryDescription: 'A floating fortress.',
    attributes: null,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: '3',
    bookId: 'book-1',
    entryType: 'rule',
    entryName: 'Sunfire Curse',
    entryDescription: 'Blood turns to gold.',
    attributes: '{"certainty":"Established"}',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: '4',
    bookId: 'book-1',
    entryType: 'event',
    entryName: 'The Fall',
    entryDescription: 'Dynasty crumbles.',
    attributes: '{"scene":"Throne room"}',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: '5',
    bookId: 'book-1',
    entryType: 'relationship',
    entryName: 'Kael-Sera Alliance',
    entryDescription: 'Reluctant partners.',
    attributes: null,
    createdAt: '',
    updatedAt: '',
  },
];

vi.mock('@/hooks/queries/use-codex', () => ({
  useCodexEntries: () => ({ data: mockEntries, isLoading: false, error: null, refetch: vi.fn() }),
  useCreateCodexEntry: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/components/relationship-graph', () => ({
  RelationshipGraph: () => <div data-testid="relationship-graph">Relationship Web</div>,
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StoryBiblePage />
    </QueryClientProvider>,
  );
}

describe('StoryBiblePage', () => {
  it('renders the Story Bible heading', () => {
    renderPage();
    expect(screen.getByText('Story Bible')).toBeInTheDocument();
  });

  it('shows codex entry cards', () => {
    renderPage();
    expect(screen.getByText('Kael Ashborne')).toBeInTheDocument();
    expect(screen.getByText('The Citadel')).toBeInTheDocument();
  });

  it('has view selector buttons', () => {
    renderPage();
    expect(screen.getByText('Entries')).toBeInTheDocument();
    expect(screen.getByText('Relationships')).toBeInTheDocument();
    expect(screen.getByText('Canon Facts')).toBeInTheDocument();
    expect(screen.getByText('Timeline')).toBeInTheDocument();
  });

  it('switches to relationship view', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText('Relationships'));
    expect(screen.getByTestId('relationship-graph')).toBeInTheDocument();
  });

  it('switches to canon view', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText('Canon Facts'));
    expect(screen.getByText('Sunfire Curse')).toBeInTheDocument();
  });

  it('switches to timeline view', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText('Timeline'));
    expect(screen.getByText('The Fall')).toBeInTheDocument();
  });

  it('filters entries by search', async () => {
    const user = userEvent.setup();
    renderPage();
    const search = screen.getByPlaceholderText('Search entries...');
    await user.type(search, 'Kael');
    expect(screen.getByText('Kael Ashborne')).toBeInTheDocument();
    expect(screen.queryByText('The Citadel')).not.toBeInTheDocument();
  });
});
