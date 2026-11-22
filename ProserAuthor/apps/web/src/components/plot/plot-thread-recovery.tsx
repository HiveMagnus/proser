'use client';
import type {
  usePlotThreadActions,
  PlotThreadRecoveryResult,
} from '@/hooks/use-plot-thread-actions';
import { Button } from '@/components/ui/button';
export function PlotThreadRecovery({
  actions,
  onRecovered,
}: {
  actions: ReturnType<typeof usePlotThreadActions>;
  onRecovered(result: PlotThreadRecoveryResult): void;
}) {
  return (
    <>
      {actions.error && (
        <p role="alert" className="break-words text-danger">
          {actions.error}
        </p>
      )}
      {actions.pending && !actions.busy && (
        <section
          aria-label="Plot thread request recovery"
          className="space-y-2 rounded border border-accent-500 p-3"
        >
          <p>The original {actions.pending.kind} request needs recovery before another action.</p>
          <p className="break-all text-xs">Operation: {actions.pending.operationId}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={actions.busy}
              onClick={() =>
                void actions.recover().then((result) => {
                  if (result) onRecovered(result);
                })
              }
            >
              Recover original request
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={actions.busy}
              onClick={() =>
                void actions.retry().then((result) => {
                  if (result) onRecovered(result);
                })
              }
            >
              Retry identical recorded request
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
