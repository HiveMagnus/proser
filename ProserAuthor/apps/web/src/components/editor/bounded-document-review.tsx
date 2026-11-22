'use client';
import { useMemo } from 'react';
import type { DocumentTraceDisplayTarget } from '@cheftaco/proser-contracts';
import type { PassageTypedSession } from '@/lib/document-passage-typed-session';
import { getScenePassage } from '@/lib/document-passage-api';
import { canonicalDocument } from '@cheftaco/proser-contracts';
import { getDocumentTraceReview } from '@/lib/document-api';
import { DocumentReview } from './document-review';
/** Findings retain exact Factory bindings. Cursors only navigate a pinned source;
 * they never locate edits by matching a quotation or load the whole scene. */
export function BoundedDocumentReview({
  bookId,
  sceneId,
  session,
  tracking,
  disabled,
  onPendingChange,
  onExternalApplied,
}: {
  bookId: string;
  sceneId: string;
  session: PassageTypedSession;
  tracking: boolean;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onExternalApplied?: (
    before: import('@cheftaco/proser-contracts').DocumentPassage,
  ) => Promise<void>;
}) {
  const adapter = useMemo(
    () => ({
      flush: async () => {
        const before = await session.flush(tracking);
        return { bookRevisionId: before.bookRevisionId, revisionId: before.sceneRevisionId };
      },
      reloadAcknowledged: async (
        receipt: import('@cheftaco/proser-contracts').DocumentCompareReceipt,
      ) => {
        const reference = receipt.manifest.scenes.find(
          (scene) => scene.sceneId === Number(sceneId),
        );
        if (!reference)
          throw new Error(
            'The acknowledged compare scene is unavailable. Recover the original operation.',
          );
        const passage = await getScenePassage(bookId, sceneId, {
          bookRevisionId: receipt.revisionId,
          cursor: session.getSnapshot().passage?.cursor,
          maxCharacters: 8000,
          maxParagraphs: 24,
          maxRuns: 256,
        });
        if (
          passage.bookRevisionId !== receipt.revisionId ||
          passage.sceneRevisionId !== reference.revisionId ||
          passage.contentHash !== reference.contentHash
        )
          throw new Error(
            'The acknowledged review source changed. Preserve and recover its exact receipt.',
          );
        session.registerReviewAcknowledgement(receipt.result.sourceSceneRevisionId, passage);
        if (onExternalApplied) await onExternalApplied(passage);
      },
    }),
    [session, tracking, bookId, sceneId, onExternalApplied],
  );
  const navigate = async (target: DocumentTraceDisplayTarget) => {
    await session.flush(tracking);
    const review = await getDocumentTraceReview(bookId, sceneId);
    const matched = [...(review?.findings ?? []), ...(review?.compareCards ?? [])].find(
      (entry) => entry.target?.targetId === target.targetId,
    );
    if (
      !review?.currentSource ||
      matched?.state !== 'bound' ||
      canonicalDocument(matched.target) !== canonicalDocument(target)
    )
      throw new Error(
        'The saved finding source changed. Refresh and revalidate it before navigating.',
      );
    const first = await getScenePassage(bookId, sceneId, {
      bookRevisionId: review.currentSource.bookRevisionId,
      anchorBlockId: target.blockId,
      maxCharacters: 8000,
      maxParagraphs: 24,
      maxRuns: 256,
    });
    if (
      first.sceneRevisionId !== review.currentSource.sceneRevisionId ||
      first.contentHash !== review.currentSource.contentHash ||
      first.sourceFrame?.bookContentHash !== review.currentSource.bookContentHash
    )
      throw new Error('The frozen finding revision does not match its owned passage.');
    const paragraph = first.paragraphs.find((entry) => entry.paragraph.id === target.blockId);
    if (!paragraph)
      throw new Error('The stable finding paragraph is no longer available. Refresh findings.');
    await session.load({
      bookRevisionId: first.bookRevisionId,
      cursor: { item: first.cursor.item, paragraph: paragraph.ordinal, offset: target.from },
    });
    const current = session.getSnapshot().passage;
    const slice = current?.paragraphs.find((entry) => entry.paragraph.id === target.blockId);
    const text = slice?.paragraph.runs
      .map((run) => (run.inlineImage ? '\ufffc' : run.text))
      .join('');
    if (
      !slice ||
      target.from !== slice.offset ||
      target.to > slice.offset + (text?.length ?? 0) ||
      text?.slice(0, target.to - target.from) !== target.sourceText
    )
      throw new Error(
        'The complete frozen finding range is unavailable in this passage. Reduce the target or refresh findings.',
      );
    if (
      !current?.paragraphs.some(
        (entry) =>
          entry.paragraph.id === target.blockId &&
          entry.runs.some((run) => target.runIds.includes(run.runId)),
      )
    )
      throw new Error('The finding run identity changed. Refresh and revalidate its exact source.');
  };
  return (
    <DocumentReview
      bookId={bookId}
      sceneId={sceneId}
      editor={adapter}
      onNavigateTarget={navigate}
      onPendingChange={onPendingChange}
      disabled={disabled}
    />
  );
}
