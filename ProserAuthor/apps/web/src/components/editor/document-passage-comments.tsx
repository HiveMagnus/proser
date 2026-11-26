'use client';
import { useEffect, useRef, useState } from 'react';
import type { DocumentSelection } from '@hivemagnus/proser-editor';
import type {
  DocumentPassageRequest,
  DocumentPassage,
  DocumentPassageReceipt,
  PassageCommentAcknowledgement,
  PassageCommentCommit,
  PassageCommentPage,
  PassageCommentSummary,
} from '@hivemagnus/proser-contracts';
import { qualifyPassageSelection } from '../../../../../packages/editor/src/passage-source';
import { acknowledgedScenePassage, recoverScenePassage } from '@/lib/document-passage-api';
import { commitPassageComment, getPassageComment } from '@/lib/document-passage-comment-api';
import {
  writePassageCommentIntent,
  readPassageCommentIntent,
  deletePassageCommentIntent,
  type PassageCommentIntent,
} from '@/lib/document-passage-comment-journal';
import { Button } from '@/components/ui/button';
interface Props {
  userId: string;
  bookId: string;
  passage: DocumentPassage;
  selection?: DocumentSelection;
  disabled?: boolean;
  flush(): Promise<DocumentPassage>;
  onCommitted(passage: DocumentPassage): Promise<void>;
  onPendingChange?(pending: boolean): void;
  bounds?: Pick<DocumentPassageRequest, 'maxCharacters' | 'maxParagraphs' | 'maxRuns'>;
}
export function DocumentPassageComments(props: Props) {
  return (
    <CommentSession key={`${props.userId}:${props.bookId}:${props.passage.sceneId}`} {...props} />
  );
}
function CommentSession(props: Props) {
  const { userId, bookId, passage, selection, disabled, onPendingChange } = props;
  const sceneId = String(passage.sceneId);
  const inactive = disabled || passage.projection !== 'final';
  const [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false);
  const [pending, setPending] = useState<PassageCommentIntent>(),
    [retryAllowed, setRetryAllowed] = useState(false),
    [error, setError] = useState<string>();
  const [detail, setDetail] = useState<PassageCommentPage>();
  const alive = useRef(true);
  const report = (reason: unknown) => {
    if (alive.current)
      setError(
        reason instanceof Error
          ? reason.message
          : 'Unable to complete the comment action. Recover the original operation.',
      );
  };
  useEffect(() => {
    alive.current = true;
    void readPassageCommentIntent(userId, bookId, sceneId)
      .then((value) => {
        if (alive.current) {
          setPending(value);
          setReady(true);
        }
      })
      .catch(report);
    return () => {
      alive.current = false;
    };
  }, [userId, bookId, sceneId]);
  useEffect(() => {
    onPendingChange?.(busy || !!pending);
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
  const finish = async (
    intent: PassageCommentIntent,
    receipt: DocumentPassageReceipt<PassageCommentAcknowledgement>,
  ) => {
    const result = receipt.result;
    if (
      result.action !== intent.request.action ||
      ('commentId' in intent.request && result.commentId !== intent.request.commentId)
    )
      throw new Error('Comment acknowledgement does not match the retained operation.');
    const current = acknowledgedScenePassage(
      { ...receipt, result: result.passage },
      bookId,
      sceneId,
      intent.request.operationId,
    );
    if (!alive.current) return;
    // The durable Factory receipt is authoritative even if refreshing the current
    // editor fails. Retain it until the editor accepts the acknowledged source.
    await props.onCommitted(current);
    if (!alive.current) return;
    await deletePassageCommentIntent(userId, bookId, sceneId, intent.request.operationId);
    if (alive.current) {
      setPending(undefined);
      setRetryAllowed(false);
      setText('');
      setDetail(undefined);
    }
  };
  const recover = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(undefined);
    setRetryAllowed(false);
    try {
      const receipt = await recoverScenePassage<PassageCommentAcknowledgement>(
        bookId,
        pending.request.operationId,
      );
      if (!alive.current) return;
      if (receipt) await finish(pending, receipt);
      else {
        setRetryAllowed(true);
        setError(
          'Factory has no receipt for this operation. You may retry the exact retained request.',
        );
      }
    } catch (reason) {
      report(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const dispatch = async (intent: PassageCommentIntent) => {
    const receipt = await commitPassageComment(bookId, sceneId, intent.request);
    await finish(intent, receipt);
  };
  const retry = async () => {
    if (!pending || !retryAllowed || busy) return;
    setBusy(true);
    setRetryAllowed(false);
    setError(undefined);
    try {
      await dispatch(pending);
    } catch (reason) {
      report(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const change = async (
    action: PassageCommentCommit['action'],
    summary?: PassageCommentSummary,
  ) => {
    if (inactive || busy || pending || !ready) return;
    setBusy(true);
    setError(undefined);
    try {
      const qualified =
        action === 'create' || action === 'reanchored'
          ? selection
            ? qualifyPassageSelection(passage, selection, {
                bookId: Number(bookId),
                sceneId: passage.sceneId,
              })
            : undefined
          : undefined;
      if ((action === 'create' || action === 'reanchored') && !qualified?.ranges.length)
        throw new Error('Select current manuscript text before anchoring a comment.');
      const saved = await props.flush();
      if (!alive.current) return;
      if (qualified) {
        if (
          saved.sourceFrame?.qualifiedMembershipHash !==
            qualified.sourceFrame.qualifiedMembershipHash ||
          saved.sourceFrame?.effectiveStyleLayoutHash !==
            qualified.sourceFrame.effectiveStyleLayoutHash
        )
          throw new Error(
            'The selection context changed while saving. Select the saved text again.',
          );
        for (const range of qualified.ranges) {
          const original = passage.paragraphs.find((item) => item.paragraph.id === range.blockId);
          const current = saved.paragraphs.find((item) => item.paragraph.id === range.blockId);
          if (
            !current ||
            current.paragraphHash !== original?.paragraphHash ||
            current.containerHash !== original?.containerHash
          )
            throw new Error(
              'The selected paragraph/container changed while saving. Select the saved text again.',
            );
          const source = current.runs.find((run) => run.runId === range.runId);
          if (
            !source ||
            source.sourceHash !== range.sourceHash ||
            range.from < source.from ||
            range.to > source.to
          )
            throw new Error(
              'The selected run changed while saving. Select the saved text again; no guessed anchor was attached.',
            );
        }
      }
      const latest = summary
        ? saved.commentSummaries?.find(
            (item) => item.id === summary.id && item.recordHash === summary.recordHash,
          )
        : undefined;
      if (summary && !latest)
        throw new Error(
          'The comment changed while saving. Reload its current record before reviewing it.',
        );
      const base = {
        schemaVersion: 1 as const,
        operationId: crypto.randomUUID(),
        expectedRevisionId: saved.bookRevisionId,
        expectedSceneRevisionId: saved.sceneRevisionId,
        windowHash: saved.windowHash,
        cursor: saved.cursor,
        reviewOffset: saved.reviewOffset,
        ...(props.bounds ?? { maxCharacters: 8000, maxParagraphs: 24, maxRuns: 256 }),
      };
      const anchors =
        qualified?.ranges.map((range) => ({
          blockId: range.blockId,
          runId: range.runId,
          start: range.from,
          end: range.to,
          sourceText: range.sourceText,
        })) ?? [];
      const request: PassageCommentCommit =
        action === 'create'
          ? { ...base, action, text, anchors }
          : action === 'reanchored'
            ? { ...base, action, commentId: summary!.id, recordHash: summary!.recordHash, anchors }
            : { ...base, action, commentId: summary!.id, recordHash: summary!.recordHash };
      const intent: PassageCommentIntent = {
        schemaVersion: 1,
        userId,
        bookId,
        sceneId,
        request,
        updatedAt: Date.now(),
      };
      await writePassageCommentIntent(intent);
      if (!alive.current) return;
      setPending(intent);
      await dispatch(intent);
    } catch (reason) {
      report(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const inspect = async (summary: PassageCommentSummary, offset = 0) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const value = await getPassageComment(bookId, sceneId, summary.id, {
        bookRevisionId: passage.bookRevisionId,
        expectedSceneRevisionId: passage.sceneRevisionId,
        recordHash: summary.recordHash,
        offset,
        limit: 4,
      });
      if (alive.current) setDetail(value);
    } catch (reason) {
      report(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <aside
      aria-label="Passage comments"
      className="space-y-3 rounded border border-border-muted bg-surface-raised/60 p-4"
    >
      <h2 className="text-lg font-semibold">Comments on this passage</h2>
      <label className="block space-y-1">
        Comment
        <textarea
          aria-label="New passage comment"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={10000}
          disabled={inactive || busy || !!pending}
          className="block min-h-24 w-full rounded border border-border-muted bg-surface-base p-2"
        />
      </label>
      <Button
        onClick={() => void change('create')}
        disabled={
          inactive || busy || !!pending || !ready || !selection?.runs.length || !text.trim()
        }
      >
        Add comment to selected text
      </Button>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Saving and checking the exact comment source…</p>}
      {pending && (
        <div className="space-y-2">
          <p role="status">
            This comment operation remains unacknowledged. Recover its exact saved outcome.
          </p>
          <Button variant="secondary" onClick={() => void recover()} disabled={busy}>
            Recover comment operation
          </Button>
          {retryAllowed && (
            <Button variant="secondary" onClick={() => void retry()} disabled={busy}>
              Retry exact comment request
            </Button>
          )}
        </div>
      )}
      {(passage.commentSummaries ?? []).map((summary) => (
        <article key={summary.id} className="space-y-2 border-t border-border-muted pt-3">
          <p className="whitespace-pre-wrap">{summary.textPreview}</p>
          <p className="text-sm text-text-secondary">
            {summary.authorName} · {summary.resolved ? 'Resolved' : 'Open'} · {summary.anchorCount}{' '}
            anchors{summary.staleAnchorCount ? ` · ${summary.staleAnchorCount} stale anchors` : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => void inspect(summary)} disabled={busy}>
              Inspect comment
            </Button>
            <Button
              variant="secondary"
              onClick={() => void change(summary.resolved ? 'reopened' : 'resolved', summary)}
              disabled={inactive || busy || !!pending}
            >
              {summary.resolved ? 'Reopen comment' : 'Resolve comment'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void change('reanchored', summary)}
              disabled={inactive || busy || !!pending || !selection?.runs.length}
            >
              Attach to selected text
            </Button>
          </div>
        </article>
      ))}
      {detail && (
        <section
          aria-label="Comment anchor details"
          className="space-y-2 border-t border-border-muted pt-3"
        >
          <p className="whitespace-pre-wrap">{detail.text}</p>
          <p>
            {detail.resolutionCount} recorded resolutions · Anchors {detail.offset + 1}–
            {detail.offset + detail.anchors.length} of {detail.total}
          </p>
          {detail.anchors.map((anchor, index) => (
            <p key={`${anchor.blockId}:${anchor.runId}:${index}`} className="whitespace-pre-wrap">
              {anchor.sourceText || '(Caret)'}{' '}
              {
                detail.anchorStates.find((state) => state.anchorIndex === detail.offset + index)
                  ?.reason
              }
            </p>
          ))}
          {detail.nextOffset !== undefined && (
            <Button
              variant="secondary"
              onClick={() => {
                const summary = passage.commentSummaries?.find(
                  (item) => item.id === detail.id && item.recordHash === detail.recordHash,
                );
                if (summary) void inspect(summary, detail.nextOffset);
              }}
              disabled={busy}
            >
              Next anchor page
            </Button>
          )}
        </section>
      )}
    </aside>
  );
}
