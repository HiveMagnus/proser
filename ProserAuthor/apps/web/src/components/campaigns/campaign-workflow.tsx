'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import type {
  CampaignRecord,
  CampaignDetail,
  CampaignPreset,
  CampaignConstraints,
  CampaignPlanRecord,
  CampaignStep,
  DocumentDiscussionRecord,
  DocumentProposalRecord,
  DocumentProposalValidationRecord,
  CampaignVerification,
} from '@hivemagnus/proser-contracts';
import { useWorkspace } from '@/contexts/workspace-context';
import { useBooks } from '@/hooks/queries/use-books';
import { useProtectedRouter } from '@/hooks/use-protected-router';
import { useCampaignActions } from '@/hooks/use-campaign-actions';
import { campaignRequest } from '@/lib/campaign-api';
import { getDocumentManifest } from '@/lib/document-api';
import { registerDocumentNavigationFence } from '@/lib/document-history-navigation';
import { Button } from '@/components/ui/button';
const presets: Record<CampaignPreset, string> = {
  antagonist: 'Strengthen the antagonist',
  'character-arc': 'Repair a character arc',
  pacing: 'Improve pacing',
  theme: 'Develop a theme',
};
export function CampaignWorkflow({ mobile = false }: { mobile?: boolean }) {
  const { data: session } = useSession(),
    { activeBookId, setActiveBookId } = useWorkspace(),
    { data: books = [] } = useBooks();
  const query = useSearchParams(),
    router = useProtectedRouter();
  const bookId = query.get('bookId') ?? activeBookId,
    userId = session?.user?.id;
  const [dirty, setDirty] = useState(false);
  return (
    <section aria-label="Revision campaigns" className="space-y-5">
      <label className="block">
        Manuscript
        <select
          aria-label="Campaign manuscript"
          disabled={dirty}
          className="mt-1 block w-full min-w-0 max-w-full rounded border bg-surface-raised p-2"
          value={bookId ?? ''}
          onChange={(e) => {
            setActiveBookId(e.target.value);
            router.replace(
              `${mobile ? '/m' : ''}/editorial/campaigns?bookId=${encodeURIComponent(e.target.value)}`,
            );
          }}
        >
          <option value="">Choose a manuscript</option>
          {bookId && !books.some((x) => x.id === bookId) && (
            <option value={bookId}>Selected manuscript</option>
          )}
          {books.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </select>
      </label>
      {bookId && userId ? (
        <CampaignWorkspace
          key={`${userId}:${bookId}`}
          userId={userId}
          bookId={bookId}
          mobile={mobile}
          requestedId={query.get('campaignId')}
          onDirty={setDirty}
        />
      ) : (
        <p>Choose a manuscript to start a revision campaign.</p>
      )}
    </section>
  );
}
function CampaignWorkspace({
  userId,
  bookId,
  mobile,
  requestedId,
  onDirty,
}: {
  userId: string;
  bookId: string;
  mobile: boolean;
  requestedId: string | null;
  onDirty(value: boolean): void;
}) {
  const actions = useCampaignActions(userId, bookId),
    router = useProtectedRouter();
  const { setError } = actions;
  const base = `/api/books/${bookId}/revision-campaigns`;
  const [list, setList] = useState<CampaignRecord[]>([]),
    [detail, setDetail] = useState<CampaignDetail>(),
    [id, setId] = useState(requestedId ?? '');
  const [goal, setGoal] = useState(''),
    [preset, setPreset] = useState<CampaignPreset>('antagonist'),
    [constraints, setConstraints] = useState<CampaignConstraints>({ facts: [], voice: [] });
  const [dirty, setDirty] = useState(false),
    [reason, setReason] = useState(''),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const appliedVersion = useRef('');
  const reload = useCallback(() => setRefresh((x) => x + 1), []);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(
    () =>
      registerDocumentNavigationFence({
        dirty: () => dirtyRef.current,
        blocked: () => setError('Save or explicitly discard campaign changes before leaving.'),
      }),
    [setError],
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
  useEffect(() => {
    if (!dirtyRef.current) setId(requestedId ?? '');
  }, [requestedId]);
  const adoptDetail = useCallback((value?: CampaignDetail) => {
    setDetail(value);
    const version = value ? `${value.campaign.id}:${value.campaign.version}` : 'new';
    if (!dirtyRef.current && appliedVersion.current !== version) {
      appliedVersion.current = version;
      setGoal(value?.campaign.goal ?? '');
      setPreset(value?.campaign.preset ?? 'antagonist');
      setConstraints(value?.campaign.constraints ?? { facts: [], voice: [] });
    }
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([
      campaignRequest<CampaignRecord[]>(base, userId),
      id ? campaignRequest<CampaignDetail>(`${base}/${id}`, userId) : Promise.resolve(undefined),
    ])
      .then(([items, value]) => {
        if (!active) return;
        setList(items);
        adoptDetail(value);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Unable to read campaigns.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [adoptDetail, base, userId, id, refresh, setError]);
  const running = detail?.plans.some((x) => ['queued', 'running'].includes(x.workflowStatus));
  useEffect(() => {
    if (!running || !id || dirty || loading || actions.busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(async () => {
        try {
          const value = await campaignRequest<CampaignDetail>(`${base}/${id}`, userId);
          if (active) adoptDetail(value);
        } catch {
          // Keep the last saved state while polling. Explicit refresh surfaces errors.
        } finally {
          if (active) schedule();
        }
      }, 2500);
    };
    schedule();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [actions.busy, adoptDetail, base, dirty, id, loading, refresh, running, userId]);
  const send = async (
    path: string,
    body: Record<string, unknown>,
    method: 'POST' | 'PATCH' = 'POST',
  ) => {
    const operationId = crypto.randomUUID();
    return actions.dispatch<{ campaignId: string; planId?: string; runId?: string }>({
      operationId,
      path,
      method,
      body: { ...body, operationId },
      kind: 'campaign',
      recoveryPath: `${base}/operations/${operationId}`,
    });
  };
  const perform = async (work: () => Promise<unknown>) => {
    setLoading(true);
    try {
      await work();
      reload();
    } catch (e) {
      setLoading(false);
      setError(e instanceof Error ? e.message : 'Recover the original request.');
    }
  };
  const save = () =>
    perform(async () => {
      const receipt = await send(
        id ? `${base}/${id}` : base,
        {
          expectedVersion: detail?.campaign.version ?? 0,
          goal,
          preset,
          constraints,
          confirmed: id ? constraints.facts.length > 0 && constraints.voice.length > 0 : false,
        },
        id ? 'PATCH' : 'POST',
      );
      dirtyRef.current = false;
      setDirty(false);
      setId(receipt.campaignId);
      router.replace(
        `${mobile ? '/m' : ''}/editorial/campaigns?bookId=${bookId}&campaignId=${receipt.campaignId}`,
      );
    });
  const analyze = (mode = 'plan', proposalId?: string, targetIds?: string[]) =>
    perform(async () => {
      const manifest = await getDocumentManifest(bookId);
      return send(`${base}/${id}/analyses`, {
        expectedVersion: detail!.campaign.version,
        expectedRevisionId: manifest.revisionId,
        mode,
        ...(proposalId ? { proposalId, targetIds } : {}),
      });
    });
  const plan = detail?.plans.find((x) => x.analysis);
  const decide = (decision: string, stepId?: string, proposalId?: string, decisionPlan = plan) =>
    perform(async () => {
      const manifest = await getDocumentManifest(bookId);
      return send(`${base}/${id}/plans/${decisionPlan!.id}/decisions`, {
        expectedVersion: detail!.campaign.version,
        expectedRevisionId: manifest.revisionId,
        decision,
        reason,
        ...(stepId ? { stepId } : {}),
        ...(proposalId ? { proposalId } : {}),
      });
    });
  const blocked = actions.blocked || dirty || !!running || loading;
  const select = (value: string) => {
    if (actions.pending) dirtyRef.current = false;
    setId(value);
    setDetail(undefined);
    router.replace(
      `${mobile ? '/m' : ''}/editorial/campaigns?bookId=${bookId}${value ? `&campaignId=${value}` : ''}`,
    );
  };
  return (
    <div className="space-y-5">
      {loading && <p role="status">Updating saved campaign…</p>}
      {actions.error && (
        <p role="alert" className="break-words text-danger">
          {actions.error}
        </p>
      )}
      {actions.pending && (
        <section aria-label="Campaign request recovery" className="space-y-2 rounded border p-3">
          <p>An original request needs recovery before another action.</p>
          <Button
            disabled={actions.busy}
            onClick={() =>
              void actions.recover().then((result) => {
                if (result) {
                  const value = result.result as { campaignId?: string };
                  if (value.campaignId) {
                    setDirty(false);
                    select(value.campaignId);
                  }
                  reload();
                }
              })
            }
          >
            Recover original request
          </Button>
          <Button
            disabled={actions.busy}
            onClick={() =>
              void actions.retry().then((result) => {
                if (result) {
                  const value = result.result as { campaignId?: string };
                  if (value.campaignId) {
                    setDirty(false);
                    select(value.campaignId);
                  }
                  reload();
                }
              })
            }
          >
            Retry identical recorded request
          </Button>
        </section>
      )}
      <div className="flex flex-wrap gap-3">
        <label className="block w-full min-w-0">
          Saved campaign
          <select
            aria-label="Saved campaign"
            disabled={dirty || actions.blocked || loading}
            className="mt-1 block w-full min-w-0 max-w-full rounded border bg-surface-raised p-2"
            value={id}
            onChange={(e) => select(e.target.value)}
          >
            <option value="">New campaign</option>
            {id && !list.some((x) => x.id === id) && <option value={id}>Selected campaign</option>}
            {list.map((x) => (
              <option key={x.id} value={x.id}>
                {x.goal}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={dirty || actions.busy}
          aria-disabled={loading || undefined}
          onClick={() => {
            if (!loading) reload();
          }}
        >
          Refresh saved campaign
        </Button>
      </div>
      <label className="block">
        Starting point
        <select
          aria-label="Campaign starting point"
          className="ml-2 rounded border bg-surface-raised p-2"
          value={preset}
          onChange={(e) => {
            setPreset(e.target.value as CampaignPreset);
            setDirty(true);
          }}
        >
          {Object.entries(presets).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        Revision goal
        <textarea
          aria-label="Revision goal"
          className="mt-1 w-full rounded border bg-surface-raised p-3"
          maxLength={4000}
          value={goal}
          onChange={(e) => {
            setGoal(e.target.value);
            setDirty(true);
          }}
        />
      </label>
      <Button
        disabled={actions.blocked || loading || goal.trim().length < 3}
        onClick={() => void save()}
      >
        {id ? 'Save confirmed protections and goal' : 'Create campaign'}
      </Button>
      {dirty && (
        <Button
          variant="secondary"
          onClick={() => {
            setDirty(false);
            appliedVersion.current = '';
            reload();
          }}
        >
          Discard unsaved campaign changes
        </Button>
      )}
      {detail && (
        <>
          <p role="status">
            {detail.complete
              ? 'Campaign complete'
              : running
                ? 'Reviewing saved manuscript…'
                : detail.campaign.confirmed
                  ? 'Protected facts and voice confirmed. Each prose edit still needs approval.'
                  : 'Scan the manuscript, then confirm protected facts and voice samples.'}
          </p>
          <Button disabled={blocked} onClick={() => void analyze(plan ? 'recheck' : 'plan')}>
            {plan ? 'Refresh plan and re-review evidence' : 'Scan whole manuscript'}
          </Button>
          {detail.plans
            .filter((x) => !['completed'].includes(x.workflowStatus))
            .map((x) => (
              <p key={x.id} role="status">
                Analysis {x.workflowStatus}
                {x.failureReason ? `: ${x.failureReason}` : ''}.{' '}
                <a className="underline" href="/workflows">
                  Open original workflow
                </a>
              </p>
            ))}
          {detail && (
            <details>
              <summary>Saved plan history</summary>
              {detail.plans
                .filter((item) => item.analysis)
                .map((item) => (
                  <details key={item.id} className="my-2 rounded border p-3">
                    <summary>
                      {item.analysis!.summary} · {item.stale ? 'stale' : 'current'}
                    </summary>
                    <p>
                      {item.analysis!.coverage.length} recorded text ranges;{' '}
                      {item.analysis!.gaps.length} coverage gaps.
                    </p>
                    {item.analysis!.steps.map((step) => (
                      <div key={step.id}>
                        <h3>{step.title}</h3>
                        {step.citations.map((citation, index) => (
                          <blockquote className="break-words font-serif" key={index}>
                            {citation.quote}
                          </blockquote>
                        ))}
                      </div>
                    ))}
                  </details>
                ))}
            </details>
          )}
          {plan?.analysis && (
            <section aria-label="Revision plan" className="space-y-4">
              <h2 className="font-semibold">Ordered revision plan</h2>
              <p>{plan.analysis.summary}</p>
              {plan.stale && (
                <p role="alert">
                  This plan is stale. Refresh evidence and approve a new plan before preparing
                  edits.
                </p>
              )}
              <p>
                Reviewed {plan.analysis.coverage.filter((x) => x.status === 'reviewed').length} text
                ranges; {plan.analysis.coverage.filter((x) => x.status === 'empty').length} empty
                scenes.{' '}
                {plan.analysis.complete
                  ? 'Whole-book scan complete.'
                  : 'Coverage incomplete; prose preparation is blocked.'}
              </p>
              {!plan.analysis.complete && (
                <p role="alert" className="break-words text-danger">
                  Coverage incomplete. Plan approval is blocked. {plan.analysis.gaps.join(' ')}
                </p>
              )}
              <details>
                <summary>Coverage and missing evidence</summary>
                {plan.analysis.rechecks?.map((recheck, index) => (
                  <p key={index}>
                    Evidence re-review ({recheck.assessment}): {recheck.explanation}
                  </p>
                ))}
                <ul>
                  {plan.analysis.coverage.map((x, i) => (
                    <li key={i}>
                      Chapter {x.chapterId}, scene {x.sceneId}, {x.from}–{x.to}: {x.status}
                      {x.reason ? ` — ${x.reason}` : ''}
                    </li>
                  ))}
                  {plan.analysis.gaps.map((x, i) => (
                    <li key={`gap-${i}`}>{x}</li>
                  ))}
                </ul>
              </details>
              <section aria-label="Preservation rules" className="space-y-3">
                <h3 className="font-semibold">Confirm facts and voice</h3>
                {(['facts', 'voice'] as const).map((kind) => (
                  <div key={kind}>
                    <h4>{kind === 'facts' ? 'Protected facts' : 'Voice samples'}</h4>
                    {constraints[kind].map((rule, index) => (
                      <label key={index} className="block">
                        {kind === 'facts' ? 'Protected fact' : 'Voice characteristic'} {index + 1}
                        <textarea
                          aria-label={`${kind === 'facts' ? 'Protected fact' : 'Voice characteristic'} ${index + 1}`}
                          className="w-full rounded border bg-surface-raised p-2"
                          value={rule.text}
                          onChange={(e) => {
                            setConstraints((old) => ({
                              ...old,
                              [kind]: old[kind].map((x, i) =>
                                i === index ? { ...x, text: e.target.value } : x,
                              ),
                            }));
                            setDirty(true);
                          }}
                        />
                        <Button
                          variant="secondary"
                          disabled={actions.blocked}
                          onClick={(event) => {
                            event.preventDefault();
                            setConstraints((old) => ({
                              ...old,
                              [kind]: old[kind].filter((_, i) => i !== index),
                            }));
                            setDirty(true);
                          }}
                        >
                          Remove {kind === 'facts' ? 'protected fact' : 'voice sample'} {index + 1}
                        </Button>
                        {rule.citations.map((c, i) => (
                          <blockquote className="break-words font-serif" key={i}>
                            Scene {c.sceneId}: {c.quote}
                          </blockquote>
                        ))}
                      </label>
                    ))}
                  </div>
                ))}
                <Button
                  disabled={actions.blocked}
                  onClick={() => {
                    setConstraints(plan.analysis!.suggestions);
                    setDirty(true);
                  }}
                >
                  Use cited protection suggestions
                </Button>
                <p>
                  Review these passages and save to confirm. Changing protections requires a fresh
                  plan.
                </p>
              </section>
              <label className="block">
                Decision reason
                <textarea
                  aria-label="Decision reason"
                  className="w-full rounded border bg-surface-raised p-2"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    blocked || plan.stale || !plan.analysis.complete || !detail.campaign.confirmed
                  }
                  onClick={() => void decide('approve')}
                >
                  Approve current plan
                </Button>
                <Button
                  disabled={blocked || plan.stale || !reason.trim()}
                  onClick={() => void decide('request-changes')}
                >
                  Request plan changes
                </Button>
                <Button disabled={blocked || plan.stale} onClick={() => void decide('finish')}>
                  Complete campaign
                </Button>
              </div>
              <p>
                Approval permits preparing proposals. Applying each proposal creates pending tracked
                edits for inspection in the manuscript.
              </p>
              <ol className="space-y-5">
                {plan.analysis.steps.map((step, index) => (
                  <li key={step.id} className="space-y-2 rounded border p-4">
                    <h3 className="font-semibold">
                      {index + 1}. {step.title}
                    </h3>
                    <p>
                      Chapter {step.chapterId} · Scene {step.sceneId}
                      {step.manual ? ' · Manual structural follow-up' : ''}
                    </p>
                    <p>{step.instruction}</p>
                    {step.citations.map((c, i) => (
                      <blockquote key={i} className="whitespace-pre-wrap break-words font-serif">
                        {c.quote}
                      </blockquote>
                    ))}
                    <p>
                      Prerequisites:{' '}
                      {step.prerequisites.length ? step.prerequisites.join(', ') : 'None'}
                    </p>
                    {step.consequences.map((x, i) => (
                      <p key={i}>Predicted consequence: {x.prediction}</p>
                    ))}
                    {step.questions.map((x, i) => (
                      <p key={i}>Unanswered: {x}</p>
                    ))}
                    <Button
                      disabled={blocked || plan.stale || !reason.trim()}
                      onClick={() => void decide('skip', step.id)}
                    >
                      Skip step with reason
                    </Button>
                    {!step.manual && (
                      <CampaignStepRevision
                        key={`${plan.id}:${step.id}`}
                        userId={userId}
                        bookId={bookId}
                        step={step}
                        plan={plan}
                        actions={actions}
                        blocked={blocked || plan.stale || !plan.approved}
                        onChanged={reload}
                        onPreview={(proposalId, targetIds) =>
                          analyze('preview', proposalId, targetIds)
                        }
                        onResolve={(proposalId) => decide('resolve', step.id, proposalId)}
                        verifications={detail.verifications}
                      />
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </div>
  );
}
function CampaignStepRevision({
  userId,
  bookId,
  step,
  plan,
  actions,
  blocked,
  onChanged,
  onPreview,
  onResolve,
  verifications,
}: {
  userId: string;
  bookId: string;
  step: CampaignStep;
  plan: CampaignPlanRecord;
  actions: ReturnType<typeof useCampaignActions>;
  blocked: boolean;
  onChanged(): void;
  onPreview(id: string, targetIds: string[]): Promise<unknown>;
  onResolve(id: string): Promise<unknown>;
  verifications: CampaignVerification[];
}) {
  const [discussion, setDiscussion] = useState<DocumentDiscussionRecord>(),
    [proposal, setProposal] = useState<DocumentProposalRecord>();
  const [selected, setSelected] = useState<string[]>([]);
  const { setError } = actions;
  const base = `/api/books/${bookId}`;
  useEffect(() => {
    let active = true;
    void campaignRequest<DocumentDiscussionRecord[]>(
      `${base}/document-discussions?sceneId=${step.sceneId}`,
      userId,
    )
      .then(async (rows) => {
        const saved = rows.find(
          (x) =>
            x.snapshot.revisionCampaign?.planId === plan.id &&
            x.snapshot.revisionCampaign.stepId === step.id,
        );
        if (!saved) return;
        const proposals = await campaignRequest<DocumentProposalRecord[]>(
          `${base}/document-discussions/${saved.id}/proposals`,
          userId,
        );
        if (active) {
          setDiscussion(saved);
          setProposal(proposals[0]);
          setSelected(proposals[0]?.result?.output?.edits.map((x) => x.targetId) ?? []);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Unable to recover proposals.');
      });
    return () => {
      active = false;
    };
  }, [base, userId, step.sceneId, step.id, plan.id, plan.stale, setError]);
  const perform = async (work: () => Promise<unknown>) => {
    try {
      await work();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recover the original proposal.');
    }
  };
  const prepare = () =>
    perform(async () => {
      const manifest = await getDocumentManifest(bookId),
        scene = manifest.scenes.find((x) => x.sceneId === step.sceneId)!;
      const operationId = crypto.randomUUID();
      const saved = await actions.dispatch<DocumentDiscussionRecord>({
        operationId,
        kind: 'discussion',
        path: `${base}/document-discussions`,
        method: 'POST',
        recoveryPath: `${base}/document-discussions/${operationId}`,
        body: {
          schemaVersion: 1,
          operationId,
          sessionId: crypto.randomUUID(),
          sceneId: step.sceneId,
          expectedRevisionId: manifest.revisionId,
          expectedSceneRevisionId: scene.revisionId,
          expectedContentHash: scene.contentHash,
          projection: 'final',
          revisionCampaignPlanId: plan.id,
          revisionCampaignStepId: step.id,
          targets: step.citations
            .filter((x) => x.sceneId === step.sceneId)
            .map((x) => ({ blockId: x.blockId, from: x.from, to: x.to, sourceText: x.quote })),
        },
      });
      setDiscussion(saved);
    });
  const request = () =>
    perform(async () => {
      const operationId = crypto.randomUUID();
      const saved = await actions.dispatch<DocumentProposalRecord>({
        operationId,
        kind: 'proposal',
        path: `${base}/document-discussions/${discussion!.id}/proposals`,
        method: 'POST',
        recoveryPath: `${base}/document-proposals/${operationId}`,
        body: {
          operationId,
          instruction:
            step.instruction +
            '\nPreserve every confirmed fact and the cited voice. Make a targeted prose edit within a 30% change budget.' +
            ' Keep any confirmed fact that appears verbatim in the target text as an exact, uninterrupted substring of the replacement. Make additions or changes outside that text.' +
            (matched?.failures.length
              ? '\nThe previous candidate was blocked: ' +
                matched.failures.join('; ') +
                '. Offer a smaller correction.'
              : ''),
        },
      });
      setProposal(saved);
      setSelected(saved.result?.output?.edits.map((x) => x.targetId) ?? []);
    });
  const apply = () =>
    perform(async () => {
      const manifest = await getDocumentManifest(bookId),
        scene = manifest.scenes.find((x) => x.sceneId === step.sceneId)!;
      const validation = await campaignRequest<DocumentProposalValidationRecord>(
        `${base}/document-proposals/${proposal!.id}/revalidate`,
        userId,
        'POST',
        {
          operationId: crypto.randomUUID(),
          expectedRevisionId: manifest.revisionId,
          expectedSceneRevisionId: scene.revisionId,
        },
      );
      const operationId = crypto.randomUUID();
      const saved = await actions.dispatch<DocumentProposalRecord>({
        operationId,
        kind: 'apply',
        path: `${base}/document-proposals/${proposal!.id}/apply`,
        method: 'POST',
        recoveryPath: `${base}/document-proposals/${proposal!.id}`,
        body: {
          operationId,
          expectedRevisionId: manifest.revisionId,
          expectedSceneRevisionId: scene.revisionId,
          validationId: validation.id,
          targetIds: selected,
        },
      });
      setProposal({
        ...proposal!,
        status: 'applied',
        application: saved as unknown as DocumentProposalRecord['application'],
      });
    });
  const matched = verifications.find((x) => x.proposalId === proposal?.id);
  const selectionVerified =
    matched?.passed &&
    matched.targetIds?.length === selected.length &&
    selected.every((id) => matched.targetIds.includes(id));
  return (
    <section aria-label={`Step revision ${step.title}`} className="space-y-3">
      {!discussion ? (
        <Button disabled={blocked} onClick={() => void prepare()}>
          Prepare cited passage
        </Button>
      ) : !proposal ? (
        <Button disabled={blocked} onClick={() => void request()}>
          Request step revision
        </Button>
      ) : (
        <>
          <p role="status">Proposal {proposal.status}</p>
          {proposal.result?.output?.edits.map((edit) => (
            <label className="block" key={edit.targetId}>
              <input
                type="checkbox"
                checked={selected.includes(edit.targetId)}
                disabled={proposal.status === 'applied'}
                onChange={(e) =>
                  setSelected((old) =>
                    e.target.checked
                      ? [...old, edit.targetId]
                      : old.filter((x) => x !== edit.targetId),
                  )
                }
              />{' '}
              Include edit<blockquote className="break-words">Before: {edit.sourceText}</blockquote>
              <blockquote className="break-words">After: {edit.replacement}</blockquote>
            </label>
          ))}
          {proposal.status === 'ready' && (
            <>
              <Button disabled={blocked} onClick={() => void onPreview(proposal.id, selected)}>
                Preview consequences and verify
              </Button>
              {matched && (
                <div role="status">
                  <p>
                    {matched.passed
                      ? 'Preservation checks passed.'
                      : 'Preservation checks blocked this candidate.'}
                  </p>
                  <p>{matched.facts}</p>
                  <p>{matched.voice}</p>
                  <p>Predicted consequences: {matched.consequences}</p>
                  {matched.failures.map((x, i) => (
                    <p key={i}>{x}</p>
                  ))}
                </div>
              )}
              <Button
                disabled={blocked || !selected.length || !selectionVerified}
                onClick={() => void apply()}
              >
                Revalidate and apply selected edits
              </Button>
            </>
          )}
          {['ready', 'failed', 'cancelled'].includes(proposal.status) &&
            ['completed', 'not-started'].includes(proposal.providerOutcome) && (
              <Button disabled={blocked} onClick={() => void request()}>
                Request another step revision
              </Button>
            )}
          {proposal.status === 'unknown' && (
            <p>Recover the original provider outcome. Another revision request is blocked.</p>
          )}
          {proposal.status === 'applied' && (
            <>
              <a
                className="underline"
                href={`${bookId ? '/manuscript' : ''}?bookId=${bookId}&sceneId=${step.sceneId}`}
              >
                Inspect and resolve tracked edits in manuscript
              </a>
              <Button disabled={actions.blocked} onClick={() => void onResolve(proposal.id)}>
                Record resolved step
              </Button>
              <p>Resolve tracked edits, record this step, then refresh downstream evidence.</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
