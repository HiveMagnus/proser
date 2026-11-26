import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentFromText, projectDocument, type ProserDocument } from '@hivemagnus/proser-editor';
import { useDocumentSession } from '@/hooks/use-document-session';
import {
  DocumentRequestError,
  getSceneDocument,
  recoverDocumentSave,
  saveSceneDocument,
  type SaveDocumentReceipt,
  type SaveDocumentRequest,
  type SavedSceneDocument,
} from '@/lib/document-api';
import { deleteDocumentDraft, readDocumentDraft, writeDocumentDraft } from '@/lib/document-drafts';
vi.mock('@/lib/document-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/document-api')>('@/lib/document-api');
  return {
    ...actual,
    getSceneDocument: vi.fn(),
    recoverDocumentSave: vi.fn(),
    saveSceneDocument: vi.fn(),
  };
});
vi.mock('@/lib/document-drafts', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/document-drafts')>('@/lib/document-drafts');
  return {
    ...actual,
    readDocumentDraft: vi.fn(),
    writeDocumentDraft: vi.fn(),
    deleteDocumentDraft: vi.fn(),
  };
});
let sequence = 0;
const document = (text: string) => documentFromText(text, () => `fixture-${++sequence}`);
const saved = (): SavedSceneDocument => ({
  sceneId: 1,
  revisionId: 'scene-1',
  bookRevisionId: 'book-1',
  contentHash: 'hash-1',
  document: document('Saved'),
  projection: { text: 'Saved', wordCount: 1, spans: [] },
});
const receipt = (request: SaveDocumentRequest): SaveDocumentReceipt => {
  const entry = request.scenes[0]!;
  const block = entry.document.blocks[0];
  return {
    kind: 'commit',
    operationId: request.operationId,
    revisionId: 'book-2',
    status: 'completed',
    scenes: [
      {
        sceneId: 1,
        revisionId: 'scene-2',
        contentHash: 'hash-2',
        text: block?.type === 'paragraph' ? block.runs.map((run) => run.text).join('') : '',
        wordCount: 1,
        document: entry.document,
      },
    ],
  };
};
beforeEach(() => {
  sequence = 0;
  vi.resetAllMocks();
  vi.mocked(getSceneDocument).mockResolvedValue(saved());
  vi.mocked(readDocumentDraft).mockResolvedValue(undefined);
  vi.mocked(writeDocumentDraft).mockResolvedValue('fixture-key');
  vi.mocked(deleteDocumentDraft).mockResolvedValue(undefined);
  vi.mocked(recoverDocumentSave).mockRejectedValue(
    new DocumentRequestError('Missing operation', 404),
  );
  vi.mocked(saveSceneDocument).mockImplementation(async (_book, input) => receipt(input));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('document save authority', () => {
  it('proposes disjoint block reconciliation and saves only after explicit application', async () => {
    const initial = saved();
    initial.document = document('First\n\nSecond');
    vi.mocked(getSceneDocument).mockResolvedValue(initial);
    const hook = renderHook(() => useDocumentSession('user-a', '1', '1'));
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    const local = structuredClone(initial.document);
    const first = local.blocks[0];
    if (first?.type !== 'paragraph') throw new Error('fixture');
    first.runs[0]!.text = 'Local first';
    vi.mocked(saveSceneDocument).mockRejectedValueOnce(
      new DocumentRequestError('Newer revision', 412),
    );
    act(() => hook.result.current.change(local));
    await act(async () => {
      await hook.result.current.save();
    });
    expect(writeDocumentDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseRevisionId: 'scene-1', baseDocument: initial.document }),
    );
    const remote = {
      ...initial,
      revisionId: 'scene-newer',
      bookRevisionId: 'book-newer',
      document: structuredClone(initial.document),
    };
    const second = remote.document.blocks[1];
    if (second?.type !== 'paragraph') throw new Error('fixture');
    second.runs[0]!.text = 'Saved second';
    vi.mocked(getSceneDocument).mockResolvedValue(remote);
    await act(async () => {
      await hook.result.current.inspectConflict();
    });
    expect(hook.result.current.reconciliation?.conflicts).toEqual([]);
    expect(hook.result.current.state).toBe('conflict');
    expect(saveSceneDocument).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.useMergedDraft());
    await act(async () => {
      await hook.result.current.save();
    });
    const request = vi.mocked(saveSceneDocument).mock.calls[1]![1];
    expect(request.expectedRevisionId).toBe('book-newer');
    expect(request.scenes[0]!.expectedRevisionId).toBe('scene-newer');
    expect(hook.result.current.state).toBe('saved');
  });
  it('retains offline edits and resumes receipt recovery when connectivity returns', async () => {
    const hook = renderHook(() => useDocumentSession('user-a', '1', '1'));
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    const online = vi.spyOn(navigator, 'onLine', 'get');
    online.mockReturnValue(false);
    const draft = document('Offline draft');
    act(() => hook.result.current.change(draft));
    await waitFor(() =>
      expect(writeDocumentDraft).toHaveBeenCalledWith(expect.objectContaining({ document: draft })),
    );
    expect(hook.result.current.state).toBe('offline');
    await act(async () => {
      await hook.result.current.save();
    });
    expect(saveSceneDocument).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('online')));
    expect(hook.result.current.state).toBe('unsaved');
    await act(async () => {
      await hook.result.current.save();
    });
    expect(hook.result.current.state).toBe('saved');
    expect(recoverDocumentSave).toHaveBeenCalledTimes(1);
    expect(saveSceneDocument).toHaveBeenCalledTimes(1);
  });
  it('ignores the prior editor teardown mutation after changing authenticated identity', async () => {
    const hook = renderHook(({ user }) => useDocumentSession(user, '1', '1'), {
      initialProps: { user: 'user-a' },
    });
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    const previousChange = hook.result.current.change;
    const otherUserDocument = saved();
    vi.mocked(getSceneDocument).mockResolvedValue(otherUserDocument);
    hook.rerender({ user: 'user-b' });
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    act(() => previousChange(document('Prior account teardown')));
    expect(hook.result.current.document).toEqual(otherUserDocument.document);
    expect(writeDocumentDraft).not.toHaveBeenCalled();
  });
  it('hides the prior user document immediately on an authenticated identity change', async () => {
    const hook = renderHook(({ user }) => useDocumentSession(user, '1', '1'), {
      initialProps: { user: 'user-a' },
    });
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    vi.mocked(getSceneDocument).mockImplementation(() => new Promise(() => {}));
    hook.rerender({ user: 'user-b' });
    expect(hook.result.current.document).toBeUndefined();
    expect(hook.result.current.recovery).toBeUndefined();
    expect(hook.result.current.state).toBe('loading');
  });
  it('does not show Saved before Factory acknowledges durable persistence', async () => {
    let acknowledge: ((value: SaveDocumentReceipt) => void) | undefined;
    vi.mocked(saveSceneDocument).mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const hook = renderHook(() => useDocumentSession('user-a', '1', '1'));
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    act(() => hook.result.current.change(document('Changed')));
    let save: Promise<void> | undefined;
    act(() => {
      save = hook.result.current.save();
    });
    await waitFor(() => expect(saveSceneDocument).toHaveBeenCalledTimes(1));
    expect(hook.result.current.state).toBe('saving');
    const request = vi.mocked(saveSceneDocument).mock.calls[0]![1];
    await act(async () => {
      acknowledge!(receipt(request));
      await save;
    });
    expect(hook.result.current.state).toBe('saved');
    expect(deleteDocumentDraft).toHaveBeenCalledTimes(1);
  });
  it('carries authenticated tracking and orphan evidence into a newer draft after a delayed acknowledgement', async () => {
    const initial = saved();
    const first = initial.document.blocks[0];
    if (first?.type !== 'paragraph') throw new Error('fixture');
    initial.document.comments = [
      {
        id: 'comment',
        authorId: 7,
        authorName: 'Writer',
        createdAt: '2026-01-01T00:00:00.000Z',
        text: 'Original note',
        anchors: [
          { blockId: first.id, runId: first.runs[0]!.id, start: 0, end: 5, sourceText: 'Saved' },
        ],
        resolved: false,
      },
    ];
    vi.mocked(getSceneDocument).mockResolvedValue(initial);
    let acknowledge: ((value: SaveDocumentReceipt) => void) | undefined;
    vi.mocked(saveSceneDocument).mockImplementationOnce(
      (_book, _input) =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const hook = renderHook(() => useDocumentSession('user-a', '1', '1'));
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    const local: ProserDocument = structuredClone(initial.document);
    const paragraph = local.blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('fixture');
    paragraph.runs[0]!.text = '';
    paragraph.runs.push({ id: 'inserted', text: ' first', style: {}, changeId: 'tracking' });
    local.changes.push({
      id: 'tracking',
      kind: 'insertion',
      status: 'pending',
      authorId: 0,
      authorName: 'You',
      createdAt: '2026-01-01T00:00:00.000Z',
      origin: 'manual',
      targetRunIds: ['inserted'],
    });
    act(() => hook.result.current.change(local));
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.save();
    });
    await waitFor(() => expect(acknowledge).toBeDefined());
    const newer = structuredClone(local);
    const newerParagraph = newer.blocks[0];
    if (newerParagraph?.type !== 'paragraph') throw new Error('fixture');
    newerParagraph.runs[1]!.text += ' while saving';
    newerParagraph.runs[0]!.text = '';
    act(() => hook.result.current.change(newer));
    const committed = receipt(vi.mocked(saveSceneDocument).mock.calls[0]![1]);
    const committedDocument = structuredClone(committed.scenes[0]!.document);
    committedDocument.changes[0] = {
      ...committedDocument.changes[0]!,
      authorId: 7,
      authorName: 'Authenticated Writer',
      createdAt: '2026-10-05T00:00:00.000Z',
    };
    committedDocument.comments[0]!.anchorStates = [
      {
        anchorIndex: 0,
        status: 'orphaned',
        reason: 'target-removed',
        sourceSceneId: 1,
        sourceSceneRevisionId: 'scene-1',
        sourceContentHash: 'a'.repeat(64),
        sourceAnchor: structuredClone(initial.document.comments[0]!.anchors[0]!),
      },
    ];
    committed.scenes[0]!.document = committedDocument;
    await act(async () => {
      acknowledge!(committed);
      await saving;
    });
    expect(hook.result.current.state).toBe('unsaved');
    expect(projectDocument(hook.result.current.document!).text).toBe(' first while saving');
    await act(async () => {
      await hook.result.current.save();
    });
    const request = vi.mocked(saveSceneDocument).mock.calls[1]![1];
    expect(request.scenes[0]!.document.changes[0]).toMatchObject({
      authorId: 7,
      authorName: 'Authenticated Writer',
      createdAt: '2026-10-05T00:00:00.000Z',
    });
    expect(request.scenes[0]!.document.comments[0]!.anchorStates).toEqual(
      committedDocument.comments[0]!.anchorStates,
    );
    expect(request.scenes[0]!.expectedRevisionId).toBe('scene-2');
    expect(hook.result.current.state).toBe('saved');
    hook.unmount();
    vi.mocked(getSceneDocument).mockResolvedValue({
      ...initial,
      document: request.scenes[0]!.document,
      revisionId: 'scene-3',
      bookRevisionId: 'book-3',
    });
    const reopened = renderHook(() => useDocumentSession('user-a', '1', '1'));
    await waitFor(() => expect(reopened.result.current.state).toBe('saved'));
    expect(projectDocument(reopened.result.current.document!).text).toBe(' first while saving');
    expect(reopened.result.current.document!.comments[0]!.anchorStates).toEqual(
      committedDocument.comments[0]!.anchorStates,
    );
  });
  it('retains newer local edits while an older save is in flight', async () => {
    let acknowledge: ((value: SaveDocumentReceipt) => void) | undefined;
    vi.mocked(saveSceneDocument).mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const hook = renderHook(() => useDocumentSession('user-a', '1', '1'));
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    act(() => hook.result.current.change(document('First edit')));
    let save: Promise<void> | undefined;
    act(() => {
      save = hook.result.current.save();
    });
    await waitFor(() => expect(saveSceneDocument).toHaveBeenCalledTimes(1));
    const request = vi.mocked(saveSceneDocument).mock.calls[0]![1];
    const newer = document('Newer edit');
    act(() => hook.result.current.change(newer));
    await act(async () => {
      acknowledge!(receipt(request));
      await save;
    });
    expect(hook.result.current.document).toEqual(newer);
    expect(hook.result.current.state).toBe('unsaved');
    expect(writeDocumentDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({
        document: newer,
        baseRevisionId: 'scene-2',
        baseBookRevisionId: 'book-2',
      }),
    );
    expect(deleteDocumentDraft).not.toHaveBeenCalled();
  });
  it('preserves the original pending operation after an interrupted save', async () => {
    vi.mocked(saveSceneDocument).mockRejectedValue(new Error('Connection interrupted'));
    const hook = renderHook(() => useDocumentSession('user-a', '1', '1'));
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    const draft = document('Recoverable edit');
    act(() => hook.result.current.change(draft));
    await act(async () => {
      await hook.result.current.save();
    });
    expect(hook.result.current.state).toBe('failed');
    const request = vi.mocked(saveSceneDocument).mock.calls[0]![1];
    expect(writeDocumentDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'user-a', document: draft, pendingSave: request }),
    );
    expect(deleteDocumentDraft).not.toHaveBeenCalled();
    vi.mocked(recoverDocumentSave).mockResolvedValue(receipt(request));
    await act(async () => {
      await hook.result.current.save();
    });
    expect(saveSceneDocument).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state).toBe('saved');
  });
  it('retains a stale draft and prevents automatic overwrite after a conflict', async () => {
    vi.mocked(saveSceneDocument).mockRejectedValue(
      new DocumentRequestError('Newer revision exists', 412),
    );
    const hook = renderHook(() => useDocumentSession('user-a', '1', '1'));
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    act(() => hook.result.current.change(document('Stale edit')));
    await act(async () => {
      await hook.result.current.save();
    });
    expect(hook.result.current.state).toBe('conflict');
    await act(async () => {
      await hook.result.current.save();
    });
    expect(saveSceneDocument).toHaveBeenCalledTimes(1);
    expect(deleteDocumentDraft).not.toHaveBeenCalled();
  });
  it('allows a corrected draft after an explicit validation rejection without replaying the invalid payload', async () => {
    vi.mocked(saveSceneDocument).mockRejectedValueOnce(
      new DocumentRequestError('Invalid document', 422),
    );
    const hook = renderHook(() => useDocumentSession('user-a', '1', '1'));
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    act(() => hook.result.current.change(document('Rejected draft')));
    await act(async () => {
      await hook.result.current.save();
    });
    const rejected = vi.mocked(saveSceneDocument).mock.calls[0]![1];
    const corrected = document('Corrected draft');
    act(() => hook.result.current.change(corrected));
    await act(async () => {
      await hook.result.current.save();
    });
    const accepted = vi.mocked(saveSceneDocument).mock.calls[1]![1];
    expect(accepted.operationId).not.toBe(rejected.operationId);
    expect(accepted.scenes[0]!.document).toEqual(corrected);
    expect(hook.result.current.state).toBe('saved');
  });
});

