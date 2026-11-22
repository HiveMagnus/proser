'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChapterTransitions } from '@/components/editor/chapter-transitions';
import { useBooks } from '@/hooks/queries/use-books';
import { ArrowRight, BookOpenCheck, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useWorkspace } from '@/contexts/workspace-context';
import {
  listBookEditorialRuns,
  startEditorialOptimize,
  type EditorialAutonomy,
  type EditorialPassKey,
} from '@/lib/api';

export default function MobileEditorialPage() {
  const { activeBookId, setActiveBookId } = useWorkspace();
  const searchParams = useSearchParams();
  const { data: books = [] } = useBooks();
  React.useEffect(() => {
    const requested = searchParams.get('bookId');
    if (requested && requested !== activeBookId && books.some((book) => book.id === requested))
      setActiveBookId(requested);
  }, [searchParams, books, activeBookId, setActiveBookId]);
  const [passPack, setPassPack] = React.useState<EditorialPassKey>('line_edit_safe');
  const [autonomy, setAutonomy] = React.useState<EditorialAutonomy>('safe_auto');
  const [runs, setRuns] = React.useState<Awaited<ReturnType<typeof listBookEditorialRuns>>>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (activeBookId)
      void listBookEditorialRuns(activeBookId)
        .then(setRuns)
        .catch(() => setRuns([]));
  }, [activeBookId]);

  async function start() {
    if (!activeBookId) return toast.error('Choose a book on Home first.');
    setBusy(true);
    try {
      const run = await startEditorialOptimize(
        { bookId: Number(activeBookId), scope: { type: 'book' }, passPack, autonomy },
        crypto.randomUUID(),
      );
      window.location.assign(`/editorial/runs/${run.runId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Editorial launch failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-md space-y-5 px-4 pb-28 pt-[calc(1rem+env(safe-area-inset-top))]">
      <header className="border-l border-accent-500 pl-4">
        <p className="font-[--font-mono] text-[10px] uppercase tracking-[0.2em] text-accent-400">
          Revision folio
        </p>
        <h1 className="mt-1 font-[--font-display] text-3xl">Editorial</h1>
        <p className="mt-2 text-sm leading-6 text-text-secondary">
          Run a bounded whole-book pass. Uncertain changes lose to the original.
        </p>
      </header>
      <Link
        className="inline-flex min-h-11 items-center text-accent-400 underline"
        href={`/m/plot${activeBookId ? `?bookId=${activeBookId}` : ''}`}
      >
        Inspect plot threads and payoffs
      </Link>
      <Card>
        <CardContent className="space-y-4 p-5">
          <label className="block space-y-2">
            <span className="text-xs text-text-muted">Pass</span>
            <select
              className="h-11 w-full rounded-md border border-border-default bg-surface-raised px-3 text-sm"
              value={passPack}
              onChange={(event) => setPassPack(event.target.value as EditorialPassKey)}
            >
              {[
                'line_edit_safe',
                'dialogue',
                'voice_preservation',
                'scene_energy',
                'continuity',
                'name_originality',
                'final_polish',
              ].map((item) => (
                <option key={item} value={item}>
                  {item.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-2">
            <span className="text-xs text-text-muted">Autonomy</span>
            <select
              className="h-11 w-full rounded-md border border-border-default bg-surface-raised px-3 text-sm"
              value={autonomy}
              onChange={(event) => setAutonomy(event.target.value as EditorialAutonomy)}
            >
              {['review_only', 'propose_only', 'safe_auto', 'max_quality_auto'].map((item) => (
                <option key={item} value={item}>
                  {item.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <p className="flex gap-2 text-xs leading-5 text-text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" /> No approval queue and no
            paused workflow state.
          </p>
          <Button
            className="h-11 w-full"
            onClick={() => void start()}
            disabled={busy || !activeBookId}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{' '}
            Start pass
          </Button>
        </CardContent>
      </Card>
      {activeBookId && (
        <>
          <Link
            className="inline-flex min-h-11 items-center underline"
            href={`/m/editorial/campaigns${activeBookId ? `?bookId=${activeBookId}` : ''}`}
          >
            Plan a revision campaign
          </Link>
          <ChapterTransitions bookId={activeBookId} />
        </>
      )}
      <section className="space-y-3">
        <h2 className="text-lg">Recent</h2>
        {runs.slice(0, 5).map((run) => (
          <Link
            key={run.workflowRunId}
            href={`/editorial/runs/${run.workflowRunId}`}
            className="flex items-center gap-3 rounded-xl border border-border-muted bg-surface-raised p-4"
          >
            <BookOpenCheck className="size-5 text-accent-400" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{run.passPackKey.replaceAll('_', ' ')}</span>
              <Badge className="mt-1" variant={run.status === 'completed' ? 'success' : 'info'}>
                {run.outcome?.replaceAll('_', ' ') ?? run.status}
              </Badge>
            </span>
            <ArrowRight className="size-4 text-text-muted" />
          </Link>
        ))}
      </section>
    </main>
  );
}
