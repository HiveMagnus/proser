'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Loader2,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageTransition } from '@/components/motion/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  applyEditorialProposal,
  getEditorialProposal,
  getEditorialRun,
  getEditorialSummary,
  listEditorialProposals,
  recordEditorialPreference,
  undoEditorialProposal,
  type EditorialProposalSummary,
  type EditorialRunSummary,
} from '@/lib/api';

const terminal = new Set(['completed', 'failed', 'cancelled']);

function label(value?: string | null) {
  return (value ?? 'pending').replaceAll('_', ' ');
}

export default function EditorialRunPage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = React.useState<Awaited<ReturnType<typeof getEditorialRun>> | null>(null);
  const [summary, setSummary] = React.useState<EditorialRunSummary | null>(null);
  const [proposals, setProposals] = React.useState<EditorialProposalSummary[]>([]);
  const [details, setDetails] = React.useState<Record<string, EditorialProposalSummary>>({});
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const current = await getEditorialRun(runId);
    setRun(current);
    if (terminal.has(current.workflowRun.status)) {
      const [finalSummary, page] = await Promise.all([
        getEditorialSummary(runId),
        listEditorialProposals(runId),
      ]);
      setSummary(finalSummary);
      setProposals(page.items);
    }
    return current.workflowRun.status;
  }, [runId]);

  React.useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const status = await load();
        if (alive && !terminal.has(status)) timer = setTimeout(poll, 2_000);
      } catch (error) {
        if (alive) toast.error(error instanceof Error ? error.message : 'Run detail failed');
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  async function expand(proposalId: string) {
    if (details[proposalId]) return;
    try {
      setDetails((prior) => ({
        ...prior,
        [proposalId]: proposals.find((item) => item.id === proposalId)!,
      }));
      const detail = await getEditorialProposal(runId, proposalId);
      setDetails((prior) => ({ ...prior, [proposalId]: detail }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Proposal detail failed');
    }
  }

  async function choose(proposal: EditorialProposalSummary, candidateId?: string) {
    setBusy(proposal.id);
    try {
      if (candidateId) {
        await applyEditorialProposal(proposal.id, candidateId);
        toast.success('Alternative applied as a new manuscript revision.');
      } else {
        await recordEditorialPreference(proposal.id, { evidenceType: 'choose_original' });
        toast.success('Original preference recorded.');
      }
      setDetails((prior) => ({
        ...prior,
        [proposal.id]: {
          ...(prior[proposal.id] ?? proposal),
          status: candidateId ? 'optionally_applied' : 'original_preferred',
        },
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Editorial decision failed');
    } finally {
      setBusy(null);
    }
  }

  async function undo(proposal: EditorialProposalSummary) {
    setBusy(proposal.id);
    try {
      await undoEditorialProposal(proposal.id);
      toast.success('The source passage was restored as a new descendant revision.');
      setDetails((prior) => ({
        ...prior,
        [proposal.id]: { ...(prior[proposal.id] ?? proposal), status: 'undone', canUndo: false },
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Undo failed');
    } finally {
      setBusy(null);
    }
  }

  const status = run?.workflowRun.status ?? 'queued';
  const progress = run?.workflowRun.progress?.percent ?? 0;

  return (
    <PageTransition className="mx-auto w-full max-w-7xl space-y-7 px-5 py-7 lg:px-9">
      <Link
        href="/editorial"
        className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-accent-300"
      >
        <ArrowLeft className="size-4" /> Editorial folios
      </Link>

      <header className="grid gap-5 border-b border-border-muted pb-7 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="border-l border-accent-500 pl-5">
          <p className="font-[--font-mono] text-[10px] uppercase tracking-[0.22em] text-accent-400">
            Run {runId.slice(0, 8)}
          </p>
          <h1 className="mt-2 font-[--font-display] text-4xl text-text-primary">
            {summary ? label(summary.outcome) : label(run?.workflowRun.phase)}
          </h1>
          <p className="mt-2 text-text-secondary">
            {terminal.has(status)
              ? 'The run is terminal. No approval checkpoint or paused manuscript state remains.'
              : 'Reviewing candidates and preserving the original whenever evidence is uncertain.'}
          </p>
        </div>
        <Badge
          variant={status === 'completed' ? 'success' : status === 'failed' ? 'danger' : 'info'}
        >
          {status === 'completed' ? (
            <CheckCircle2 className="mr-1 size-3.5" />
          ) : (
            <CircleDashed className="mr-1 size-3.5" />
          )}
          {label(status)}
        </Badge>
      </header>

      {!terminal.has(status) && (
        <Card>
          <CardContent className="space-y-3 p-6">
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">{label(run?.workflowRun.phase)}</span>
              <span className="font-[--font-mono] text-accent-300">{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} />
            <p className="text-xs text-text-muted">
              This page polls while the durable worker runs. It is safe to leave and return.
            </p>
          </CardContent>
        </Card>
      )}

      {run?.workflowRun.failureReason && (
        <Card className="border-danger/40">
          <CardContent className="flex gap-3 p-5 text-sm text-danger">
            <ShieldAlert className="size-5 shrink-0" /> {run.workflowRun.failureReason}
          </CardContent>
        </Card>
      )}

      {summary && (
        <>
          <section className="grid gap-px overflow-hidden rounded-lg border border-border-muted bg-border-muted sm:grid-cols-2 xl:grid-cols-4">
            {[
              ['Scopes reviewed', summary.counts.scopesReviewed],
              ['Proposals', summary.counts.proposalsGenerated],
              ['Applied', summary.counts.proposalsApplied],
              ['Original wins', summary.counts.originalWins + summary.counts.noClearWinner],
            ].map(([name, value]) => (
              <div key={name} className="bg-surface-sunken p-5">
                <p className="font-[--font-display] text-3xl text-text-primary">{value}</p>
                <p className="mt-1 text-xs text-text-muted">{name}</p>
              </div>
            ))}
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Evidence ledger</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm md:grid-cols-3">
              <div className="flex gap-3">
                <CheckCircle2 className="size-5 text-success" />
                <span>
                  <strong className="block text-text-primary">Hard invariants</strong>
                  <span className="text-text-muted">
                    {summary.quality.hardInvariantsPassed ? 'Passed' : 'Review required'}
                  </span>
                </span>
              </div>
              <div className="flex gap-3">
                <Sparkles className="size-5 text-accent-400" />
                <span>
                  <strong className="block text-text-primary">Judge agreement</strong>
                  <span className="text-text-muted">
                    {Math.round(summary.quality.judgeAgreementRate * 100)}%
                  </span>
                </span>
              </div>
              <div className="flex gap-3">
                {summary.quality.styleDriftWithinProfile ? (
                  <CheckCircle2 className="size-5 text-success" />
                ) : (
                  <XCircle className="size-5 text-danger" />
                )}
                <span>
                  <strong className="block text-text-primary">Style drift</strong>
                  <span className="text-text-muted">
                    {summary.quality.styleDriftWithinProfile ? 'Within profile' : 'Outside profile'}
                  </span>
                </span>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="font-[--font-display] text-2xl">Before / after evidence</h2>
            <p className="text-sm text-text-muted">
              Alternatives are disclosed only after blind judging.
            </p>
          </div>
          <span className="font-[--font-mono] text-xs text-text-muted">
            {proposals.length} proposals
          </span>
        </div>
        {proposals.map((proposal) => {
          const detail = details[proposal.id];
          return (
            <Card key={proposal.id} className="overflow-hidden border-border-muted">
              <button
                type="button"
                onClick={() => void expand(proposal.id)}
                className="flex w-full items-center gap-4 p-5 text-left hover:bg-surface-hover"
              >
                <span className="h-9 w-1 rounded-full bg-accent-600" />
                <span className="flex-1">
                  <span className="block font-medium text-text-primary">
                    {label(proposal.passKey)} · {proposal.scopeType} {proposal.scopeId}
                  </span>
                  <span className="text-xs text-text-muted">
                    {label(proposal.status)} · {proposal.risk} risk ·{' '}
                    {Math.round(proposal.confidence * 100)}% confidence
                  </span>
                </span>
                <ChevronDown className="size-4 text-text-muted" />
              </button>
              {detail && (
                <CardContent className="border-t border-border-muted p-0">
                  <div className="grid lg:grid-cols-2">
                    <article className="border-b border-border-muted p-5 lg:border-b-0 lg:border-r">
                      <p className="mb-3 font-[--font-mono] text-[10px] uppercase tracking-widest text-text-muted">
                        Original
                      </p>
                      <p className="whitespace-pre-wrap font-[--font-reading] text-sm leading-7 text-text-secondary">
                        {detail.originalText}
                      </p>
                    </article>
                    <div>
                      {(detail.candidates ?? [])
                        .filter((candidate) => candidate.candidateType !== 'original')
                        .map((candidate) => (
                          <article
                            key={candidate.id}
                            className="border-b border-border-muted p-5 last:border-b-0"
                          >
                            <p className="mb-3 font-[--font-mono] text-[10px] uppercase tracking-widest text-accent-400">
                              Alternative
                            </p>
                            <p className="whitespace-pre-wrap font-[--font-reading] text-sm leading-7 text-text-secondary">
                              {candidate.outputText}
                            </p>
                            {proposal.status === 'proposed' && (
                              <Button
                                className="mt-4"
                                size="sm"
                                disabled={busy === proposal.id || detail.stale}
                                onClick={() => void choose(proposal, candidate.id)}
                              >
                                {busy === proposal.id && (
                                  <Loader2 className="size-4 animate-spin" />
                                )}{' '}
                                Apply as revision
                              </Button>
                            )}
                            {detail.stale && (
                              <p className="mt-3 text-xs text-warning">
                                Unavailable: the manuscript has a newer revision.
                              </p>
                            )}
                          </article>
                        ))}
                    </div>
                  </div>
                  <div className="flex justify-end border-t border-border-muted bg-surface-sunken/50 p-4">
                    {detail.canUndo && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy === proposal.id}
                        onClick={() => void undo(proposal)}
                      >
                        Restore original as revision
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === proposal.id}
                      onClick={() => void choose(proposal)}
                    >
                      Keep original
                    </Button>
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })}
        {summary && proposals.length === 0 && (
          <Card>
            <CardContent className="p-6 text-text-secondary">
              No proposal survived the pass. The manuscript remains unchanged.
            </CardContent>
          </Card>
        )}
      </section>
    </PageTransition>
  );
}
