'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SemanticDocument, type ProserDocument, resolveChange } from '@hivemagnus/proser-editor';
import { DocumentLayoutStoryEditor } from './document-layout-story-editor';
import { DocumentComments } from './document-comments';
import { DocumentStoryDiscussion } from './document-story-discussion';
import { storyDraftContext } from '@/lib/document-story-draft';
import {
  appendLayoutHistory,
  readLayoutHistory,
  writeLayoutHistory,
  type LayoutHistory,
} from '@/lib/document-layout-history';
import type { DocumentSelection } from '@hivemagnus/proser-editor';
import {
  canonicalDocument,
  documentFromText,
  type BookLayoutSnapshot,
  type DocumentLayout,
  type DocumentPassageOperation,
  type DocumentStoryDraftReceipt,
  type DocumentStorySourceRecord,
} from '@hivemagnus/proser-contracts';
import {
  DocumentRequestError,
  getDocumentScope,
  saveDocumentLayout,
  recoverDocumentLayout,
  getDocumentLayoutRevision,
  type SaveLayoutReceipt,
} from '@/lib/document-api';
import { getDocumentStory, commitDocumentStoryDraft } from '@/lib/document-story-api';
import { requestDocumentResource } from '@/lib/document-api';
import {
  layoutDraftOperationId,
  readLayoutDraft,
  writeLayoutDraft,
  deleteLayoutDraft,
  type LayoutDraft,
} from '@/lib/document-layout-journal';
import {
  editLayoutStoryParagraph,
  layoutForChapter,
  reconcileLayoutSettings,
  ownHeaderFooterStory,
  storyDisplayLayout,
} from '@/lib/document-layout-editing';

