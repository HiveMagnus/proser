import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookTrash } from '@/components/dashboard/book-trash';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'writer-1' } } }) }));

describe('Deleted books', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  let deleted = [
    {
      id: 12,
      title: 'The Salt Road',
      deletedAt: '2026-11-25T10:00:00.000Z',
      revisionId: 'revision-deleted',
      restoreRevisionId: 'revision-before',
    },
  ];
  beforeEach(() => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/books/trash')
        return Response.json({ success: true, data: { books: deleted } });
      if (
        url === '/api/books/12/document-revisions/revision-before/restore' &&
        init?.method === 'POST'
      ) {
        deleted = [];
        return Response.json({ success: true, data: { revisionId: 'revision-restored' } });
      }
      return Response.json({ success: false }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('restores a deleted book to the revision before its deletion', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BookTrash />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Deleted books (1)')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /Restore/ }));
    await waitFor(() => expect(screen.queryByText('The Salt Road')).not.toBeInTheDocument());
    const restore = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/restore'));
    expect(JSON.parse(String(restore?.[1]?.body))).toMatchObject({
      expectedRevisionId: 'revision-deleted',
    });
    expect((restore?.[1]?.headers as Record<string, string>)['X-Proser-Expected-User']).toBe(
      'writer-1',
    );
  });
});
