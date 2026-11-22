'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleStop, Clipboard, EyeOff, LoaderCircle, X } from 'lucide-react';
import { cancelGenerationOperation } from '@/lib/api';
import { recoverGenerationReceipt } from '@/lib/generation-recovery';
import {
  GENERATION_RECEIPTS_CHANGED,
  listGenerationReceipts,
  removeGenerationReceipt,
  type RetainedGenerationReceipt,
  updateGenerationReceipt,
} from '@/lib/generation-receipts';
import { Button } from '@/components/ui/button';

function ageLabel(createdAt: number): string {
  const minutes = Math.max(1, Math.floor((Date.now() - createdAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function GenerationRecoveryBanner() {
  const [records, setRecords] = useState<RetainedGenerationReceipt[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(
    () => setRecords(listGenerationReceipts().filter((record) => record.state !== 'watching')),
    [],
  );

  const reconcile = useCallback(async () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return true;
    const retained = listGenerationReceipts();
    let succeeded = true;
    await Promise.all(
      retained.map(async (record) => {
        if (['completed', 'failed', 'cancelled'].includes(record.state)) return;
        try {
          await recoverGenerationReceipt(record);
        } catch {
          succeeded = false;
          updateGenerationReceipt(record.idempotencyKey, { state: 'unresolved' });
        }
      }),
    );
    load();
    return succeeded;
  }, [load]);

  useEffect(() => {
    load();
    let stopped = false;
    let timer: number | undefined;
    let failures = 0;
    const channel =
      typeof BroadcastChannel === 'undefined'
        ? null
        : new BroadcastChannel('proser-generation-recovery');

    const schedule = (delay: number) => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(), delay);
    };
    const run = async () => {
      if (stopped) return;
      let succeeded = true;
      const locks = navigator.locks;
      if (locks) {
        try {
          await locks.request('proser-generation-recovery', { ifAvailable: true }, async (lock) => {
            if (lock) succeeded = await reconcile();
          });
        } catch {
          succeeded = await reconcile();
        }
      } else {
        succeeded = await reconcile();
      }
      if (stopped) return;
      if (succeeded) {
        failures = 0;
        channel?.postMessage('reconciled');
      } else {
        failures += 1;
      }
      const base = succeeded ? 30_000 : Math.min(300_000, 30_000 * 2 ** failures);
      schedule(Math.round(base * (0.8 + Math.random() * 0.4)));
    };
    const onChanged = () => load();
    const onAvailable = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) schedule(0);
    };
    window.addEventListener(GENERATION_RECEIPTS_CHANGED, onChanged);
    window.addEventListener('online', onAvailable);
    document.addEventListener('visibilitychange', onAvailable);
    if (channel) channel.onmessage = load;
    schedule(0);
    return () => {
      stopped = true;
      window.removeEventListener(GENERATION_RECEIPTS_CHANGED, onChanged);
      window.removeEventListener('online', onAvailable);
      document.removeEventListener('visibilitychange', onAvailable);
      if (timer !== undefined) window.clearTimeout(timer);
      channel?.close();
    };
  }, [load, reconcile]);

  const cancel = async (record: RetainedGenerationReceipt) => {
    if (!record.operationId) return;
    setCancelling(record.idempotencyKey);
    try {
      const receipt = await cancelGenerationOperation(record.operationId);
      if (receipt.status === 'completed') {
        await recoverGenerationReceipt(record);
      } else if (receipt.status === 'failed' || receipt.status === 'cancelled') {
        updateGenerationReceipt(record.idempotencyKey, {
          state: receipt.status,
          operationStatus: receipt.status,
          terminalMessage:
            receipt.status === 'cancelled' ? 'Generation was cancelled.' : 'Generation failed.',
        });
      }
    } catch {
      updateGenerationReceipt(record.idempotencyKey, { state: 'unresolved' });
    } finally {
      setCancelling(null);
      load();
    }
  };

  if (records.length === 0) return null;
  const completedCount = records.filter((record) => record.state === 'completed').length;

  return (
    <aside
      className="border-b border-amber-400/20 bg-amber-400/8 px-4 py-3 text-text-primary"
      aria-label="Background generations"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-3">
        <div>
          <p className="text-sm font-semibold">
            {completedCount > 0 ? 'Completed generation inbox' : 'Background generations'}
          </p>
          <p className="text-xs text-text-secondary">
            Completed results and terminal outcomes remain here until dismissed. Stopping tracking
            does not cancel Factory work.
          </p>
        </div>
        {records.map((record) => (
          <div
            key={record.idempotencyKey}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-default bg-surface-raised px-3 py-2"
          >
            <div className="min-w-0 text-xs">
              <span className="font-medium">
                Book {record.request.bookId} · {record.operationStatus ?? record.state}
              </span>
              <span className="ml-2 text-text-tertiary">retained {ageLabel(record.createdAt)}</span>
            </div>
            <div className="flex gap-2">
              {record.state === 'completed' && record.artifact && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void navigator.clipboard.writeText(record.artifact!)}
                >
                  <Clipboard />
                  Copy result
                </Button>
              )}
              {['completed', 'failed', 'cancelled'].includes(record.state) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeGenerationReceipt(record.idempotencyKey)}
                >
                  {record.state === 'completed' ? <CheckCircle2 /> : <X />}
                  Dismiss
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeGenerationReceipt(record.idempotencyKey)}
                  >
                    <EyeOff />
                    Stop tracking
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={!record.operationId || cancelling === record.idempotencyKey}
                    onClick={() => void cancel(record)}
                  >
                    {cancelling === record.idempotencyKey ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <CircleStop />
                    )}
                    Cancel generation
                  </Button>
                </>
              )}
            </div>
            {record.terminalMessage && (
              <p className="basis-full text-xs text-text-secondary">{record.terminalMessage}</p>
            )}
            {record.state === 'completed' && record.artifact && (
              <p className="basis-full truncate text-xs text-text-tertiary">
                {record.artifact.slice(0, 240)}
              </p>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
