'use client';
import { useEffect, useRef, useState } from 'react';
import {
  canonicalDocument,
  type DocumentStorySourceRecord,
  type DocumentStoryDiscussionRecord,
  type DocumentPassageOperation,
  type ProserDocument,
} from '@hivemagnus/proser-contracts';
import type { DocumentSelection } from '@hivemagnus/proser-editor';
import { getDocumentStory } from '@/lib/document-story-api';
import { storyDraftContext, type StoryDraftContext } from '@/lib/document-story-draft';
import { DocumentDiscussion } from './document-discussion';
export interface DocumentStoryDiscussionProps {
  bookId: string;
  storyId: string;
  bookRevisionId?: string;
  document: ProserDocument;
  selection?: DocumentSelection;
  disabled?: boolean;
  sessionId?: string;
  flush(localOperations?: {
    operationId: string;
    operations: DocumentPassageOperation[];
  }): Promise<DocumentStorySourceRecord>;
  refresh(receipt?: unknown): Promise<void>;
}
export function DocumentStoryDiscussion(props: DocumentStoryDiscussionProps) {
  return <StoryDiscussionSession key={`${props.bookId}:${props.storyId}`} {...props} />;
}
function StoryDiscussionSession({
  bookId,
  storyId,
  bookRevisionId,
  document,
  selection,
  disabled,
  sessionId: providedSession,
  flush,
  refresh,
}: DocumentStoryDiscussionProps) {
  const [source, setSource] = useState<DocumentStorySourceRecord>();
  const [context, setContext] = useState<StoryDraftContext>();
  const [error, setError] = useState<string>();
  const [sessionId] = useState(() => providedSession ?? crypto.randomUUID());
  const [generation, setGeneration] = useState(0);
  const operation = useRef<{ sourceKey: string; operationId: string; ids: Map<string, string> }>(
    undefined,
  );
  const currentKey = canonicalDocument(document);
  const contextKey = useRef('');
  useEffect(() => {
    const controller = new AbortController();
    setContext(undefined);
    setError(undefined);
    void getDocumentStory(bookId, storyId, controller.signal, bookRevisionId)
      .then((saved) => {
        if (!controller.signal.aborted) setSource(saved);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : 'The saved story source could not load.',
          );
      });
    return () => controller.abort();
  }, [bookId, storyId, bookRevisionId, generation]);
  useEffect(() => {
    let active = true;
    setContext(undefined);
    if (!source) return;
    const sourceKey = `${source.layoutRevisionId}:${source.contentHash}`;
    if (operation.current?.sourceKey !== sourceKey)
      operation.current = { sourceKey, operationId: crypto.randomUUID(), ids: new Map() };
    const reserved = operation.current;
    void storyDraftContext(source, document, reserved.operationId, (key) => {
      let id = reserved.ids.get(key);
      if (!id) {
        id = crypto.randomUUID();
        reserved.ids.set(key, id);
      }
      return id;
    })
      .then((derived) => {
        if (active) {
          contextKey.current = currentKey;
          setContext(derived);
          setError(undefined);
        }
      })
      .catch((failure) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Save the changed story before preparing context.',
          );
      });
    return () => {
      active = false;
    };
  }, [source, document, currentKey]);
  const recoverContext = async (record: DocumentStoryDiscussionRecord) => {
    if (record.storyId !== storyId || record.snapshot.sourceKind !== 'layout-story')
      throw new Error('This discussion belongs to another owned story.');
    const currentSource = await getDocumentStory(bookId, storyId);
    if (canonicalDocument(currentSource.document) === currentKey) {
      setSource(currentSource);
      return;
    }
    const retained = record.draftOperations;
    if (!retained) {
      setSource(currentSource);
      return;
    }
    const original = await getDocumentStory(
      bookId,
      storyId,
      undefined,
      record.snapshot.sourceBookRevisionId,
    );
    if (
      original.contentHash !== record.snapshot.sourceContentHash ||
      original.layoutRevisionId !== record.snapshot.sourceLayoutRevisionId
    )
      throw new Error('The saved discussion source does not match its immutable story.');
    const ids = new Map<string, string>();
    for (const intention of retained.operations) {
      if (intention.kind === 'paragraph-format')
        ids.set(intention.target.blockId + ':paragraph-format', intention.id);
      else if (intention.kind === 'text' || intention.kind === 'run-format')
        ids.set(intention.target.runId + ':' + intention.kind, intention.id);
      else throw new Error('Unsupported retained story intention.');
    }
    const restored = await storyDraftContext(original, document, retained.operationId, (key) => {
      const id = ids.get(key);
      if (!id) throw new Error('The local story changed after this saved discussion.');
      return id;
    });
    if (canonicalDocument(restored.localOperations) !== canonicalDocument(retained))
      throw new Error(
        'The local story differs from this saved discussion. Preserve the draft and prepare new context.',
      );
    operation.current = {
      sourceKey: `${original.layoutRevisionId}:${original.contentHash}`,
      operationId: retained.operationId,
      ids,
    };
    setSource(original);
    contextKey.current = currentKey;
    setContext(restored);
    setError(undefined);
  };
  if (!source)
    return (
      <p role={error ? 'alert' : 'status'}>{error ?? 'Loading saved story discussion source…'}</p>
    );
  const frozen = contextKey.current === currentKey ? context : undefined;
  return (
    <section aria-label="Owned story discussion" className="space-y-3">
      {error && <p role="alert">{error}</p>}
      <DocumentDiscussion
        bookId={bookId}
        selection={selection}
        disabled={disabled || !frozen}
        story={{
          source,
          document,
          targets: frozen?.targets ?? [],
          localOperations: frozen?.localOperations,
          sessionId,
          draftKey: canonicalDocument({
            source: source.layoutRevisionId,
            document,
            current: frozen?.localOperations,
          }),
          blocked: !frozen,
          recoverContext,
          flush: async () => {
            const saved = await flush(frozen?.localOperations);
            setSource(saved);
            return saved;
          },
          refresh: async (receipt) => {
            await refresh(receipt);
            setGeneration((value) => value + 1);
          },
        }}
      />
    </section>
  );
}
