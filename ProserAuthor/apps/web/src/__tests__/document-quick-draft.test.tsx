import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentQuickDraft } from '@/hooks/use-document-quick-draft';
import { createBook } from '@/lib/api';
import * as api from '@/lib/document-api';
import * as journal from '@/lib/document-quick-drafts';
vi.mock('@/lib/document-quick-drafts', async () => ({
  ...(await vi.importActual<typeof import('@/lib/document-quick-drafts')>(
    '@/lib/document-quick-drafts',
  )),
  readQuickDraftIntent: vi.fn(),
  writeQuickDraftIntent: vi.fn(),
  deleteQuickDraftIntent: vi.fn(),
}));
import type {
  DocumentQuickDraftInput,
  DocumentQuickDraftReceipt,
} from '@hivemagnus/proser-contracts';
vi.mock('@/lib/api', () => ({ createBook: vi.fn() }));
vi.mock('@/lib/document-api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/document-api')>('@/lib/document-api')),
  getDocumentManifest: vi.fn(),
  createDocumentQuickDraft: vi.fn(),
  recoverDocumentQuickDraft: vi.fn(),
  recoverDocumentBookCreation: vi.fn(),
}));
const receipt = (input: DocumentQuickDraftInput): DocumentQuickDraftReceipt => ({
  kind: 'catalog',
  operationId: input.operationId,
  revisionId: 'book-committed',
  contentHash: 'book-hash',
  status: 'completed',
  result: { command: 'quick-draft', actId: 10, chapterId: 20, sceneId: 30 },
  manifest: {
    schemaVersion: 1,
    scenes: [
      {
        sceneId: 30,
        chapterId: 20,
        sceneNumber: 1,
        revisionId: 'scene-committed',
        contentHash: 'scene-hash',
        wordCount: 0,
      },
    ],
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(journal.readQuickDraftIntent).mockResolvedValue(undefined);
  vi.mocked(journal.writeQuickDraftIntent).mockResolvedValue(undefined);
  vi.mocked(journal.deleteQuickDraftIntent).mockResolvedValue(undefined);
  vi.mocked(api.getDocumentManifest).mockResolvedValue({
    schemaVersion: 1,
    revisionId: 'book-source',
    contentHash: 'source-hash',
    scenes: [],
    totals: { projection: 'final', wordCount: 0, sceneCount: 0 },
    scopes: {
      structure: { revisionId: 'structure-source', contentHash: 'structure-hash' },
      canon: { revisionId: 'canon-source', contentHash: 'canon-hash' },
      layout: { revisionId: 'layout-source', contentHash: 'layout-hash' },
    },
  });
});
describe('quick draft transactional recovery', () => {
  it('freezes an explicitly displayed structure revision before journal reads and never refreshes it at dispatch', async () => {
    vi.mocked(api.createDocumentQuickDraft).mockImplementation(async (_bookId, input) =>
      receipt(input),
    );
    const { result } = renderHook(() => useDocumentQuickDraft('author-one'));
    const request = {
      bookId: '1',
      summary: 'Opening scene',
      outline: 'Exact brief\n\nkept.',
      base: { bookRevisionId: 'displayed-book', structureRevisionId: 'displayed-structure' },
    };
    await act(async () => {
      const creation = result.current.create(request);
      request.base.bookRevisionId = 'later-book';
      request.base.structureRevisionId = 'later-structure';
      await creation;
    });
    expect(api.getDocumentManifest).not.toHaveBeenCalled();
    expect(api.createDocumentQuickDraft).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({
        expectedRevisionId: 'displayed-book',
        expectedScopes: { structure: 'displayed-structure' },
        outline: 'Exact brief\n\nkept.',
      }),
    );
  });
  it('loads an interrupted intent for the same author after restart without replaying either mutation', async () => {
    const input: DocumentQuickDraftInput = {
      schemaVersion: 1,
      operationId: 'retained-operation',
      expectedRevisionId: 'book-original',
      expectedScopes: { structure: 'structure-original' },
      summary: 'Original',
      outline: 'Exact original premise',
    };
    vi.mocked(journal.readQuickDraftIntent).mockResolvedValue({
      userId: 'author-one',
      creationId: 'retained-creation',
      bookId: '1',
      request: { bookId: '1', summary: 'Original', outline: 'Exact original premise' },
      creationSent: false,
      draftSent: true,
      draft: input,
      retryAllowed: false,
    });
    vi.mocked(api.recoverDocumentQuickDraft).mockResolvedValue(receipt(input));
    const { result } = renderHook(() => useDocumentQuickDraft('author-one'));
    await waitFor(() => expect(result.current.pending?.operationId).toBe(input.operationId));
    expect(api.createDocumentQuickDraft).not.toHaveBeenCalled();
    expect(createBook).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.recover()).toMatchObject({
        bookId: '1',
        sceneId: '30',
        outline: 'Exact original premise',
      });
    });
    expect(api.getDocumentManifest).not.toHaveBeenCalled();
    expect(api.createDocumentQuickDraft).not.toHaveBeenCalled();
  });
  it('recovers a lost scene acknowledgement by its retained operation without repeating creation', async () => {
    vi.mocked(api.createDocumentQuickDraft).mockRejectedValue(new Error('Acknowledgement lost'));
    const { result } = renderHook(() => useDocumentQuickDraft('author-one'));
    await act(async () => {
      await expect(
        result.current.create({
          bookId: '1',
          summary: 'Draft',
          outline: 'Exact original premise 😀',
        }),
      ).rejects.toThrow('lost');
    });
    const input = vi.mocked(api.createDocumentQuickDraft).mock.calls[0]![1];
    expect(input.expectedRevisionId).toBe('book-source');
    expect(result.current.pending?.operationId).toBe(input.operationId);
    vi.mocked(api.recoverDocumentQuickDraft).mockResolvedValue(receipt(input));
    let target;
    await act(async () => {
      target = await result.current.recover();
    });
    expect(target).toEqual({
      bookId: '1',
      sceneId: '30',
      bookTitle: undefined,
      outline: 'Exact original premise 😀',
    });
    expect(api.createDocumentQuickDraft).toHaveBeenCalledTimes(1);
    expect(api.getDocumentManifest).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeUndefined();
  });
  it('requires receipt recovery before an explicit retry and keeps the original source revision', async () => {
    vi.mocked(api.createDocumentQuickDraft).mockRejectedValue(new Error('Connection lost'));
    const { result } = renderHook(() => useDocumentQuickDraft('author-one'));
    await act(async () => {
      await expect(
        result.current.create({ bookId: '1', summary: 'Draft', outline: 'Original' }),
      ).rejects.toThrow();
    });
    const original = structuredClone(vi.mocked(api.createDocumentQuickDraft).mock.calls[0]![1]);
    await expect(result.current.retry()).rejects.toThrow('Recover');
    vi.mocked(api.recoverDocumentQuickDraft).mockRejectedValue(
      new api.DocumentRequestError('Receipt not found', 404),
    );
    await act(async () => {
      await expect(result.current.recover()).rejects.toThrow('not found');
    });
    vi.mocked(api.createDocumentQuickDraft).mockRejectedValue(
      new api.DocumentRequestError('Source changed', 412),
    );
    await act(async () => {
      await expect(result.current.retry()).rejects.toThrow('Source changed');
    });
    expect(api.createDocumentQuickDraft).toHaveBeenLastCalledWith('1', original);
    expect(api.getDocumentManifest).toHaveBeenCalledTimes(1);
    expect(result.current.pending?.rejected).toBe(true);
    await act(async () => {
      await result.current.discardRejected();
    });
    expect(journal.deleteQuickDraftIntent).toHaveBeenCalledWith('author-one', expect.any(String));
    expect(result.current.pending).toBeUndefined();
  });
  it('recovers new-book creation first and continues the original draft without another book POST', async () => {
    vi.mocked(createBook).mockRejectedValue(new Error('Book acknowledgement lost'));
    const { result } = renderHook(() => useDocumentQuickDraft('author-one'));
    await act(async () => {
      await expect(
        result.current.create({
          newBook: { title: 'New manuscript' },
          summary: 'Draft',
          outline: 'Original premise',
        }),
      ).rejects.toThrow();
    });
    const operationId = vi.mocked(createBook).mock.calls[0]![0].operationId!;
    vi.mocked(api.recoverDocumentBookCreation).mockResolvedValue({
      operationId,
      bookId: 2,
      title: 'New manuscript',
      revisionId: 'book-created',
      status: 'completed',
    });
    await act(async () => {
      expect(await result.current.recover()).toBeUndefined();
    });
    expect(result.current.pending?.retryAllowed).toBe(true);
    expect(api.createDocumentQuickDraft).not.toHaveBeenCalled();
    vi.mocked(api.createDocumentQuickDraft).mockImplementation(async (_book, input) =>
      receipt(input),
    );
    await act(async () => {
      expect(await result.current.retry()).toMatchObject({ bookId: '2', sceneId: '30' });
    });
    expect(createBook).toHaveBeenCalledTimes(1);
  });
  it('hides another account’s pending request and rejects a late acknowledgement after logout', async () => {
    let resolve!: (receipt: DocumentQuickDraftReceipt) => void;
    vi.mocked(api.createDocumentQuickDraft).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result, rerender } = renderHook(({ user }) => useDocumentQuickDraft(user), {
      initialProps: { user: 'author-one' as string | undefined },
    });
    let action!: Promise<unknown>;
    await act(async () => {
      action = result.current.create({ bookId: '1', summary: 'Draft', outline: 'Original' });
      await Promise.resolve();
    });
    const input = vi.mocked(api.createDocumentQuickDraft).mock.calls[0]![1];
    rerender({ user: undefined });
    expect(result.current.pending).toBeUndefined();
    await act(async () => {
      resolve(receipt(input));
      await expect(action).rejects.toThrow('same author');
    });
    rerender({ user: 'author-two' });
    expect(result.current.pending).toBeUndefined();
    await expect(result.current.recover()).rejects.toThrow('this author');
  });
  it('retains an acknowledged new book but stops the remaining mutation chain after unmount', async () => {
    let resolve!: (book: Awaited<ReturnType<typeof createBook>>) => void;
    vi.mocked(createBook).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result, unmount } = renderHook(() => useDocumentQuickDraft('author-one'));
    let action!: Promise<unknown>;
    await act(async () => {
      action = result.current.create({
        newBook: { title: 'Original owned book' },
        summary: 'Draft',
        outline: 'Private original context',
      });
    });
    await waitFor(() => expect(createBook).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      resolve({ data: { id: '2', title: 'Original owned book' } });
      await expect(action).rejects.toThrow('same author');
    });
    expect(api.getDocumentManifest).not.toHaveBeenCalled();
    expect(api.createDocumentQuickDraft).not.toHaveBeenCalled();
    expect(journal.deleteQuickDraftIntent).not.toHaveBeenCalled();
  });
});