describe('shared canonical operation history', () => {
  it('undoes and redoes styles after an acknowledged save using a new revision-safe operation', async () => {
    const hook = renderHook(() => useDocumentSession('history-user', '1', '1'));
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    const original = structuredClone(hook.result.current.document!);
    const changed = structuredClone(original);
    const paragraph = changed.blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('fixture');
    paragraph.runs[0]!.style.bold = true;
    act(() => hook.result.current.change(changed));
    expect(hook.result.current.canUndo).toBe(true);
    await act(async () => {
      await hook.result.current.save();
    });
    const firstOperation = vi.mocked(saveSceneDocument).mock.calls[0]![1];
    await act(async () => {
      hook.result.current.undo();
      await hook.result.current.save();
    });
    expect(hook.result.current.document).toEqual(original);
    expect(hook.result.current.canRedo).toBe(true);
    expect(hook.result.current.state).toBe('saved');
    await act(async () => {
      await hook.result.current.save();
    });
    const undoOperation = vi.mocked(saveSceneDocument).mock.calls[1]![1];
    expect(undoOperation.operationId).not.toBe(firstOperation.operationId);
    expect(undoOperation.expectedRevisionId).toBe('book-2');
    expect(undoOperation.scenes[0]!.expectedRevisionId).toBe('scene-2');
    expect(undoOperation.scenes[0]!.restoreFromRevisionId).toBe('scene-1');
    await act(async () => {
      hook.result.current.redo();
      await hook.result.current.save();
    });
    expect(hook.result.current.document).toEqual(changed);
    expect(writeDocumentDraft).toHaveBeenCalledWith(
      expect.objectContaining({ history: expect.objectContaining({ cursor: 1 }) }),
    );
  });
  it('does not undo an unknown save until its exact operation is recovered', async () => {
    const hook = renderHook(() => useDocumentSession('history-user', '1', '1'));
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    act(() => hook.result.current.change(document('Unknown outcome')));
    vi.mocked(saveSceneDocument).mockRejectedValueOnce(new TypeError('Lost acknowledgement'));
    await act(async () => {
      await hook.result.current.save();
    });
    expect(hook.result.current.state).toBe('failed');
    expect(hook.result.current.canUndo).toBe(false);
    const request = vi.mocked(saveSceneDocument).mock.calls[0]![1];
    act(() => hook.result.current.undo());
    expect(hook.result.current.document).toEqual(request.scenes[0]!.document);
    vi.mocked(recoverDocumentSave).mockResolvedValueOnce(receipt(request));
    await act(async () => {
      await hook.result.current.save();
    });
    expect(hook.result.current.canUndo).toBe(true);
    expect(saveSceneDocument).toHaveBeenCalledTimes(1);
  });
});

