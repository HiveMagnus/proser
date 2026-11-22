'use client';
import { useEffect, useState } from 'react';
import type {
  DocumentDiscussionRecord,
  DocumentProposalRecord,
  DocumentProposalValidationRecord,
  PlotThreadRecord,
  PlotThreadReviewRecord,
} from '@cheftaco/proser-contracts';
import type { usePlotThreadActions } from '@/hooks/use-plot-thread-actions';
import { plotRequest } from '@/lib/plot-thread-api';
import { getDocumentManifest } from '@/lib/document-api';
import { Button } from '@/components/ui/button';
export function PlotThreadRevision({
  userId,
  bookId,
  thread,
  review,
  evidenceId,
  actions,
  onChanged,
}: {
  userId: string;
  bookId: string;
  thread: PlotThreadRecord;
  review: PlotThreadReviewRecord;
  evidenceId: string;
  actions: ReturnType<typeof usePlotThreadActions>;
  onChanged(): void;
}) {
  const { setError } = actions;
  const evidence = review.snapshot.evidence.find((item) => item.id === evidenceId)!;
  const base = `/api/books/${bookId}`;
  const [discussion, setDiscussion] = useState<DocumentDiscussionRecord>();
  const [proposal, setProposal] = useState<DocumentProposalRecord>();
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [instruction, setInstruction] = useState(
    'Strengthen this linked passage so the payoff feels earned. Explain the connection to the story question. Propose one small edit, preserving voice, viewpoint, facts and events. Change at most 600 characters in total.',
  );
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void plotRequest<DocumentDiscussionRecord[]>(
      `${base}/document-discussions?sceneId=${evidence.source.frame.sceneId}`,
      userId,
    )
      .then(async (rows) => {
        const saved = rows.find(
          (row) =>
            row.snapshot.plotThread?.reviewId === review.id &&
            row.snapshot.plotThread.evidenceId === evidenceId,
        );
        if (!saved) return;
        const proposals = await plotRequest<DocumentProposalRecord[]>(
          `${base}/document-discussions/${saved.id}/proposals`,
          userId,
        );
        if (active) {
          setDiscussion(saved);
          setProposal(proposals[0]);
          setSelected(proposals[0]?.result?.output?.edits.map((edit) => edit.targetId) ?? []);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Unable to recover saved proposals.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [base, userId, review.id, evidenceId, evidence.source.frame.sceneId, refresh, setError]);
  const generate = async () => {
    try {
      const frame = evidence.source.frame,
        operationId = crypto.randomUUID();
      const prepared =
        discussion ??
        (await actions.dispatch<DocumentDiscussionRecord>({
          operationId,
          path: `${base}/document-discussions`,
          method: 'POST',
          kind: 'discussion',
          body: {
            schemaVersion: 1,
            operationId,
            sessionId: crypto.randomUUID(),
            sceneId: frame.sceneId,
            expectedRevisionId: review.snapshot.bookRevisionId,
            expectedSceneRevisionId: frame.sceneRevisionId,
            expectedContentHash: frame.sceneContentHash,
            projection: 'final',
            targets: evidence.source.targets.map(({ blockId, from, to, sourceText }) => ({
              blockId,
              from,
              to,
              sourceText,
            })),
            plotThreadReviewId: review.id,
            plotThreadEvidenceId: evidenceId,
          },
          recoveryPath: `${base}/document-discussions/${operationId}`,
        }));
      setDiscussion(prepared);
      // The first dispatch completed and its durable slot is free; yield for React's pending state.
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to prepare the cited passage.');
    }
  };
  const request = async () => {
    if (!discussion) return;
    try {
      const operationId = crypto.randomUUID();
      const saved = await actions.dispatch<DocumentProposalRecord>({
        operationId,
        path: `${base}/document-discussions/${discussion.id}/proposals`,
        method: 'POST',
        kind: 'proposal',
        body: { operationId, instruction },
        recoveryPath: `${base}/document-proposals/${operationId}`,
      });
      setProposal(saved);
      setSelected(saved.result?.output?.edits.map((edit) => edit.targetId) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recover the original proposal request.');
    }
  };
  const apply = async () => {
    if (!proposal) return;
    try {
      const manifest = await getDocumentManifest(bookId);
      const scene = manifest.scenes.find(
        (item) => item.sceneId === evidence.source.frame.sceneId && !item.deletedAt,
      );
      if (!scene) throw new Error('The cited scene is no longer active.');
      const validation = await plotRequest<DocumentProposalValidationRecord>(
        `${base}/document-proposals/${proposal.id}/revalidate`,
        userId,
        'POST',
        {
          operationId: crypto.randomUUID(),
          expectedRevisionId: manifest.revisionId,
          expectedSceneRevisionId: scene.revisionId,
        },
      );
      const operationId = crypto.randomUUID();
      await actions.dispatch({
        operationId,
        path: `${base}/document-proposals/${proposal.id}/apply`,
        method: 'POST',
        kind: 'apply',
        body: {
          operationId,
          expectedRevisionId: manifest.revisionId,
          expectedSceneRevisionId: scene.revisionId,
          validationId: validation.id,
          targetIds: selected,
        },
        recoveryPath: `${base}/document-proposals/${proposal.id}`,
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recover the original application receipt.');
    }
  };
  const blocked =
    actions.blocked || loading || review.stale || thread.version !== review.snapshot.threadVersion;
  return (
    <section
      aria-label="Thread before and after revision"
      className="space-y-3 rounded border border-accent-500 p-4"
    >
      <h3 className="font-semibold">Small revision · {evidence.stage}</h3>
      <p className="text-xs">{evidence.source.label}</p>
      <blockquote className="whitespace-pre-wrap break-words font-serif">
        {evidence.source.text}
      </blockquote>
      <p className="text-sm">
        Uses this saved review and its exact cited passage. Applying creates pending tracked edits
        for inspection in the manuscript.
      </p>
      {loading && <p role="status">Recovering saved proposals…</p>}
      <Button type="button" variant="ghost" onClick={() => setRefresh((n) => n + 1)}>
        Refresh saved proposal
      </Button>
      <label className="block">
        Revision instruction
        <textarea
          aria-label="Revision instruction"
          className="mt-1 w-full rounded border bg-surface-raised p-2"
          value={instruction}
          maxLength={8000}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={blocked}
        />
      </label>
      {!discussion ? (
        <Button type="button" disabled={blocked} onClick={() => void generate()}>
          Prepare cited passage
        </Button>
      ) : !proposal ? (
        <Button
          type="button"
          disabled={blocked || !instruction.trim()}
          onClick={() => void request()}
        >
          Request small revision
        </Button>
      ) : (
        <>
          <p className="text-sm">Saved proposal: {proposal.status}</p>
          {proposal.errorCode && <p role="alert">{proposal.errorCode}</p>}
          {proposal.status === 'failed' &&
            ['completed', 'not-started'].includes(proposal.providerOutcome) && (
              <Button
                type="button"
                disabled={blocked || !instruction.trim()}
                onClick={() => void request()}
              >
                Request another small revision
              </Button>
            )}
          <p className="whitespace-pre-wrap break-words">{proposal.result?.output?.reply}</p>
          {proposal.result?.output?.edits.map((edit) => (
            <label key={edit.targetId} className="block space-y-2 rounded border p-3">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.includes(edit.targetId)}
                  disabled={blocked || proposal.status !== 'ready'}
                  onChange={(e) =>
                    setSelected((rows) =>
                      e.target.checked
                        ? [...rows, edit.targetId]
                        : rows.filter((id) => id !== edit.targetId),
                    )
                  }
                />
                Include this proposed edit
              </span>
              <span className="block text-sm">Before</span>
              <del className="block whitespace-pre-wrap break-words text-danger">
                {edit.sourceText}
              </del>
              <span className="block text-sm">After</span>
              <ins className="block whitespace-pre-wrap break-words text-success no-underline">
                {edit.replacement}
              </ins>
            </label>
          ))}
          <Button
            type="button"
            disabled={blocked || proposal.status !== 'ready' || !selected.length}
            onClick={() => void apply()}
          >
            Revalidate and apply selected edits
          </Button>
          {['pending', 'running', 'unknown'].includes(proposal.status) && (
            <p>
              Recover this original proposal. An uncertain provider outcome cannot be rerun
              automatically.
            </p>
          )}
        </>
      )}
      <a
        className="inline-flex min-h-11 items-center text-accent-400 underline"
        href={`/manuscript?bookId=${bookId}&sceneId=${evidence.source.frame.sceneId}&threadId=${thread.id}&evidenceId=${evidenceId}`}
      >
        Inspect passage in manuscript
      </a>
    </section>
  );
}
