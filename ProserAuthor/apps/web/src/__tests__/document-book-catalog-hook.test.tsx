import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentBookCatalog } from '@/hooks/use-document-book-catalog';
import {
  getDocumentBookCatalogScope,
  recoverDocumentBookCatalog,
  type BookCatalogScope,
} from '@/lib/document-api';
import { deleteBook } from '@/lib/api';
import {
  readBookCatalogIntent,
  writeBookCatalogIntent,
  deleteBookCatalogIntent,
  type BookCatalogIntent,
} from '@/lib/document-book-catalog-journal';
vi.mock('@/lib/document-api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/document-api')>('@/lib/document-api')),
  getDocumentBookCatalogScope: vi.fn(),
  recoverDocumentBookCatalog: vi.fn(),
}));
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  deleteBook: vi.fn(),
  updateBook: vi.fn(),
}));
vi.mock('@/lib/document-book-catalog-journal', async () => ({
  ...(await vi.importActual<typeof import('@/lib/document-book-catalog-journal')>(
    '@/lib/document-book-catalog-journal',
  )),
  readBookCatalogIntent: vi.fn(),
  writeBookCatalogIntent: vi.fn(),
  deleteBookCatalogIntent: vi.fn(),
}));
const saved = (): BookCatalogScope => ({
  revisionId: 'structure-before',
  bookRevisionId: 'book-before',
  contentHash: 'hash',
  content: {
    schemaVersion: 1,
    acts: [],
    chapters: [],
    scenes: [],
    book: {
      title: 'Private owner title',
      summary: 'Private owner summary',
      genre: null,
      targetAudience: null,
      draftStatus: 'draft',
      tagline: null,
      storyOutline: null,
      storyArchetypeKey: null,
      selectedImageId: 0,
    },
  },
});
let row: BookCatalogIntent | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  row = undefined;
  vi.mocked(getDocumentBookCatalogScope).mockResolvedValue(saved());
  vi.mocked(readBookCatalogIntent).mockImplementation(async (user) =>
    row?.userId === user ? structuredClone(row) : undefined,
  );
  vi.mocked(writeBookCatalogIntent).mockImplementation(async (value) => {
    row = structuredClone(value);
  });
  vi.mocked(deleteBookCatalogIntent).mockImplementation(async () => {
    row = undefined;
  });
});
describe('book catalog authenticated hook lifecycle', () => {
  it('rejects an old-owner prepare that completes after the new authenticated owner commits', async () => {
    let finish!: (scope: BookCatalogScope) => void;
    vi.mocked(getDocumentBookCatalogScope).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = renderHook(({ owner }) => useDocumentBookCatalog(owner), {
      initialProps: { owner: 'first-owner' },
    });
    await waitFor(() => expect(view.result.current.busy).toBe(false));
    let preparing!: ReturnType<typeof view.result.current.prepare>;
    await act(async () => {
      preparing = view.result.current.prepare('7');
    });
    view.rerender({ owner: 'second-owner' });
    await act(async () => {
      finish(saved());
      await expect(preparing).rejects.toThrow('authenticated user changed');
    });
    expect(view.result.current.pending).toBeUndefined();
    expect(getDocumentBookCatalogScope).toHaveBeenCalledWith('7', 'first-owner');
    view.unmount();
  });
  it('retains an in-flight delete under its original owner and suppresses its late acknowledgement after logout', async () => {
    let finish!: () => void;
    vi.mocked(deleteBook).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const view = renderHook(({ owner }) => useDocumentBookCatalog(owner), {
      initialProps: { owner: 'first-owner' as string | undefined },
    });
    await waitFor(() => expect(view.result.current.busy).toBe(false));
    let pending!: ReturnType<typeof view.result.current.remove>;
    await act(async () => {
      const source = await view.result.current.prepare('7');
      pending = view.result.current.remove(source);
    });
    await waitFor(() => expect(finish).toBeDefined());
    view.rerender({ owner: undefined });
    expect(view.result.current.pending).toBeUndefined();
    await act(async () => {
      finish();
      await expect(pending).rejects.toThrow('authenticated user changed');
    });
    expect(recoverDocumentBookCatalog).not.toHaveBeenCalled();
    expect(row?.status).toBe('unknown');
    view.rerender({ owner: 'second-owner' });
    await waitFor(() => expect(view.result.current.busy).toBe(false));
    expect(view.result.current.pending).toBeUndefined();
    view.rerender({ owner: 'first-owner' });
    await waitFor(() => expect(view.result.current.pending?.userId).toBe('first-owner'));
    expect(deleteBook).toHaveBeenCalledOnce();
    view.unmount();
  });
});
