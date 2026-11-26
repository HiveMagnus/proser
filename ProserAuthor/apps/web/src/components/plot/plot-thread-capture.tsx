'use client';
import { useEffect, useState } from 'react';
import type { DocumentSelection } from '@hivemagnus/proser-editor';
import type {
  DocumentPassage,
  PlotThreadStage,
  PlotThreadSummary,
} from '@hivemagnus/proser-contracts';
import { visibleRun } from '@hivemagnus/proser-contracts';
import { usePlotThreadActions } from '@/hooks/use-plot-thread-actions';
import { listThreads, readThread, plotThreadBase } from '@/lib/plot-thread-api';
import { Button } from '@/components/ui/button';
import { PlotThreadRecovery } from './plot-thread-recovery';
export function PlotThreadCapture({
  userId,
  bookId,
  selection,
  disabled,
  flush,
}: {
  userId: string;
  bookId: string;
  selection?: DocumentSelection;
  disabled: boolean;
  flush(): Promise<DocumentPassage>;
}) {
  const [open, setOpen] = useState(false),
    [threads, setThreads] = useState<PlotThreadSummary[]>([]);
  const [threadId, setThreadId] = useState(''),
    [stage, setStage] = useState<PlotThreadStage>('setup');
  const [notice, setNotice] = useState<string>();
  const [next, setNext] = useState<number | null>(null);
  const actions = usePlotThreadActions(userId, bookId);
  const { setError } = actions;
  useEffect(() => {
    if (!open) return;
    let active = true;
    void listThreads(bookId, userId)
      .then((list) => {
        if (active) {
          setThreads(list.threads);
          setNext(list.next);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Unable to load threads.');
      });
    return () => {
      active = false;
    };
  }, [open, bookId, userId, setError]);
  const add = async () => {
    if (!selection?.targets.length || !threadId) return;
    const targets = structuredClone(selection.targets);
    try {
      const saved = await flush();
      // Never relocate by quotation after saving: retain exact block IDs and coordinates.
      for (const target of targets) {
        const paragraph = saved.paragraphs.find((item) => item.paragraph.id === target.blockId);
        if (!paragraph)
          throw new Error('Selection left the acknowledged passage. Select it again after saving.');
        const text = paragraph.paragraph.runs
          .filter((run) => visibleRun(run, saved.changes, 'final'))
          .map((run) => (run.inlineImage ? '\ufffc' : run.text))
          .join('');
        if (
          text.slice(target.from - paragraph.offset, target.to - paragraph.offset) !==
          target.sourceText
        )
          throw new Error(
            'Saved text or selection coordinates changed. Select the saved excerpt again.',
          );
      }
      const selected = await readThread(bookId, userId, Number(threadId));
      const operationId = crypto.randomUUID();
      await actions.dispatch({
        operationId,
        path: `${plotThreadBase(bookId)}/${threadId}/evidence`,
        method: 'POST',
        kind: 'mutation',
        body: {
          operationId,
          expectedVersion: selected.version,
          stage,
          sceneId: saved.sceneId,
          expectedRevisionId: saved.bookRevisionId,
          expectedSceneRevisionId: saved.sceneRevisionId,
          expectedContentHash: saved.contentHash,
          targets,
        },
        recoveryPath: `${plotThreadBase(bookId)}/operations/${operationId}`,
      });
      setNotice(`Saved ${stage} evidence. Inspect it in Plot Threads.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to link saved selection.');
    }
  };
  return (
    <section aria-label="Capture plot thread selection" className="space-y-2">
      <Button
        type="button"
        variant="secondary"
        disabled={
          disabled ||
          actions.blocked ||
          !selection?.targets.some((target) => target.sourceText.trim())
        }
        onClick={() => setOpen((value) => !value)}
      >
        Add selection to plot thread
      </Button>
      <PlotThreadRecovery
        actions={actions}
        onRecovered={() => setNotice('Original selection request recovered.')}
      />
      {notice && <p role="status">{notice}</p>}
      {open && (
        <div className="flex flex-wrap items-center gap-2">
          <label>
            Thread
            <select
              aria-label="Thread"
              className="ml-2 max-w-full rounded border bg-surface-raised p-2"
              value={threadId}
              onChange={(e) => setThreadId(e.target.value)}
              disabled={disabled || actions.blocked}
            >
              <option value="">Choose thread</option>
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.question ?? thread.description ?? thread.threadKey}
                </option>
              ))}
            </select>
          </label>
          <label>
            Stage
            <select
              aria-label="Stage"
              className="ml-2 rounded border bg-surface-raised p-2"
              value={stage}
              onChange={(e) => setStage(e.target.value as PlotThreadStage)}
              disabled={disabled || actions.blocked}
            >
              {['setup', 'escalation', 'payoff'].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            disabled={disabled || actions.blocked || !threadId || !selection?.targets.length}
            onClick={() => void add()}
          >
            Save selection link
          </Button>
          {next && (
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                void listThreads(bookId, userId, false, next)
                  .then((list) => {
                    setThreads((rows) => [...rows, ...list.threads]);
                    setNext(list.next);
                  })
                  .catch((e) => setError(String(e)))
              }
            >
              Load more threads
            </Button>
          )}
          <a
            className="inline-flex min-h-11 items-center text-accent-400 underline"
            href={`/plot?bookId=${bookId}&tab=threads`}
          >
            Open Plot Threads
          </a>
        </div>
      )}
    </section>
  );
}
