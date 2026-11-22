'use client';
import { useEffect, useRef, useState } from 'react';
import { FactoryRequestError } from '@/lib/api';
import { plotRequest, verifyPlotThreadAcknowledgement } from '@/lib/plot-thread-api';
import {
  readPlotThreadIntent,
  writePlotThreadIntent,
  deletePlotThreadIntent,
  type PlotThreadIntent,
} from '@/lib/plot-thread-journal';
export interface PlotThreadRecoveryResult {
  intent: PlotThreadIntent;
  result: { status?: string; threadId?: number; application?: unknown };
}
const definitiveRejection = (error: unknown) =>
  error instanceof FactoryRequestError &&
  [400, 409, 412, 413, 422, 428].includes(error.status) &&
  error.code !== 'DOCUMENT_OPERATION_CONFLICT' &&
  error.code !== 'FACTORY_SESSION_CHANGED' &&
  error.code !== 'SESSION_SCOPE_CHANGED';
export function usePlotThreadActions(userId: string, bookId: string) {
  const [pending, setPending] = useState<PlotThreadIntent>();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const scope = JSON.stringify([userId, bookId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const epoch = useRef(0);
  const locked = useRef(false);
  useEffect(() => {
    const generation = ++epoch.current;
    locked.current = false;
    setReady(false);
    setPending(undefined);
    setBusy(false);
    setError(undefined);
    void readPlotThreadIntent(userId, bookId)
      .then((row) => {
        if (epoch.current === generation) {
          setPending(row);
          setReady(true);
        }
      })
      .catch((e) => {
        if (epoch.current === generation) setError(String(e));
      });
    return () => {
      epoch.current = generation + 1;
    };
  }, [userId, bookId]);
  const generation = epoch.current;
  const isCurrent = () => currentScope.current === scope && epoch.current === generation;
  const finish = async (intent: PlotThreadIntent) => {
    await deletePlotThreadIntent(intent.userId, intent.bookId, intent.operationId);
    if (isCurrent()) setPending(undefined);
  };
  const begin = () => {
    if (!isCurrent() || locked.current)
      throw new Error('Recover the previous request before continuing.');
    locked.current = true;
    setBusy(true);
    setError(undefined);
  };
  const end = () => {
    if (isCurrent()) {
      locked.current = false;
      setBusy(false);
    }
  };
  const dispatch = async <T>(input: Omit<PlotThreadIntent, 'userId' | 'bookId'>): Promise<T> => {
    if (!ready || pending || busy)
      throw new Error('Recover the previous request before continuing.');
    begin();
    const intent = { ...input, userId, bookId };
    let recorded = false;
    try {
      await writePlotThreadIntent(intent);
      recorded = true;
      if (!isCurrent())
        throw new Error(
          'Author or manuscript changed before dispatch. Recover this saved request in its original scope.',
        );
      setPending(intent);
      const result = await plotRequest<T>(intent.path, userId, intent.method, intent.body);
      verifyPlotThreadAcknowledgement(intent, result);
      const status = (result as { status?: string })?.status;
      if (!['pending', 'running'].includes(status ?? '')) await finish(intent);
      return result;
    } catch (e) {
      if (recorded && definitiveRejection(e)) await finish(intent);
      // Another tab can own the durable slot even when this hook saw it empty.
      const retained = await readPlotThreadIntent(userId, bookId);
      if (isCurrent()) {
        setPending(retained);
        setError(e instanceof Error ? e.message : 'Request failed. Recover its original receipt.');
      }
      throw e;
    } finally {
      end();
    }
  };
  const recoverOriginal = async (
    intent: PlotThreadIntent,
    retrying = false,
  ): Promise<PlotThreadRecoveryResult | undefined> => {
    const result = await plotRequest<PlotThreadRecoveryResult['result']>(
      intent.recoveryPath,
      userId,
    );
    if (intent.kind === 'apply' && !result.application) return undefined;
    verifyPlotThreadAcknowledgement(intent, result, true);
    if (retrying && result.status === 'running')
      throw new Error('Original request is running. Recover it after it completes.');
    if (['pending', 'running'].includes(result.status ?? '')) return undefined;
    await finish(intent);
    return { intent, result };
  };
  const recover = async () => {
    if (!pending || busy || locked.current) return;
    begin();
    try {
      const recovered = await recoverOriginal(pending);
      if (!recovered)
        throw new Error(
          pending.kind === 'apply'
            ? 'No application receipt is available. Retry the recorded application request explicitly.'
            : 'Original request is still pending or running. Recover again after it completes.',
        );
      return isCurrent() ? recovered : undefined;
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : 'Recovery failed.');
    } finally {
      end();
    }
  };
  const retry = async () => {
    if (!pending || busy || locked.current) return;
    begin();
    let absent = false;
    try {
      // Recover first: a terminal/unknown provider receipt never causes redispatch.
      try {
        const recovered = await recoverOriginal(pending, true);
        if (recovered) return isCurrent() ? recovered : undefined;
        absent = true;
      } catch (e) {
        if (
          !(e instanceof FactoryRequestError) ||
          e.status !== 404 ||
          ![
            'PLOT_THREAD_OPERATION_NOT_FOUND',
            'DOCUMENT_DISCUSSION_NOT_FOUND',
            'DOCUMENT_PROPOSAL_NOT_FOUND',
            'PLOT_THREAD_REVIEW_NOT_FOUND',
          ].includes(e.code ?? '')
        )
          throw e;
        absent = true;
      }
      if (!isCurrent())
        throw new Error(
          'Author or manuscript changed. Recover the original request in its recorded scope.',
        );
      const result = await plotRequest<PlotThreadRecoveryResult['result']>(
        pending.path,
        userId,
        pending.method,
        pending.body,
      );
      verifyPlotThreadAcknowledgement(pending, result);
      if (['pending', 'running'].includes(result.status ?? ''))
        throw new Error('Original request is still running. Recover it after it completes.');
      await finish(pending);
      return isCurrent() ? { intent: pending, result } : undefined;
    } catch (e) {
      // An absent receipt followed by a definitive precondition rejection proves
      // this original request did not apply. Release its slot, preserving drafts.
      if (absent && definitiveRejection(e)) await finish(pending);
      if (isCurrent())
        setError(e instanceof Error ? e.message : 'Original request remains unresolved.');
    } finally {
      end();
    }
  };
  return {
    pending,
    busy,
    ready,
    error,
    setError,
    dispatch,
    recover,
    retry,
    blocked: !ready || busy || !!pending,
  };
}
