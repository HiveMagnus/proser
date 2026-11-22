import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookCreationSession } from '@/lib/book-creation-session';
import { createBook, FactoryRequestError } from '@/lib/api';
import { documentCapabilitiesFixture } from './document-capabilities-fixture';
import {
  recoverDocumentBookCreation,
  getAuthoringDocumentCapabilities,
  DocumentRequestError,
} from '@/lib/document-api';
import * as journal from '@/lib/book-creation-intent';
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  createBook: vi.fn(),
}));
vi.mock('@/lib/document-api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/document-api')>('@/lib/document-api')),
  recoverDocumentBookCreation: vi.fn(),
  getAuthoringDocumentCapabilities: vi.fn(),
}));
vi.mock('@/lib/book-creation-intent', async () => ({
  ...(await vi.importActual<typeof import('@/lib/book-creation-intent')>(
    '@/lib/book-creation-intent',
  )),
  readBookCreationIntent: vi.fn(),
  writeBookCreationIntent: vi.fn(),
  deleteBookCreationIntent: vi.fn(),
}));
const request = {
  title: 'Exact 😀 book',
  summary: 'Whitespace\n\n e\u0301 retained.',
  genre: 'fantasy',
};
let retained: journal.BookCreationIntent | undefined;
const receipt = (operationId: string) => ({
  operationId,
  bookId: 2,
  title: request.title,
  revisionId: 'created-revision',
  status: 'completed' as const,
});
beforeEach(() => {
  vi.resetAllMocks();
  retained = undefined;
  vi.mocked(getAuthoringDocumentCapabilities).mockResolvedValue(documentCapabilitiesFixture());
  vi.mocked(journal.readBookCreationIntent).mockImplementation(
    async () => retained && structuredClone(retained),
  );
  vi.mocked(journal.writeBookCreationIntent).mockImplementation(async (row) => {
    retained = structuredClone(row);
  });
  vi.mocked(journal.deleteBookCreationIntent).mockImplementation(async () => {
    retained = undefined;
  });
});
describe('durable project creation', () => {
  it('persists exact intent and dispatched operation before its single authenticated POST and durably acknowledges only that version', async () => {
    vi.mocked(createBook).mockImplementation(async (input, owner) => {
      expect(owner).toBe('owner');
      expect(retained?.state).toBe('dispatched');
      expect(retained?.operationId).toBe(input.operationId);
      expect(retained?.request).toEqual(request);
      return { data: { id: '2', title: request.title } };
    });
    const session = new BookCreationSession('owner', () => true, vi.fn());
    await expect(session.create(request)).resolves.toMatchObject({ data: { id: '2' } });
    expect(createBook).toHaveBeenCalledTimes(1);
    expect(journal.writeBookCreationIntent).toHaveBeenCalledTimes(2);
    const dispatched = vi.mocked(journal.writeBookCreationIntent).mock.calls[1]![0];
    expect(journal.deleteBookCreationIntent).toHaveBeenCalledWith(
      'owner',
      dispatched.operationId,
      dispatched.version,
    );
    expect(session.snapshot().pending).toBeUndefined();
  });
  it('recovers a lost acknowledgement after restart by the original receipt without another POST or scene creation', async () => {
    vi.mocked(createBook).mockRejectedValue(new Error('lost acknowledgement'));
    const first = new BookCreationSession('owner', () => true, vi.fn());
    await expect(first.create(request)).rejects.toThrow('lost acknowledgement');
    const original = structuredClone(retained!);
    const restarted = new BookCreationSession('owner', () => true, vi.fn());
    await restarted.load();
    expect(restarted.snapshot().pending?.request).toEqual(request);
    vi.mocked(recoverDocumentBookCreation).mockResolvedValue(receipt(original.operationId));
    await expect(restarted.recover()).resolves.toMatchObject({
      data: { id: '2', summary: request.summary },
    });
    expect(recoverDocumentBookCreation).toHaveBeenCalledWith(original.operationId, 'owner');
    expect(createBook).toHaveBeenCalledTimes(1);
  });
  it('requires fresh404 before explicit retry and dispatches the same operation/request; a saved404 is not authority after restart', async () => {
    vi.mocked(createBook).mockRejectedValue(new Error('offline'));
    const first = new BookCreationSession('owner', () => true, vi.fn());
    await expect(first.create(request)).rejects.toThrow();
    const original = vi.mocked(createBook).mock.calls[0]![0];
    await expect(first.retry()).rejects.toThrow('Recover');
    vi.mocked(recoverDocumentBookCreation).mockRejectedValue(
      new DocumentRequestError('missing', 404),
    );
    expect(await first.recover()).toBeUndefined();
    expect(first.snapshot().retryAllowed).toBe(true);
    const restarted = new BookCreationSession('owner', () => true, vi.fn());
    await restarted.load();
    expect(restarted.snapshot().retryAllowed).toBe(false);
    await expect(restarted.retry()).rejects.toThrow('Recover');
    await restarted.recover();
    await expect(restarted.retry()).rejects.toThrow('offline');
    expect(createBook).toHaveBeenLastCalledWith(original, 'owner');
    expect(restarted.snapshot().retryAllowed).toBe(false);
  });
  it('retains uncertain transport/receipt errors and rejects mismatched receipts without deleting evidence or retrying', async () => {
    vi.mocked(createBook).mockRejectedValue(new Error('unknown'));
    const session = new BookCreationSession('owner', () => true, vi.fn());
    await expect(session.create(request)).rejects.toThrow();
    vi.mocked(recoverDocumentBookCreation).mockRejectedValue(
      new DocumentRequestError('unavailable', 503),
    );
    await expect(session.recover()).rejects.toThrow();
    expect(session.snapshot().retryAllowed).toBe(false);
    vi.mocked(recoverDocumentBookCreation).mockResolvedValue(receipt('wrong-operation'));
    await expect(session.recover()).rejects.toThrow('match');
    expect(journal.deleteBookCreationIntent).not.toHaveBeenCalled();
    expect(createBook).toHaveBeenCalledTimes(1);
    await expect(session.discardRejected()).rejects.toThrow('uncertain');
  });
  it('suppresses a late acknowledged response after logout/unmount and retains the original operation for its owner', async () => {
    let active = true;
    let done!: (book: Awaited<ReturnType<typeof createBook>>) => void;
    vi.mocked(createBook).mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const session = new BookCreationSession('owner', () => active, vi.fn());
    const action = session.create(request);
    await vi.waitFor(() => expect(createBook).toHaveBeenCalledTimes(1));
    active = false;
    done({ data: { id: '2', title: request.title } });
    await expect(action).rejects.toThrow('same author');
    expect(journal.deleteBookCreationIntent).not.toHaveBeenCalled();
    expect(retained?.state).toBe('dispatched');
  });
  it('blocks POST on local journal failure and never clears an ACK when its versioned delete fails', async () => {
    vi.mocked(journal.writeBookCreationIntent).mockRejectedValueOnce(
      new Error('storage unavailable'),
    );
    const blocked = new BookCreationSession('owner', () => true, vi.fn());
    await expect(blocked.create(request)).rejects.toThrow('storage');
    expect(createBook).not.toHaveBeenCalled();
    vi.mocked(createBook).mockResolvedValue({ data: { id: '2', title: request.title } });
    vi.mocked(journal.deleteBookCreationIntent).mockRejectedValue(new Error('newer journal'));
    const session = new BookCreationSession('owner', () => true, vi.fn());
    await expect(session.create(request)).rejects.toThrow('newer journal');
    expect(retained?.state).toBe('dispatched');
    expect(session.snapshot().pending).toBeDefined();
  });
  it('permits explicit discard only after a definite rejection and keeps its original payload', async () => {
    vi.mocked(createBook).mockRejectedValue(new FactoryRequestError(422, 'invalid title'));
    const session = new BookCreationSession('owner', () => true, vi.fn());
    await expect(session.create(request)).rejects.toThrow();
    expect(session.snapshot().pending?.state).toBe('rejected');
    expect(session.snapshot().pending?.request).toEqual(request);
    await session.discardRejected();
    expect(session.snapshot().pending).toBeUndefined();
  });
  it('rejects simultaneous submissions and another request while an uncertain operation remains', async () => {
    let done!: (book: Awaited<ReturnType<typeof createBook>>) => void;
    vi.mocked(createBook).mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const session = new BookCreationSession('owner', () => true, vi.fn());
    const action = session.create(request);
    await vi.waitFor(() => expect(createBook).toHaveBeenCalledTimes(1));
    await expect(session.create({ ...request, title: 'second' })).rejects.toThrow('in progress');
    done({ data: { id: '2', title: 'wrong title' } });
    await expect(action).rejects.toThrow('match');
    await expect(session.create({ ...request, title: 'second' })).rejects.toThrow('pending');
    expect(createBook).toHaveBeenCalledTimes(1);
  });
  it('keeps409 conflicts uncertain until exact receipt recovery instead of allowing discard or another POST', async () => {
    vi.mocked(createBook).mockRejectedValue(
      new FactoryRequestError(409, 'operation already exists'),
    );
    const session = new BookCreationSession('owner', () => true, vi.fn());
    await expect(session.create(request)).rejects.toThrow('already exists');
    expect(session.snapshot().pending?.state).toBe('dispatched');
    await expect(session.discardRejected()).rejects.toThrow('uncertain');
    await expect(session.retry()).rejects.toThrow('Recover');
    vi.mocked(recoverDocumentBookCreation).mockResolvedValue(receipt(retained!.operationId));
    await expect(session.recover()).resolves.toMatchObject({ data: { id: '2' } });
    expect(createBook).toHaveBeenCalledTimes(1);
  });
  it('allows explicit recovery-storage retry after a transient read failure without dispatching a mutation', async () => {
    vi.mocked(journal.readBookCreationIntent).mockRejectedValueOnce(
      new Error('temporary storage lock'),
    );
    const session = new BookCreationSession('owner', () => true, vi.fn());
    await expect(session.load()).rejects.toThrow('storage lock');
    expect(session.snapshot().ready).toBe(false);
    await session.load();
    expect(session.snapshot().ready).toBe(true);
    expect(session.snapshot().error).toBeUndefined();
    expect(createBook).not.toHaveBeenCalled();
  });
  it.each([
    { enabled: false, schemaVersion: 1 },
    { enabled: true, schemaVersion: 2 },
  ])(
    'rejects inactive/unsupported Factory %j before retaining a new intent or making a book POST',
    async (capabilities) => {
      vi.mocked(getAuthoringDocumentCapabilities).mockResolvedValue(
        documentCapabilitiesFixture(capabilities),
      );
      const session = new BookCreationSession('owner', () => true, vi.fn());
      await expect(session.create(request)).rejects.toThrow(
        'compatible structured document authority',
      );
      expect(createBook).not.toHaveBeenCalled();
      expect(journal.writeBookCreationIntent).not.toHaveBeenCalled();
      expect(session.snapshot().pending).toBeUndefined();
    },
  );
  it('keeps an original uncertain nonce after retry capability failure and can still recover its completed receipt', async () => {
    vi.mocked(createBook).mockRejectedValue(new Error('acknowledgement lost'));
    const session = new BookCreationSession('owner', () => true, vi.fn());
    await expect(session.create(request)).rejects.toThrow('lost');
    const original = structuredClone(retained!);
    vi.mocked(recoverDocumentBookCreation).mockRejectedValueOnce(
      new DocumentRequestError('missing', 404),
    );
    await session.recover();
    const beforeRetry = structuredClone(retained!);
    vi.mocked(getAuthoringDocumentCapabilities).mockResolvedValue(
      documentCapabilitiesFixture({ enabled: false }),
    );
    await expect(session.retry()).rejects.toThrow('compatible structured document authority');
    expect(retained).toEqual(beforeRetry);
    expect(retained?.state).not.toBe('rejected');
    expect(createBook).toHaveBeenCalledTimes(1);
    expect(journal.deleteBookCreationIntent).not.toHaveBeenCalled();
    vi.mocked(recoverDocumentBookCreation).mockResolvedValue(receipt(original.operationId));
    await expect(session.recover()).resolves.toMatchObject({ data: { id: '2' } });
    expect(createBook).toHaveBeenCalledTimes(1);
  });
  it('stops after a late capability acknowledgement when the author changed, before journal admission or POST', async () => {
    let active = true;
    let done!: (value: Awaited<ReturnType<typeof getAuthoringDocumentCapabilities>>) => void;
    vi.mocked(getAuthoringDocumentCapabilities).mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const session = new BookCreationSession('owner', () => active, vi.fn());
    const action = session.create(request);
    await vi.waitFor(() => expect(getAuthoringDocumentCapabilities).toHaveBeenCalledTimes(1));
    active = false;
    done(documentCapabilitiesFixture());
    await expect(action).rejects.toThrow('same author');
    expect(journal.writeBookCreationIntent).not.toHaveBeenCalled();
    expect(createBook).not.toHaveBeenCalled();
  });
});
