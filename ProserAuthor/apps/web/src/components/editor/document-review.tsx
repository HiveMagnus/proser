'use client';
import { useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import type {
  DocumentTraceReview,
  DocumentTraceDisplayTarget,
  DocumentCompareReceipt,
} from '@hivemagnus/proser-contracts';
import { Button } from '@/components/ui/button';
import {
  getDocumentTraceReview,
  revalidateDocumentCompare,
  recordDocumentCompare,
  recoverDocumentCompare,
  cancelDocumentAnalysis,
  DocumentRequestError,
} from '@/lib/document-api';
import {
  readDocumentCompareIntent,
  writeDocumentCompareIntent,
  deleteDocumentCompareIntent,
  type DocumentCompareIntent,
} from '@/lib/document-review-journal';

type ReviewProps = {
  bookId: string;
  sceneId: string;
  editor: {
    flush(): Promise<{ bookRevisionId: string; revisionId: string }>;
    reloadAcknowledged(receipt: DocumentCompareReceipt): Promise<unknown>;
  };
  onNavigateTarget?: (target: DocumentTraceDisplayTarget) => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
};
export function DocumentReview(props: ReviewProps) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return userId ? (
    <OwnedDocumentReview
      key={JSON.stringify([userId, props.bookId, props.sceneId])}
      {...props}
      userId={userId}
    />
  ) : null;
}
function OwnedDocumentReview({
  bookId,
  sceneId,
  editor,
  onPendingChange,
  disabled,
  userId,
  onNavigateTarget,
}: ReviewProps & { userId: string }) {
  const [review, setReview] = useState<DocumentTraceReview | null>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<DocumentCompareIntent>();
  const [retryAllowed, setRetryAllowed] = useState(false);
  const [journalReady, setJournalReady] = useState(false);
  const mounted = useRef(true);
  const report = (failure: unknown) => {
    if (mounted.current)
      setError(
        failure instanceof Error ? failure.message : 'Unable to complete this review action.',
      );
  };
  const refresh = async () => {
    const row = await getDocumentTraceReview(bookId, sceneId);
    if (mounted.current) setReview(row);
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void getDocumentTraceReview(bookId, sceneId, controller.signal)
      .then((row) => {
        if (mounted.current) setReview(row);
      })
      .catch(report);
    if (userId)
      void readDocumentCompareIntent(userId, bookId, sceneId)
        .then((row) => {
          if (mounted.current) {
            setPending(row);
            setJournalReady(true);
          }
        })
        .catch(report);
    return () => {
      mounted.current = false;
      controller.abort();
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
  const finish = async (intent: DocumentCompareIntent, receipt: DocumentCompareReceipt) => {
    const request = intent.request;
    if (
      receipt.kind !== 'catalog' ||
      receipt.status !== 'completed' ||
      receipt.operationId !== request.operationId ||
      receipt.result.traceId !== request.traceId ||
      receipt.result.compareCardId !== request.compareCardId ||
      receipt.result.sourceBookRevisionId !== request.expectedRevisionId ||
      receipt.result.sourceSceneRevisionId !== request.expectedSceneRevisionId ||
      'scenes' in receipt
    )
      throw new Error(
        'Factory returned an incompatible compare receipt. Recover the original operation.',
      );
    if (!mounted.current) return;
    await editor.reloadAcknowledged(receipt);
    await deleteDocumentCompareIntent(intent.userId, bookId, sceneId, intent.request.operationId);
    if (!mounted.current) return;
    setPending(undefined);
    setRetryAllowed(false);
    await refresh();
  };
  const choose = async (cardId: number, chosen: 'a' | 'b', applyChosen: boolean) => {
    if (disabled || !review || !userId || busy || pending || !journalReady) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await editor.flush();
      if (!mounted.current) return;
      const validation = applyChosen
        ? await revalidateDocumentCompare(bookId, review.traceId, cardId, {
            operationId: crypto.randomUUID(),
            expectedRevisionId: saved.bookRevisionId,
            expectedSceneRevisionId: saved.revisionId,
          })
        : undefined;
      if (!mounted.current) return;
      const intent: DocumentCompareIntent = {
        schemaVersion: 1,
        userId,
        bookId,
        sceneId,
        updatedAt: Date.now(),
        request: {
          operationId: crypto.randomUUID(),
          expectedRevisionId: saved.bookRevisionId,
          expectedSceneRevisionId: saved.revisionId,
          traceId: review.traceId,
          compareCardId: cardId,
          chosen,
          applyChosen,
          ...(validation ? { validationId: validation.id } : {}),
        },
      };
      // Persist exact request before dispatch. A browser crash or lost response
      // must recover this receipt rather than creating another operation.
      await writeDocumentCompareIntent(intent);
      if (!mounted.current) return;
      setPending(intent);
      setRetryAllowed(false);
      const acknowledgement = await recordDocumentCompare(bookId, sceneId, intent.request);
      await finish(intent, acknowledgement.documentReceipt);
    } catch (failure) {
      report(failure);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const recover = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(undefined);
    setRetryAllowed(false);
    try {
      const receipt = await recoverDocumentCompare(bookId, pending.request.operationId);
      await finish(pending, receipt);
    } catch (failure) {
      if (mounted.current && failure instanceof DocumentRequestError && failure.status === 404) {
        setRetryAllowed(true);
        setError(
          'Factory has no committed receipt. You can retry this exact guarded request or discard it.',
        );
      } else report(failure);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const retry = async () => {
    if (!pending || !retryAllowed || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const acknowledgement = await recordDocumentCompare(bookId, sceneId, pending.request);
      await finish(pending, acknowledgement.documentReceipt);
    } catch (failure) {
      report(failure);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      aria-label="Manuscript findings and compare choices"
      className="space-y-3 rounded border border-border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Findings and choices</h2>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void refresh().catch(report)}
        >
          Refresh findings
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {pending && (
        <div className="space-y-2 rounded border p-2">
          <p>An unacknowledged review choice is retained for this scene.</p>
          <code className="break-all text-xs">{pending.request.operationId}</code>
          <Button disabled={busy} onClick={() => void recover()}>
            Recover choice
          </Button>
          {retryAllowed && (
            <Button disabled={busy} onClick={() => void retry()}>
              Retry exact choice
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              void deleteDocumentCompareIntent(
                pending.userId,
                bookId,
                sceneId,
                pending.request.operationId,
              )
                .then(() => {
                  if (mounted.current) {
                    setPending(undefined);
                    setRetryAllowed(false);
                  }
                })
                .catch(report);
            }}
          >
            Discard retained choice
          </Button>
        </div>
      )}
      {review === undefined ? (
        <p>Loading saved findings…</p>
      ) : !review ? (
        <p>No saved analysis for this scene.</p>
      ) : (
        <>
          {review.summary && <p>{review.summary.summary}</p>}
          {review.status !== 'completed' && (
            <p>
              {review.status === 'unbound'
                ? 'Refresh analysis to connect findings to this revision.'
                : review.status === 'pending'
                  ? 'Analysis is queued.'
                  : review.status === 'running'
                    ? 'Analyzing this scene…'
                    : `Analysis ${review.status}.`}{' '}
              {review.analysisId && <code className="break-all text-xs">{review.analysisId}</code>}
            </p>
          )}
          {review.analysisId && ['pending', 'running'].includes(review.status) && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void cancelDocumentAnalysis(bookId, review.analysisId!).then(refresh).catch(report);
              }}
            >
              Cancel analysis
            </Button>
          )}
          {review.findings.map((finding) => (
            <article key={finding.id} className="rounded border p-2">
              <h3 className="font-medium">{finding.title ?? finding.severity}</h3>
              <p>{finding.message}</p>
              {finding.suggestion && <p>{finding.suggestion}</p>}
              {finding.state === 'bound' && finding.target && onNavigateTarget && (
                <Button
                  disabled={busy || !!pending || disabled}
                  variant="secondary"
                  size="sm"
                  onClick={() => void onNavigateTarget(finding.target!).catch(report)}
                >
                  Open exact finding target
                </Button>
              )}
              <p className="text-xs">
                {finding.state === 'bound'
                  ? 'Attached to saved text'
                  : finding.state === 'stale'
                    ? 'Target changed · prepare a new proposal'
                    : finding.state === 'review-blocked'
                      ? 'Resolve pending review changes first'
                      : 'No verified manuscript target'}
              </p>
            </article>
          ))}
          {review.compareCards.map((card) => (
            <article key={card.id} className="space-y-2 rounded border p-2">
              <h3 className="font-medium">{card.title}</h3>
              <p>{card.message}</p>
              {card.state === 'bound' && card.target && onNavigateTarget && (
                <Button
                  disabled={busy || !!pending || disabled}
                  variant="secondary"
                  size="sm"
                  onClick={() => void onNavigateTarget(card.target!).catch(report)}
                >
                  Open exact choice target
                </Button>
              )}
              <p className="text-xs">
                {card.status} · {card.state}
              </p>
              {(['a', 'b'] as const).map((chosen) => (
                <div key={chosen} className="space-y-1">
                  <p className="font-medium">
                    {chosen === 'a' ? card.optionALabel : card.optionBLabel}
                  </p>
                  <p className="whitespace-pre-wrap">
                    {chosen === 'a' ? card.optionAText : card.optionBText}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={
                        disabled || busy || !!pending || !journalReady || card.status !== 'open'
                      }
                      onClick={() => void choose(card.id, chosen, false)}
                    >
                      Record {chosen.toUpperCase()} preference
                    </Button>
                    <Button
                      size="sm"
                      disabled={
                        disabled ||
                        busy ||
                        !!pending ||
                        !journalReady ||
                        card.status !== 'open' ||
                        card.state !== 'bound'
                      }
                      onClick={() => void choose(card.id, chosen, true)}
                    >
                      Revalidate and apply {chosen.toUpperCase()}
                    </Button>
                  </div>
                </div>
              ))}
            </article>
          ))}
          <p className="text-xs text-muted-foreground">
            Applied edits remain tracked changes. Accepting changes and approving publication are
            separate actions.
          </p>
        </>
      )}
    </section>
  );
}
