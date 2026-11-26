import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookAiSetting } from '@/components/dashboard/book-ai-setting';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'writer-1' } } }) }));

describe('Book AI setting', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  let aiDisabled = false;
  let reject = false;

  beforeEach(() => {
    aiDisabled = false;
    reject = false;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) !== '/api/books/7/ai-policy')
        return Response.json({ success: false }, { status: 404 });
      if (init?.method === 'PUT') {
        if (reject)
          return Response.json(
            { success: false, error: { code: 'NOT_FOUND', message: 'Book not found' } },
            { status: 404 },
          );
        aiDisabled = JSON.parse(String(init.body)).aiDisabled;
      }
      return Response.json({ success: true, data: { bookId: 7, aiDisabled, updatedAt: null } });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderSetting = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BookAiSetting bookId="7" />
      </QueryClientProvider>,
    );

  it('switches AI off for the book through Factory and shows the state', async () => {
    renderSetting();
    const toggle = await screen.findByRole('switch', { name: 'Keep this book away from AI' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('AI features are available for this book.')).toBeInTheDocument();

    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(await screen.findByText('AI is off for this book.')).toBeInTheDocument();
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ aiDisabled: true });
    expect(new Headers(put?.[1]?.headers).get('X-Proser-Expected-User')).toBe('writer-1');
  });

  it('keeps the saved state and reports a failed change', async () => {
    reject = true;
    renderSetting();
    const toggle = await screen.findByRole('switch', { name: 'Keep this book away from AI' });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    expect(await screen.findByText('Book not found')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
