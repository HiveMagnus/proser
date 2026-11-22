'use client';
import { mergeDocumentAcknowledgement } from '@/lib/document-ack-metadata';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canonicalDocument,
  reconcileDocuments,
  type ProserDocument,
} from '@cheftaco/proser-editor';
import {
  DocumentRequestError,
  getSceneDocument,
  recoverDocumentSave,
  saveSceneDocument,
  type SavedSceneDocument,
  type SaveDocumentRequest,
  type SaveDocumentReceipt,
} from '@/lib/document-api';
import {
  deleteDocumentDraft,
  documentDraftKey,
  readDocumentDraft,
  writeDocumentDraft,
  type DocumentDraft,
} from '@/lib/document-drafts';

import {
  initialDocumentHistory,
  appendDocumentHistory,
  recoverDocumentHistory,
  type DocumentHistory,
} from '@/lib/document-history';

export type DocumentSaveState =
  'loading' | 'saved' | 'unsaved' | 'saving' | 'conflict' | 'failed' | 'offline';
export function useDocumentSession(
  userId: string | undefined,
  bookId: string,
  sceneId: string,
  options: { autosave?: boolean; journalHistory?: boolean } = {},
) {
  const autosave = options.autosave !== false;
  const journalHistory = options.journalHistory !== false;
  const [document, setDocument] = useState<ProserDocument>();
  const [state, setState] = useState<DocumentSaveState>('loading');
  const [error, setError] = useState<string>();
  const [recovery, setRecovery] = useState<DocumentDraft>();
  const [conflictVersion, setConflictVersion] = useState<SavedSceneDocument>();
  const [loadedScope, setLoadedScope] = useState('');
  const history = useRef<DocumentHistory | undefined>(undefined);
  const saved = useRef<SavedSceneDocument | undefined>(undefined);
  const base = useRef<
    { revisionId: string; bookRevisionId: string; document?: ProserDocument } | undefined
  >(undefined);
  const live = useRef<ProserDocument | undefined>(undefined);
  const pending = useRef<SaveDocumentRequest | undefined>(undefined);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const scope = `${userId ?? ''}:${bookId}:${sceneId}`;
  const active = useRef(scope);
  active.current = scope;
  const localWrites = useRef(Promise.resolve());
  const key = userId ? documentDraftKey(userId, bookId, sceneId) : '';
  const persist = useCallback(async () => {
    if (!userId || active.current !== scope || !saved.current || !live.current) return;
    const draft: DocumentDraft = {
      key,
      userId,
      bookId,
      sceneId,
      baseRevisionId: base.current?.revisionId ?? saved.current.revisionId,
      baseBookRevisionId: base.current?.bookRevisionId ?? saved.current.bookRevisionId,
      baseDocument: base.current?.document,
      document: structuredClone(live.current),
      updatedAt: Date.now(),
      ...(journalHistory && history.current ? { history: structuredClone(history.current) } : {}),
      ...(pending.current ? { pendingSave: structuredClone(pending.current) } : {}),
    };
    localWrites.current = localWrites.current
      .catch(() => {})
      .then(async () => {
        await writeDocumentDraft(draft);
      });
    await localWrites.current;
  }, [userId, key, bookId, sceneId, scope, journalHistory]);
  useEffect(() => {
    history.current = undefined;
    saved.current = undefined;
    base.current = undefined;
    live.current = undefined;
    pending.current = undefined;
    inFlight.current = undefined;
    setDocument(undefined);
    setRecovery(undefined);
    setConflictVersion(undefined);
    setLoadedScope('');
    setError(undefined);
    setState('loading');
    if (!userId) return;
    const controller = new AbortController();
    const captured = scope;
    void (async () => {
      const current = await getSceneDocument(bookId, sceneId, controller.signal);
      let draft = await readDocumentDraft(userId, bookId, sceneId);
      if (draft?.pendingSave) {
        const original = draft.pendingSave;
        try {
          const receipt = await recoverDocumentSave(bookId, original.operationId);
          if (controller.signal.aborted || active.current !== captured) return;
          const acknowledged = receipt.scenes.find((item) => item.sceneId === Number(sceneId));
          if (
            receipt.kind !== 'commit' ||
            receipt.status !== 'completed' ||
            receipt.operationId !== original.operationId ||
            !acknowledged
          )
            throw new Error('The recovered save receipt does not acknowledge this scene.');
          const sent = original.scenes.find((item) => item.sceneId === Number(sceneId));
          const unchangedSinceDispatch =
            sent && canonicalDocument(draft.document) === canonicalDocument(sent.document);
          draft = {
            ...draft,
            pendingSave: undefined,
            baseRevisionId: acknowledged.revisionId,
            baseBookRevisionId: receipt.revisionId,
            baseDocument: acknowledged.document,
            ...(unchangedSinceDispatch ? { document: acknowledged.document } : {}),
          };
          if (canonicalDocument(draft.document) === canonicalDocument(current.document)) {
            await deleteDocumentDraft(key);
            draft = undefined;
          } else await writeDocumentDraft(draft);
        } catch (failure) {
          if (controller.signal.aborted || active.current !== captured) return;
          if (!(failure instanceof DocumentRequestError && failure.status === 404))
            setError(
              'The interrupted save outcome is unresolved. Recover its original operation before editing or discarding.',
            );
        }
      }
      if (controller.signal.aborted || active.current !== captured) return;
      saved.current = current;
      base.current = current;
      setLoadedScope(captured);
      live.current = current.document;
      history.current = initialDocumentHistory(current.document, current.revisionId);
      setDocument(current.document);
      setState('saved');
      if (
        draft &&
        (draft.pendingSave ||
          canonicalDocument(draft.document) !== canonicalDocument(current.document))
      )
        setRecovery(draft);
    })().catch((failure: unknown) => {
      if (!controller.signal.aborted && active.current === captured) {
        setLoadedScope(captured);
        setState('failed');
        setError(failure instanceof Error ? failure.message : 'Unable to load this document.');
      }
    });
    return () => controller.abort();
  }, [userId, bookId, sceneId, scope, key]);
  const acknowledgeReceipt = useCallback(
    async (receipt: SaveDocumentReceipt, request: SaveDocumentRequest) => {
      const captured = scope;
      if (active.current !== captured) return;
      const acknowledged = receipt.scenes.find((item) => item.sceneId === Number(sceneId));
      if (
        !acknowledged ||
        receipt.kind !== 'commit' ||
        receipt.operationId !== request.operationId ||
        receipt.status !== 'completed'
      )
        throw new Error('Factory did not confirm this scene save.');
      saved.current = {
        ...acknowledged,
        bookRevisionId: receipt.revisionId,
        projection: { text: acknowledged.text, wordCount: acknowledged.wordCount, spans: [] },
      };
      base.current = saved.current;
      pending.current = undefined;
      await localWrites.current.catch(() =>
        setError('Factory saved this revision. Local recovery cleanup is unavailable.'),
      );
      if (active.current !== captured) return;
      if (history.current) {
        const original = request.scenes.find((item) => item.sceneId === Number(sceneId))!.document;
        for (const entry of history.current.entries)
          if (canonicalDocument(entry.document) === canonicalDocument(original)) {
            entry.document = structuredClone(acknowledged.document);
            entry.revisionId = acknowledged.revisionId;
          }
      }
      const unchanged =
        canonicalDocument(live.current) ===
        canonicalDocument(
          request.scenes.find((item) => item.sceneId === Number(sceneId))!.document,
        );
      if (unchanged && active.current === captured) {
        live.current = acknowledged.document;
        if (history.current)
          history.current.entries[history.current.cursor]!.document = structuredClone(
            acknowledged.document,
          );
        setDocument(acknowledged.document);
        const acknowledgedHash = canonicalDocument(acknowledged.document);
        localWrites.current = localWrites.current
          .catch(() => {})
          .then(async () => {
            if (active.current === captured && canonicalDocument(live.current) === acknowledgedHash)
              await deleteDocumentDraft(key);
          });
        await localWrites.current.catch(() =>
          setError('Factory saved this revision. Local recovery cleanup is unavailable.'),
        );
        if (active.current === captured) {
          if (canonicalDocument(live.current) === acknowledgedHash) setState('saved');
          else {
            await persist().catch(() =>
              setError(
                'Factory saved the previous edit. Keep the remaining local draft open until it is saved.',
              ),
            );
            setState('unsaved');
          }
        }
      } else {
        live.current = mergeDocumentAcknowledgement(
          live.current!,
          acknowledged.document,
          request.scenes.find((item) => item.sceneId === Number(sceneId))!.document,
        );
        setDocument(live.current);
        if (history.current)
          history.current.entries[history.current.cursor]!.document = structuredClone(live.current);
        await persist().catch(() =>
          setError(
            'Factory saved the previous edit. Keep the remaining local draft open until it is saved.',
          ),
        );
        if (active.current === captured) setState('unsaved');
      }
    },
    [scope, sceneId, key, persist],
  );
  const save = useCallback(async (): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    if (!userId || !saved.current || !live.current || state === 'conflict' || recovery) return;
    if (!navigator.onLine) {
      setState('offline');
      await persist().catch(() =>
        setError('Local recovery storage is unavailable. Keep this document open.'),
      );
      return;
    }
    if (
      !pending.current &&
      canonicalDocument(live.current) === canonicalDocument(saved.current.document)
    )
      return;
    const captured = scope;
    const request = pending.current ?? {
      schemaVersion: 1 as const,
      operationId: crypto.randomUUID(),
      expectedRevisionId: saved.current.bookRevisionId,
      scenes: [
        {
          sceneId: Number(sceneId),
          expectedRevisionId: saved.current.revisionId,
          document: structuredClone(live.current),
          ...(history.current?.entries[history.current.cursor]?.revisionId &&
          canonicalDocument(history.current.entries[history.current.cursor]!.document) ===
            canonicalDocument(live.current)
            ? { restoreFromRevisionId: history.current.entries[history.current.cursor]!.revisionId }
            : {}),
        },
      ],
    };
    pending.current = request;
    setState('saving');
    setError(undefined);
    const perform = async () => {
      try {
        await persist();
        let receipt;
        try {
          receipt = await recoverDocumentSave(bookId, request.operationId);
        } catch (failure) {
          if (!(failure instanceof DocumentRequestError) || failure.status !== 404) throw failure;
          receipt = await saveSceneDocument(bookId, request);
        }
        if (active.current !== captured) return;
        await acknowledgeReceipt(receipt, request);
      } catch (failure) {
        if (active.current !== captured) return;
        if (
          failure instanceof DocumentRequestError &&
          [400, 413, 422, 428].includes(failure.status)
        )
          pending.current = undefined;
        if (failure instanceof DocumentRequestError && failure.status === 412) {
          pending.current = undefined;
          setConflictVersion(undefined);
          setState('conflict');
        } else setState(navigator.onLine ? 'failed' : 'offline');
        setError(
          failure instanceof Error ? failure.message : 'Save failed. Your draft is retained.',
        );
        await persist().catch(() => {});
      } finally {
        if (active.current === captured) inFlight.current = undefined;
      }
    };
    inFlight.current = perform();
    await inFlight.current;
  }, [userId, state, recovery, scope, sceneId, bookId, persist, acknowledgeReceipt]);
  const change = useCallback(
    (next: ProserDocument) => {
      if (active.current !== scope || canonicalDocument(live.current) === canonicalDocument(next))
        return;
      if (journalHistory && live.current)
        history.current = appendDocumentHistory(history.current, live.current, next);
      live.current = next;
      setDocument(next);
      setState((previous) =>
        previous === 'conflict' ? 'conflict' : navigator.onLine ? 'unsaved' : 'offline',
      );
      void persist().catch(() =>
        setError('Local recovery storage is unavailable. Save this draft before leaving.'),
      );
    },
    [persist, scope, journalHistory],
  );
  useEffect(() => {
    const offline = () =>
      setState((previous) =>
        ['unsaved', 'saving', 'failed'].includes(previous) ? 'offline' : previous,
      );
    const online = () =>
      setState((previous) =>
        previous === 'offline'
          ? saved.current &&
            live.current &&
            (pending.current ||
              canonicalDocument(saved.current.document) !== canonicalDocument(live.current))
            ? 'unsaved'
            : saved.current
              ? 'saved'
              : 'failed'
          : previous,
      );
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, []);
  useEffect(() => {
    if (!autosave || state !== 'unsaved') return;
    const timer = setTimeout(() => void save(), 750);
    return () => clearTimeout(timer);
  }, [document, state, save, autosave]);
  useEffect(() => {
    const interval = setInterval(() => {
      if (autosave && state === 'unsaved') void save();
    }, 5000);
    return () => clearInterval(interval);
  }, [state, save, autosave]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (recovery || (live.current && state !== 'saved' && state !== 'loading')) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [state, recovery]);
  const restoreDraft = () => {
    if (!recovery || !saved.current) return;
    const stale =
      recovery.baseRevisionId !== saved.current.revisionId ||
      recovery.baseBookRevisionId !== saved.current.bookRevisionId;
    live.current = recovery.document;
    history.current = recoverDocumentHistory(recovery.history, recovery.document);
    base.current = {
      revisionId: recovery.baseRevisionId,
      bookRevisionId: recovery.baseBookRevisionId,
      document: recovery.baseDocument,
    };
    pending.current = recovery.pendingSave;
    setDocument(recovery.document);
    setRecovery(undefined);
    setState(stale && !recovery.pendingSave ? 'conflict' : 'unsaved');
    if (stale && !recovery.pendingSave)
      setError(
        'Recovered draft has an older base. Reconcile it with the saved revision before applying.',
      );
  };
  const discardDraft = async () => {
    if (recovery?.pendingSave || pending.current) {
      setError(
        'Recover the interrupted save using Restore draft and Save changes before discarding local work.',
      );
      return;
    }
    const captured = scope;
    const draftHash = canonicalDocument(live.current);
    await localWrites.current;
    if (active.current !== captured || canonicalDocument(live.current) !== draftHash) return;
    await deleteDocumentDraft(key);
    if (active.current !== captured) return;
    if (canonicalDocument(live.current) !== draftHash) {
      setError('The draft changed while discarding. Review it before discarding again.');
      await persist();
      return;
    }
    setRecovery(undefined);
    pending.current = undefined;
    if (saved.current) {
      live.current = saved.current.document;
      history.current = initialDocumentHistory(saved.current.document, saved.current.revisionId);
      base.current = saved.current;
      setDocument(saved.current.document);
      setState('saved');
      setError(undefined);
    }
  };
  const inspectConflict = async () => {
    const captured = scope;
    try {
      const current = await getSceneDocument(bookId, sceneId);
      if (active.current === captured) setConflictVersion(current);
    } catch (failure) {
      if (active.current === captured)
        setError(failure instanceof Error ? failure.message : 'Unable to load the saved revision.');
    }
  };
  const useLocalDraft = () => {
    if (!conflictVersion || !live.current) return;
    saved.current = conflictVersion;
    base.current = conflictVersion;
    pending.current = undefined;
    setConflictVersion(undefined);
    setError(undefined);
    setState('unsaved');
    void persist().catch(() => setError('Local draft recovery is unavailable.'));
  };
  const useSavedVersion = async () => {
    if (!conflictVersion) return;
    const captured = scope;
    const current = conflictVersion;
    const draftHash = canonicalDocument(live.current);
    await localWrites.current;
    if (active.current !== captured || canonicalDocument(live.current) !== draftHash) return;
    await deleteDocumentDraft(key);
    if (active.current !== captured) return;
    if (canonicalDocument(live.current) !== draftHash) {
      setError('The draft changed while discarding. Review it before discarding again.');
      await persist();
      return;
    }
    saved.current = current;
    base.current = current;
    live.current = current.document;
    history.current = initialDocumentHistory(current.document, current.revisionId);
    pending.current = undefined;
    setDocument(current.document);
    setConflictVersion(undefined);
    setError(undefined);
    setState('saved');
  };
  const visible = loadedScope === scope;
  const flush = async () => {
    const captured = scope;
    if (state === 'conflict' || state === 'loading' || recovery)
      throw new Error('Resolve loading, recovery or conflict state before applying a proposal.');
    await save();
    if (
      active.current !== captured ||
      !saved.current ||
      !live.current ||
      pending.current ||
      canonicalDocument(live.current) !== canonicalDocument(saved.current.document)
    )
      throw new Error(
        'Wait for the current draft to be saved and reconciled before applying a proposal.',
      );
    return saved.current;
  };
  const reloadAcknowledged = async () => {
    const captured = scope;
    const previous = saved.current;
    const current = await getSceneDocument(bookId, sceneId);
    if (active.current !== captured || !previous) return;
    const dirty =
      pending.current || canonicalDocument(live.current) !== canonicalDocument(previous.document);
    if (dirty) {
      setConflictVersion(current);
      setState('conflict');
      setError(
        'Your draft changed while Factory applied the proposal. Both versions are retained for reconciliation.',
      );
      await persist();
      return;
    }
    saved.current = current;
    base.current = current;
    live.current = current.document;
    history.current = initialDocumentHistory(current.document, current.revisionId);
    setDocument(current.document);
    setState('saved');
    setError(undefined);
  };
  const reconciliation =
    state === 'conflict' && base.current?.document && live.current && conflictVersion
      ? reconcileDocuments(base.current.document, live.current, conflictVersion.document)
      : undefined;
  const useMergedDraft = () => {
    if (!conflictVersion || !base.current?.document || !live.current) return;
    const proposal = reconcileDocuments(
      base.current.document,
      live.current,
      conflictVersion.document,
    );
    if (!proposal.document) return;
    saved.current = conflictVersion;
    base.current = conflictVersion;
    history.current = appendDocumentHistory(history.current, live.current, proposal.document);
    live.current = proposal.document;
    pending.current = undefined;
    setDocument(proposal.document);
    setConflictVersion(undefined);
    setError(undefined);
    setState(navigator.onLine ? 'unsaved' : 'offline');
    void persist().catch(() => setError('Local draft recovery is unavailable.'));
  };
  const historyReady =
    visible &&
    !pending.current &&
    !inFlight.current &&
    !recovery &&
    !['loading', 'conflict'].includes(state);
  const navigateHistory = (direction: -1 | 1) => {
    if (!historyReady || !history.current || active.current !== scope) return;
    const cursor = history.current.cursor + direction;
    const entry = history.current.entries[cursor];
    if (!entry) return;
    history.current.cursor = cursor;
    live.current = structuredClone(entry.document);
    setDocument(live.current);
    setState(navigator.onLine ? 'unsaved' : 'offline');
    void persist().catch(() =>
      setError('Local operation recovery is unavailable. Save before leaving.'),
    );
    if (entry.revisionId) void save();
  };
  return {
    group: {
      peekDocument: () => (active.current === scope ? live.current : undefined),
      pendingSave: visible ? pending.current : undefined,
      prepare: (copy = true) => {
        if (
          active.current !== scope ||
          !saved.current ||
          !live.current ||
          recovery ||
          state === 'loading' ||
          state === 'conflict' ||
          inFlight.current
        )
          throw new Error(
            'Load, restore or reconcile every affected scene before committing a window edit.',
          );
        return {
          saved: saved.current,
          document: copy ? structuredClone(live.current) : live.current,
          pendingSave: pending.current,
        };
      },
      stage: async (request: SaveDocumentRequest) => {
        if (active.current !== scope || !saved.current || !live.current || recovery)
          throw new Error('This document session changed before the atomic save.');
        if (pending.current && pending.current.operationId !== request.operationId)
          throw new Error('Recover the existing scene operation before starting another.');
        pending.current = request;
        setState('saving');
        setError(undefined);
        await persist();
      },
      acknowledge: acknowledgeReceipt,
      refreshBookRevision: async (revisionId: string) => {
        if (active.current !== scope || !saved.current) return;
        saved.current.bookRevisionId = revisionId;
        if (
          live.current &&
          canonicalDocument(live.current) !== canonicalDocument(saved.current.document)
        )
          await persist().catch(() =>
            setError('Keep the unsaved draft open until its refreshed base is retained.'),
          );
      },
      reject: async (failure: unknown) => {
        if (active.current !== scope) return;
        if (
          failure instanceof DocumentRequestError &&
          [400, 413, 422, 428, 412].includes(failure.status)
        )
          pending.current = undefined;
        setState(
          failure instanceof DocumentRequestError && failure.status === 412
            ? 'conflict'
            : navigator.onLine
              ? 'failed'
              : 'offline',
        );
        setError(
          failure instanceof Error
            ? failure.message
            : 'Atomic save failed. The original operation remains recoverable.',
        );
        await persist().catch(() => {});
      },
    },
    canUndo: !!historyReady && !!history.current && history.current.cursor > 0,
    canRedo:
      !!historyReady &&
      !!history.current &&
      history.current.cursor < history.current.entries.length - 1,
    undo: () => navigateHistory(-1),
    redo: () => navigateHistory(1),
    document: visible ? document : undefined,
    saved: visible ? saved.current : undefined,
    state: visible ? state : ('loading' as DocumentSaveState),
    error: visible ? error : undefined,
    recovery: visible ? recovery : undefined,
    conflictVersion: visible ? conflictVersion : undefined,
    reconciliation: visible ? reconciliation : undefined,
    useMergedDraft,
    change,
    save,
    flush,
    reloadAcknowledged,
    restoreDraft,
    discardDraft,
    inspectConflict,
    useLocalDraft,
    useSavedVersion,
    setError,
  };
}
