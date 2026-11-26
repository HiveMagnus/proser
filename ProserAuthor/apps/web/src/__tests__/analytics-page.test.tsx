import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AnalyticsPage from '@/app/analytics/page';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'writer-1' } } }) }));
const workspace = vi.hoisted(() => ({ activeBookId: 'book-7' as string | null }));
vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ activeBookId: workspace.activeBookId, activeBookTitle: 'The Lighthouse' }),
}));

const day = (date: string, written: number) => ({ date, written, other: 0, totalWords: 1000 });
const stats = (goal: unknown) => ({
  bookId: 7,
  timeZone: 'UTC',
  today: '2026-11-26',
  totalWords: 41_250,
  days: [day('2026-11-24', 0), day('2026-11-25', 900), day('2026-11-26', 400)],
  writtenInPeriod: 1300,
  dailyAverage: 43,
  bestDay: { date: '2026-11-25', written: 900 },
  streak: { current: 2, longest: 2 },
  goal,
  pacing: goal
    ? { remainingWords: 38_750, daysLeft: 31, wordsPerDayNeeded: 1250, todayRemaining: 600 }
    : null,
});

describe('Analytics page', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  let goal: unknown = null;

  beforeEach(() => {
    workspace.activeBookId = 'book-7';
    goal = null;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/api/books/book-7/writing-stats'))
        return Response.json({ success: true, data: stats(goal) });
      if (url === '/api/books/book-7/writing-goal' && init?.method === 'PUT') {
        goal = JSON.parse(String(init.body));
        return Response.json({ success: true, data: { goal } });
      }
      return Response.json({ success: false }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderPage = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AnalyticsPage />
      </QueryClientProvider>,
    );

  it('shows totals, streak and daily words from Factory for the open book', async () => {
    renderPage();
    expect(await screen.findByText('41,250')).toBeInTheDocument();
    expect(screen.getByText('1,300')).toBeInTheDocument();
    expect(screen.getByText('900')).toBeInTheDocument();
    expect(screen.getByText(/Longest in 30 days: 2/)).toBeInTheDocument();
    const statsCall = String(fetchMock.mock.calls[0]![0]);
    expect(statsCall).toMatch(/\/api\/books\/book-7\/writing-stats\?days=(30|90)&tz=/);
  });

  it('saves a goal and shows the pacing Factory reports', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('41,250');
    await user.type(screen.getByLabelText('Book length target (words)'), '80000');
    await user.type(screen.getByLabelText('Daily goal (words)'), '1000');
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    await waitFor(() =>
      expect(goal).toEqual({ targetWords: 80_000, dailyWords: 1000, deadline: null }),
    );
    expect(await screen.findByText(/600 words to go today/)).toBeInTheDocument();
    expect(screen.getByText(/about 1,250 a day for 31 days/)).toBeInTheDocument();
  });

  it('rejects a goal that is not a whole number', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('41,250');
    await user.type(screen.getByLabelText('Daily goal (words)'), 'lots');
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('whole numbers');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('asks for a book when none is open', () => {
    workspace.activeBookId = null;
    renderPage();
    expect(screen.getByText('Choose a book')).toBeInTheDocument();
  });
});
