'use client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DocumentPassage } from '@hivemagnus/proser-contracts';
import {
  PassageTypedSession,
  type PassageTypedReceipt,
} from '@/lib/document-passage-typed-session';
import {
  getScenePassage,
  commitScenePassageOperations,
  restoreScenePassage,
  recoverScenePassage,
} from '@/lib/document-passage-api';
import {
  readDocumentPassageDraft,
  writeDocumentPassageDraft,
  acknowledgeDocumentPassageDraft,
  deleteDocumentPassageDraft,
} from '@/lib/document-passage-journal';

export function useDocumentPassageSession(
  userId: string,
  bookId: string,
  sceneId: string,
  options: { composing?: boolean; tracking?: boolean; bookRevisionId?: string } = {},
) {
  const [online, setOnline] = useState(true);
  const composing = useRef(options.composing);
  composing.current = options.composing;
  const session = useMemo(
    () =>
      new PassageTypedSession(
        { userId, bookId, sceneId },
        {
          load: (request) => getScenePassage(bookId, sceneId, request),
          read: () => readDocumentPassageDraft(userId, bookId, sceneId),
          write: writeDocumentPassageDraft,
          advance: acknowledgeDocumentPassageDraft,
          remove: (version) => deleteDocumentPassageDraft(userId, bookId, sceneId, version),
          commit: (request) => commitScenePassageOperations(bookId, sceneId, request),
          restore: (request) => restoreScenePassage(bookId, sceneId, request),
          recover: (operationId) =>
            recoverScenePassage<
              | PassageTypedReceipt['result']
              | import('@hivemagnus/proser-contracts').DocumentPassageRestoreResult
            >(bookId, operationId) as ReturnType<
              import('@/lib/document-passage-typed-session').PassageTypedDependencies['recover']
            >,
          id: () => crypto.randomUUID(),
        },
      ),
    [userId, bookId, sceneId],
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    session.activate();
    void session.load();
    return () => session.dispose();
  }, [session]);
  useEffect(() => {
    const retain = () => void session.retainDraft().catch(() => undefined);
    const background = () => {
      if (document.visibilityState === 'hidden') retain();
    };
    const protect = (event: BeforeUnloadEvent) => {
      const current = session.getSnapshot();
      if (
        composing.current ||
        ['unsaved', 'saving', 'conflict', 'recoverable', 'failed'].includes(current.state)
      ) {
        retain();
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const resume = (event: PageTransitionEvent) => {
      const current = session.getSnapshot();
      // A restored page rechecks saved content. Unacknowledged work keeps its
      // exact journal and requires receipt recovery/reconciliation as before.
      if (event.persisted && current.state === 'saved' && !composing.current)
        void session.load({ cursor: current.passage?.cursor }).catch(() => undefined);
    };
    window.addEventListener('beforeunload', protect);
    window.addEventListener('pagehide', retain);
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', background);
    return () => {
      window.removeEventListener('beforeunload', protect);
      window.removeEventListener('pagehide', retain);
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', background);
    };
  }, [session]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const firstDirty = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (snapshot.state !== 'unsaved') {
      if (snapshot.state !== 'saving') firstDirty.current = undefined;
      return;
    }
    firstDirty.current ??= Date.now();
    if (!online || options.composing) return;
    const delay = Math.max(0, Math.min(750, 5000 - (Date.now() - firstDirty.current)));
    const timer = setTimeout(() => {
      void session.save(options.tracking).catch(() => undefined);
    }, delay);
    return () => clearTimeout(timer);
  }, [snapshot.document, snapshot.state, session, online, options.composing, options.tracking]);
  const seenManifest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!options.bookRevisionId || snapshot.state !== 'saved') return;
    if (seenManifest.current === undefined) {
      seenManifest.current = options.bookRevisionId;
      return;
    }
    if (seenManifest.current === options.bookRevisionId) return;
    seenManifest.current = options.bookRevisionId;
    if (snapshot.passage?.bookRevisionId !== options.bookRevisionId)
      void session.load({
        cursor: snapshot.passage?.cursor,
        bookRevisionId: options.bookRevisionId,
      });
  }, [
    options.bookRevisionId,
    snapshot.state,
    snapshot.passage?.bookRevisionId,
    snapshot.passage?.cursor,
    session,
  ]);
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const flush = async (): Promise<DocumentPassage> => session.flush(options.tracking);
  return {
    ...snapshot,
    session,
    online,
    flush,
    refresh: async () => {
      if (latest.current.state !== 'saved')
        throw new Error('Save or recover before refreshing the passage.');
      await session.load({ cursor: latest.current.passage?.cursor });
    },
  };
}