describe('reload recovers exact save acknowledgement', () => {
  it('recovers a committed interrupted save without reposting or offering an acknowledged draft', async () => {
    const current = saved();
    const request: SaveDocumentRequest = {
      schemaVersion: 1,
      operationId: 'interrupted-operation',
      expectedRevisionId: 'book-before',
      scenes: [{ sceneId: 1, expectedRevisionId: 'scene-before', document: current.document }],
    };
    const completed = receipt(request);
    vi.mocked(getSceneDocument).mockResolvedValue({
      ...current,
      revisionId: 'scene-2',
      bookRevisionId: 'book-2',
    });
    vi.mocked(readDocumentDraft).mockResolvedValue({
      key: 'recovered-key',
      userId: 'recover-user',
      bookId: '1',
      sceneId: '1',
      baseRevisionId: 'scene-before',
      baseBookRevisionId: 'book-before',
      document: current.document,
      pendingSave: request,
      updatedAt: Date.now(),
    });
    vi.mocked(recoverDocumentSave).mockResolvedValueOnce(completed);
    const hook = renderHook(() => useDocumentSession('recover-user', '1', '1'));
    await waitFor(() => expect(hook.result.current.state).toBe('saved'));
    expect(hook.result.current.recovery).toBeUndefined();
    expect(recoverDocumentSave).toHaveBeenCalledWith('1', 'interrupted-operation');
    expect(deleteDocumentDraft).toHaveBeenCalled();
    expect(saveSceneDocument).not.toHaveBeenCalled();
  });
  it('keeps edits made after dispatch and advances their base to the recovered immutable receipt', async () => {
    const current = saved();
    const remaining = document('Edits after dispatch');
    const request: SaveDocumentRequest = {
      schemaVersion: 1,
      operationId: 'interrupted-operation',
      expectedRevisionId: 'book-before',
      scenes: [{ sceneId: 1, expectedRevisionId: 'scene-before', document: current.document }],
    };
    vi.mocked(readDocumentDraft).mockResolvedValue({
      key: 'recovered-key',
      userId: 'recover-user',
      bookId: '1',
      sceneId: '1',
      baseRevisionId: 'scene-before',
      baseBookRevisionId: 'book-before',
      document: remaining,
      pendingSave: request,
      updatedAt: Date.now(),
    });
    vi.mocked(recoverDocumentSave).mockResolvedValueOnce(receipt(request));
    const hook = renderHook(() => useDocumentSession('recover-user', '1', '1'));
    await waitFor(() => expect(hook.result.current.recovery).toBeDefined());
    expect(hook.result.current.recovery).toMatchObject({
      document: remaining,
      baseRevisionId: 'scene-2',
      baseBookRevisionId: 'book-2',
      pendingSave: undefined,
    });
    expect(saveSceneDocument).not.toHaveBeenCalled();
  });
});
