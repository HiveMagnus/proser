import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BookArchive } from '@/components/publish/book-archive';

const receipt = {
  operationId: '00000000-0000-4000-8000-000000000001',
  bookId: 77,
  title: 'Moved book',
  revisionId: 'r1',
  status: 'completed',
  counts: {
    acts: 1,
    chapters: 2,
    scenes: 3,
    codex: 1,
    notes: 1,
    plotThreads: 0,
    images: 1,
    wordCount: 1234,
  },
  losses: { resolvedReviewFolded: 1, commentsDropped: 2, plainTextFallbacks: 0 },
};

describe('BookArchive', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it('links the archive download and imports a chosen archive as a new book', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: receipt }), { status: 201 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const onImported = vi.fn();
    render(
      <BookArchive
        bookId="5"
        disabled={false}
        signal={new AbortController().signal}
        onImported={onImported}
      />,
    );
    expect(screen.getByRole('link', { name: 'Download book archive' }).getAttribute('href')).toBe(
      '/api/books/5/archive',
    );
    const file = new File([new Uint8Array([80, 75, 3, 4])], 'moved.proser.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Import a book archive as a new book'), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import as new book' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Moved book'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^\/api\/books\/archive-imports\?operationId=[0-9a-f-]{36}$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/zip');
    expect(screen.getByRole('status').textContent).toContain('2 resolved or detached comments');
    fireEvent.click(screen.getByRole('button', { name: 'Open the new book' }));
    expect(onImported).toHaveBeenCalledWith('77', 'Moved book');
  });
  it('shows the error and retries with the same operation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: { message: 'Digest mismatch' } }), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: receipt }), { status: 201 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<BookArchive bookId={null} disabled={false} signal={new AbortController().signal} />);
    expect(screen.queryByRole('link', { name: 'Download book archive' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Import a book archive as a new book'), {
      target: { files: [new File([new Uint8Array([1])], 'a.zip')] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import as new book' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Digest mismatch'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(fetchMock.mock.calls[0]?.[0]).toBe(fetchMock.mock.calls[1]?.[0]);
  });
});
