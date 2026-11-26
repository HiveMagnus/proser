'use client';

import { PlotThreadWorkflow } from '@/components/plot/plot-thread-workflow';
import { PageTransition } from '@/components/motion/primitives';

export default function PlotStudioPage() {
  return (
    <PageTransition>
      <div className="space-y-6">
        {/* ── Header ─────────────────────────── */}
        <div>
          <h1 className="font-[--font-display] text-[length:--text-3xl] font-bold tracking-tight text-text-primary">
            Plot Studio
          </h1>
          <p className="mt-1 text-[length:--text-sm] text-text-secondary">
            Track and resolve your story&apos;s plot threads.
          </p>
        </div>

        <PlotThreadWorkflow />
      </div>
    </PageTransition>
  );
}
