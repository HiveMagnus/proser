'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  BookOpenCheck,
  FlaskConical,
  Loader2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import { ChapterTransitions } from '@/components/editor/chapter-transitions';
import { PageTransition } from '@/components/motion/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useWorkspace } from '@/contexts/workspace-context';
import { useBooks } from '@/hooks/queries/use-books';
import {
  listBookEditorialRuns,
  listEditorialPasses,
  startEditorialOptimize,
  type EditorialAutonomy,
  type EditorialPassKey,
  type EditorialPassPack,
} from '@/lib/api';

const autonomyCopy: Record<EditorialAutonomy, { label: string; note: string }> = {
  review_only: { label: 'Review only', note: 'Findings and evidence; no alternatives.' },
  propose_only: {
    label: 'Propose only',
    note: 'Compare alternatives; leave the manuscript unchanged.',
  },
  safe_auto: { label: 'Safe auto', note: 'Apply only clear, low-risk local wins.' },
  max_quality_auto: {
    label: 'Maximum quality',
    note: 'Spend more bounded evaluation on medium-risk local wins.',
  },
};

function outcomeLabel(value?: string | null) {
  return (value ?? 'in progress').replaceAll('_', ' ');
}

export default function EditorialPage() {
  const { data: books = [] } = useBooks();
  const searchParams = useSearchParams();
  const { activeBookId, setActiveBookId } = useWorkspace();
  const [passes, setPasses] = React.useState<EditorialPassPack[]>([]);
  const [runs, setRuns] = React.useState<Awaited<ReturnType<typeof listBookEditorialRuns>>>([]);
  const [passPack, setPassPack] = React.useState<EditorialPassKey>('line_edit_safe');
  const [autonomy, setAutonomy] = React.useState<EditorialAutonomy>('safe_auto');
  const [scopeType, setScopeType] = React.useState<'book' | 'act' | 'chapter' | 'scene'>('book');
  const [scopeId, setScopeId] = React.useState('');
  const [objective, setObjective] = React.useState('');
  const [protectedElements, setProtectedElements] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const selectedPass = passes.find((item) => item.key === passPack);

  React.useEffect(() => {
    const requestedBookId = searchParams.get('bookId');
    if (
      requestedBookId &&
      books.some((book) => book.id === requestedBookId) &&
      requestedBookId !== activeBookId
    ) {
      setActiveBookId(requestedBookId);
    }
  }, [activeBookId, books, searchParams, setActiveBookId]);

  React.useEffect(() => {
    void listEditorialPasses()
      .then((items) => {
        setPasses(items);
        setPassPack((current) =>
          items[0] && !items.some((item) => item.key === current) ? items[0].key : current,
        );
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : 'Pass discovery failed'),
      );
  }, []);

  React.useEffect(() => {
    if (!activeBookId) {
      setRuns([]);
      return;
    }
    void listBookEditorialRuns(activeBookId)
      .then(setRuns)
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Run history failed'));
  }, [activeBookId]);

  async function launch() {
    if (!activeBookId) {
      toast.error('Choose a book first.');
      return;
    }
    if (scopeType !== 'book' && (!Number.isInteger(Number(scopeId)) || Number(scopeId) < 1)) {
      toast.error(`Enter a ${scopeType} ID.`);
      return;
    }
    if (passPack === 'custom' && objective.trim().length < 3) {
      toast.error('Custom passes need a bounded objective.');
      return;
    }
    setBusy(true);
    try {
      const input = {
        bookId: Number(activeBookId),
        scope:
          scopeType === 'book'
            ? ({ type: 'book' } as const)
            : { type: scopeType, id: Number(scopeId) },
        passPack,
        autonomy,
        objective: objective.trim() || undefined,
        protectedElements: [
          ...new Set(
            protectedElements
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ],
      };
      const run = await startEditorialOptimize(input, crypto.randomUUID());
      toast.success('Editorial run started. Uncertain edits will be kept as original.');
      window.location.assign(`/editorial/runs/${run.runId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Editorial launch failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageTransition className="mx-auto w-full max-w-7xl space-y-8 px-5 py-7 lg:px-9">
      <header className="relative overflow-hidden border-b border-border-muted pb-8">
        <div className="absolute inset-y-0 left-0 w-px bg-gradient-to-b from-accent-300 via-accent-600 to-transparent" />
        <div className="pl-6">
          <p className="mb-2 font-[--font-mono] text-[11px] uppercase tracking-[0.22em] text-accent-400">
            Revision folio
          </p>
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div className="max-w-3xl">
              <h1 className="font-[--font-display] text-4xl text-text-primary md:text-5xl">
                Edit toward evidence,
                <span className="block italic text-text-secondary">never away from the book.</span>
              </h1>
              <p className="mt-4 max-w-2xl text-text-secondary">
                Proser compares every alternative against the original, applies only policy-safe
                winners, and finishes without an approval queue.
              </p>
            </div>
            <div className="flex gap-2">
              <Button asChild variant="secondary">
                <Link href="/editorial/profiles">
                  <SlidersHorizontal className="size-4" /> Profiles
                </Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href="/editorial/quality-lab">
                  <FlaskConical className="size-4" /> Quality Lab
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="overflow-hidden border-border-strong">
          <CardHeader className="border-b border-border-muted bg-surface-sunken/40">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-5 text-accent-400" /> New editorial run
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5 p-6 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm text-text-secondary">Book</span>
              <Select value={activeBookId ?? ''} onValueChange={setActiveBookId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a manuscript" />
                </SelectTrigger>
                <SelectContent>
                  {books.map((book) => (
                    <SelectItem key={book.id} value={String(book.id)}>
                      {book.title ?? `Book ${book.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-2">
              <span className="text-sm text-text-secondary">Pass</span>
              <Select
                value={passPack}
                onValueChange={(value) => setPassPack(value as EditorialPassKey)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {passes.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {item.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-2">
              <span className="text-sm text-text-secondary">Scope</span>
              <Select
                value={scopeType}
                onValueChange={(value) => setScopeType(value as typeof scopeType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['book', 'act', 'chapter', 'scene'].map((item) => (
                    <SelectItem key={item} value={item}>
                      {item.charAt(0).toUpperCase() + item.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-2">
              <span className="text-sm text-text-secondary">
                {scopeType === 'book' ? 'Scope ID' : `${scopeType} ID`}
              </span>
              <Input
                value={scopeId}
                onChange={(event) => setScopeId(event.target.value)}
                disabled={scopeType === 'book'}
                inputMode="numeric"
                placeholder={scopeType === 'book' ? 'Whole book' : 'Required'}
              />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm text-text-secondary">Autonomy</span>
              <Select
                value={autonomy}
                onValueChange={(value) => setAutonomy(value as EditorialAutonomy)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.entries(autonomyCopy) as Array<
                      [EditorialAutonomy, (typeof autonomyCopy)[EditorialAutonomy]]
                    >
                  ).map(([key, copy]) => (
                    <SelectItem key={key} value={key}>
                      {copy.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-text-muted">{autonomyCopy[autonomy].note}</p>
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm text-text-secondary">
                Objective{' '}
                {passPack !== 'custom' && <span className="text-text-muted">(optional)</span>}
              </span>
              <Input
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="Tighten the confrontation without making Mara more forthcoming."
              />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm text-text-secondary">Protected elements</span>
              <Input
                value={protectedElements}
                onChange={(event) => setProtectedElements(event.target.value)}
                placeholder="Mara's reserve, the glass pear, close third"
              />
              <p className="text-xs text-text-muted">
                Comma-separated names, facts, motifs, or voice traits.
              </p>
            </label>
            <div className="md:col-span-2 flex flex-col gap-4 border-t border-border-muted pt-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3 text-sm text-text-secondary">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
                <span>
                  Risk, disagreement, staleness, or weak benefit keeps the original. No checkpoint
                  is created.
                </span>
              </div>
              <Button
                onClick={() => void launch()}
                disabled={busy || !activeBookId}
                className="shrink-0"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <BookOpenCheck className="size-4" />
                )}
                Start edit
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border-muted">
          <CardHeader>
            <CardTitle className="text-xl">{selectedPass?.displayName ?? 'Pass details'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-sm leading-6 text-text-secondary">
              {selectedPass?.description ?? 'Loading pass registry…'}
            </p>
            <div>
              <p className="mb-2 font-[--font-mono] text-[10px] uppercase tracking-widest text-text-muted">
                May change
              </p>
              <div className="flex flex-wrap gap-2">
                {selectedPass?.mayChange.map((item) => (
                  <Badge key={item} variant="info">
                    {item}
                  </Badge>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 font-[--font-mono] text-[10px] uppercase tracking-widest text-text-muted">
                Must preserve
              </p>
              <div className="flex flex-wrap gap-2">
                {selectedPass?.mustPreserve.map((item) => (
                  <Badge key={item} variant="accent">
                    {item}
                  </Badge>
                ))}
              </div>
            </div>
            {selectedPass && (
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border-muted bg-border-muted">
                <div className="bg-surface-sunken p-4">
                  <p className="font-[--font-mono] text-xs text-accent-300">
                    {selectedPass.defaultBudget.maxChangedWordsPercentPerScene}%
                  </p>
                  <p className="mt-1 text-xs text-text-muted">scene ceiling</p>
                </div>
                <div className="bg-surface-sunken p-4">
                  <p className="font-[--font-mono] text-xs text-accent-300">
                    {selectedPass.defaultBudget.maxProposals}
                  </p>
                  <p className="mt-1 text-xs text-text-muted">proposal ceiling</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {activeBookId && (
        <>
          <Link
            className="inline-flex min-h-11 items-center underline"
            href={`/editorial/campaigns${activeBookId ? `?bookId=${activeBookId}` : ''}`}
          >
            Plan a revision campaign
          </Link>
          <ChapterTransitions bookId={activeBookId} />
        </>
      )}

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl">Recent folios</h2>
          <span className="font-[--font-mono] text-xs text-text-muted">{runs.length} recorded</span>
        </div>
        {runs.length ? (
          <div className="divide-y divide-border-muted border-y border-border-muted">
            {runs.slice(0, 10).map((run) => (
              <Link
                key={run.workflowRunId}
                href={`/editorial/runs/${run.workflowRunId}`}
                className="group grid gap-3 py-4 transition-colors hover:bg-surface-raised/40 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:px-3"
              >
                <div className="flex items-center gap-4">
                  <span className="h-10 w-1 rounded-full bg-accent-600/70" />
                  <div>
                    <p className="font-medium text-text-primary">
                      {passes.find((item) => item.key === run.passPackKey)?.displayName ??
                        run.passPackKey}
                    </p>
                    <p className="text-xs text-text-muted">
                      {run.scopeType}
                      {run.scopeId ? ` ${run.scopeId}` : ''} · source{' '}
                      {run.sourceRevisionId.slice(0, 8)}
                    </p>
                  </div>
                </div>
                <Badge
                  variant={
                    run.status === 'completed'
                      ? 'success'
                      : run.status === 'failed'
                        ? 'danger'
                        : 'info'
                  }
                >
                  {outcomeLabel(run.outcome ?? run.status)}
                </Badge>
                <ArrowRight className="size-4 text-text-muted transition-transform group-hover:translate-x-1 group-hover:text-accent-400" />
              </Link>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="flex items-center gap-3 p-6 text-text-secondary">
              <BookOpenCheck className="size-5 text-accent-400" /> Choose a book and start its first
              evidence-backed editorial run.
            </CardContent>
          </Card>
        )}
      </section>
    </PageTransition>
  );
}
