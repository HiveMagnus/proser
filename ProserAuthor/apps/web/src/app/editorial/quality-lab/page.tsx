'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, FlaskConical, Loader2, Play, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { PageTransition } from '@/components/motion/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  listEditorialBenchmarks,
  startEditorialBenchmark,
  type EditorialBenchmark,
} from '@/lib/api';

export default function EditorialQualityLabPage() {
  const [runs, setRuns] = React.useState<EditorialBenchmark[]>([]);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => setRuns(await listEditorialBenchmarks()), []);
  React.useEffect(() => {
    void refresh().catch((error) =>
      toast.error(error instanceof Error ? error.message : 'Benchmark history failed'),
    );
  }, [refresh]);

  async function start() {
    setBusy(true);
    try {
      await startEditorialBenchmark(
        { suiteKey: 'editorial-deterministic', maximumCases: 20, live: false },
        crypto.randomUUID(),
      );
      await refresh();
      toast.success('Deterministic editorial benchmark completed.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Benchmark failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageTransition className="mx-auto w-full max-w-6xl space-y-7 px-5 py-7 lg:px-9">
      <Link
        href="/editorial"
        className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-accent-300"
      >
        <ArrowLeft className="size-4" /> Editorial
      </Link>
      <header className="flex flex-col justify-between gap-5 border-b border-border-muted pb-7 md:flex-row md:items-end">
        <div className="border-l border-accent-500 pl-5">
          <p className="font-[--font-mono] text-[10px] uppercase tracking-[0.22em] text-accent-400">
            Release evidence
          </p>
          <h1 className="mt-2 font-[--font-display] text-4xl">Quality Lab</h1>
          <p className="mt-2 max-w-2xl text-text-secondary">
            Synthetic fixtures and compact benchmark novels test detection, preservation,
            determinism, and false-positive control without exposing real manuscripts.
          </p>
        </div>
        <Button onClick={() => void start()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run
          deterministic suite
        </Button>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        {['Hard invariants', 'Detector precision', 'Deterministic report'].map((item) => (
          <Card key={item}>
            <CardContent className="flex gap-3 p-5">
              <CheckCircle2 className="size-5 text-success" />
              <div>
                <p className="font-medium">{item}</p>
                <p className="mt-1 text-xs text-text-muted">Release-blocking evidence</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <section className="space-y-3">
        <h2 className="font-[--font-display] text-2xl">Benchmark runs</h2>
        {runs.map((run) => {
          const blocking = run.report?.release?.blocking;
          const passing = blocking
            ? Object.values(blocking).every(Boolean)
            : run.status === 'completed';
          return (
            <Card key={run.id} className={passing ? '' : 'border-danger/40'}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <FlaskConical className="size-4 text-accent-400" /> {run.suiteKey}{' '}
                    <span className="text-text-muted">v{run.suiteVersion}</span>
                  </CardTitle>
                  <Badge
                    variant={passing ? 'success' : run.status === 'failed' ? 'danger' : 'info'}
                  >
                    {run.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                {run.metrics && (
                  <div className="grid gap-3 text-sm sm:grid-cols-4">
                    {Object.entries(run.metrics)
                      .slice(0, 8)
                      .map(([key, value]) => (
                        <div key={key}>
                          <p className="font-[--font-mono] text-accent-300">
                            {Number(value).toFixed(3)}
                          </p>
                          <p className="text-xs text-text-muted">{key.replaceAll('_', ' ')}</p>
                        </div>
                      ))}
                  </div>
                )}
                {!passing && (
                  <p className="mt-4 flex gap-2 text-sm text-danger">
                    <ShieldAlert className="size-4" /> This run is not valid release evidence.
                  </p>
                )}
                {run.reportHash && (
                  <p className="mt-4 font-[--font-mono] text-[10px] text-text-muted">
                    report sha256 {run.reportHash}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
        {!runs.length && (
          <Card>
            <CardContent className="p-6 text-text-secondary">
              No benchmark evidence has been recorded yet.
            </CardContent>
          </Card>
        )}
      </section>
    </PageTransition>
  );
}
