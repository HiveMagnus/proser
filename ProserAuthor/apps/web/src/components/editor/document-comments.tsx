'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  paragraphsOf,
  paragraphSelection,
  visibleRun,
  type DocumentSelection,
  type ProserDocument,
} from '@cheftaco/proser-editor';
import type {
  DocumentAnchor,
  DocumentCommentReviewReceipt,
  DocumentCommentResolutionAction,
  SceneCommentsResponse,
  LayoutStoryCommentsResponse,
} from '@cheftaco/proser-contracts';
import {
  DocumentRequestError,
  getDocumentComments,
  revalidateDocumentComment,
  resolveDocumentComment,
  recoverDocumentComment,
} from '@/lib/document-api';
import {
  readDocumentCommentIntent,
  writeDocumentCommentIntent,
  deleteDocumentCommentIntent,
  type CommentScope,
  type DocumentCommentIntent,
} from '@/lib/document-comment-journal';
interface Props {
  userId: string;
  bookId: string;
  scope: CommentScope;
  selection?: DocumentSelection;
  disabled?: boolean;
  prepare: () => Promise<{ document: ProserDocument; bookRevisionId: string; revisionId: string }>;
  onCommitted: (receipt: DocumentCommentReviewReceipt) => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}
export function DocumentComments(props: Props) {
  const scope = useMemo<CommentScope>(
    () => ({ kind: props.scope.kind, id: props.scope.id }),
    [props.scope.kind, props.scope.id],
  );
  return (
    <CommentSession
      key={`${props.userId}:${props.bookId}:${props.scope.kind}:${props.scope.id}`}
      {...props}
      scope={scope}
    />
  );
}
function CommentSession({
  userId,
  bookId,
  scope,
  selection,
  disabled,
  prepare,
  onCommitted,
  onPendingChange,
}: Props) {
  const [source, setSource] = useState<SceneCommentsResponse | LayoutStoryCommentsResponse>();
  const [pending, setPending] = useState<DocumentCommentIntent>();
  const [journalReady, setJournalReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryAllowed, setRetryAllowed] = useState(false);
  const [error, setError] = useState<string>();
  const [proposed, setProposed] = useState<{
    commentId: string;
    anchors: DocumentAnchor[];
    bookRevisionId: string;
    revisionId: string;
  }>();
  const alive = useRef(true);
  const refresh = async () => {
    const next = await getDocumentComments(bookId, scope);
    if (alive.current) setSource(next);
  };
  const report = (reason: unknown) => {
    if (alive.current)
      setError(reason instanceof Error ? reason.message : 'Comment review failed.');
  };
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    void Promise.all([
      getDocumentComments(bookId, scope, abort.signal),
      readDocumentCommentIntent(userId, bookId, scope),
    ])
      .then(([saved, retained]) => {
        if (alive.current) {
          setSource(saved);
          setPending(retained);
          setJournalReady(true);
        }
      })
      .catch(report);
    return () => {
      alive.current = false;
      abort.abort();
    };
  }, [userId, bookId, scope]);
  useEffect(() => {
    onPendingChange?.(busy || Boolean(pending));
  }, [busy, pending, onPendingChange]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (busy || pending) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [busy, pending]);
  const finish = async (intent: DocumentCommentIntent, receipt: DocumentCommentReviewReceipt) => {
    const sameScope =
      'sceneId' in receipt.result
        ? scope.kind === 'scene' && String(receipt.result.sceneId) === scope.id
        : scope.kind === 'layout-story' && receipt.result.storyId === scope.id;
    if (
      receipt.status !== 'completed' ||
      receipt.kind !== 'catalog' ||
      receipt.operationId !== intent.request.operationId ||
      receipt.result.commentId !== intent.commentId ||
      receipt.result.action !== intent.request.action ||
      !sameScope
    )
      throw new Error('Factory returned an incompatible comment receipt.');
    if (!alive.current) return;
    await onCommitted(receipt);
    if (!alive.current) return;
    await deleteDocumentCommentIntent(userId, bookId, scope, intent.request.operationId);
    setPending(undefined);
    setRetryAllowed(false);
    setProposed(undefined);
    await refresh();
  };
  const sourceRequest = (saved: { bookRevisionId: string; revisionId: string }) =>
    scope.kind === 'scene'
      ? { expectedRevisionId: saved.bookRevisionId, expectedSceneRevisionId: saved.revisionId }
      : { expectedRevisionId: saved.bookRevisionId, expectedLayoutRevisionId: saved.revisionId };
  const inspect = async (commentId: string) => {
    if (busy || pending || disabled || !journalReady || !selection?.runs.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await prepare();
      if (!alive.current) return;
      const paragraphs = paragraphsOf(saved.document);
      for (const target of selection.targets) {
        const paragraph = paragraphs.find((block) => block.id === target.blockId);
        if (!paragraph) throw new Error('The selected paragraph is stale. Select it again.');
        const text = paragraph.runs
          .filter((run) => visibleRun(run, saved.document.changes, 'final'))
          .map((run) => (run.inlineImage ? '\ufffc' : run.text))
          .join('');
        paragraphSelection(saved.document, target.blockId, target.from, target.to, text);
        if (text.slice(target.from, target.to) !== target.sourceText)
          throw new Error('The selected quotation changed. Select it again.');
      }
      const anchors = selection.runs.map((span) => {
        const run = paragraphs
          .find((block) => block.id === span.blockId)
          ?.runs.find((run) => run.id === span.runId);
        if (!run || run.inlineImage || span.to <= span.from)
          throw new Error('Select a complete text range again.');
        return {
          blockId: span.blockId,
          runId: span.runId,
          start: span.from,
          end: span.to,
          sourceText: run.text.slice(span.from, span.to),
        };
      });
      const validated = await revalidateDocumentComment(bookId, scope, commentId, {
        ...sourceRequest(saved),
        anchors,
      });
      if (!validated.proposedAnchors || validated.attachment !== 'attached')
        throw new Error('The selected anchor did not validate. Select an exact current range.');
      if (alive.current)
        setProposed({
          commentId,
          anchors: validated.proposedAnchors,
          bookRevisionId: validated.bookRevisionId,
          revisionId:
            'sceneRevisionId' in validated ? validated.sceneRevisionId : validated.layoutRevisionId,
        });
    } catch (reason) {
      report(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const resolve = async (commentId: string, action: DocumentCommentResolutionAction) => {
    if (busy || pending || disabled || !journalReady) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await prepare();
      if (!alive.current) return;
      if (
        action === 'reanchored' &&
        (!proposed ||
          proposed.commentId !== commentId ||
          proposed.bookRevisionId !== saved.bookRevisionId ||
          proposed.revisionId !== saved.revisionId)
      )
        throw new Error('The reviewed anchor is stale. Revalidate the selection.');
      const intent: DocumentCommentIntent = {
        schemaVersion: 1,
        userId,
        bookId,
        scope,
        commentId,
        updatedAt: Date.now(),
        request: {
          ...sourceRequest(saved),
          operationId: crypto.randomUUID(),
          action,
          ...(action === 'reanchored' ? { anchors: proposed!.anchors } : {}),
        },
      };
      await writeDocumentCommentIntent(intent);
      if (!alive.current) return;
      setPending(intent);
      setRetryAllowed(false);
      await finish(intent, await resolveDocumentComment(bookId, scope, commentId, intent.request));
    } catch (reason) {
      report(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const recover = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await finish(pending, await recoverDocumentComment(bookId, pending.request.operationId));
    } catch (reason) {
      if (reason instanceof DocumentRequestError && reason.status === 404 && alive.current)
        setRetryAllowed(true);
      report(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const retry = async () => {
    if (!pending || busy || disabled || !retryAllowed) return;
    setBusy(true);
    setRetryAllowed(false);
    setError(undefined);
    try {
      await finish(
        pending,
        await resolveDocumentComment(bookId, scope, pending.commentId, pending.request),
      );
    } catch (reason) {
      report(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section
      aria-label="Document comments"
      className="space-y-3 rounded border border-border-muted p-3"
    >
      <h2 className="font-semibold">Comments</h2>
      {error && <p role="alert">{error}</p>}
      {pending && (
        <aside aria-label="Comment operation recovery">
          <p>Comment review needs recovery before continuing.</p>
          <button type="button" disabled={busy} onClick={() => void recover()}>
            Recover comment receipt
          </button>
          {retryAllowed && (
            <button type="button" disabled={busy || disabled} onClick={() => void retry()}>
              Retry exact comment resolution
            </button>
          )}
        </aside>
      )}
      {!source && !error && <p role="status">Loading comments…</p>}
      {source && !source.comments.length && <p>No comments in this document.</p>}
      {source?.comments.map((comment) => (
        <article
          key={comment.id}
          aria-label={`Comment by ${comment.authorName}`}
          className="space-y-2"
        >
          <p>{comment.text}</p>
          <p>
            {comment.authorName}
            {comment.importedAuthor ? ' (imported)' : ''} · {comment.resolved ? 'Resolved' : 'Open'}
          </p>
          {comment.anchorStates?.map((state) => (
            <blockquote key={state.anchorIndex}>
              <p role="status">
                {state.status === 'orphaned' ? 'Orphaned anchor' : 'Stale anchor'}:{' '}
                {state.reason.replaceAll('-', ' ')}
              </p>
              <p>Original quotation: {state.sourceAnchor.sourceText || '(empty range)'}</p>
              <small>
                Source revision:{' '}
                {'sourceSceneRevisionId' in state
                  ? state.sourceSceneRevisionId
                  : state.sourceLayoutRevisionId}
              </small>
            </blockquote>
          ))}
          <button
            type="button"
            disabled={busy || Boolean(pending) || disabled || !journalReady}
            onClick={() => void resolve(comment.id, comment.resolved ? 'reopened' : 'resolved')}
          >
            {comment.resolved ? 'Reopen comment' : 'Resolve comment'}
          </button>
          <button
            type="button"
            disabled={
              busy || Boolean(pending) || disabled || !selection?.runs.length || !journalReady
            }
            onClick={() => void inspect(comment.id)}
          >
            Revalidate selected anchor
          </button>
          {proposed?.commentId === comment.id && (
            <aside aria-label="Reviewed comment anchor">
              <p>
                Proposed quotation: {proposed.anchors.map((anchor) => anchor.sourceText).join('')}
              </p>
              <button
                type="button"
                disabled={busy || disabled || Boolean(pending)}
                onClick={() => void resolve(comment.id, 'reanchored')}
              >
                Apply reviewed anchor
              </button>
            </aside>
          )}
        </article>
      ))}
    </section>
  );
}