interface Props {
  userId: string;
  bookId: string;
  chapterId?: number;
  actorId?: number;
  onCommentCommitted?: () => void;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onCommitted?: (
    receipt: Pick<SaveLayoutReceipt, 'operationId' | 'revisionId' | 'manifest'>,
  ) => void;
}
export function DocumentLayoutSettings(props: Props) {
  return <LayoutSettingsSession key={`${props.userId}:${props.bookId}`} {...props} />;
}
function LayoutSettingsSession({
  userId,
  bookId,
  chapterId,
  actorId,
  onCommentCommitted,
  disabled,
  onDirtyChange,
  onCommitted,
}: Props) {
  const [source, setSource] = useState<Awaited<ReturnType<typeof getDocumentScope<'layout'>>>>();
  const [draft, setDraft] = useState<LayoutDraft>();
  const [recovered, setRecovered] = useState<LayoutDraft>();
  const [chapter, setChapter] = useState(false);
  const [styleName, setStyleName] = useState('Body');
  const [matterName, setMatterName] = useState('');
  const [editingStory, setEditingStory] = useState<string>();
  const [storyComposing, setStoryComposing] = useState(false);
  const [commentPending, setCommentPending] = useState(false);
  const [rejectedStories, setRejectedStories] = useState<Record<string, boolean>>({});
  const rejectedStoryPending = Object.values(rejectedStories).some(Boolean);
  const reportRejectedStory = useCallback(
    (storyId: string, pending: boolean) =>
      setRejectedStories((current) =>
        current[storyId] === pending ? current : { ...current, [storyId]: pending },
      ),
    [],
  );
  const [storySelection, setStorySelection] = useState<DocumentSelection>();
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<LayoutHistory>();
  const historyRef = useRef<LayoutHistory | undefined>(undefined);
  const historyVersion = useRef<string | undefined>(undefined);
  const historyWriting = useRef<Promise<void>>(Promise.resolve());
  const [retryAllowed, setRetryAllowed] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [comparison, setComparison] = useState<{
    source: Awaited<ReturnType<typeof getDocumentScope<'layout'>>>;
    layout: BookLayoutSnapshot;
    conflicts: string[];
  }>();
  const alive = useRef(true);
  const writing = useRef<Promise<void>>(Promise.resolve());
  const persistedVersion = useRef<string | undefined>(undefined);
  const dirty = Boolean(draft || recovered);
  const sourceRef = useRef(source),
    draftRef = useRef(draft),
    recoveredRef = useRef(recovered);
  sourceRef.current = source;
  draftRef.current = draft;
  recoveredRef.current = recovered;
  useEffect(() => {
    onDirtyChange?.(dirty || busy || storyComposing || commentPending || rejectedStoryPending);
  }, [dirty, busy, storyComposing, commentPending, rejectedStoryPending, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void Promise.all([
      getDocumentScope(bookId, 'layout', controller.signal),
      readLayoutDraft(userId, bookId),
      readLayoutHistory(userId, bookId),
    ])
      .then(([saved, retained, previousHistory]) => {
        if (!controller.signal.aborted) {
          persistedVersion.current = retained?.journalRevision;
          setSource(saved);
          setRecovered(retained);
          historyVersion.current = previousHistory?.version;
          const initial =
            retained?.history ??
            (previousHistory &&
            ((retained &&
              canonicalDocument(previousHistory.frames[previousHistory.cursor]?.layout) ===
                canonicalDocument(retained.layout)) ||
              (previousHistory.frames[previousHistory.cursor]?.revisionId === saved.revisionId &&
                canonicalDocument(previousHistory.frames[previousHistory.cursor]?.layout) ===
                  canonicalDocument(saved.content)))
              ? previousHistory
              : {
                  schemaVersion: 1 as const,
                  userId,
                  bookId,
                  version: crypto.randomUUID(),
                  updatedAt: Date.now(),
                  cursor: 0,
                  frames: [
                    {
                      layout: saved.content,
                      revisionId: saved.revisionId,
                      contentHash: saved.contentHash,
                    },
                  ],
                });
          historyRef.current = initial;
          setHistory(initial);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Layout could not load.');
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [bookId, userId]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty || busy || storyComposing || commentPending || rejectedStoryPending)
        event.preventDefault();
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty, busy, storyComposing, commentPending, rejectedStoryPending]);
  const layout = draft?.layout ?? source?.content;
  const currentCommentStory = [
    ...(layout?.headerFooterStories ?? []),
    ...(layout?.frontMatter ?? []),
    ...(layout?.backMatter ?? []),
  ].find((story) => story.id === editingStory);
  const selected = layout ? layoutForChapter(layout, chapter ? chapterId : undefined) : undefined;
  const selectedStoryLayout = useMemo(
    () => (selected ? storyDisplayLayout(selected) : undefined),
    [selected],
  );
  const bookPageSettings = layout?.book;
  const bookStoryLayout = useMemo(
    () => (bookPageSettings ? storyDisplayLayout(bookPageSettings) : undefined),
    [bookPageSettings],
  );
  const locked =
    disabled ||
    busy ||
    commentPending ||
    Boolean(recovered || draft?.pending || draft?.pendingStory);
  const retainHistory = (next: LayoutHistory) => {
    historyRef.current = next;
    setHistory(next);
    historyWriting.current = historyWriting.current
      .catch(() => undefined)
      .then(async () => {
        await writeLayoutHistory(next, historyVersion.current);
        historyVersion.current = next.version;
      });
    void historyWriting.current.catch((reason) => {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : 'Layout undo storage failed.');
    });
  };
  const retain = (next: LayoutDraft) => {
    const previous = writing.current;
    writing.current = previous
      .catch(() => undefined)
      .then(async () => {
        await writeLayoutDraft(next, persistedVersion.current);
        persistedVersion.current = next.journalRevision;
      });
    void writing.current.catch((reason: unknown) => {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : 'Recovery storage failed.');
    });
  };
  const edit = (change: (next: BookLayoutSnapshot) => void) => {
    if (!source || !layout || locked) return;
    try {
      const next = structuredClone(layout);
      change(next);
      const retained: LayoutDraft = {
        schemaVersion: 1,
        userId,
        bookId,
        baseRevisionId: draft?.baseRevisionId ?? source.bookRevisionId,
        baseLayoutRevisionId: draft?.baseLayoutRevisionId ?? source.revisionId,
        updatedAt: Date.now(),
        journalRevision: crypto.randomUUID(),
        layout: next,
        baseLayout: draft?.baseLayout ?? source.content,
      };
      const nextHistory = historyRef.current
        ? appendLayoutHistory(historyRef.current, next)
        : undefined;
      if (nextHistory) {
        retained.history = nextHistory;
        retainHistory(nextHistory);
      }
      setDraft(retained);
      setError(undefined);
      setNotice(undefined);
      retain(retained);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Layout edit failed.');
    }
  };
  const editPage = (change: (page: DocumentLayout) => void) =>
    edit((next) => {
      const page =
        chapter && chapterId
          ? (next.chapters[String(chapterId)] ??= structuredClone(next.book))
          : next.book;
      change(page);
    });
  const acknowledged = async (receipt: SaveLayoutReceipt, retained: LayoutDraft) => {
    if (
      receipt.status !== 'completed' ||
      receipt.operationId !== retained.pending?.operationId ||
      receipt.result?.changedScope !== 'layout'
    )
      throw new Error('Factory returned an incompatible layout receipt.');
    const reference = receipt.manifest.scopes?.layout;
    if (!reference) throw new Error('Factory receipt omitted its immutable layout reference.');
    const exact = await getDocumentLayoutRevision(bookId, reference.revisionId);
    if (exact.revisionId !== reference.revisionId || exact.contentHash !== reference.contentHash)
      throw new Error('Factory layout revision does not match its committed receipt.');
    const saved = { ...exact, bookRevisionId: receipt.revisionId };
    const previousHistory = retained.history ?? historyRef.current;
    if (previousHistory) {
      const acknowledgedHistory = {
        ...previousHistory,
        version: crypto.randomUUID(),
        updatedAt: Date.now(),
        frames: previousHistory.frames.map((frame) =>
          canonicalDocument(frame.layout) === canonicalDocument(retained.pending!.layout)
            ? {
                layout: exact.content,
                revisionId: exact.revisionId,
                contentHash: exact.contentHash,
                operationId: receipt.operationId,
              }
            : frame,
        ),
      };
      retainHistory(acknowledgedHistory);
      await historyWriting.current;
    }
    await deleteLayoutDraft(userId, bookId, receipt.operationId);
    persistedVersion.current = undefined;
    if (!alive.current) return;
    setSource(saved);
    setDraft(undefined);
    setRecovered(undefined);
    setRetryAllowed(false);
    setNotice('Layout saved by Factory.');
    setComparison(undefined);
    onCommitted?.(receipt);
    return saved;
  };
  const storyFrom = (value: BookLayoutSnapshot, id: string) =>
    [...(value.headerFooterStories ?? []), ...value.frontMatter, ...value.backMatter].find(
      (story) => story.id === id,
    );
  const otherStoryChanges = (id: string) => {
    if (!source || !layout) return true;
    const copy = structuredClone(layout),
      current = storyFrom(copy, id),
      original = storyFrom(source.content, id);
    if (!current || !original) return true;
    current.document = structuredClone(original.document);
    return canonicalDocument(copy) !== canonicalDocument(source.content);
  };
  const receiveStoryReceipt = async (receipt: DocumentStoryDraftReceipt, retained: LayoutDraft) => {
    const pending = retained.pendingStory,
      reference = receipt.manifest.scopes?.layout;
    if (
      !pending ||
      receipt.kind !== 'catalog' ||
      receipt.status !== 'completed' ||
      receipt.operationId !== pending.request.operationId ||
      receipt.result.sourceKind !== 'layout-story' ||
      receipt.result.storyId !== pending.storyId ||
      receipt.result.bookRevisionId !== receipt.revisionId ||
      reference?.revisionId !== receipt.result.layoutRevisionId ||
      'scenes' in receipt
    )
      throw new Error(
        'Factory returned an incompatible story operation receipt; recover its original operation.',
      );
    const exact = await getDocumentLayoutRevision(bookId, reference.revisionId);
    if (exact.revisionId !== reference.revisionId || exact.contentHash !== reference.contentHash)
      throw new Error(
        'The exact story layout reference is unavailable; retain and recover this receipt.',
      );
    const owned = await getDocumentStory(bookId, pending.storyId, undefined, receipt.revisionId);
    if (
      owned.layoutRevisionId !== reference.revisionId ||
      owned.layoutContentHash !== reference.contentHash ||
      owned.contentHash !== receipt.result.contentHash ||
      owned.bookRevisionId !== receipt.revisionId
    )
      throw new Error('The acknowledged story digest or owner changed.');
    const old = retained.history ?? historyRef.current;
    if (old) {
      const frames = old.frames.map((frame, index) =>
        index === old.cursor
          ? {
              layout: exact.content,
              revisionId: exact.revisionId,
              contentHash: exact.contentHash,
              operationId: receipt.operationId,
            }
          : frame,
      );
      retainHistory({ ...old, frames, version: crypto.randomUUID(), updatedAt: Date.now() });
      await historyWriting.current;
    }
    if (!alive.current) return owned;
    await deleteLayoutDraft(userId, bookId, receipt.operationId, retained.journalRevision);
    persistedVersion.current = undefined;
    sourceRef.current = { ...exact, bookRevisionId: receipt.revisionId };
    draftRef.current = undefined;
    recoveredRef.current = undefined;
    setSource(sourceRef.current);
    setDraft(undefined);
    setRecovered(undefined);
    setRetryAllowed(false);
    setComparison(undefined);
    setNotice('Story saved by Factory.');
    setStorySelection(undefined);
    onCommitted?.(receipt);
    return owned;
  };
  const sendPendingStory = async (retained: LayoutDraft) => {
    const pending = retained.pendingStory;
    if (!pending) throw new Error('No retained story operation exists.');
    return receiveStoryReceipt(
      await commitDocumentStoryDraft(bookId, pending.storyId, pending.request),
      retained,
    );
  };
  const flushStoryOperations = async (
    storyId: string,
    local?: { operationId: string; operations: DocumentPassageOperation[] },
  ): Promise<DocumentStorySourceRecord> => {
    if (
      !source ||
      !layout ||
      disabled ||
      busy ||
      recovered ||
      draft?.pending ||
      draft?.pendingStory ||
      storyComposing ||
      commentPending
    )
      throw new Error('Save or recover the current layout before applying this story proposal.');
    if (otherStoryChanges(storyId))
      throw new Error(
        'Save page settings, named styles and other stories before preparing or applying story discussion.',
      );
    setBusy(true);
    setError(undefined);
    try {
      const owned = await getDocumentStory(bookId, storyId);
      if (
        owned.layoutRevisionId !== source.revisionId ||
        owned.layoutContentHash !== source.contentHash ||
        canonicalDocument(owned.document) !==
          canonicalDocument(storyFrom(source.content, storyId)?.document)
      )
        throw new Error('This owned story source changed. Reconcile the saved layout first.');
      if (!local?.operations.length) {
        if (draft && canonicalDocument(layout) !== canonicalDocument(source.content))
          throw new Error(
            'The story draft has no matching typed operations. Save and prepare a fresh context.',
          );
        return owned;
      }
      const current = storyFrom(layout, storyId);
      if (!current) throw new Error('The story was removed from the local layout.');
      const derived = await storyDraftContext(owned, current.document, local.operationId, () =>
        crypto.randomUUID(),
      );
      const semantic = (operations: DocumentPassageOperation[]) =>
        canonicalDocument(operations.map(({ id: _id, ...operation }) => operation));
      if (
        !derived.localOperations ||
        semantic(derived.localOperations.operations) !== semantic(local.operations)
      )
        throw new Error(
          'The story draft changed after this prepared context. Retain it and prepare a fresh proposal.',
        );
      await writing.current;
      await historyWriting.current;
      const operation: LayoutDraft = {
        schemaVersion: 1,
        userId,
        bookId,
        updatedAt: Date.now(),
        journalRevision: crypto.randomUUID(),
        baseRevisionId: owned.bookRevisionId,
        baseLayoutRevisionId: owned.layoutRevisionId,
        layout,
        baseLayout: source.content,
        ...(historyRef.current ? { history: historyRef.current } : {}),
        pendingStory: {
          storyId,
          request: {
            schemaVersion: 1,
            operationId: local.operationId,
            expectedRevisionId: owned.bookRevisionId,
            expectedLayoutRevisionId: owned.layoutRevisionId,
            expectedContentHash: owned.contentHash,
            operations: local.operations,
          },
        },
      };
      await writeLayoutDraft(operation, persistedVersion.current);
      persistedVersion.current = operation.journalRevision;
      if (!alive.current)
        throw new Error(
          'The authenticated layout session changed; recover the retained original operation.',
        );
      draftRef.current = operation;
      setDraft(operation);
      setRetryAllowed(false);
      return await sendPendingStory(operation);
    } catch (reason) {
      if (alive.current)
        setError(
          reason instanceof Error ? reason.message : 'Story save needs exact operation recovery.',
        );
      throw reason;
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const refreshStoryReceipt = async (raw?: unknown) => {
    const receipt = raw as
      | {
          operationId?: string;
          revisionId?: string;
          status?: string;
          manifest?: DocumentStoryDraftReceipt['manifest'];
          result?: { sourceKind?: string; storyId?: string };
        }
      | undefined;
    if (draftRef.current || recoveredRef.current)
      throw new Error('Recover or save the pending layout before adopting an applied story.');
    if (
      !receipt ||
      receipt.status !== 'completed' ||
      !receipt.operationId ||
      !receipt.revisionId ||
      receipt.result?.sourceKind !== 'layout-story' ||
      receipt.result.storyId !== editingStory
    )
      throw new Error('The applied story acknowledgement does not match this owned story.');
    const ref = receipt.manifest?.scopes?.layout;
    if (!ref) throw new Error('The story acknowledgement omitted its immutable layout reference.');
    const exact = await getDocumentLayoutRevision(bookId, ref.revisionId);
    if (exact.contentHash !== ref.contentHash)
      throw new Error('Applied story layout digest changed.');
    const old = historyRef.current;
    if (old) {
      const next = appendLayoutHistory(old, exact.content, exact.revisionId, exact.contentHash);
      next.frames[next.cursor] = { ...next.frames[next.cursor]!, operationId: receipt.operationId };
      retainHistory(next);
      await historyWriting.current;
    }
    if (!alive.current) return;
    setSource({ ...exact, bookRevisionId: receipt.revisionId });
    setStorySelection(undefined);
    onCommitted?.({
      operationId: receipt.operationId,
      revisionId: receipt.revisionId,
      manifest: receipt.manifest!,
    });
  };
  const save = async (retained = draft) => {
    if (!retained || busy || disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      await writing.current;
      await historyWriting.current;
      if (retained.pendingStory) {
        await sendPendingStory(retained);
        return sourceRef.current;
      }
      const pending = retained.pending ?? {
        schemaVersion: 1 as const,
        operationId: crypto.randomUUID(),
        expectedRevisionId: retained.baseRevisionId,
        expectedScopes: { layout: retained.baseLayoutRevisionId },
        layout: retained.layout,
        ...(retained.restoreFromRevisionId
          ? { restoreFromRevisionId: retained.restoreFromRevisionId }
          : {}),
      };
      const stampedHistory = retained.history
        ? {
            ...retained.history,
            frames: retained.history.frames.map((frame, index) =>
              index === retained.history!.cursor
                ? { ...frame, operationId: pending.operationId }
                : frame,
            ),
          }
        : undefined;
      const operation = {
        ...retained,
        ...(stampedHistory ? { history: stampedHistory } : {}),
        pending,
        updatedAt: Date.now(),
        journalRevision: crypto.randomUUID(),
      };
      if (stampedHistory) {
        retainHistory({ ...stampedHistory, version: crypto.randomUUID(), updatedAt: Date.now() });
        await historyWriting.current;
      }
      await writeLayoutDraft(operation, persistedVersion.current);
      persistedVersion.current = operation.journalRevision;
      if (!alive.current) return;
      setDraft(operation);
      setRecovered(undefined);
      setRetryAllowed(false);
      return await acknowledged(await saveDocumentLayout(bookId, pending), operation);
    } catch (reason) {
      if (alive.current)
        setError(
          reason instanceof Error
            ? reason.message
            : 'Layout save was not acknowledged. Recover the original operation before retrying.',
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const resolveStoryChange = async (
    storyId: string,
    changeId: string,
    status: 'accepted' | 'rejected',
  ) => {
    if (recovered || draft?.pending || draft?.pendingStory)
      throw new Error('Recover the original layout operation before reviewing its changes.');
    const saved = draft ? await save(draft) : source;
    if (!saved) throw new Error('Save the current layout before resolving its tracked changes.');
    const next = structuredClone(saved.content);
    const story = [
      ...(next.headerFooterStories ?? []),
      ...next.frontMatter,
      ...next.backMatter,
    ].find((item) => item.id === storyId);
    if (!story) throw new Error('This story no longer belongs to the saved layout.');
    story.document = resolveChange(story.document, changeId, status);
    const nextHistory = historyRef.current
      ? appendLayoutHistory(historyRef.current, next)
      : undefined;
    const operation: LayoutDraft = {
      schemaVersion: 1,
      userId,
      bookId,
      updatedAt: Date.now(),
      journalRevision: crypto.randomUUID(),
      baseRevisionId: saved.bookRevisionId,
      baseLayoutRevisionId: saved.revisionId,
      baseLayout: saved.content,
      layout: next,
      ...(nextHistory ? { history: nextHistory } : {}),
    };
    setDraft(operation);
    if (nextHistory) retainHistory(nextHistory);
    retain(operation);
    if (!(await save(operation)))
      throw new Error('The review decision awaits layout recovery or reconciliation.');
  };
  const travelHistory = async (direction: -1 | 1) => {
    const current = historyRef.current;
    if (!source || !current || locked || storyComposing) return;
    if (
      !draft &&
      (current.frames[current.cursor]?.revisionId !== source.revisionId ||
        current.frames[current.cursor]?.contentHash !== source.contentHash)
    ) {
      setError(
        'The layout changed after this undo journal. Reload or explicitly reconcile the selected revision before restoring it.',
      );
      return;
    }
    if (draft && draft.baseLayoutRevisionId !== source.revisionId) {
      setError('The layout draft has a stale base. Compare it before applying undo.');
      return;
    }
    const cursor = current.cursor + direction;
    const frame = current.frames[cursor];
    if (!frame) return;
    const nextHistory = { ...current, cursor, version: crypto.randomUUID(), updatedAt: Date.now() };
    const next: LayoutDraft = {
      schemaVersion: 1,
      userId,
      bookId,
      updatedAt: Date.now(),
      journalRevision: crypto.randomUUID(),
      baseRevisionId: draft?.baseRevisionId ?? source.bookRevisionId,
      baseLayoutRevisionId: draft?.baseLayoutRevisionId ?? source.revisionId,
      baseLayout: draft?.baseLayout ?? source.content,
      layout: frame.layout,
      history: nextHistory,
      ...(frame.revisionId ? { restoreFromRevisionId: frame.revisionId } : {}),
    };
    setDraft(next);
    retainHistory(nextHistory);
    retain(next);
    if (frame.revisionId) await save(next);
  };
  const recover = async () => {
    const retained = draft?.pending || draft?.pendingStory ? draft : recovered;
    if (!retained || !layoutDraftOperationId(retained) || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (retained.pendingStory)
        await receiveStoryReceipt(
          await requestDocumentResource<DocumentStoryDraftReceipt>(
            `/api/books/${encodeURIComponent(bookId)}/document-operations/${encodeURIComponent(retained.pendingStory.request.operationId)}`,
          ),
          retained,
        );
      else
        await acknowledged(
          await recoverDocumentLayout(bookId, retained.pending!.operationId),
          retained,
        );
    } catch (reason) {
      if (alive.current) {
        setRetryAllowed(reason instanceof DocumentRequestError && reason.status === 404);
        setError(
          reason instanceof DocumentRequestError && reason.status === 404
            ? 'Factory has no committed receipt for this operation. Retry the exact retained request.'
            : reason instanceof Error
              ? reason.message
              : 'Layout receipt recovery failed.',
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const discard = async () => {
    if (
      draft?.pending ||
      draft?.pendingStory ||
      recovered?.pending ||
      recovered?.pendingStory ||
      busy
    )
      return;
    setBusy(true);
    try {
      await writing.current;
      await deleteLayoutDraft(userId, bookId, undefined, persistedVersion.current);
      persistedVersion.current = undefined;
      if (alive.current) {
        setDraft(undefined);
        setRecovered(undefined);
        setNotice('Local layout draft discarded.');
      }
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : 'Draft discard failed.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const compare = async () => {
    const retained = draft ?? recovered;
    if (!retained?.pending || !retryAllowed || busy) return;
    setBusy(true);
    try {
      const saved = await getDocumentScope(bookId, 'layout');
      if (alive.current)
        setComparison({
          source: saved,
          ...reconcileLayoutSettings(retained.baseLayout, retained.layout, saved.content),
        });
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : 'Saved layout comparison failed.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const applyCompared = async () => {
    const retained = draft ?? recovered;
    if (!retained?.pending || !comparison || busy) return;
    setBusy(true);
    try {
      // Recheck the exact operation immediately before releasing its local claim.
      try {
        const receipt = await recoverDocumentLayout(bookId, retained.pending.operationId);
        await acknowledged(receipt, retained);
        return;
      } catch (reason) {
        if (!(reason instanceof DocumentRequestError && reason.status === 404)) throw reason;
      }
      await deleteLayoutDraft(
        userId,
        bookId,
        retained.pending.operationId,
        persistedVersion.current,
      );
      persistedVersion.current = undefined;
      const next: LayoutDraft = {
        schemaVersion: 1,
        userId,
        bookId,
        journalRevision: crypto.randomUUID(),
        updatedAt: Date.now(),
        baseRevisionId: comparison.source.bookRevisionId,
        baseLayoutRevisionId: comparison.source.revisionId,
        baseLayout: comparison.source.content,
        layout: comparison.layout,
      };
      await writeLayoutDraft(next);
      persistedVersion.current = next.journalRevision;
      if (alive.current) {
        setSource(comparison.source);
        setDraft(next);
        setRecovered(undefined);
        setComparison(undefined);
        setRetryAllowed(false);
        setError(undefined);
      }
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : 'Layout reconciliation failed.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  if (!userId) return null;
  return (
    <section
      aria-label="Manuscript layout settings"
      className="space-y-3 rounded border border-border-muted p-3"
    >
      <h2 className="font-semibold">Typography and page layout</h2>
      {error && <p role="alert">{error}</p>}
      <nav aria-label="Layout operation history">
        <button
          type="button"
          disabled={locked || storyComposing || !history || history.cursor === 0}
          onClick={() => void travelHistory(-1)}
        >
          Undo layout edit
        </button>
        <button
          type="button"
          disabled={
            locked || storyComposing || !history || history.cursor >= history.frames.length - 1
          }
          onClick={() => void travelHistory(1)}
        >
          Redo layout edit
        </button>
      </nav>
      <p role="status">
        {busy
          ? 'Saving or recovering layout…'
          : rejectedStoryPending
            ? 'Unsupported story edit needs review.'
            : (notice ??
              (dirty
                ? 'Layout has unacknowledged changes.'
                : source
                  ? 'Saved layout.'
                  : 'Loading layout…'))}
      </p>
      {recovered && (
        <aside aria-label="Layout draft recovery">
          <p>A layout draft is available for this authenticated account.</p>
          {!recovered.pending && !recovered.pendingStory && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(recovered);
                if (recovered.history) retainHistory(recovered.history);
                setRecovered(undefined);
              }}
            >
              Restore layout draft
            </button>
          )}
        </aside>
      )}
      {(draft?.pending || draft?.pendingStory || recovered?.pending || recovered?.pendingStory) && (
        <div>
          <button type="button" disabled={busy} onClick={() => void recover()}>
            Recover layout receipt
          </button>
          {retryAllowed && (
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => void save(draft ?? recovered)}
            >
              Retry exact layout save
            </button>
          )}
          {retryAllowed && !(draft?.pendingStory || recovered?.pendingStory) && (
            <button type="button" disabled={busy} onClick={() => void compare()}>
              Compare saved layout
            </button>
          )}
        </div>
      )}
      {comparison && (
        <aside aria-label="Layout reconciliation">
          <p>Review the proposed settings against the current saved layout.</p>
          <p>
            Saved: {comparison.source.content.book.font}, {comparison.source.content.book.fontSize};
            page {comparison.source.content.book.width} × {comparison.source.content.book.height};
            margins {comparison.source.content.book.margins.join(', ')}.
          </p>
          <p>
            Proposed: {comparison.layout.book.font}, {comparison.layout.book.fontSize}; page{' '}
            {comparison.layout.book.width} × {comparison.layout.book.height}; margins{' '}
            {comparison.layout.book.margins.join(', ')}.
          </p>
          <p>
            {comparison.conflicts.length
              ? `Overlapping settings require your explicit choice: ${comparison.conflicts.join(', ')}`
              : 'Your changed settings and saved settings affect separate properties.'}
          </p>
          <button type="button" disabled={busy || disabled} onClick={() => void applyCompared()}>
            {comparison.conflicts.length
              ? 'Use my reviewed overlapping settings'
              : 'Use reviewed layout merge'}
          </button>
        </aside>
      )}
      {((draft && !draft.pending && !draft.pendingStory) ||
        (recovered && !recovered.pending && !recovered.pendingStory)) && (
        <button type="button" disabled={busy} onClick={() => void discard()}>
          Discard local layout draft
        </button>
      )}
      {selected && layout && (
        <fieldset disabled={locked} className="space-y-3">
          <legend>Saved book and chapter settings</legend>
          <label>
            Layout scope{' '}
            <select
              value={chapter ? 'chapter' : 'book'}
              onChange={(event) => setChapter(event.target.value === 'chapter')}
            >
              <option value="book">Book</option>
              {chapterId && <option value="chapter">Current chapter</option>}
            </select>
          </label>
          <label>
            Preset{' '}
            <select
              value={selected.preset}
              onChange={(event) =>
                editPage((page) => {
                  page.preset = event.target.value as DocumentLayout['preset'];
                })
              }
            >
              <option value="manuscript">Submission manuscript</option>
              <option value="book">Print book</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-3">
            {(['width', 'height', 'fontSize'] as const).map((field) => (
              <label key={field}>
                {field === 'fontSize' ? 'Default font size' : `Page ${field}`}{' '}
                <input
                  type="number"
                  min={field === 'fontSize' ? 6 : 100}
                  max={field === 'fontSize' ? 144 : field === 'width' ? 2000 : 3000}
                  value={selected[field]}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value))
                      editPage((page) => {
                        page[field] = value;
                      });
                  }}
                />
              </label>
            ))}
          </div>
          <label>
            Default font{' '}
            <select
              value={selected.font}
              onChange={(event) =>
                editPage((page) => {
                  page.font = event.target.value;
                })
              }
            >
              {[
                ...new Set([
                  selected.font,
                  'Liberation Serif',
                  'Liberation Sans',
                  'DejaVu Sans',
                  'DejaVu Serif',
                ]),
              ].map((font) => (
                <option key={font}>{font}</option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-3">
            {(['Top', 'Right', 'Bottom', 'Left'] as const).map((name, index) => (
              <label key={name}>
                {name} margin{' '}
                <input
                  type="number"
                  min={0}
                  max={1000}
                  value={selected.margins[index]}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value))
                      editPage((page) => {
                        page.margins[index] = value;
                      });
                  }}
                />
              </label>
            ))}
          </div>
          <label>
            <input
              type="checkbox"
              checked={selected.pageNumbers}
              onChange={(event) =>
                editPage((page) => {
                  page.pageNumbers = event.target.checked;
                })
              }
            />
            Page numbers
          </label>
          {(['header', 'footer'] as const).map((kind) => {
            const owned = layout.headerFooterStories?.find(
              (story) =>
                story.kind === kind &&
                story.owner === (chapter ? 'chapter' : 'book') &&
                story.chapterId === (chapter ? chapterId : undefined),
            );
            return (
              <fieldset key={kind}>
                <legend>{kind === 'header' ? 'Header' : 'Footer'} story</legend>
                {owned ? (
                  <>
                    <button
                      type="button"
                      disabled={storyComposing}
                      onClick={() =>
                        setEditingStory(editingStory === owned.id ? undefined : owned.id)
                      }
                    >
                      {editingStory === owned.id ? 'Close' : 'Edit'} {kind} story
                    </button>
                    {editingStory === owned.id ? (
                      <DocumentLayoutStoryEditor
                        userId={userId}
                        bookId={bookId}
                        storyId={owned.id}
                        source={
                          source && {
                            revisionId: source.revisionId,
                            contentHash: source.contentHash,
                          }
                        }
                        onRejectedPending={reportRejectedStory}
                        document={owned.document}
                        actorId={actorId}
                        disabled={locked}
                        displayLayout={selectedStoryLayout!}
                        namedStyles={layout.styles}
                        onResolveChange={(id, status) => resolveStoryChange(owned.id, id, status)}
                        onUndo={() => void travelHistory(-1)}
                        onRedo={() => void travelHistory(1)}
                        canUndo={Boolean(history && history.cursor > 0 && !locked)}
                        canRedo={Boolean(
                          history && history.cursor < history.frames.length - 1 && !locked,
                        )}
                        onCompositionState={setStoryComposing}
                        onSelection={setStorySelection}
                        onError={setError}
                        onChange={(document: ProserDocument) =>
                          edit((next) => {
                            const story = next.headerFooterStories!.find(
                              (item) => item.id === owned.id,
                            )!;
                            story.document = document;
                          })
                        }
                      />
                    ) : (
                      <SemanticDocument document={owned.document} />
                    )}
                  </>
                ) : (
                  <>
                    {selected[kind].length > 0 && (
                      <p>
                        Existing story paragraphs will retain their identities and formatting when
                        upgraded.
                      </p>
                    )}
                    {selected[kind].map((paragraph, index) => (
                      <label key={paragraph.id}>
                        {kind} paragraph {index + 1}
                        <textarea
                          value={paragraph.runs.map((run) => run.text).join('')}
                          onChange={(event) =>
                            editPage((page) => {
                              page[kind][index] = editLayoutStoryParagraph(
                                page[kind][index]!,
                                event.target.value,
                              );
                            })
                          }
                        />
                      </label>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        edit((next) =>
                          Object.assign(
                            next,
                            ownHeaderFooterStory(next, kind, chapter ? chapterId : undefined),
                          ),
                        )
                      }
                    >
                      {selected[kind].length ? 'Upgrade' : 'Create'} owned {kind} story
                    </button>
                  </>
                )}
              </fieldset>
            );
          })}
          {chapter && chapterId && layout.chapters[String(chapterId)] && (
            <button
              type="button"
              onClick={() =>
                edit((next) => {
                  delete next.chapters[String(chapterId)];
                })
              }
            >
              Use book layout for this chapter
            </button>
          )}
          <fieldset>
            <legend>Front and back matter</legend>
            <label>
              Story name{' '}
              <input
                value={matterName}
                maxLength={200}
                onChange={(event) => setMatterName(event.target.value)}
              />
            </label>
            {(['frontMatter', 'backMatter'] as const).map((collection) => (
              <fieldset key={collection}>
                <legend>{collection === 'frontMatter' ? 'Front matter' : 'Back matter'}</legend>
                {layout[collection].map((story) => (
                  <article key={story.id}>
                    <h3>{story.name}</h3>
                    <button
                      type="button"
                      disabled={storyComposing}
                      onClick={() => {
                        setEditingStory(editingStory === story.id ? undefined : story.id);
                        setStorySelection(undefined);
                      }}
                    >
                      {editingStory === story.id ? 'Close' : 'Edit'} {story.name}
                    </button>
                    {editingStory === story.id ? (
                      <>
                        <DocumentLayoutStoryEditor
                          userId={userId}
                          bookId={bookId}
                          storyId={story.id}
                          source={
                            source && {
                              revisionId: source.revisionId,
                              contentHash: source.contentHash,
                            }
                          }
                          onRejectedPending={reportRejectedStory}
                          document={story.document}
                          actorId={actorId}
                          disabled={locked}
                          displayLayout={bookStoryLayout!}
                          namedStyles={layout.styles}
                          onResolveChange={(id, status) => resolveStoryChange(story.id, id, status)}
                          onUndo={() => void travelHistory(-1)}
                          onRedo={() => void travelHistory(1)}
                          canUndo={Boolean(history && history.cursor > 0 && !locked)}
                          canRedo={Boolean(
                            history && history.cursor < history.frames.length - 1 && !locked,
                          )}
                          onCompositionState={setStoryComposing}
                          onSelection={setStorySelection}
                          onError={setError}
                          onChange={(document) =>
                            edit((next) => {
                              next[collection].find((item) => item.id === story.id)!.document =
                                document;
                            })
                          }
                        />
                      </>
                    ) : (
                      <SemanticDocument document={story.document} />
                    )}
                  </article>
                ))}
                <button
                  type="button"
                  disabled={!matterName.trim()}
                  onClick={() =>
                    edit((next) => {
                      next[collection].push({
                        id: crypto.randomUUID(),
                        name: matterName.trim(),
                        document: documentFromText('', () => crypto.randomUUID()),
                      });
                    })
                  }
                >
                  Add {collection === 'frontMatter' ? 'front' : 'back'} matter story
                </button>
              </fieldset>
            ))}
          </fieldset>
          <fieldset>
            <legend>Named styles</legend>
            <label>
              Style name{' '}
              <input
                value={styleName}
                maxLength={100}
                onChange={(event) => setStyleName(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={!styleName.trim()}
              onClick={() =>
                edit((next) => {
                  const label = styleName.trim();
                  const matches = Object.keys(next.styles.paragraph).filter(
                    (key) => (next.styles.labels?.[key] ?? key) === label,
                  );
                  if (matches.length > 1)
                    throw new Error(
                      'More than one style has this label. Give the new style a distinct name.',
                    );
                  const styleId = matches[0] ?? `style_${crypto.randomUUID().replaceAll('-', '')}`;
                  (next.styles.labels ??= {})[styleId] = label;
                  next.styles.text[styleId] = {
                    font: selected.font,
                    size: selected.fontSize,
                  };
                  next.styles.paragraph[styleId] = {
                    name: styleId,
                    alignment: 'left',
                  };
                })
              }
            >
              Create or update named style
            </button>
            <p>
              {Object.keys(layout.styles.paragraph)
                .map((key) => layout.styles.labels?.[key] ?? key)
                .join(', ') || 'No named paragraph styles saved.'}
            </p>
          </fieldset>
        </fieldset>
      )}
      {currentCommentStory && (
        <DocumentComments
          userId={userId}
          bookId={bookId}
          scope={{ kind: 'layout-story', id: currentCommentStory.id }}
          selection={storySelection}
          disabled={Boolean(draft || recovered || disabled || busy || storyComposing)}
          onPendingChange={setCommentPending}
          prepare={async () => {
            if (draft || recovered)
              throw new Error('Save or recover the layout before reviewing its story comments.');
            const saved = await getDocumentScope(bookId, 'layout');
            const document = [
              ...(saved.content.headerFooterStories ?? []),
              ...saved.content.frontMatter,
              ...saved.content.backMatter,
            ].find((item) => item.id === currentCommentStory.id)?.document;
            if (!document) throw new Error('The story no longer belongs to the saved layout.');
            return {
              document,
              bookRevisionId: saved.bookRevisionId,
              revisionId: saved.revisionId,
            };
          }}
          onCommitted={async (receipt) => {
            const reference = receipt.manifest.scopes?.layout;
            if (!reference)
              throw new Error('The comment receipt omitted its complete layout revision.');
            const exact = await getDocumentLayoutRevision(bookId, reference.revisionId);
            if (
              exact.revisionId !== reference.revisionId ||
              exact.contentHash !== reference.contentHash
            )
              throw new Error(
                'The comment acknowledgement differs from its retained layout revision.',
              );
            if (alive.current) {
              const previous = historyRef.current;
              const frame = previous?.frames[previous.cursor];
              const matches =
                frame?.revisionId === source?.revisionId &&
                frame?.contentHash === source?.contentHash;
              const next =
                previous && matches
                  ? appendLayoutHistory(
                      previous,
                      exact.content,
                      exact.revisionId,
                      exact.contentHash,
                    )
                  : {
                      schemaVersion: 1 as const,
                      userId,
                      bookId,
                      version: crypto.randomUUID(),
                      updatedAt: Date.now(),
                      cursor: 0,
                      frames: [
                        {
                          layout: exact.content,
                          revisionId: exact.revisionId,
                          contentHash: exact.contentHash,
                        },
                      ],
                    };
              next.frames[next.cursor] = {
                ...next.frames[next.cursor]!,
                operationId: receipt.operationId,
              };
              retainHistory(next);
              await historyWriting.current;
              if (!alive.current) return;
              setSource({ ...exact, bookRevisionId: receipt.revisionId });
              setStorySelection(undefined);
              onCommentCommitted?.();
            }
          }}
        />
      )}

      {currentCommentStory && editingStory && (
        <aside aria-label="Story discussion and proposals">
          {otherStoryChanges(editingStory) && (
            <p role="status">
              Save page settings, named styles and other stories before preparing discussion
              context.
            </p>
          )}
          <DocumentStoryDiscussion
            bookId={bookId}
            storyId={editingStory}
            bookRevisionId={source?.bookRevisionId}
            document={currentCommentStory.document}
            selection={storySelection}
            disabled={Boolean(
              disabled ||
              busy ||
              commentPending ||
              storyComposing ||
              rejectedStoryPending ||
              recovered ||
              draft?.pending ||
              draft?.pendingStory ||
              otherStoryChanges(editingStory),
            )}
            flush={(local) => flushStoryOperations(editingStory, local)}
            refresh={refreshStoryReceipt}
          />
        </aside>
      )}
      <button
        type="button"
        disabled={
          !draft ||
          Boolean(draft.pending || draft.pendingStory) ||
          busy ||
          storyComposing ||
          commentPending ||
          rejectedStoryPending ||
          disabled ||
          Boolean(source && canonicalDocument(source.content) === canonicalDocument(draft.layout))
        }
        onClick={() => void save()}
      >
        Save layout changes
      </button>
    </section>
  );
}
