'use client';
import { canonicalDocument, type DocumentSelection } from '@cheftaco/proser-editor';
import type {
  DocumentPassage,
  DocumentPassageOperation,
  DocumentTargetInput,
} from '@cheftaco/proser-contracts';
import { DocumentDiscussion } from './document-discussion';

/** The discussion UI receives only bounded excerpts and owned source proofs.
 * Factory reproduces draft intents and returns complete disclosed target blocks;
 * the editor must flush the same operation UUID before tracked application. */
export function BoundedDocumentDiscussion(props: {
  passage: DocumentPassage;
  targets?: DocumentTargetInput[];
  selection?: DocumentSelection;
  selectionError?: string;
  localOperations?: { operationId: string; operations: DocumentPassageOperation[] };
  sessionId: string;
  draftKey?: string;
  flush(): Promise<DocumentPassage>;
  retainLocalOperations?(local: {
    operationId: string;
    operations: DocumentPassageOperation[];
  }): Promise<void>;
  refresh(
    receipt: import('@cheftaco/proser-contracts').DocumentProposalApplicationReceipt,
    beforeSceneRevisionId?: string,
  ): Promise<void>;
  disabled?: boolean;
}) {
  const frame = props.passage.sourceFrame;
  if (!frame || frame.bookId <= 0 || frame.sceneId !== props.passage.sceneId) return null;
  // Changed excerpt text must be supplied with canonical derivative coordinates;
  // never guess them from clipped slices after an insertion/deletion.
  const targets =
    props.targets ??
    (props.localOperations
      ? []
      : props.passage.paragraphs.map((item) => {
          const sourceText = item.paragraph.runs
            .map((run) => (run.inlineImage ? '\uFFFC' : run.text))
            .join('');
          return {
            blockId: item.paragraph.id,
            from: item.offset,
            to: item.offset + sourceText.length,
            sourceText,
          };
        }));
  return (
    <DocumentDiscussion
      key={`${frame.bookId}:${frame.sceneId}:${props.sessionId}`}
      bookId={String(frame.bookId)}
      sceneId={String(frame.sceneId)}
      bounded={{
        passage: props.passage,
        targets,
        localOperations: props.localOperations,
        sessionId: props.sessionId,
        draftKey: canonicalDocument({
          draftKey: props.draftKey ?? null,
          passage: props.passage.windowHash,
          targets,
          operations: props.localOperations ?? null,
        }),
        flush: props.flush,
        refresh: props.refresh,
        retainLocalOperations: props.retainLocalOperations,
        blocked: props.disabled || props.passage.projection !== 'final',
      }}
      selection={props.selection}
      selectionError={props.selectionError}
      disabled={props.disabled}
    />
  );
}
