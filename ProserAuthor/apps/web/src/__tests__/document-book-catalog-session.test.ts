import { describe, expect, it, vi } from 'vitest';
import {
  BookCatalogSession,
  type BookCatalogDependencies,
} from '@/lib/document-book-catalog-session';
import type { BookCatalogIntent } from '@/lib/document-book-catalog-journal';
import type { BookCatalogScope, BookCatalogReceipt } from '@/lib/document-api';

const failure = (status: number) => Object.assign(new Error(`Failure ${status}`), { status });
const scope = (): BookCatalogScope => ({
  revisionId: 'structure-before',
  bookRevisionId: 'book-before',
  contentHash: 'hash',
  content: {
    schemaVersion: 1,
    acts: [],
    chapters: [],
    scenes: [],
    book: {
      title: 'Saved title',
      summary: 'Saved summary',
      genre: 'fantasy',
      targetAudience: null,
      draftStatus: 'draft',
      tagline: null,
      storyOutline: null,
      storyArchetypeKey: 'saved-archetype',
      selectedImageId: 0,
    },
  },
});
function fixture() {
  const userId = crypto.randomUUID();
  let retained: BookCatalogIntent | undefined;
  const receipt = (): BookCatalogReceipt => ({
    kind: 'catalog',
    status: 'completed',
    operationId: retained!.operationId,
    revisionId: 'book-after',
    contentHash: 'hash-after',
    result:
      retained!.kind === 'delete'
        ? { bookId: Number(retained!.bookId) }
        : { id: Number(retained!.bookId) },
  });
  const deps: BookCatalogDependencies = {
    read: vi.fn(async (owner) =>
      retained?.userId === owner ? structuredClone(retained) : undefined,
    ),
    write: vi.fn(async (row, expected) => {
      if (retained?.version !== expected) throw failure(409);
      retained = structuredClone(row);
    }),
    remove: vi.fn(async (owner, version, operationId) => {
      if (
        retained &&
        (retained.userId !== owner ||
          retained.version !== version ||
          retained.operationId !== operationId)
      )
        throw failure(409);
      retained = undefined;
    }),
    scope: vi.fn(async () => scope()),
    mutate: vi.fn(async () => undefined),
    recover: vi.fn(async () => receipt()),
  };
  return {
    userId,
    deps,
    receipt,
    session: new BookCatalogSession(userId, deps),
    get retained() {
      return retained;
    },
  };
}
describe('owned immutable book catalog operations', () => {
  it('uses the dialog-open metadata and both revisions, rejecting stale edits without refetch or rebase', async () => {
    const f = fixture();
    const snapshot = await f.session.prepare('7');
    expect(snapshot.book.title).toBe('Saved title');
    expect(snapshot.book.archetype).toBe('saved-archetype');
    expect(snapshot.sourceBook).toEqual(scope().content.book);
    vi.mocked(f.deps.scope).mockResolvedValue({ ...scope(), bookRevisionId: 'newer' });
    vi.mocked(f.deps.mutate).mockRejectedValue(failure(412));
    await expect(f.session.update(snapshot, { title: 'My form' })).rejects.toThrow('412');
    expect(f.deps.scope).toHaveBeenCalledOnce();
    expect(f.retained?.preconditions).toMatchObject({
      expectedRevisionId: 'book-before',
      expectedScopes: { structure: 'structure-before' },
    });
    expect(f.retained?.patch).toEqual({ title: 'My form' });
    expect(f.session.getSnapshot().pending?.status).toBe('rejected');
    vi.mocked(f.deps.recover).mockRejectedValueOnce(failure(404));
    expect(await f.session.recover()).toBeUndefined();
    expect(f.session.getSnapshot().pending?.status).toBe('rejected');
    expect(f.session.getSnapshot().retryAllowed).toBe(false);
    await expect(f.session.prepare('7')).rejects.toThrow('Recover');
    await f.session.discardRejected();
    expect((await f.session.prepare('7')).bookRevisionId).toBe('newer');
  });
  it('does not dispatch when the exact intent cannot be retained', async () => {
    const f = fixture();
    const snapshot = await f.session.prepare('7');
    vi.mocked(f.deps.write).mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(f.session.remove(snapshot)).rejects.toThrow('Storage unavailable');
    expect(f.deps.mutate).not.toHaveBeenCalled();
    expect(f.session.getSnapshot().journalError).toBe('Storage unavailable');
  });
  it('recovers a lost delete acknowledgement through the original receipt without repeating deletion', async () => {
    const f = fixture();
    const snapshot = await f.session.prepare('7');
    vi.mocked(f.deps.mutate).mockRejectedValueOnce(new Error('Lost acknowledgement'));
    await expect(f.session.remove(snapshot)).rejects.toThrow('Lost acknowledgement');
    const operationId = f.retained!.operationId;
    const reopened = new BookCatalogSession(f.userId, f.deps);
    await reopened.load();
    expect(reopened.getSnapshot().pending?.snapshot.book.title).toBe('Saved title');
    expect(await reopened.recover()).toMatchObject({ operationId, kind: 'catalog' });
    expect(f.deps.recover).toHaveBeenCalledWith('7', operationId, f.userId);
    expect(f.deps.mutate).toHaveBeenCalledOnce();
    expect(f.retained).toBeUndefined();
  });
  it('requires an original 404 before explicit continuation and rechecks for delayed completion', async () => {
    const f = fixture();
    const snapshot = await f.session.prepare('7');
    vi.mocked(f.deps.mutate).mockRejectedValueOnce(new Error('Unknown outcome'));
    await expect(f.session.update(snapshot, { summary: 'Owned change' })).rejects.toThrow();
    const operationId = f.retained!.operationId;
    await expect(f.session.retry()).rejects.toThrow('Recover');
    vi.mocked(f.deps.recover).mockRejectedValueOnce(failure(404));
    expect(await f.session.recover()).toBeUndefined();
    expect(f.session.getSnapshot().retryAllowed).toBe(true);
    await expect(f.session.discardRejected()).rejects.toThrow('uncertain');
    // Delayed original acknowledgement appears before the explicit retry.
    expect(await f.session.retry()).toMatchObject({ operationId });
    expect(f.deps.mutate).toHaveBeenCalledOnce();
  });
  it('retries only the retained operation/preconditions after two original-receipt 404 checks', async () => {
    const f = fixture();
    const snapshot = await f.session.prepare('7');
    vi.mocked(f.deps.mutate).mockRejectedValueOnce(new Error('Unknown outcome'));
    await expect(f.session.remove(snapshot)).rejects.toThrow();
    const request = structuredClone(f.retained!);
    vi.mocked(f.deps.recover)
      .mockRejectedValueOnce(failure(404))
      .mockRejectedValueOnce(failure(404));
    await f.session.recover();
    await f.session.retry();
    const calls = vi.mocked(f.deps.mutate).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![0].operationId).toBe(request.operationId);
    expect(calls[1]![0].preconditions).toEqual(request.preconditions);
    expect(f.deps.scope).toHaveBeenCalledOnce();
  });
  it('retains unknown outcomes on recovery failures and rejects silent discard', async () => {
    const f = fixture();
    await expect(
      (async () => f.session.remove(await f.session.prepare('7')))(),
    ).resolves.toBeDefined();
    // Start another operation whose provider acknowledgement is uncertain.
    vi.mocked(f.deps.mutate).mockRejectedValueOnce(new Error('Lost ACK'));
    await expect(f.session.remove(await f.session.prepare('8'))).rejects.toThrow();
    vi.mocked(f.deps.recover).mockRejectedValueOnce(failure(503));
    await expect(f.session.recover()).rejects.toThrow('503');
    await expect(f.session.discardRejected()).rejects.toThrow('uncertain');
    expect(f.session.getSnapshot().retryAllowed).toBe(false);
    expect(f.retained?.bookId).toBe('8');
  });
  it('keeps a durable completed operation recoverable when acknowledgement deletion loses CAS', async () => {
    const f = fixture();
    const snapshot = await f.session.prepare('7');
    vi.mocked(f.deps.remove).mockRejectedValueOnce(new Error('Journal version changed'));
    await expect(f.session.update(snapshot, { title: 'Changed' })).rejects.toThrow(
      'Journal version changed',
    );
    expect(f.retained?.status).toBe('unknown');
    expect(f.session.getSnapshot().journalError).toBe('Journal version changed');
    await f.session.recover();
    expect(f.deps.mutate).toHaveBeenCalledOnce();
  });
  it('suppresses late acknowledgements and never reveals another authenticated owner intent', async () => {
    const f = fixture();
    let finish!: () => void;
    vi.mocked(f.deps.mutate).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.session.remove(await f.session.prepare('7'));
    await vi.waitFor(() => expect(finish).toBeDefined());
    f.session.dispose();
    const foreign = new BookCatalogSession('another-user', f.deps);
    await foreign.load();
    expect(foreign.getSnapshot().pending).toBeUndefined();
    finish();
    await expect(pending).rejects.toThrow('authenticated user changed');
    expect(f.deps.recover).not.toHaveBeenCalled();
    expect(f.retained?.userId).toBe(f.userId);
    expect(f.session.getSnapshot().pending).toBeUndefined();
  });
  it('rejects a foreign or modified snapshot before any mutation', async () => {
    const f = fixture();
    const snapshot = await f.session.prepare('7');
    await expect(
      f.session.remove({ ...snapshot, bookRevisionId: 'guessed-newer' }),
    ).rejects.toThrow('exact saved snapshot');
    expect(f.deps.mutate).not.toHaveBeenCalled();
    expect(f.deps.write).not.toHaveBeenCalled();
  });
  it('keeps generic 409 outcomes uncertain until the original completed receipt is recovered', async () => {
    const f = fixture();
    vi.mocked(f.deps.mutate).mockRejectedValueOnce(failure(409));
    await expect(f.session.remove(await f.session.prepare('7'))).rejects.toThrow('409');
    expect(f.retained?.status).toBe('unknown');
    await expect(f.session.discardRejected()).rejects.toThrow('uncertain');
    expect(await f.session.recover()).toMatchObject({ status: 'completed' });
    expect(f.deps.mutate).toHaveBeenCalledOnce();
  });
  it('allows explicit receipt recovery after a transient IndexedDB read failure without replaying the mutation', async () => {
    const f = fixture();
    vi.mocked(f.deps.mutate).mockRejectedValueOnce(new Error('Unknown ACK'));
    await expect(f.session.remove(await f.session.prepare('7'))).rejects.toThrow();
    const reopened = new BookCatalogSession(f.userId, f.deps);
    vi.mocked(f.deps.read).mockRejectedValueOnce(new Error('Storage temporarily blocked'));
    await expect(reopened.load()).rejects.toThrow('Storage temporarily blocked');
    expect(reopened.getSnapshot().journalError).toBe('Storage temporarily blocked');
    expect(await reopened.recover()).toMatchObject({ status: 'completed' });
    expect(f.deps.mutate).toHaveBeenCalledOnce();
    expect(reopened.getSnapshot().journalError).toBeUndefined();
  });
  it('waits for a retiring owner journal write before a replacement session loads recovery', async () => {
    const f = fixture();
    const snapshot = await f.session.prepare('7');
    const write = f.deps.write;
    let release!: () => void;
    vi.mocked(f.deps.write).mockImplementationOnce(async (row, version) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (f.retained?.version !== version) throw failure(409);
      // The original mock is replaced only for this queued first write.
      await write(row, version);
    });
    const pending = f.session.remove(snapshot);
    await vi.waitFor(() => expect(release).toBeDefined());
    f.session.dispose();
    const reopened = new BookCatalogSession(f.userId, f.deps);
    let loaded = false;
    const loading = reopened.load().then(() => {
      loaded = true;
    });
    await Promise.resolve();
    expect(loaded).toBe(false);
    release();
    await expect(pending).rejects.toThrow('authenticated user changed');
    await loading;
    expect(reopened.getSnapshot().pending?.status).toBe('prepared');
    expect(f.deps.mutate).not.toHaveBeenCalled();
  });
  it('does not acknowledge an unrelated operation receipt', async () => {
    const f = fixture();
    vi.mocked(f.deps.recover).mockImplementationOnce(async () => ({
      ...f.receipt(),
      operationId: 'different',
    }));
    await expect(f.session.remove(await f.session.prepare('7'))).rejects.toThrow(
      'exact book operation',
    );
    expect(f.retained).toBeDefined();
    expect(f.deps.remove).not.toHaveBeenCalled();
  });
});
