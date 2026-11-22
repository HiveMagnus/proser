'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EventSourceClient } from '../lib/sse/event-source-client';
import type { ConnectionState } from '../lib/sse/event-source-client';
import {
  cancelGenerationOperation,
  createProseOperation,
  lookupGenerationOperation,
} from '../lib/api';
import { recoverGenerationReceipt } from '../lib/generation-recovery';
import {
  isTerminalGenerationStatus,
  listGenerationReceipts,
  removeGenerationReceipt,
  type RetainedGenerationReceipt,
  saveGenerationReceipt,
  updateGenerationReceipt,
} from '../lib/generation-receipts';

export type ProseStreamStatus =
  'idle' | 'connecting' | 'streaming' | 'done' | 'error' | 'cancelled' | 'detached';
export type TraceStreamStatus =
  'idle' | 'connecting' | 'streaming' | 'done' | 'error' | 'cancelled';
export type WizardStreamStatus =
  'idle' | 'connecting' | 'running' | 'paused' | 'done' | 'error' | 'cancelled';

export interface ProseStreamMeta {
  operationId: string;
  wordCount: number;
  model: string;
  latencyMs?: number;
  traceId?: string;
  genreKey?: string | null;
  recipeVersion?: string;
  judgeStatus?: string | null;
  adapterUsed?: string | null;
  validatorResults?: Array<Record<string, unknown>>;
  revisionApplied?: boolean;
  terminalReason: 'stop';
  authoritative: true;
  artifactHash: string;
  cursor: number;
}

export interface TraceStreamSnapshot {
  traceId: string;
  status: string;
  judgeStatus?: string | null;
  genreKey?: string | null;
  adapterUsed?: string | null;
  recipeVersion?: string | null;
  judgeSummary?: Record<string, unknown> | null;
  candidates?: Array<Record<string, unknown>>;
  inlineFindings?: Array<Record<string, unknown>>;
  compareCards?: Array<Record<string, unknown>>;
  actions?: Array<Record<string, unknown>>;
}

export interface UseProseStreamReturn {
  text: string;
  status: ProseStreamStatus;
  meta: ProseStreamMeta | null;
  error: string | null;
  connectionState: ConnectionState;
  start: (params: {
    bookId: string;
    sceneId?: string;
    prompt?: string;
    instructions?: string;
    targetWords?: number;
    pov?: string;
    tense?: string;
  }) => Promise<void>;
  stopWatching: () => void;
  cancel: () => Promise<void>;
}

export interface UseTraceStreamReturn {
  trace: TraceStreamSnapshot | null;
  status: TraceStreamStatus;
  error: string | null;
  connectionState: ConnectionState;
  start: (traceId: string) => void;
  cancel: () => void;
}

export interface WizardStep {
  phase: string;
  step: string;
  description: string;
  status: string;
}

export interface UseWizardStreamReturn {
  status: WizardStreamStatus;
  steps: WizardStep[];
  currentStep: WizardStep | null;
  error: string | null;
  connectionState: ConnectionState;
  start: (sessionId: string) => void;
  pause: (sessionId: string) => Promise<void>;
  resume: (sessionId: string) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
}

const API_BASE = '';

type ProseStreamLimits = {
  maxBytes: number;
  maxWords: number;
  maxFrames: number;
  maxDurationMs: number;
};

export function proseStreamLimits(targetWords?: number): ProseStreamLimits {
  const requestedWords = Math.min(Math.max(Math.trunc(targetWords ?? 900), 50), 10_000);
  return {
    maxBytes: Math.min(Math.max(requestedWords * 16, 16 * 1024), 2 * 1024 * 1024),
    maxWords: Math.min(Math.ceil(requestedWords * 1.75) + 100, 17_600),
    maxFrames: Math.min(Math.max(requestedWords * 8, 512), 20_000),
    maxDurationMs: Math.min(Math.max(requestedWords * 500, 60_000), 10 * 60_000),
  };
}

