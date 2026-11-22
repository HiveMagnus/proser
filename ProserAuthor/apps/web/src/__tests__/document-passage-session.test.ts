import { describe, expect, it, vi } from 'vitest';
import {
  canonicalDocument,
  defaultLayout,
  type DocumentPassage,
  type DocumentPassageCommit,
  type DocumentPassageReceipt,
} from '@cheftaco/proser-contracts';
import {
  DocumentPassageSession,
  type PassageSessionDependencies,
} from '@/lib/document-passage-session';
import type { DocumentPassageDraft } from '@/lib/document-passage-journal';
function window(revision = 'before', changed = false): DocumentPassage {
  const paragraphs = ['First', 'Second'].map((text, index) => ({
    paragraph: {
      type: 'paragraph' as const,
      id: `paragraph-${index}`,
      style: {},
      runs: [{ id: `run-${index}`, text: changed && index === 0 ? 'First new' : text, style: {} }],
    },
    ordinal: index,
    offset: 0,
    length: changed && index === 0 ? 9 : text.length,
    continuedBefore: false,
    continuedAfter: false,
    runs: [
      {
        runId: `run-${index}`,
        sourceHash: (changed && index === 0 ? '8' : String(index + 1)).repeat(64),
        from: 0,
        to: changed && index === 0 ? 9 : text.length,
        sourceLength: changed && index === 0 ? 9 : text.length,
      },
    ],
  }));
  return {
    schemaVersion: 1,
    sourceFrame: {
      bookId: 1,
      actId: 2,
      chapterId: 3,
      sceneId: 4,
      bookRevisionId: `book-${revision}`,
      sceneRevisionId: `scene-${revision}`,
      bookContentHash: 'a'.repeat(64),
      sceneContentHash: 'b'.repeat(64),
      qualifiedMembershipHash: 'c'.repeat(64),
      effectiveStyleLayoutHash: 'd'.repeat(64),
      structureScope: { revisionId: 'structure', contentHash: 'e'.repeat(64) },
      layoutScope: { revisionId: 'layout', contentHash: 'f'.repeat(64) },
      projection: 'final',
    },
    bookRevisionId: `book-${revision}`,
    sceneId: 4,
    sceneRevisionId: `scene-${revision}`,
    contentHash: 'b'.repeat(64),
    projection: 'final',
    cursor: { paragraph: 0, offset: 0 },
    paragraphs,
    images: [],
    changes: [],
    omitted: { paragraphs: 900000, objects: 0, comments: 0, changes: 0 },
    layout: defaultLayout(),
    windowHash: '9'.repeat(64),
  };
}
function receipt(request: DocumentPassageCommit): DocumentPassageReceipt {
  const passage = window('after', true);
  const reference = {
    sceneId: 4,
    chapterId: 3,
    sceneNumber: 1,
    revisionId: passage.sceneRevisionId,
    contentHash: passage.contentHash,
    wordCount: 300000,
  };
  return {
    kind: 'catalog',
    operationId: request.operationId,
    revisionId: passage.bookRevisionId,
    contentHash: 'a'.repeat(64),
    manifest: { schemaVersion: 1, scenes: [reference] },
    sceneReferences: [reference],
    result: passage,
    status: 'completed',
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  let row: DocumentPassageDraft | undefined;
  let sequence = 0;
  const dependencies: PassageSessionDependencies = {
    load: vi.fn(async () => window()),
    read: vi.fn(async () => (row ? structuredClone(row) : undefined)),
    write: vi.fn(async (draft, version) => {
      if (
        row &&
        (row.version !== version ||
          (row.pending && canonicalDocument(row.pending) !== canonicalDocument(draft.pending)))
      )
        throw new Error('Competing tab');
      row = structuredClone(draft);
    }),
    advance: vi.fn(async (draft, version, operationId) => {
      if (!row || row.version !== version || row.pending?.request.operationId !== operationId)
        throw new Error('Stale acknowledgement');
      row = structuredClone(draft);
    }),
    remove: vi.fn(async (version) => {
      if (row?.version === version) row = undefined;
    }),
    save: vi.fn(async (request) => receipt(request)),
    recover: vi.fn(async () => undefined),
    operationId: () => `operation-${++sequence}`,
    version: () => `journal-${++sequence}`,
  };
  const session = new DocumentPassageSession(
    { userId: 'trusted-user', bookId: '1', sceneId: '4' },
    dependencies,
    { maxCharacters: 2400, maxParagraphs: 12 },
  );
  return { session, dependencies, row: () => row };
}
const edit = { blockId: 'paragraph-0', runId: 'run-0', text: 'First new' };
async function until(predicate: () => boolean) {
  for (let n = 0; n < 100 && !predicate(); n++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
}
describe('inactive bounded passage session', () => {
  it('persists an exact request before dispatch and claims saved only for the acknowledged current text', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    session.edit(edit);
    vi.mocked(dependencies.save).mockImplementation(async (request) => {
      expect(row()?.pending?.request).toEqual(request);
      return receipt(request);
    });
    await session.save(true);
    expect(session.getSnapshot()).toMatchObject({
      state: 'saved',
      drafts: [],
      passage: { sceneRevisionId: 'scene-after' },
    });
    expect(row()).toBeUndefined();
    const request = vi.mocked(dependencies.save).mock.calls[0]![0];
    expect(request).toMatchObject({
      expectedRevisionId: 'book-before',
      expectedSceneRevisionId: 'scene-before',
      maxCharacters: 2400,
      maxParagraphs: 12,
      tracking: true,
    });
    expect(JSON.stringify(request).length).toBeLessThan(1024);
  });
  it('recovers a lost acknowledgement using the original operation without repeating the save', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    session.edit(edit);
    vi.mocked(dependencies.save).mockRejectedValue(new Error('Lost acknowledgement'));
    await session.save();
    expect(session.getSnapshot().state).toBe('recoverable');
    const original = row()!.pending!.request as DocumentPassageCommit;
    vi.mocked(dependencies.recover).mockResolvedValue(receipt(original));
    await session.recover();
    expect(session.getSnapshot().state).toBe('saved');
    expect(dependencies.save).toHaveBeenCalledTimes(1);
    expect(dependencies.recover).toHaveBeenCalledWith(original.operationId);
    expect(row()).toBeUndefined();
  });
  it('preserves disjoint typing during save under unchanged exact run source proofs', async () => {
    const { session, dependencies, row } = harness();
    const completion = deferred<DocumentPassageReceipt>();
    vi.mocked(dependencies.save).mockReturnValue(completion.promise);
    await session.load();
    session.edit(edit);
    const saving = session.save();
    await until(() => vi.mocked(dependencies.save).mock.calls.length === 1);
    session.edit({ blockId: 'paragraph-1', runId: 'run-1', text: 'Second continued' });
    const request = vi.mocked(dependencies.save).mock.calls[0]![0];
    completion.resolve(receipt(request));
    await saving;
    expect(session.getSnapshot()).toMatchObject({
      state: 'unsaved',
      passage: { sceneRevisionId: 'scene-after' },
      drafts: [{ blockId: 'paragraph-1', runId: 'run-1', text: 'Second continued' }],
    });
    expect(row()?.pending).toBeUndefined();
    expect(row()).toMatchObject({
      passage: { sceneRevisionId: 'scene-after' },
      drafts: session.getSnapshot().drafts,
    });
  });
  it('retains same-run later typing and an undo while in flight instead of falsely marking them saved', async () => {
    for (const text of ['First new more', 'First']) {
      const { session, dependencies, row } = harness();
      const completion = deferred<DocumentPassageReceipt>();
      vi.mocked(dependencies.save).mockReturnValue(completion.promise);
      await session.load();
      session.edit(edit);
      const saving = session.save();
      await until(() => vi.mocked(dependencies.save).mock.calls.length === 1);
      session.edit({ ...edit, text });
      completion.resolve(receipt(vi.mocked(dependencies.save).mock.calls[0]![0]));
      await saving;
      expect(session.getSnapshot().state).toBe('conflict');
      expect(row()?.passage.sceneRevisionId).toBe('scene-before');
      expect(row()?.pending?.request.operationId).toBeDefined();
      const pending = row()?.pending;
      expect(pending?.kind === 'commit' && pending.submittedDrafts).toEqual([edit]);
      expect(row()?.drafts).toEqual(text === 'First' ? [] : [{ ...edit, text }]);
    }
  });
  it('retains input arriving during the local acknowledgement transaction', async () => {
    const { session, dependencies, row } = harness();
    const removing = deferred<void>();
    const originalRemove = vi.mocked(dependencies.remove).getMockImplementation()!;
    vi.mocked(dependencies.remove).mockImplementation(async (version) => {
      await removing.promise;
      await originalRemove(version);
    });
    await session.load();
    session.edit(edit);
    const saving = session.save();
    await until(() => vi.mocked(dependencies.remove).mock.calls.length === 1);
    session.edit({ ...edit, text: 'First new late' });
    removing.resolve();
    await saving;
    await until(() => row()?.drafts[0]?.text === 'First new late');
    expect(session.getSnapshot().state).toBe('conflict');
    expect(row()?.pending?.request.operationId).toBeDefined();
    expect(row()?.passage.sceneRevisionId).toBe('scene-before');
  });
  it('never dispatches after draft storage failure or reveals late results after logout', async () => {
    const { session, dependencies } = harness();
    await session.load();
    vi.mocked(dependencies.write).mockRejectedValue(new Error('IndexedDB unavailable'));
    session.edit(edit);
    await session.save();
    expect(dependencies.save).not.toHaveBeenCalled();
    expect(session.getSnapshot().state).toBe('failed');
    const active = harness();
    const completion = deferred<DocumentPassageReceipt>();
    vi.mocked(active.dependencies.save).mockReturnValue(completion.promise);
    await active.session.load();
    active.session.edit(edit);
    const saving = active.session.save();
    await until(() => vi.mocked(active.dependencies.save).mock.calls.length === 1);
    active.session.dispose();
    completion.resolve(receipt(vi.mocked(active.dependencies.save).mock.calls[0]![0]));
    await saving;
    expect(active.session.getSnapshot()).toEqual({ state: 'inactive', drafts: [] });
    expect(active.dependencies.remove).not.toHaveBeenCalled();
    expect(active.row()?.pending).toBeDefined();
  });
});
