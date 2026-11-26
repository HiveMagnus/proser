import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocumentBookSearch } from '@/components/editor/document-book-search';
import {
  searchDocumentBook,
  recoverDocumentSearchIndex,
  DocumentRequestError,
} from '@/lib/document-api';
import type { DocumentSearchResponse } from '@hivemagnus/proser-contracts';
vi.mock('@/lib/document-api', async (original) => ({
  ...(await original<typeof import('@/lib/document-api')>()),
  searchDocumentBook: vi.fn(),
  recoverDocumentSearchIndex: vi.fn(),
}));
const response = (): DocumentSearchResponse => ({
  schemaVersion: 1,
  sourceBookRevisionId: 'saved-book',
  sourceContentHash: 'a'.repeat(64),
  currentBookRevisionId: 'saved-book',
  stale: false,
  projection: 'final',
  normalization: 'unicode-16.0.0-nfc-full-casefold-v1',
  index: 'revision-gin-v1',
  query: 'Exact',
  caseSensitive: false,
  hits: [],
  scannedScenes: 8,
  decodedBytes: 8192,
  complete: false,
  nextCursor: 'owned-manifest-cursor',
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(searchDocumentBook).mockResolvedValue(response());
});
describe('revision-bound global manuscript search', () => {
  it('continues empty bounded pages using the exact manifest cursor', async () => {
    const user = userEvent.setup();
    render(<DocumentBookSearch bookId="1" onOpen={vi.fn()} />);
    await user.type(screen.getByLabelText('Search whole book'), 'Exact');
    await user.click(screen.getByRole('button', { name: 'Search saved text' }));
    await screen.findByText('No matches in this portion of the saved manuscript.');
    await user.click(screen.getByRole('button', { name: 'Next search results' }));
    await waitFor(() => expect(searchDocumentBook).toHaveBeenCalledTimes(2));
    expect(vi.mocked(searchDocumentBook).mock.calls[1]![1]).toMatchObject({
      q: 'Exact',
      cursor: 'owned-manifest-cursor',
      limit: 20,
    });
  });
  it('disables stale results and suppresses late responses after the query changes', async () => {
    let finish!: (response: DocumentSearchResponse) => void;
    vi.mocked(searchDocumentBook).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<DocumentBookSearch bookId="1" onOpen={vi.fn()} />);
    await user.type(screen.getByLabelText('Search whole book'), 'Exact');
    await user.click(screen.getByRole('button', { name: 'Search saved text' }));
    await user.type(screen.getByLabelText('Search whole book'), ' new');
    finish({ ...response(), stale: true });
    await waitFor(() => expect(screen.queryByText('Saved revision: saved-book')).toBeNull());
    vi.mocked(searchDocumentBook).mockResolvedValue({
      ...response(),
      stale: true,
      hits: [
        {
          id: 'match',
          sceneId: 2,
          sceneNumber: 1,
          chapterId: 1,
          wordCount: 2,
          sceneRevisionId: 'scene',
          sceneContentHash: 'b'.repeat(64),
          projectionSha256: 'c'.repeat(64),
          from: 0,
          to: 5,
          sourceText: 'Exact',
          excerpt: 'Exact source',
          excerptFrom: 0,
          excerptTo: 5,
          anchors: [],
          locations: [],
          editable: true,
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Search saved text' }));
    await screen.findByText(
      'The manuscript changed after this search. Refresh before selecting a result.',
    );
    expect(screen.getByRole('button', { name: 'Open scene 2 match' })).toBeDisabled();
  });
  it('recovers a missing index in explicit bounded pages without fetching scene bodies', async () => {
    const user = userEvent.setup();
    vi.mocked(searchDocumentBook).mockRejectedValue(
      new DocumentRequestError('Missing index', 503, 'DOCUMENT_SEARCH_INDEX_INCOMPLETE'),
    );
    vi.mocked(recoverDocumentSearchIndex)
      .mockResolvedValueOnce({
        schemaVersion: 1,
        index: 'revision-gin-v1',
        normalization: 'unicode-16.0.0-nfc-full-casefold-v1',
        scanned: 8,
        missing: 8,
        inserted: 8,
        verified: 8,
        complete: false,
        nextAfter: 'exact-next',
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        index: 'revision-gin-v1',
        normalization: 'unicode-16.0.0-nfc-full-casefold-v1',
        scanned: 3,
        missing: 3,
        inserted: 3,
        verified: 3,
        complete: true,
      });
    render(<DocumentBookSearch bookId="1" onOpen={vi.fn()} />);
    await user.type(screen.getByLabelText('Search whole book'), 'Exact');
    await user.click(screen.getByRole('button', { name: 'Search saved text' }));
    await user.click(await screen.findByRole('button', { name: 'Recover saved search index' }));
    await screen.findByRole('button', { name: 'Continue search recovery' });
    expect(recoverDocumentSearchIndex).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Continue search recovery' }));
    await screen.findByText('Search is ready. Search saved text again.');
    expect(vi.mocked(recoverDocumentSearchIndex).mock.calls[1]![1]).toEqual({
      limit: 8,
      after: 'exact-next',
    });
    expect(searchDocumentBook).toHaveBeenCalledTimes(1);
  });
});
