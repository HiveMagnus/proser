'use client';
import { useCallback, useEffect, useState, useRef, type ReactNode } from 'react';
import { headerFooterForChapter } from '@/lib/document-layout-editing';
import type {
  DocumentPassage,
  SceneDocumentReference,
  BookLayoutSnapshot,
} from '@cheftaco/proser-contracts';
import type { PassageTypedSession } from '@/lib/document-passage-typed-session';
import { DocumentPassageTransfers } from './document-passage-transfers';
import { DocumentPassageWorkspace } from './document-passage-workspace';

/** Every scene fetches only a bounded passage. Inactive windows are released
 * when navigation changes the three stable scene references. */
export function DocumentPassageWindowWorkspace({
  userId,
  bookId,
  references,
  bookRevisionId,
  layout,
  searchHit,
  actorId,
  selectedSceneId,
  onActiveSceneChange,
  onDirtyChange,
  onAcknowledged,
  sideContext,
}: {
  userId: string;
  bookId: string;
  references: SceneDocumentReference[];
  bookRevisionId?: string;
  actorId: number;
  layout?: BookLayoutSnapshot;
  searchHit?: import('@cheftaco/proser-contracts').DocumentSearchHit;
  selectedSceneId?: number;
  onActiveSceneChange?: (id: number) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onAcknowledged?: (passage: DocumentPassage) => void;
  sideContext?: ReactNode;
}) {
  if (references.length > 3)
    throw new Error('A manuscript editing window contains at most three scenes.');
  const sessions = useRef(new Map<number, PassageTypedSession>());
  const callbacks = useRef(new Map<number, (session: PassageTypedSession) => void>());
  const [revision, setRevision] = useState(0);
  const [transferDirty, setTransferDirty] = useState(false);
  const register = (id: number) => {
    let callback = callbacks.current.get(id);
    if (!callback) {
      callback = (session) => {
        sessions.current.set(id, session);
        setRevision((value) => value + 1);
      };
      callbacks.current.set(id, callback);
    }
    return callback;
  };
  const [activeId, setActiveId] = useState(selectedSceneId ?? references[0]?.sceneId);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  useEffect(
    () => setActiveId(selectedSceneId ?? references[0]?.sceneId),
    [selectedSceneId, references],
  );
  useEffect(
    () => onDirtyChange?.(transferDirty || Object.values(dirty).some(Boolean)),
    [dirty, transferDirty, onDirtyChange],
  );
  const report = useCallback(
    (sceneId: number, value: boolean) =>
      setDirty((before) => (before[sceneId] === value ? before : { ...before, [sceneId]: value })),
    [],
  );
  return (
    <section
      aria-label="Bounded manuscript editing window"
      className="space-y-6"
      data-document-window
    >
      <p role="status">{references.length} scene passages in this editing window.</p>
      {references.length > 1 && (
        <DocumentPassageTransfers
          userId={userId}
          bookId={bookId}
          references={references}
          sessions={sessions.current}
          revision={revision}
          disabled={Object.values(dirty).some(Boolean)}
          onDirtyChange={setTransferDirty}
          onAcknowledged={onAcknowledged}
        />
      )}
      {references.map((reference) => (
        <section
          key={reference.sceneId}
          aria-label={`Scene ${reference.sceneNumber} document`}
          className="space-y-3 border-t border-border-muted pt-4"
        >
          <h2 className="text-lg font-semibold">Scene {reference.sceneNumber}</h2>
          <DocumentPassageWorkspace
            userId={userId}
            onSession={register(reference.sceneId)}
            bookId={bookId}
            sceneId={String(reference.sceneId)}
            actorId={actorId}
            bookRevisionId={bookRevisionId}
            searchHit={searchHit?.sceneId === reference.sceneId ? searchHit : undefined}
            namedStyles={layout?.styles}
            displayStories={
              layout ? headerFooterForChapter(layout, reference.chapterId) : undefined
            }
            active={reference.sceneId === activeId}
            disabled={transferDirty}
            onActivate={() => {
              if (
                transferDirty ||
                (Object.values(dirty).some(Boolean) && reference.sceneId !== activeId)
              )
                return;
              setActiveId(reference.sceneId);
              onActiveSceneChange?.(reference.sceneId);
            }}
            onDirtyChange={(value) => report(reference.sceneId, value)}
            onAcknowledged={onAcknowledged}
            sideContext={reference.sceneId === activeId ? sideContext : undefined}
          />
        </section>
      ))}
    </section>
  );
}
