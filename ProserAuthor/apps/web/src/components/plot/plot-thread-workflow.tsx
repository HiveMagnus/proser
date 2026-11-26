'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useProtectedRouter } from '@/hooks/use-protected-router';
import type {
  PlotThreadRecord,
  PlotThreadSummary,
  PlotThreadStage,
  PlotThreadAssessment,
  PlotThreadReviewRecord,
} from '@hivemagnus/proser-contracts';
import { useWorkspace } from '@/contexts/workspace-context';
import { useBooks } from '@/hooks/queries/use-books';
import { usePlotThreadActions } from '@/hooks/use-plot-thread-actions';
import { listThreads, readThread, readThreadReview, plotThreadBase } from '@/lib/plot-thread-api';
import { registerDocumentNavigationFence } from '@/lib/document-history-navigation';
import { getDocumentManifest } from '@/lib/document-api';
import { Button } from '@/components/ui/button';
import { PlotThreadEvidencePicker } from './plot-thread-evidence-picker';
import { PlotThreadRecovery } from './plot-thread-recovery';
import { PlotThreadRevision } from './plot-thread-revision';

export function PlotThreadWorkflow({ mobile = false }: { mobile?: boolean }) {
  const { data: session } = useSession();
  const { activeBookId, setActiveBookId } = useWorkspace();
  const { data: books = [] } = useBooks();
  const query = useSearchParams(),
    router = useProtectedRouter();
  const [formDirty, setFormDirty] = useState(false);
  const bookId = query.get('bookId') ?? activeBookId;
  const userId = session?.user?.id;
  return (
    <section aria-label="Plot threads workflow" className="space-y-4">
      <label className="block text-sm">
        Manuscript
        <select
          aria-label="Plot threads manuscript"
          disabled={formDirty}
          className="ml-2 max-w-full rounded border bg-surface-raised p-2"
          value={bookId ?? ''}
          onChange={(e) => {
            setActiveBookId(e.target.value);
            router.replace(
              `${mobile ? '/m/plot' : '/plot'}?bookId=${encodeURIComponent(e.target.value)}&tab=threads`,
            );
          }}
        >
          <option value="">Choose a manuscript</option>
          {bookId && !books.some((b) => b.id === bookId) && (
            <option value={bookId}>Selected manuscript</option>
          )}
          {books.map((book) => (
            <option key={book.id} value={book.id}>
              {book.title}
            </option>
          ))}
        </select>
      </label>
      {!bookId ? (
        <p>Select a book to create and inspect plot threads.</p>
      ) : !userId ? (
        <p role="status">Loading author session…</p>
      ) : (
        <ThreadWorkspace
          key={`${userId}:${bookId}`}
          userId={userId}
          bookId={bookId}
          mobile={mobile}
          requestedThread={query.get('threadId')}
          onDirtyChange={setFormDirty}
        />
      )}
    </section>
  );
}
function ThreadWorkspace({
  userId,
  bookId,
  mobile,
  requestedThread,
  onDirtyChange,
}: {
  userId: string;
  bookId: string;
  mobile: boolean;
  requestedThread: string | null;
  onDirtyChange(dirty: boolean): void;
}) {
  const [threads, setThreads] = useState<PlotThreadSummary[]>([]),
    [selected, setSelected] = useState<PlotThreadRecord>();
  const [threadId, setThreadId] = useState<number | undefined>(
    requestedThread ? Number(requestedThread) : undefined,
  );
  const [archived, setArchived] = useState(false),
    [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false),
    [question, setQuestion] = useState(''),
    [description, setDescription] = useState(''),
    [notes, setNotes] = useState('');
  const [status, setStatus] = useState<PlotThreadRecord['status']>('open');
  const [linking, setLinking] = useState<{ stage: PlotThreadStage; replacesEvidenceId?: string }>();
  const [revisionTarget, setRevisionTarget] = useState<{
    review: PlotThreadReviewRecord;
    evidenceId: string;
  }>();
  const [refresh, setRefresh] = useState(0);
  const actions = usePlotThreadActions(userId, bookId);
  const [assessmentDrafts, setAssessmentDrafts] = useState<Record<string, boolean>>({});
  const assessmentDirty = Object.values(assessmentDrafts).some(Boolean);
  const reportAssessmentDirty = useCallback((reviewId: string, value: boolean) => {
    setAssessmentDrafts((previous) =>
      previous[reviewId] === value ? previous : { ...previous, [reviewId]: value },
    );
  }, []);
  const metadataDirty = creating
    ? Boolean(question || description || notes)
    : Boolean(
        selected &&
        (question !== (selected.question ?? selected.description ?? selected.threadKey) ||
          description !== (selected.description ?? '') ||
          notes !== (selected.notes ?? '') ||
          status !== selected.status),
      );
  const dirty = metadataDirty || assessmentDirty;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const { setError: reportNavigation } = actions;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(
    () =>
      registerDocumentNavigationFence({
        dirty: () => dirtyRef.current,
        blocked: () => reportNavigation('Save or discard your thread changes before leaving.'),
      }),
    [reportNavigation],
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(() => {
    setThreadId(requestedThread ? Number(requestedThread) : undefined);
  }, [requestedThread]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setSelected(undefined);
    void Promise.all([
      listThreads(bookId, userId, archived),
      threadId ? readThread(bookId, userId, threadId) : Promise.resolve(undefined),
    ])
      .then(([list, detail]) => {
        if (!active) return;
        setThreads(list.threads);
        setNext(list.next);
        setSelected(detail);
        if (detail) {
          setQuestion(detail.question ?? detail.description ?? detail.threadKey);
          setDescription(detail.description ?? '');
          setNotes(detail.notes ?? '');
          setStatus(detail.status);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Unable to load threads.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bookId, userId, threadId, archived, refresh]);
  const mutation = async (
    path: string,
    body: Record<string, unknown>,
    method: 'POST' | 'PATCH' = 'POST',
  ) => {
    const operationId = crypto.randomUUID();
    const receipt = await actions.dispatch<{ threadId: number }>({
      path,
      method,
      body: { ...body, operationId },
      operationId,
      kind: 'mutation',
      recoveryPath: `${plotThreadBase(bookId)}/operations/${operationId}`,
    });
    setCreating(false);
    setThreadId(receipt.threadId);
    reload();
  };
  const report = (e: unknown) =>
    actions.setError(e instanceof Error ? e.message : 'Unable to complete thread action.');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">
          Follow narrative promises from setup to payoff.
        </p>
        <Button
          type="button"
          disabled={actions.blocked || dirty}
          onClick={() => {
            setCreating(true);
            setSelected(undefined);
            setThreadId(undefined);
            setQuestion('');
            setDescription('');
            setNotes('');
            setLinking(undefined);
            setRevisionTarget(undefined);
          }}
        >
          New Thread
        </Button>
      </div>
      <PlotThreadRecovery
        actions={actions}
        onRecovered={({ intent, result }) => {
          if (intent.kind === 'mutation' && result.threadId) {
            setCreating(false);
            setThreadId(result.threadId);
            setLinking(undefined);
          }
          reload();
        }}
      />
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading plot threads…</p>}
      <Button type="button" variant="ghost" disabled={dirty || actions.blocked} onClick={reload}>
        Refresh threads
      </Button>
      {creating && (
        <form
          aria-label="Create plot thread"
          className="space-y-3 rounded border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void mutation(plotThreadBase(bookId), {
              expectedVersion: 0,
              question,
              description,
              notes,
            }).catch(report);
          }}
        >
          <ThreadFields
            question={question}
            setQuestion={setQuestion}
            description={description}
            setDescription={setDescription}
            notes={notes}
            setNotes={setNotes}
            disabled={actions.blocked}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={actions.blocked || !question.trim()}>
              Create thread
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={actions.busy}
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {!creating && !selected && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => {
                setArchived(e.target.checked);
                setThreadId(undefined);
              }}
            />
            Show archived threads
          </label>
          {!loading && !error && !threads.length && (
            <p>No plot threads. Create a story question to begin.</p>
          )}
          {threads.map((t) => (
            <article
              key={t.id}
              className="space-y-2 rounded border border-border-muted bg-surface-raised p-4"
            >
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start whitespace-normal break-words text-left"
                onClick={() => {
                  setThreadId(t.id);
                  setLinking(undefined);
                  setRevisionTarget(undefined);
                }}
              >
                {t.question ?? t.description ?? t.threadKey}
              </Button>
              <p className="text-xs text-text-muted">
                {t.status} · Setup {t.coverage.setup} · Escalation {t.coverage.escalation} · Payoff{' '}
                {t.coverage.payoff}
              </p>
              {t.checks.map((check) => (
                <p key={check} className="text-sm text-warning">
                  {check}
                </p>
              ))}
            </article>
          ))}
          {next && (
            <Button
              type="button"
              onClick={() =>
                void listThreads(bookId, userId, archived, next)
                  .then((list) => {
                    setThreads((rows) => [...rows, ...list.threads]);
                    setNext(list.next);
                  })
                  .catch(report)
              }
            >
              Load more threads
            </Button>
          )}
        </>
      )}
      {selected && !creating && (
        <article
          aria-label="Plot thread detail"
          className="space-y-5 rounded border border-border-muted p-4"
        >
          <Button
            type="button"
            variant="ghost"
            disabled={dirty || actions.busy}
            onClick={() => {
              setThreadId(undefined);
              setSelected(undefined);
              setLinking(undefined);
              setRevisionTarget(undefined);
            }}
          >
            Back to threads
          </Button>
          <form
            aria-label="Edit plot thread"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void mutation(
                `${plotThreadBase(bookId)}/${selected.id}`,
                { expectedVersion: selected.version, question, description, notes, status },
                'PATCH',
              ).catch(report);
            }}
          >
            <ThreadFields
              question={question}
              setQuestion={setQuestion}
              description={description}
              setDescription={setDescription}
              notes={notes}
              setNotes={setNotes}
              disabled={actions.blocked || assessmentDirty}
            />
            <label className="block">
              Status
              <select
                aria-label="Thread status"
                className="ml-2 rounded border bg-surface-raised p-2"
                value={status}
                disabled={actions.blocked || assessmentDirty}
                onChange={(e) => setStatus(e.target.value as PlotThreadRecord['status'])}
              >
                {['open', 'escalated', 'resolved', 'abandoned'].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={actions.blocked || assessmentDirty || !question.trim()}
              >
                Save thread changes
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={actions.blocked || assessmentDirty}
                onClick={() =>
                  void mutation(
                    `${plotThreadBase(bookId)}/${selected.id}`,
                    {
                      expectedVersion: selected.version,
                      question,
                      description,
                      notes,
                      status,
                      archived: !selected.archivedAt,
                    },
                    'PATCH',
                  ).catch(report)
                }
              >
                {selected.archivedAt ? 'Restore thread' : 'Archive thread'}
              </Button>
              {metadataDirty && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={actions.blocked}
                  onClick={() => {
                    setQuestion(selected.question ?? selected.description ?? selected.threadKey);
                    setDescription(selected.description ?? '');
                    setNotes(selected.notes ?? '');
                    setStatus(selected.status);
                  }}
                >
                  Discard unsaved thread changes
                </Button>
              )}
            </div>
          </form>
          {dirty && (
            <p role="status">
              Save your thread changes before linking evidence or reviewing payoff.
            </p>
          )}
          <section aria-label="Linked evidence checks" className="space-y-1 text-sm">
            {selected.checks.length ? (
              selected.checks.map((check) => (
                <p key={check} className="text-warning">
                  {check}
                </p>
              ))
            ) : (
              <p>All three stages have linked evidence. Review their narrative connection.</p>
            )}
          </section>
          {(['setup', 'escalation', 'payoff'] as const).map((stage) => (
            <section key={stage} aria-label={`${stage} evidence`} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold capitalize">{stage}</h3>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={actions.blocked || dirty || !!selected.archivedAt}
                  onClick={() => setLinking({ stage })}
                >
                  Link {stage}
                </Button>
              </div>
              {selected.evidence
                .filter((e) => e.stage === stage)
                .map((evidence) => (
                  <div key={evidence.id} className="space-y-2 rounded border bg-surface-sunken p-3">
                    <p className="text-xs text-text-secondary">{evidence.source.label}</p>
                    <blockquote className="whitespace-pre-wrap break-words font-serif leading-7">
                      {evidence.source.text}
                    </blockquote>
                    {evidence.stale && (
                      <p className="text-warning">
                        This excerpt changed or its source is unavailable. The saved quotation
                        remains here.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {!evidence.stale && (
                        <a
                          className="inline-flex min-h-11 items-center text-sm text-accent-400 underline"
                          href={`${mobile ? '/m/studio' : '/manuscript'}?bookId=${bookId}&sceneId=${evidence.source.frame.sceneId}&threadId=${selected.id}&evidenceId=${evidence.id}`}
                        >
                          Open exact excerpt
                        </a>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={actions.blocked || dirty || !!selected.archivedAt}
                        onClick={() => setLinking({ stage, replacesEvidenceId: evidence.id })}
                      >
                        Replace excerpt
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={actions.blocked || dirty}
                        onClick={() =>
                          void mutation(
                            `${plotThreadBase(bookId)}/${selected.id}/evidence/${evidence.id}/remove`,
                            { expectedVersion: selected.version },
                          ).catch(report)
                        }
                      >
                        Remove link
                      </Button>
                    </div>
                  </div>
                ))}
            </section>
          ))}
          {linking && (
            <PlotThreadEvidencePicker
              key={`${linking.stage}:${linking.replacesEvidenceId ?? ''}`}
              bookId={bookId}
              userId={userId}
              stage={linking.stage}
              disabled={actions.blocked || dirty}
              onCancel={() => setLinking(undefined)}
              onAdd={async (input) => {
                await mutation(`${plotThreadBase(bookId)}/${selected.id}/evidence`, {
                  ...input,
                  expectedVersion: selected.version,
                  ...(linking.replacesEvidenceId
                    ? { replacesEvidenceId: linking.replacesEvidenceId }
                    : {}),
                });
                setLinking(undefined);
              }}
            />
          )}
          <section aria-label="Payoff review" className="space-y-4 border-t pt-4">
            <h3 className="font-semibold">Does the payoff feel earned?</h3>
            <p className="text-sm text-text-secondary">
              AI reviews only these linked excerpts. Its opinion stays separate from your assessment
              and thread status.
            </p>
            <Button
              type="button"
              disabled={
                actions.blocked ||
                dirty ||
                !!selected.archivedAt ||
                !selected.evidence.length ||
                selected.reviews.some(
                  (review) =>
                    !review.stale && ['pending', 'running', 'unknown'].includes(review.status),
                ) ||
                selected.evidence.some((e) => e.stale)
              }
              onClick={() =>
                void (async () => {
                  const manifest = await getDocumentManifest(bookId),
                    operationId = crypto.randomUUID();
                  await actions.dispatch({
                    path: `${plotThreadBase(bookId)}/${selected.id}/reviews`,
                    method: 'POST',
                    operationId,
                    kind: 'review',
                    body: {
                      operationId,
                      expectedVersion: selected.version,
                      expectedRevisionId: manifest.revisionId,
                    },
                    recoveryPath: `${plotThreadBase(bookId)}/${selected.id}/reviews/${operationId}`,
                  });
                  reload();
                })().catch(report)
              }
            >
              {actions.busy ? 'Working…' : 'Review payoff'}
            </Button>
            {selected.reviews.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                disabled={
                  actions.blocked ||
                  metadataDirty ||
                  Object.entries(assessmentDrafts).some(
                    ([id, changed]) => changed && id !== review.id,
                  )
                }
                onDirtyChange={reportAssessmentDirty}
                onRecover={() =>
                  readThreadReview(bookId, userId, selected.id, review.id).then(() => reload())
                }
                onAssess={(assessment, reviewNotes) =>
                  mutation(
                    `${plotThreadBase(bookId)}/${selected.id}/reviews/${review.id}/assessment`,
                    { expectedVersion: selected.version, assessment, notes: reviewNotes },
                  )
                }
                onRevise={(evidenceId) => setRevisionTarget({ review, evidenceId })}
              />
            ))}
          </section>
          {revisionTarget && (
            <PlotThreadRevision
              key={`${revisionTarget.review.id}:${revisionTarget.evidenceId}`}
              userId={userId}
              bookId={bookId}
              thread={selected}
              review={
                selected.reviews.find((review) => review.id === revisionTarget.review.id) ?? {
                  ...revisionTarget.review,
                  stale: true,
                }
              }
              evidenceId={revisionTarget.evidenceId}
              actions={{ ...actions, blocked: actions.blocked || dirty }}
              onChanged={reload}
            />
          )}
        </article>
      )}
    </div>
  );
}
function ThreadFields({
  question,
  setQuestion,
  description,
  setDescription,
  notes,
  setNotes,
  disabled,
}: {
  question: string;
  setQuestion(v: string): void;
  description: string;
  setDescription(v: string): void;
  notes: string;
  setNotes(v: string): void;
  disabled: boolean;
}) {
  return (
    <>
      <label className="block space-y-1">
        Story question
        <input
          aria-label="Story question"
          className="w-full rounded border bg-surface-raised p-2"
          required
          maxLength={1000}
          placeholder="Will the apprentice discover who betrayed her?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={disabled}
        />
      </label>
      <label className="block space-y-1">
        Description
        <textarea
          aria-label="Description"
          className="w-full rounded border bg-surface-raised p-2"
          maxLength={4000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={disabled}
        />
      </label>
      <label className="block space-y-1">
        Thread notes
        <textarea
          aria-label="Thread notes"
          className="w-full rounded border bg-surface-raised p-2"
          maxLength={8000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={disabled}
        />
      </label>
    </>
  );
}
function ReviewCard({
  review,
  disabled,
  onAssess,
  onRevise,
  onRecover,
  onDirtyChange,
}: {
  review: PlotThreadReviewRecord;
  disabled: boolean;
  onAssess(assessment: PlotThreadAssessment, notes: string): Promise<void>;
  onRevise(evidenceId: string): void;
  onRecover(): Promise<void>;
  onDirtyChange(reviewId: string, dirty: boolean): void;
}) {
  const [assessment, setAssessment] = useState<PlotThreadAssessment>(
      review.assessment ?? 'insufficient-evidence',
    ),
    [notes, setNotes] = useState(review.notes ?? ''),
    [error, setError] = useState<string>();
  const output = review.result?.output;
  const dirty =
    assessment !== (review.assessment ?? 'insufficient-evidence') || notes !== (review.notes ?? '');
  useEffect(() => {
    onDirtyChange(review.id, dirty);
    return () => onDirtyChange(review.id, false);
  }, [review.id, dirty, onDirtyChange]);
  return (
    <article
      aria-label="Saved payoff review"
      className="space-y-3 rounded border bg-surface-raised p-3"
    >
      <p className="text-xs text-text-secondary">
        {new Date(review.createdAt).toLocaleString()} · {review.status} ·{' '}
        {review.snapshot.evidence.length} linked excerpts reviewed
      </p>
      {review.stale && (
        <p className="text-warning">
          This saved review uses earlier thread or manuscript inputs. Refresh the evidence and
          review before applying revisions.
        </p>
      )}
      {review.errorCode && (
        <p role="alert">
          {review.errorCode}.{' '}
          {review.status === 'failed'
            ? 'This review failed; its result is retained. No prose changed.'
            : 'Recover this original operation. An unknown outcome does not authorize another provider call.'}
        </p>
      )}
      {['pending', 'running', 'unknown'].includes(review.status) && (
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || dirty}
          onClick={() => void onRecover().catch((e) => setError(String(e)))}
        >
          Recover saved review
        </Button>
      )}
      {output && (
        <>
          <p>
            <strong>AI assessment: {output.assessment.replaceAll('-', ' ')}</strong>
          </p>
          <p className="whitespace-pre-wrap break-words">{output.summary}</p>
          {output.findings.map((finding, i) => (
            <section key={i} className="space-y-2 border-t pt-2">
              <h4 className="font-medium capitalize">{finding.aspect}</h4>
              <p className="break-words">{finding.explanation}</p>
              {finding.citations.map((citation, j) => {
                const evidence = review.snapshot.evidence.find(
                  (e) => e.id === citation.evidenceId,
                )!;
                return (
                  <div key={j}>
                    <p className="text-xs text-text-secondary">
                      {evidence?.stage} · {evidence?.source.label}
                    </p>
                    <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-3">
                      {citation.quote}
                    </blockquote>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={disabled || dirty || review.stale}
                      onClick={() => onRevise(citation.evidenceId)}
                    >
                      Offer a small revision
                    </Button>
                    {review.stale && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={disabled || dirty}
                        onClick={() => onRevise(citation.evidenceId)}
                      >
                        Inspect saved revisions
                      </Button>
                    )}
                  </div>
                );
              })}
              <p className="text-sm">{finding.suggestion}</p>
            </section>
          ))}
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void onAssess(assessment, notes).catch((e) =>
                setError(e instanceof Error ? e.message : 'Unable to save assessment.'),
              );
            }}
          >
            <label className="block">
              Your assessment
              <select
                aria-label="Your assessment"
                className="ml-2 rounded border bg-surface-sunken p-2"
                value={assessment}
                disabled={disabled}
                onChange={(e) => setAssessment(e.target.value as PlotThreadAssessment)}
              >
                {['earned', 'weak', 'insufficient-evidence'].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="block">
              Review notes
              <textarea
                aria-label="Review notes"
                className="mt-1 w-full rounded border bg-surface-sunken p-2"
                value={notes}
                maxLength={8000}
                disabled={disabled}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            <Button type="submit" disabled={disabled}>
              Save my assessment
            </Button>
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  setAssessment(review.assessment ?? 'insufficient-evidence');
                  setNotes(review.notes ?? '');
                }}
              >
                Discard unsaved assessment
              </Button>
            )}
            {review.assessment && (
              <p className="text-sm">Saved author assessment: {review.assessment}</p>
            )}
            {error && <p role="alert">{error}</p>}
          </form>
        </>
      )}
      <details>
        <summary>Frozen evidence used by this review</summary>
        {review.snapshot.evidence.map((e) => (
          <blockquote key={e.id} className="my-2 whitespace-pre-wrap break-words border-l-2 pl-3">
            {e.stage}: {e.source.text}
          </blockquote>
        ))}
      </details>
    </article>
  );
}
