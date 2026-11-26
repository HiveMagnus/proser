'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canonicalDocument,
  moveDocumentBlocks,
  splitDocumentSceneBoundary,
  joinDocumentSceneBoundary,
  movedBlockLineage,
  type DocumentAnchorLineage,
  type SceneDocumentReference,
} from '@hivemagnus/proser-editor';
import { useDocumentSession } from './use-document-session';
import {
  DocumentRequestError,
  recoverDocumentSave,
  saveSceneDocument,
  type SaveDocumentRequest,
} from '@/lib/document-api';
import {
  appendWindowHistory,
  initialWindowHistory,
  readWindowHistory,
  sameWindowDocuments,
  windowHistoryKey,
  writeWindowHistory,
  type DocumentWindowHistory,
  type WindowDocuments,
} from '@/lib/document-window-history';

/** A window owns at most three scene bodies. Its mutations share one journal
 * operation, book precondition and atomic Factory acknowledgement. */
export function useDocumentWindowSession(
  userId: string | undefined,
  bookId: string,
  references: SceneDocumentReference[],
  manifestBookRevisionId?: string,
) {
  if (references.length > 3)
    throw new Error('An editing window cannot contain more than three scenes.');
  const first = useDocumentSession(
    references[0] ? userId : undefined,
    bookId,
    String(references[0]?.sceneId ?? ''),
    { autosave: false, journalHistory: false },
  );
  const second = useDocumentSession(
    references[1] ? userId : undefined,
    bookId,
    String(references[1]?.sceneId ?? ''),
    { autosave: false, journalHistory: false },
  );
  const third = useDocumentSession(
    references[2] ? userId : undefined,
    bookId,
    String(references[2]?.sceneId ?? ''),
    { autosave: false, journalHistory: false },
  );
  const sessions = [first, second, third].slice(0, references.length);
  const current = useRef(sessions);
  current.current = sessions;
  useEffect(() => {
    if (
      !manifestBookRevisionId ||
      sessions.some(
        (session, index) =>
          !session.saved ||
          session.group.pendingSave ||
          session.saved.revisionId !== references[index]?.revisionId ||
          session.saved.contentHash !== references[index]?.contentHash,
      )
    )
      return;
    if (sessions.every((session) => session.saved?.bookRevisionId === manifestBookRevisionId))
      return;
    void Promise.all(
      sessions.map((session) => session.group.refreshBookRevision(manifestBookRevisionId)),
    );
  }, [manifestBookRevisionId, sessions, references]);
  const sceneIdSignature = references.map((reference) => String(reference.sceneId)).join(',');
  const sceneIds = useMemo(
    () => (sceneIdSignature ? sceneIdSignature.split(',') : []),
    [sceneIdSignature],
  );
  const scope = JSON.stringify([userId, bookId, sceneIds]);
  const active = useRef(scope);
  active.current = scope;
  const history = useRef<DocumentWindowHistory | undefined>(undefined);
  const pendingLineage = useRef<DocumentAnchorLineage[]>([]);
  const restoreIntent = useRef(new Map<string, { revisionId: string; documentHash: string }>());
  const adapterCache = useRef(
    new Map<string, { signature: unknown[]; value: ReturnType<typeof useDocumentSession> }>(),
  );
  const callbackCache = useRef(new Map<string, Partial<ReturnType<typeof useDocumentSession>>>());
  const historyScope = useRef(scope);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  if (historyScope.current !== scope) {
    history.current = undefined;
    pendingLineage.current = [];
    restoreIntent.current.clear();
    adapterCache.current.clear();
    callbackCache.current.clear();
    inFlight.current = undefined;
    historyScope.current = scope;
  }
  const writes = useRef(Promise.resolve());
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string>();
  const snapshot = useCallback(
    (): WindowDocuments =>
      Object.fromEntries(
        current.current.map((session) => {
          const prepared = session.group.prepare(false);
          return [String(prepared.saved.sceneId), prepared.document];
        }),
      ),
    [],
  );
  const persistHistory = useCallback(async () => {
    if (!userId || !history.current || active.current !== scope) return;
    const record = {
      key: windowHistoryKey(userId, bookId, sceneIds),
      userId,
      bookId,
      sceneIds,
      updatedAt: Date.now(),
      history: history.current,
    };
    writes.current = writes.current
      .catch(() => {})
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      .then(() =>
        active.current === scope && history.current
          ? writeWindowHistory({ ...record, history: history.current })
          : undefined,
      )
      .then(() => {});
    await writes.current;
  }, [scope, userId, bookId, sceneIds]);
  const loaded =
    sessions.length > 0 && sessions.every((session) => !!session.document && !!session.saved);
  const recovering = sessions.some((session) => !!session.recovery);
  const conflict = sessions.some((session) => session.state === 'conflict');
  const pending = sessions.some((session) => !!session.group.pendingSave);
  const dirty = sessions.some(
    (session) =>
      !!session.recovery || (!!session.document && !['saved', 'loading'].includes(session.state)),
  );
  useEffect(() => {
    if (!userId || !loaded || recovering || conflict || history.current) return;
    const captured = scope;
    void readWindowHistory(userId, bookId, sceneIds)
      .then((retained) => {
        if (active.current !== captured || history.current) return;
        const documents = snapshot();
        const base = Object.fromEntries(
          current.current.flatMap((session) =>
            session.saved ? [[String(session.saved.sceneId), session.saved.document]] : [],
          ),
        );
        const revisions = Object.fromEntries(
          current.current.flatMap((session) =>
            session.saved ? [[String(session.saved.sceneId), session.saved.revisionId]] : [],
          ),
        );
        history.current =
          retained && sameWindowDocuments(retained.entries[retained.cursor]!.documents, documents)
            ? retained
            : appendWindowHistory(initialWindowHistory(base, revisions), base, documents);
        const acknowledgedFrame = history.current.entries.reduce(
          (latest, entry, index) =>
            index <= history.current!.cursor &&
            current.current.every(
              (session) =>
                session.saved &&
                canonicalDocument(entry.documents[String(session.saved.sceneId)]) ===
                  canonicalDocument(session.saved.document),
            )
              ? index
              : latest,
          -1,
        );
        pendingLineage.current = history.current.entries
          .slice(Math.max(0, acknowledgedFrame + 1), history.current.cursor + 1)
          .flatMap((entry) => entry.anchorLineage ?? []);
        setVersion((value) => value + 1);
      })
      .catch(() => {
        if (active.current !== captured || history.current) return;
        history.current = initialWindowHistory(
          snapshot(),
          Object.fromEntries(
            current.current.flatMap((session) =>
              session.saved ? [[String(session.saved.sceneId), session.saved.revisionId]] : [],
            ),
          ),
        );
        setError(
          'Window history recovery is unavailable. Keep unsaved work open until Factory acknowledges it.',
        );
        setVersion((value) => value + 1);
      });
  }, [scope, loaded, recovering, conflict, userId, bookId, sceneIds, snapshot]);
  const changeMany = useCallback(
    (changes: WindowDocuments, lineage?: DocumentAnchorLineage[]) => {
      if (
        active.current !== scope ||
        (inFlight.current && current.current.some((session) => session.state === 'conflict'))
      )
        return;
      try {
        const before = snapshot();
        const after = { ...before, ...changes };
        for (const id of Object.keys(changes))
          if (!(id in before))
            throw new Error('The target scene is outside the active editing window.');
        if (!history.current)
          history.current = initialWindowHistory(
            before,
            Object.fromEntries(
              current.current.flatMap((session) =>
                session.saved &&
                canonicalDocument(before[String(session.saved.sceneId)]) ===
                  canonicalDocument(session.saved.document)
                  ? [[String(session.saved.sceneId), session.saved.revisionId]]
                  : [],
              ),
            ),
          );
        history.current = appendWindowHistory(history.current, before, after, lineage);
        if (lineage?.length) pendingLineage.current.push(...structuredClone(lineage));
        for (const session of current.current)
          if (session.saved && changes[String(session.saved.sceneId)])
            session.change(changes[String(session.saved.sceneId)]!);
        setVersion((value) => value + 1);
        void persistHistory().catch(() =>
          setError(
            'The window operation journal could not be retained locally. Save before leaving.',
          ),
        );
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Unable to edit this window.');
      }
    },
    [scope, snapshot, persistHistory],
  );
  const save = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const captured = scope;
    const perform = async () => {
      let participants: ReturnType<typeof useDocumentSession>[] = [];
      let acknowledged = false;
      try {
        if (!navigator.onLine)
          throw new Error('Offline · the window edits remain in local recovery.');
        const prepared = current.current.map((session) => ({
          session,
          ...session.group.prepare(),
        }));
        const pendingRequests = prepared.flatMap((item) =>
          item.pendingSave ? [item.pendingSave] : [],
        );
        if (new Set(pendingRequests.map((request) => request.operationId)).size > 1)
          throw new Error('Recover each interrupted operation before combining new scene edits.');
        let request: SaveDocumentRequest | undefined = pendingRequests[0];
        if (!request) {
          const changed = prepared.filter(
            (item) => canonicalDocument(item.document) !== canonicalDocument(item.saved.document),
          );
          if (!changed.length) return;
          const heads = new Set(changed.map((item) => item.saved.bookRevisionId));
          if (heads.size !== 1)
            throw new Error(
              'The book changed while loading this window. Reload or reconcile its scene revisions.',
            );
          request = {
            schemaVersion: 1,
            operationId: crypto.randomUUID(),
            expectedRevisionId: changed[0]!.saved.bookRevisionId,
            ...(pendingLineage.current.length
              ? { anchorLineage: structuredClone(pendingLineage.current) }
              : {}),
            scenes: changed.map((item) => ({
              sceneId: item.saved.sceneId,
              expectedRevisionId: item.saved.revisionId,
              document: item.document,
              ...(restoreIntent.current.get(String(item.saved.sceneId))?.documentHash ===
              canonicalDocument(item.document)
                ? {
                    restoreFromRevisionId: restoreIntent.current.get(String(item.saved.sceneId))!
                      .revisionId,
                  }
                : {}),
            })),
          };
        }
        if (
          request.scenes.some(
            (scene) => !prepared.some((item) => item.saved.sceneId === scene.sceneId),
          )
        )
          throw new Error(
            'Restore the original editing window to recover this multi-scene operation.',
          );
        participants = prepared
          .filter((item) => request.scenes.some((scene) => scene.sceneId === item.saved.sceneId))
          .map((item) => item.session);
        // Every participant retains the same complete request before dispatch.
        for (const session of participants) await session.group.stage(request);
        let receipt;
        try {
          receipt = await recoverDocumentSave(bookId, request.operationId);
        } catch (failure) {
          if (!(failure instanceof DocumentRequestError) || failure.status !== 404) throw failure;
          receipt = await saveSceneDocument(bookId, request);
        }
        if (active.current !== captured) return;
        if (
          receipt.kind !== 'commit' ||
          receipt.operationId !== request.operationId ||
          receipt.status !== 'completed' ||
          request.scenes.some(
            (scene) =>
              !receipt.scenes.some((acknowledged) => acknowledged.sceneId === scene.sceneId),
          )
        )
          throw new Error('Factory did not acknowledge every scope in the atomic window save.');
        acknowledged = true;
        for (const session of participants) await session.group.acknowledge(receipt, request);
        for (const session of current.current)
          await session.group.refreshBookRevision(receipt.revisionId);
        if (history.current) {
          for (const entry of history.current.entries) {
            for (const scene of request.scenes) {
              if (
                canonicalDocument(entry.documents[String(scene.sceneId)]) !==
                canonicalDocument(scene.document)
              )
                continue;
              const committed = receipt.scenes.find((item) => item.sceneId === scene.sceneId)!;
              entry.documents = {
                ...entry.documents,
                [String(scene.sceneId)]: structuredClone(committed.document),
              };
              entry.sceneRevisionIds = {
                ...entry.sceneRevisionIds,
                [String(scene.sceneId)]: committed.revisionId,
              };
            }
          }
          const latest = history.current.entries[history.current.cursor]!;
          latest.documents = snapshot();
          for (const scene of receipt.scenes)
            if (
              canonicalDocument(latest.documents[String(scene.sceneId)]) ===
              canonicalDocument(scene.document)
            )
              latest.sceneRevisionIds = {
                ...latest.sceneRevisionIds,
                [String(scene.sceneId)]: scene.revisionId,
              };
          const committedMappings = new Set(
            (request.anchorLineage ?? []).map((mapping) => canonicalDocument(mapping)),
          );
          pendingLineage.current = pendingLineage.current.filter(
            (mapping) => !committedMappings.has(canonicalDocument(mapping)),
          );
          for (const scene of request.scenes) restoreIntent.current.delete(String(scene.sceneId));
          await persistHistory();
        }
        setError(undefined);
        setVersion((value) => value + 1);
      } catch (failure) {
        if (active.current !== captured) return;
        if (!acknowledged) for (const session of participants) await session.group.reject(failure);
        setError(
          acknowledged
            ? 'Factory acknowledged the window save. Local undo history could not be retained; keep remaining edits open.'
            : failure instanceof Error
              ? failure.message
              : 'Atomic save failed. Recover the original operation before retrying.',
        );
        setVersion((value) => value + 1);
      } finally {
        if (active.current === captured) inFlight.current = undefined;
      }
    };
    // Assign before starting: an unchanged save can finish synchronously.
    inFlight.current = Promise.resolve().then(perform);
    await inFlight.current;
  }, [scope, bookId, snapshot, persistHistory]);
  const changedSignature = sessions
    .map((session) => (session.document ? canonicalDocument(session.document) : ''))
    .join('|');
  const unsaved = sessions.some((session) => session.state === 'unsaved');
  useEffect(() => {
    if (!loaded || recovering || conflict || !unsaved) return;
    const timer = setTimeout(() => void save(), 750);
    return () => clearTimeout(timer);
  }, [changedSignature, loaded, recovering, conflict, unsaved, save]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (current.current.some((session) => session.state === 'unsaved')) void save();
    }, 5000);
    return () => clearInterval(timer);
  }, [save]);
  const renderedDocuments = Object.fromEntries(
    sessions.flatMap((session) =>
      session.saved && session.document ? [[String(session.saved.sceneId), session.document]] : [],
    ),
  );
  const historyMatches =
    !!history.current &&
    sameWindowDocuments(
      history.current.entries[history.current.cursor]!.documents,
      renderedDocuments,
    );
  const canNavigateHistory =
    loaded && !recovering && !conflict && !pending && !inFlight.current && historyMatches;
  const travel = (direction: -1 | 1) => {
    if (!canNavigateHistory || !history.current) return;
    const entry = history.current.entries[history.current.cursor + direction];
    if (!entry) return;
    const previous = history.current.entries[history.current.cursor]!;
    history.current.cursor += direction;
    restoreIntent.current.clear();
    for (const [id, revisionId] of Object.entries(entry.sceneRevisionIds ?? {}))
      restoreIntent.current.set(id, {
        revisionId,
        documentHash: canonicalDocument(entry.documents[id]),
      });
    const lineage = direction === -1 ? previous.anchorLineage : entry.anchorLineage;
    const committedLineage = lineage?.filter(
      (mapping) =>
        !!previous.sceneRevisionIds?.[
          String(direction === -1 ? mapping.target.sceneId : mapping.source.sceneId)
        ],
    );
    pendingLineage.current =
      committedLineage?.map((mapping) => ({
        kind: 'restore',
        source: direction === -1 ? mapping.target : mapping.source,
        target: direction === -1 ? mapping.source : mapping.target,
      })) ?? [];
    for (const session of current.current)
      if (session.saved)
        session.change(structuredClone(entry.documents[String(session.saved.sceneId)]!));
    setVersion((value) => value + 1);
    void persistHistory().catch(() => setError('Local operation recovery is unavailable.'));
    if (Object.keys(entry.sceneRevisionIds ?? {}).length) void save();
  };
  const saveReference = useRef(save);
  saveReference.current = save;
  const travelReference = useRef(travel);
  travelReference.current = travel;
  const changeReference = useRef(changeMany);
  changeReference.current = changeMany;
  const adapted = sessions.map((session, index) => {
    const id = sceneIds[index]!;
    const canUndo = !!canNavigateHistory && !!history.current && history.current.cursor > 0;
    const canRedo =
      !!canNavigateHistory &&
      !!history.current &&
      history.current.cursor < history.current.entries.length - 1;
    const signature = [
      session.document,
      session.saved,
      session.saved?.bookRevisionId,
      session.state,
      session.error,
      session.recovery,
      session.conflictVersion,
      session.reconciliation,
      session.group.pendingSave,
      canUndo,
      canRedo,
    ];
    const cached = adapterCache.current.get(id);
    if (cached && signature.every((value, position) => value === cached.signature[position]))
      return cached.value;
    let callbacks = callbackCache.current.get(id);
    if (!callbacks) {
      const member = () => current.current[index]!;
      callbacks = {
        change: (document) => changeReference.current({ [id]: document }),
        save: () => saveReference.current(),
        flush: async () => {
          await saveReference.current();
          const prepared = current.current.map((item) => item.group.prepare(false));
          if (
            prepared.some(
              (item) =>
                item.pendingSave ||
                canonicalDocument(item.document) !== canonicalDocument(item.saved.document),
            )
          )
            throw new Error(
              'Save and reconcile all changed scenes before applying a proposal in this window.',
            );
          const acknowledged = prepared.find((item) => String(item.saved.sceneId) === id);
          if (!acknowledged) throw new Error('The requested scene left the editing window.');
          return acknowledged.saved;
        },
        undo: () => travelReference.current(-1),
        redo: () => travelReference.current(1),
        reloadAcknowledged: () => member().reloadAcknowledged(),
        restoreDraft: () => member().restoreDraft(),
        discardDraft: () => member().discardDraft(),
        inspectConflict: () => member().inspectConflict(),
        useLocalDraft: () => member().useLocalDraft(),
        useSavedVersion: () => member().useSavedVersion(),
        useMergedDraft: () => member().useMergedDraft(),
        setError: (error) => member().setError(error),
      };
      callbackCache.current.set(id, callbacks);
    }
    const value = { ...session, ...callbacks, canUndo, canRedo };
    adapterCache.current.set(id, { signature, value });
    return value;
  });
  return {
    sessions: adapted,
    loaded,
    dirty,
    error,
    version,
    save,
    split: async (leftId: string, rightId: string, blockId: string, offset: number) => {
      try {
        await save();
        const prepared = current.current.map((session) => session.group.prepare());
        if (
          prepared.some(
            (item) => canonicalDocument(item.document) !== canonicalDocument(item.saved.document),
          )
        )
          throw new Error('Save or reconcile the current window before splitting its scenes.');
        const documents = snapshot();
        if (
          sceneIds.indexOf(rightId) !== sceneIds.indexOf(leftId) + 1 ||
          !documents[leftId] ||
          !documents[rightId]
        )
          throw new Error('Choose adjacent scenes in this editing window.');
        const split = splitDocumentSceneBoundary(
          documents[leftId]!,
          documents[rightId]!,
          Number(leftId),
          Number(rightId),
          blockId,
          offset,
          () => crypto.randomUUID(),
        );
        changeMany({ [leftId]: split.left, [rightId]: split.right }, split.anchorLineage);
        await save();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Unable to split these scenes.');
      }
    },
    join: async (leftId: string, rightId: string, track = false) => {
      try {
        await save();
        const prepared = current.current.map((session) => session.group.prepare());
        if (
          prepared.some(
            (item) => canonicalDocument(item.document) !== canonicalDocument(item.saved.document),
          )
        )
          throw new Error('Save or reconcile the current window before joining its scenes.');
        const documents = snapshot();
        if (
          sceneIds.indexOf(rightId) !== sceneIds.indexOf(leftId) + 1 ||
          !documents[leftId] ||
          !documents[rightId]
        )
          throw new Error('Choose adjacent scenes in this editing window.');
        const joined = joinDocumentSceneBoundary(
          documents[leftId]!,
          documents[rightId]!,
          Number(leftId),
          Number(rightId),
          () => crypto.randomUUID(),
          track,
        );
        changeMany({ [leftId]: joined.left, [rightId]: joined.right }, joined.anchorLineage);
        await save();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Unable to join these scenes.');
      }
    },
    move: (
      sourceId: string,
      destinationId: string,
      blockIds: string[],
      placement: 'start' | 'end',
    ) => {
      try {
        const documents = snapshot();
        if (sourceId === destinationId || !documents[sourceId] || !documents[destinationId])
          throw new Error('Choose two distinct scenes in the current window.');
        const moved = moveDocumentBlocks(
          documents[sourceId]!,
          documents[destinationId]!,
          blockIds,
          placement,
        );
        changeMany(
          { [sourceId]: moved.source, [destinationId]: moved.destination },
          movedBlockLineage(
            documents[sourceId]!.blocks.filter((block) => blockIds.includes(block.id)),
            Number(sourceId),
            Number(destinationId),
          ),
        );
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Unable to move these blocks.');
      }
    },
  };
}
