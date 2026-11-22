'use client';
import { PlotThreadWorkflow } from '@/components/plot/plot-thread-workflow';
export default function MobilePlotPage() {
  return (
    <div className="space-y-4">
      <h1 className="font-[--font-display] text-3xl">Plot Threads</h1>
      <p className="text-sm text-text-secondary">
        Connect a story question to its saved setup, escalation and payoff.
      </p>
      <PlotThreadWorkflow mobile />
    </div>
  );
}
