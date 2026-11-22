'use client';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { DocumentPassageSession } from '@/lib/document-passage-session';
import { getScenePassage, recoverScenePassage, saveScenePassage } from '@/lib/document-passage-api';
import {
  readDocumentPassageDraft,
  writeDocumentPassageDraft,
  acknowledgeDocumentPassageDraft,
  deleteDocumentPassageDraft,
} from '@/lib/document-passage-journal';
/** Caller enables this only after negotiating the complete ordered-operation surface.
 * It is intentionally not imported by the active workspace yet. */
export function usePassageSession(
  identity: { userId: string; bookId: string; sceneId: string } | undefined,
  options: {
    enabled: boolean;
    tracking?: boolean;
    autosave?: boolean;
    maxCharacters?: number;
    maxParagraphs?: number;
  },
) {
  const userId = identity?.userId;
  const bookId = identity?.bookId;
  const sceneId = identity?.sceneId;
  const maxCharacters = options.maxCharacters ?? 2400;
  const maxParagraphs = options.maxParagraphs ?? 12;
  const controller = useMemo(() => {
    if (!options.enabled || !userId || !bookId || !sceneId) return;
    return new DocumentPassageSession(
      { userId, bookId, sceneId },
      {
        load: (input) => getScenePassage(bookId, sceneId, input),
        read: () => readDocumentPassageDraft(userId, bookId, sceneId),
        write: writeDocumentPassageDraft,
        advance: acknowledgeDocumentPassageDraft,
        remove: (version) => deleteDocumentPassageDraft(userId, bookId, sceneId, version),
        save: (request) => saveScenePassage(bookId, sceneId, request),
        recover: (operationId) => recoverScenePassage(bookId, operationId),
        operationId: () => crypto.randomUUID(),
        version: () => crypto.randomUUID(),
      },
      { maxCharacters, maxParagraphs },
    );
  }, [options.enabled, userId, bookId, sceneId, maxCharacters, maxParagraphs]);
  const inactive = useMemo(() => ({ state: 'inactive' as const, drafts: [] }), []);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? (() => inactive),
    () => inactive,
  );
  const firstDirty = useRef<number | undefined>(undefined);
  const tracking = useRef(options.tracking ?? false);
  tracking.current = options.tracking ?? false;
  useEffect(() => {
    if (!controller) return;
    controller.activate();
    void controller.load();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    if (snapshot.state === 'saved' || snapshot.state === 'inactive') firstDirty.current = undefined;
    if (!controller || options.autosave === false || snapshot.state !== 'unsaved') return;
    firstDirty.current ??= Date.now();
    const timer = setTimeout(
      () => {
        void controller.save(tracking.current);
      },
      Math.min(750, Math.max(0, 5000 - (Date.now() - firstDirty.current))),
    );
    return () => clearTimeout(timer);
  }, [controller, options.autosave, snapshot]);
  return { ...snapshot, controller };
}