function isDefinitiveCreationRejection(error: unknown): boolean {
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
  return [400, 401, 403, 404, 405, 422].includes(status);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function buildUrl(path: string, params?: Record<string, string | number | undefined>) {
  const url = new URL(
    path,
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
  );
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return `${API_BASE}${url.pathname}${url.search}`;
}

export function useProseStream(): UseProseStreamReturn {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<ProseStreamStatus>('idle');
  const [meta, setMeta] = useState<ProseStreamMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const clientRef = useRef<EventSourceClient | null>(null);
  const operationIdRef = useRef<string | null>(null);
  const cursorRef = useRef(0);
  const stagedTextRef = useRef('');
  const stagedMetaRef = useRef<ProseStreamMeta | null>(null);
  const stagedBytesRef = useRef(0);
  const stagedWordsRef = useRef(0);
  const stagedFramesRef = useRef(0);
  const previousWhitespaceRef = useRef(true);
  const limitsRef = useRef<ProseStreamLimits>(proseStreamLimits());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const staleReasonsRef = useRef(
    new Map<number, 'superseded' | 'detached' | 'unmounted' | 'explicitly_cancelled'>(),
  );
  const idempotencyKeyRef = useRef<string | null>(null);
  const restoredRef = useRef(false);

  const clearTimeoutRef = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const discardProvisional = useCallback(() => {
    stagedTextRef.current = '';
    stagedMetaRef.current = null;
    stagedBytesRef.current = 0;
    stagedWordsRef.current = 0;
    stagedFramesRef.current = 0;
    previousWhitespaceRef.current = true;
  }, []);

  const stopWatching = useCallback(() => {
    staleReasonsRef.current.set(generationRef.current, 'detached');
    generationRef.current += 1;
    clientRef.current?.close();
    clientRef.current = null;
    discardProvisional();
    clearTimeoutRef();
    if (idempotencyKeyRef.current) {
      updateGenerationReceipt(idempotencyKeyRef.current, { state: 'detached' });
    }
    if (status === 'streaming' || status === 'connecting') {
      setStatus('detached');
    }
  }, [clearTimeoutRef, discardProvisional, status]);

  const cancel = useCallback(async () => {
    const operationId = operationIdRef.current;
    const operationIdempotencyKey = idempotencyKeyRef.current;
    staleReasonsRef.current.set(generationRef.current, 'explicitly_cancelled');
    generationRef.current += 1;
    clientRef.current?.close();
    clientRef.current = null;
    discardProvisional();
    clearTimeoutRef();
    operationIdRef.current = null;
    cursorRef.current = 0;
    if (!operationId) return;
    try {
      const receipt = await cancelGenerationOperation(operationId);
      if (isTerminalGenerationStatus(receipt.status) && operationIdempotencyKey) {
        removeGenerationReceipt(operationIdempotencyKey);
      }
      idempotencyKeyRef.current = null;
      setStatus('cancelled');
    } catch {
      setError('The stream was closed, but Factory could not confirm generation cancellation.');
      setStatus('error');
    }
  }, [clearTimeoutRef, discardProvisional]);

  useEffect(
    () => () => {
      staleReasonsRef.current.set(generationRef.current, 'unmounted');
      generationRef.current += 1;
      clientRef.current?.close();
      clearTimeoutRef();
      if (idempotencyKeyRef.current) {
        updateGenerationReceipt(idempotencyKeyRef.current, { state: 'detached' });
      }
    },
    [clearTimeoutRef],
  );

  const begin = useCallback(
    async (
      params: {
        bookId: string;
        sceneId?: string;
        prompt?: string;
        instructions?: string;
        targetWords?: number;
        pov?: string;
        tense?: string;
      },
      retained?: RetainedGenerationReceipt,
    ) => {
      if (idempotencyKeyRef.current && idempotencyKeyRef.current !== retained?.idempotencyKey) {
        updateGenerationReceipt(idempotencyKeyRef.current, { state: 'detached' });
      }
      clientRef.current?.close();
      clientRef.current = null;
      clearTimeoutRef();
      if (generationRef.current > 0) {
        staleReasonsRef.current.set(generationRef.current, 'superseded');
      }
      const generation = ++generationRef.current;

      setText('');
      setMeta(null);
      setError(null);
      setStatus('connecting');
      operationIdRef.current = null;
      cursorRef.current = 0;
      discardProvisional();
      limitsRef.current = proseStreamLimits(params.targetWords);

      const fail = (message: string, terminal = false) => {
        if (generation !== generationRef.current) return;
        discardProvisional();
        operationIdRef.current = null;
        clientRef.current?.close();
        clientRef.current = null;
        clearTimeoutRef();
        if (idempotencyKeyRef.current) {
          if (terminal) {
            removeGenerationReceipt(idempotencyKeyRef.current);
            idempotencyKeyRef.current = null;
          } else updateGenerationReceipt(idempotencyKeyRef.current, { state: 'detached' });
        }
        setError(message);
        setStatus('error');
      };

      const acceptFrame = (frame: { operationId?: string; cursor?: number }) => {
        if (
          !operationIdRef.current ||
          frame.operationId !== operationIdRef.current ||
          !Number.isInteger(frame.cursor) ||
          frame.cursor! <= cursorRef.current
        ) {
          throw new Error('invalid operation cursor');
        }
        if (Date.now() - startedAt > limitsRef.current.maxDurationMs) {
          throw new Error('generation exceeded its duration limit');
        }
        stagedFramesRef.current += 1;
        if (stagedFramesRef.current > limitsRef.current.maxFrames) {
          throw new Error('generation exceeded its frame limit');
        }
        cursorRef.current = frame.cursor!;
      };

      const onEvent = (event: string, data: string) => {
        if (generation !== generationRef.current) return;
        switch (event) {
          case 'start': {
            try {
              const frame = JSON.parse(data) as { operationId?: string; cursor?: number };
              if (
                !frame.operationId ||
                !Number.isInteger(frame.cursor) ||
                frame.cursor! <= cursorRef.current
              )
                throw new Error('invalid start frame');
              operationIdRef.current = frame.operationId;
              cursorRef.current = frame.cursor!;
              stagedFramesRef.current = 1;
            } catch {
              fail('Generation returned an invalid start frame.');
            }
            break;
          }
          case 'message':
          case 'token':
            try {
              const frame = JSON.parse(data) as {
                operationId?: string;
                cursor?: number;
                text?: string;
              };
              acceptFrame(frame);
              if (typeof frame.text !== 'string') throw new Error('invalid token frame');
              const bytes = new TextEncoder().encode(frame.text).byteLength;
              stagedBytesRef.current += bytes;
              for (const character of frame.text) {
                const whitespace = character.trim() === '';
                if (!whitespace && previousWhitespaceRef.current) stagedWordsRef.current += 1;
                previousWhitespaceRef.current = whitespace;
              }
              if (
                stagedBytesRef.current > limitsRef.current.maxBytes ||
                stagedWordsRef.current > limitsRef.current.maxWords
              )
                throw new Error('provisional prose exceeded its output limit');
              setStatus('streaming');
              stagedTextRef.current += frame.text;
            } catch {
              fail('Generation exceeded its safety limits or returned an invalid token frame.');
            }
            break;
          case 'meta':
            try {
              const frame = JSON.parse(data) as ProseStreamMeta;
              acceptFrame(frame);
              if (
                frame.authoritative !== true ||
                frame.terminalReason !== 'stop' ||
                !Number.isInteger(frame.wordCount) ||
                frame.wordCount !== stagedWordsRef.current ||
                !/^[a-f0-9]{64}$/.test(frame.artifactHash)
              ) {
                throw new Error('invalid metadata frame');
              }
              stagedMetaRef.current = frame;
            } catch {
              fail('Generation returned invalid completion metadata.');
            }
            break;
          case 'done':
            try {
              const frame = JSON.parse(data) as {
                operationId?: string;
                cursor?: number;
                status?: string;
                artifactHash?: string;
              };
              acceptFrame(frame);
              if (
                frame.status !== 'committed' ||
                !stagedMetaRef.current ||
                frame.artifactHash !== stagedMetaRef.current.artifactHash
              ) {
                throw new Error('invalid terminal frame');
              }
              const completedText = stagedTextRef.current;
              const completedMeta = stagedMetaRef.current;
              clientRef.current?.close();
              clientRef.current = null;
              clearTimeoutRef();
              void sha256Hex(completedText)
                .then((hash) => {
                  if (generation !== generationRef.current) return;
                  if (hash !== completedMeta.artifactHash) {
                    fail('Generation artifact verification failed. Partial output was discarded.');
                    return;
                  }
                  setText(completedText);
                  setMeta(completedMeta);
                  setStatus('done');
                  discardProvisional();
                  operationIdRef.current = null;
                  removeGenerationReceipt(operationIdempotencyKey);
                  idempotencyKeyRef.current = null;
                })
                .catch(() =>
                  fail(
                    'Generation artifact verification failed. Partial output was discarded.',
                    true,
                  ),
                );
            } catch {
              fail(
                'Generation ended without a valid completion frame. Partial output was discarded.',
              );
            }
            break;
          case 'error':
            try {
              const errData = JSON.parse(data) as { message?: string; correlationId?: string };
              fail(
                `${errData.message || 'Generation failed.'}${errData.correlationId ? ` Reference: ${errData.correlationId}` : ''}`,
                true,
              );
            } catch {
              fail('Generation failed. Partial output was discarded.', true);
            }
            break;
          case 'replay_error':
            fail('Generation replay window expired. Partial output was discarded.', true);
            break;
          case 'cancelled':
            removeGenerationReceipt(operationIdempotencyKey);
            idempotencyKeyRef.current = null;
            operationIdRef.current = null;
            clientRef.current?.close();
            clientRef.current = null;
            clearTimeoutRef();
            discardProvisional();
            setStatus('cancelled');
            break;
          default:
            break;
        }
      };

      const connectResume = () => {
        if (!operationIdRef.current || generation !== generationRef.current) {
          fail('Generation connection failed before a resumable operation was established.');
          return;
        }
        const resumeClient = new EventSourceClient({
          url: () =>
            buildUrl(
              `/api/generate/operations/${encodeURIComponent(operationIdRef.current!)}/stream`,
              { cursor: cursorRef.current, limit: 500 },
            ),
          maxRetries: 3,
          onStateChange: setConnectionState,
          onEvent,
          onError: (resumeError) =>
            fail(
              resumeError.message === 'Browser is offline'
                ? resumeError.message
                : 'Generation replay failed. Partial output was discarded.',
            ),
        });
        clientRef.current = resumeClient;
        resumeClient.connect();
      };

      const startedAt = Date.now();
      timeoutRef.current = setTimeout(
        () => fail('Generation exceeded its duration limit. Partial output was discarded.'),
        limitsRef.current.maxDurationMs,
      );
      const operationIdempotencyKey = retained?.idempotencyKey ?? globalThis.crypto.randomUUID();
      const request = {
        bookId: Number(params.bookId),
        sceneId: params.sceneId ? Number(params.sceneId) : undefined,
        prompt: params.prompt,
        instructions: params.instructions,
        targetWords: params.targetWords,
        pov: params.pov,
        tense: params.tense,
      };
      const record: RetainedGenerationReceipt = retained ?? {
        version: 1,
        idempotencyKey: operationIdempotencyKey,
        request,
        state: 'creating',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      idempotencyKeyRef.current = operationIdempotencyKey;
      saveGenerationReceipt({ ...record, request, state: 'creating', updatedAt: Date.now() });
      try {
        let receipt;
        try {
          receipt = await createProseOperation(request, operationIdempotencyKey);
        } catch (creationError) {
          receipt = await lookupGenerationOperation(operationIdempotencyKey).catch(() => null);
          if (!receipt) throw creationError;
        }
        if (generation !== generationRef.current) {
          const staleReason = staleReasonsRef.current.get(generation);
          staleReasonsRef.current.delete(generation);
          if (staleReason === 'superseded' || staleReason === 'explicitly_cancelled') {
            try {
              const cancelled = await cancelGenerationOperation(receipt.operationId);
              if (isTerminalGenerationStatus(cancelled.status)) {
                removeGenerationReceipt(operationIdempotencyKey);
              }
            } catch {
              updateGenerationReceipt(operationIdempotencyKey, {
                state: 'detached',
                operationId: receipt.operationId,
                operationStatus: receipt.status,
              });
            }
          } else {
            updateGenerationReceipt(operationIdempotencyKey, {
              state: 'detached',
              operationId: receipt.operationId,
              operationStatus: receipt.status,
            });
          }
          return;
        }
        operationIdRef.current = receipt.operationId;
        cursorRef.current = 0;
        updateGenerationReceipt(operationIdempotencyKey, {
          state: 'watching',
          operationId: receipt.operationId,
          operationStatus: receipt.status,
        });
        connectResume();
      } catch (creationError) {
        if (isDefinitiveCreationRejection(creationError)) {
          removeGenerationReceipt(operationIdempotencyKey);
          idempotencyKeyRef.current = null;
        } else {
          updateGenerationReceipt(operationIdempotencyKey, { state: 'unresolved' });
        }
        fail(
          creationError instanceof Error
            ? creationError.message
            : 'Generation operation could not be created or reconciled.',
        );
      }
    },
    [clearTimeoutRef, discardProvisional],
  );

  const start = useCallback(
    (params: Parameters<UseProseStreamReturn['start']>[0]) => begin(params),
    [begin],
  );

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    let active = true;
    void (async () => {
      const retained = listGenerationReceipts();
      let resume: RetainedGenerationReceipt | null = null;
      for (const record of retained) {
        try {
          const receipt = await recoverGenerationReceipt(record);
          if (!isTerminalGenerationStatus(receipt.status)) {
            resume ??= {
              ...record,
              operationId: receipt.operationId,
              operationStatus: receipt.status,
            };
          }
        } catch {
          updateGenerationReceipt(record.idempotencyKey, { state: 'unresolved' });
        }
      }
      if (active && resume) {
        await begin(
          {
            ...resume.request,
            bookId: String(resume.request.bookId),
            sceneId:
              resume.request.sceneId === undefined ? undefined : String(resume.request.sceneId),
          },
          resume,
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [begin]);

  return { text, status, meta, error, connectionState, start, stopWatching, cancel };
}

export function useTraceStream(): UseTraceStreamReturn {
  const [trace, setTrace] = useState<TraceStreamSnapshot | null>(null);
  const [status, setStatus] = useState<TraceStreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const clientRef = useRef<EventSourceClient | null>(null);

  const cancel = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
    if (status === 'streaming' || status === 'connecting') {
      setStatus('cancelled');
    }
  }, [status]);

  const start = useCallback((traceId: string) => {
    clientRef.current?.close();
    clientRef.current = null;

    setTrace(null);
    setError(null);
    setStatus('connecting');

    const client = new EventSourceClient({
      url: `${API_BASE}/api/prose/traces/${encodeURIComponent(traceId)}/stream`,
      maxRetries: 5,
      onStateChange: setConnectionState,
      onEvent: (event, data) => {
        switch (event) {
          case 'trace':
            setStatus('streaming');
            try {
              setTrace(JSON.parse(data) as TraceStreamSnapshot);
            } catch {
              // ignore malformed trace payloads
            }
            break;
          case 'done':
            setStatus('done');
            client.close();
            clientRef.current = null;
            break;
          case 'error':
            try {
              const errData = JSON.parse(data) as { message?: string };
              setError(errData.message || 'Unknown error');
            } catch {
              setError(data || 'Unknown error');
            }
            setStatus('error');
            client.close();
            clientRef.current = null;
            break;
          default:
            break;
        }
      },
      onError: (err) => {
        setError(err.message);
        setStatus('error');
      },
    });

    clientRef.current = client;
    client.connect();
  }, []);

  return { trace, status, error, connectionState, start, cancel };
}

export function useWizardStream(): UseWizardStreamReturn {
  const [status, setStatus] = useState<WizardStreamStatus>('idle');
  const [steps, setSteps] = useState<WizardStep[]>([]);
  const [currentStep, setCurrentStep] = useState<WizardStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const clientRef = useRef<EventSourceClient | null>(null);

  const start = useCallback((sessionId: string) => {
    clientRef.current?.close();
    clientRef.current = null;

    setSteps([]);
    setCurrentStep(null);
    setError(null);
    setStatus('connecting');

    const client = new EventSourceClient({
      url: `${API_BASE}/api/wizard/stream/${encodeURIComponent(sessionId)}`,
      maxRetries: 5,
      onStateChange: setConnectionState,
      onEvent: (event, data) => {
        switch (event) {
          case 'progress': {
            setStatus('running');
            try {
              const step: WizardStep = JSON.parse(data);
              setCurrentStep(step);
              setSteps((prev) => [...prev, step]);
            } catch {
              // ignore malformed progress payloads
            }
            break;
          }
          case 'done':
            setStatus('done');
            client.close();
            clientRef.current = null;
            break;
          case 'error':
            try {
              const errData = JSON.parse(data) as { message?: string };
              setError(errData.message || 'Unknown error');
            } catch {
              setError(data || 'Unknown error');
            }
            setStatus('error');
            client.close();
            clientRef.current = null;
            break;
          default:
            break;
        }
      },
      onError: (err) => {
        setError(err.message);
        setStatus('error');
      },
    });

    clientRef.current = client;
    client.connect();
  }, []);

  const sendControl = useCallback(
    async (sessionId: string, action: 'pause' | 'resume' | 'cancel') => {
      try {
        const res = await fetch(`${API_BASE}/api/wizard/${encodeURIComponent(sessionId)}/control`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}) as { error?: string });
          throw new Error(body.error || `Control action failed: ${res.status}`);
        }

        if (action === 'pause') setStatus('paused');
        else if (action === 'resume') setStatus('running');
        else if (action === 'cancel') {
          setStatus('cancelled');
          clientRef.current?.close();
          clientRef.current = null;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Control action failed');
      }
    },
    [],
  );

  const pause = useCallback((sessionId: string) => sendControl(sessionId, 'pause'), [sendControl]);
  const resume = useCallback(
    (sessionId: string) => sendControl(sessionId, 'resume'),
    [sendControl],
  );
  const cancelWizard = useCallback(
    (sessionId: string) => sendControl(sessionId, 'cancel'),
    [sendControl],
  );

  return {
    status,
    steps,
    currentStep,
    error,
    connectionState,
    start,
    pause,
    resume,
    cancel: cancelWizard,
  };
}
