'use client';

import * as React from 'react';
import {
  BookMarked,
  Check,
  CirclePause,
  Loader2,
  MessageSquareText,
  Play,
  RefreshCw,
  ScanSearch,
  Sparkles,
  TriangleAlert,
  WandSparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

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
import { PageTransition } from '@/components/motion/primitives';
import { useBooks } from '@/hooks/queries/use-books';
import { useWorkspace } from '@/contexts/workspace-context';
import {
  controlWorkflow,
  decideWorkflowCheckpoint,
  getWorkflowPublication,
  getWorkflow,
  getWorkflowCheckpointDetail,
  listBookWorkflows,
  listBookRevisions,
  listInferenceModels,
  listBookReviews,
  listBookFindings,
  listWorkflowArtifacts,
  listWorkflowCheckpoints,
  rollbackBookRevision,
  startFullBook,
  startGuidedImprove,
  startImproveQuality,
  startQualityReview,
  FactoryRequestError,
  FactoryTimeoutError,
  type QualityReviewSummary,
  type QualityFindingSummary,
  type ManuscriptRevisionSummary,
  type WorkflowArtifactSummary,
  type WorkflowCheckpointSummary,
  type WorkflowCheckpointDetailPage,
  type WorkflowPublicationSummary,
  type WorkflowStatus,
  waiveQualityFinding,
} from '@/lib/api';
import {
  isTerminalWorkflow,
  workflowPollDelayMs,
  WORKFLOW_POLL_BASE_MS,
} from '@/lib/workflow-status';

const workflowCopy = {
  full_book: {
    label: 'Full Book',
    icon: BookMarked,
    tone: 'border-accent-500/40',
    description: 'Build the manuscript, review it, improve it, and prepare release artifacts.',
  },
  quality_review: {
    label: 'Quality Review',
    icon: ScanSearch,
    tone: 'border-info/40',
    description: 'Run a read-only review round and preserve the model’s findings.',
  },
  improve_quality: {
    label: 'Improve Quality',
    icon: WandSparkles,
    tone: 'border-success/40',
    description: 'Implement stored findings, then verify each change independently.',
  },
  guided_improve: {
    label: 'Guided Improve',
    icon: MessageSquareText,
    tone: 'border-warning/40',
    description: 'Give the manuscript a direct instruction without starting a review first.',
  },
} as const;

type WorkflowType = keyof typeof workflowCopy;
const workflowDisplay = (workflowType: import('@/lib/api').WorkflowType) =>
  workflowType === 'revision_campaign_analysis'
    ? {
        label: 'Revision Campaign Analysis',
        icon: ScanSearch,
        tone: 'border-accent-500/40',
        description:
          'Review cited whole-book campaign evidence; prose edits require separate approval.',
      }
    : workflowType === 'editorial_optimize'
      ? {
          label: 'Editorial Optimize',
          icon: ScanSearch,
          tone: 'border-accent-500/40',
          description:
            'Run an evidence-backed editorial pass from the dedicated Editorial workspace.',
        }
      : workflowCopy[workflowType];
type PendingLaunchState = 'pending' | 'reconciling' | 'retryable';
type PendingLaunch = {
  workflowType: WorkflowType;
  fingerprint: string;
  idempotencyKey: string;
  input: Record<string, unknown>;
  state: PendingLaunchState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
};
type RetainedLaunch = PendingLaunch & { storageKey: string };
const launchStoragePrefix = 'proser:workflow-launch:';

function normalizedInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedInput);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizedInput(child)]),
    );
  }
  return value;
}

function retainLaunchOperation(
  workflowType: WorkflowType,
  input: Record<string, unknown>,
  fallback: Map<string, PendingLaunch>,
): RetainedLaunch {
  const storageKey = `${launchStoragePrefix}${workflowType}`;
  const fingerprint = JSON.stringify(normalizedInput(input));
  let existing = fallback.get(storageKey);
  if (typeof window !== 'undefined') {
    try {
      const stored = window.sessionStorage.getItem(storageKey);
      if (stored) existing = JSON.parse(stored) as PendingLaunch;
    } catch {
      // The in-memory fallback still preserves retries when storage is unavailable.
    }
  }
  if (existing?.fingerprint === fingerprint) {
    const retained: PendingLaunch = {
      ...existing,
      workflowType,
      input,
      state: existing.state ?? 'pending',
      attempts: existing.attempts ?? 0,
      createdAt: existing.createdAt ?? new Date().toISOString(),
      updatedAt: existing.updatedAt ?? new Date().toISOString(),
    };
    fallback.set(storageKey, retained);
    return { storageKey, ...retained };
  }
  const now = new Date().toISOString();
  const operation: PendingLaunch = {
    workflowType,
    fingerprint,
    idempotencyKey: crypto.randomUUID(),
    input,
    state: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  fallback.set(storageKey, operation);
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(operation));
    } catch {
      // The operation remains retained in memory for this mounted page.
    }
  }
  return { storageKey, ...operation };
}

function updateLaunchOperation(
  operation: RetainedLaunch,
  changes: Partial<PendingLaunch>,
  fallback: Map<string, PendingLaunch>,
): RetainedLaunch {
  const updated = { ...operation, ...changes, updatedAt: new Date().toISOString() };
  const { storageKey, ...stored } = updated;
  fallback.set(storageKey, stored);
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(stored));
    } catch {
      // The in-memory pending-operation center remains authoritative for this page.
    }
  }
  return updated;
}

function clearLaunchOperation(
  operation: { storageKey: string; idempotencyKey: string },
  fallback: Map<string, PendingLaunch>,
) {
  if (fallback.get(operation.storageKey)?.idempotencyKey === operation.idempotencyKey)
    fallback.delete(operation.storageKey);
  if (typeof window !== 'undefined') {
    try {
      const stored = window.sessionStorage.getItem(operation.storageKey);
      if (
        !stored ||
        (JSON.parse(stored) as PendingLaunch).idempotencyKey === operation.idempotencyKey
      )
        window.sessionStorage.removeItem(operation.storageKey);
    } catch {
      // A storage failure cannot affect the completed Factory operation.
    }
  }
}

function isDefinitiveLaunchFailure(error: unknown) {
  if (!(error instanceof FactoryRequestError) || error instanceof FactoryTimeoutError) return false;
  return new Set([
    'VALIDATION_FAILED',
    'VALIDATION_ERROR',
    'UNAUTHORIZED',
    'AUTH_REQUIRED',
    'FORBIDDEN',
  ]).has(error.code ?? '');
}

function isOlderWorkflowStatus(current: WorkflowStatus | null, updated: WorkflowStatus) {
  if (!current || current.runId !== updated.runId) return false;
  if (isTerminalWorkflow(current) && !isTerminalWorkflow(updated)) return true;
  const currentHasVersion = Number.isInteger(current.statusVersion);
  const updatedHasVersion = Number.isInteger(updated.statusVersion);
  if (currentHasVersion) {
    if (!updatedHasVersion) return true;
    if (updated.statusVersion! < current.statusVersion!) return true;
    if (updated.statusVersion! > current.statusVersion!) return false;
  }
  const currentHeartbeat = current.lastHeartbeatAt
    ? new Date(current.lastHeartbeatAt).getTime()
    : Number.NEGATIVE_INFINITY;
  const updatedHeartbeat = updated.lastHeartbeatAt
    ? new Date(updated.lastHeartbeatAt).getTime()
    : Number.NEGATIVE_INFINITY;
  if (updatedHeartbeat < currentHeartbeat) return true;
  if (
    updatedHeartbeat === currentHeartbeat &&
    (updated.progress?.percent ?? 0) < (current.progress?.percent ?? 0)
  )
    return true;
  return false;
}

function statusTone(status: string) {
  if (['completed', 'release_approved', 'publishable_candidate'].includes(status)) return 'success';
  if (['failed', 'cancelled', 'blocked'].includes(status)) return 'danger';
  if (['awaiting_approval', 'paused'].includes(status)) return 'warning';
  return 'info';
}

export default function WorkflowsPage() {
  const { data: books = [] } = useBooks();
  const { activeBookId, setActiveBookId } = useWorkspace();
  const [premise, setPremise] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [genre, setGenre] = React.useState('fantasy');
  const [targetWords, setTargetWords] = React.useState('80000');
  const [model, setModel] = React.useState('');
  const [models, setModels] = React.useState<Array<{ id: string; name?: string }>>([]);
  const [instruction, setInstruction] = React.useState('');
  const [activeRun, setActiveRun] = React.useState<WorkflowStatus | null>(null);
  const [runs, setRuns] = React.useState<WorkflowStatus[]>([]);
  const [checkpoints, setCheckpoints] = React.useState<WorkflowCheckpointSummary[]>([]);
  const [artifacts, setArtifacts] = React.useState<WorkflowArtifactSummary[]>([]);
  const [publication, setPublication] = React.useState<WorkflowPublicationSummary | null>(null);
  const [reviews, setReviews] = React.useState<QualityReviewSummary[]>([]);
  const [findings, setFindings] = React.useState<Array<QualityFindingSummary & { model: string }>>(
    [],
  );
  const [revisions, setRevisions] = React.useState<ManuscriptRevisionSummary[]>([]);
  const [findingModel, setFindingModel] = React.useState('all');
  const [findingSeverity, setFindingSeverity] = React.useState('all');
  const [findingScope, setFindingScope] = React.useState('all');
  const [findingState, setFindingState] = React.useState('open');
  const [findingNextCursor, setFindingNextCursor] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [bookLoadFailures, setBookLoadFailures] = React.useState<string[]>([]);
  const [resourceLoadFailures, setResourceLoadFailures] = React.useState<string[]>([]);
  const [resourceRetryNonce, setResourceRetryNonce] = React.useState(0);
  const [pollFailureCount, setPollFailureCount] = React.useState(0);
  const [pendingOperations, setPendingOperations] = React.useState<RetainedLaunch[]>([]);
  const [checkpointDetail, setCheckpointDetail] =
    React.useState<WorkflowCheckpointDetailPage | null>(null);
  const [checkpointDetailText, setCheckpointDetailText] = React.useState('');
  const activeBookRef = React.useRef(activeBookId);
  const refreshGeneration = React.useRef(0);
  const refreshController = React.useRef<AbortController | null>(null);
  const latestWorkflowRef = React.useRef<WorkflowStatus | null>(null);
  const pendingLaunches = React.useRef(new Map<string, PendingLaunch>());

  const syncPendingOperations = React.useCallback(() => {
    setPendingOperations(
      [...pendingLaunches.current.entries()]
        .map(([storageKey, operation]) => ({ storageKey, ...operation }))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
  }, []);

  React.useEffect(() => {
    for (const workflowType of Object.keys(workflowCopy) as WorkflowType[]) {
      const storageKey = `${launchStoragePrefix}${workflowType}`;
      try {
        const raw = window.sessionStorage.getItem(storageKey);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as Partial<PendingLaunch>;
        if (!parsed.idempotencyKey || !parsed.fingerprint || !parsed.input) continue;
        const now = new Date().toISOString();
        pendingLaunches.current.set(storageKey, {
          workflowType,
          fingerprint: parsed.fingerprint,
          idempotencyKey: parsed.idempotencyKey,
          input: parsed.input,
          state: parsed.state ?? 'pending',
          attempts: parsed.attempts ?? 0,
          createdAt: parsed.createdAt ?? now,
          updatedAt: parsed.updatedAt ?? now,
          lastError: parsed.lastError,
        });
      } catch {
        // Ignore malformed legacy session data; a new launch replaces it safely.
      }
    }
    syncPendingOperations();
  }, [syncPendingOperations]);

  React.useEffect(() => {
    activeBookRef.current = activeBookId;
  }, [activeBookId]);
  React.useEffect(() => {
    latestWorkflowRef.current = activeRun;
  }, [activeRun]);

  const refreshReviews = React.useCallback(
    async (bookId: string | null, preferredRunId?: string) => {
      const requestedBookId = bookId;
      const generation = ++refreshGeneration.current;
      refreshController.current?.abort();
      const controller = new AbortController();
      refreshController.current = controller;
      if (!requestedBookId) {
        setReviews([]);
        setFindings([]);
        setRevisions([]);
        setRuns([]);
        setActiveRun(null);
        setBookLoadFailures([]);
        setResourceLoadFailures([]);
        setFindingNextCursor(null);
        return;
      }
      const requests = await Promise.allSettled([
        listBookReviews(requestedBookId, controller.signal),
        listBookRevisions(requestedBookId, controller.signal),
        listBookWorkflows(requestedBookId, controller.signal),
        listBookFindings(
          requestedBookId,
          {
            state: findingState,
            model: findingModel,
            severity: findingSeverity,
            scope: findingScope,
            limit: 100,
          },
          controller.signal,
        ),
      ]);
      if (
        controller.signal.aborted ||
        generation !== refreshGeneration.current ||
        activeBookRef.current !== requestedBookId
      )
        return;
      const [reviewResult, revisionResult, runResult, findingResult] = requests;
      const failures: string[] = [];
      if (reviewResult.status === 'fulfilled') setReviews(reviewResult.value);
      else failures.push('review rounds');
      if (revisionResult.status === 'fulfilled') setRevisions(revisionResult.value);
      else failures.push('revision history');
      if (runResult.status === 'fulfilled') {
        const storedRuns = runResult.value;
        setRuns(storedRuns);
        setActiveRun((current) => {
          const preferred = preferredRunId
            ? storedRuns.find((run) => run.runId === preferredRunId)
            : undefined;
          if (preferred) return preferred;
          if (current?.bookId === Number(requestedBookId)) {
            return storedRuns.find((run) => run.runId === current.runId) ?? current;
          }
          return storedRuns[0] ?? null;
        });
      } else failures.push('workflow history');
      if (findingResult.status === 'fulfilled') {
        setFindings(findingResult.value.items);
        setFindingNextCursor(findingResult.value.nextCursor);
      } else failures.push('finding ledger');
      setBookLoadFailures(failures);
    },
    [findingModel, findingScope, findingSeverity, findingState],
  );

  React.useEffect(() => {
    void refreshReviews(activeBookId);
    return () => refreshController.current?.abort();
  }, [activeBookId, refreshReviews]);
  React.useEffect(() => {
    void listInferenceModels()
      .then((available) => {
        setModels(available);
        setModel((current) => current || available[0]?.id || '');
      })
      .catch(() => setModels([]));
  }, []);
  const activeRunId = activeRun?.runId;
  const activeWorkflowType = activeRun?.workflowType;
  const activeRunStatus = activeRun?.status;
  const activeRunTerminal = activeRun ? isTerminalWorkflow(activeRun) : true;
  const resourceVersionKey = activeRun
    ? `${activeRun.runId}:${activeRun.resourceVersions?.checkpoints ?? 'initial'}:${activeRun.resourceVersions?.artifacts ?? 'initial'}:${activeRun.resourceVersions?.publication ?? 'initial'}`
    : '';
  React.useEffect(() => {
    if (!activeRunId) {
      setCheckpoints([]);
      setArtifacts([]);
      setPublication(null);
      return;
    }
    const requestedRunId = activeRunId;
    const controller = new AbortController();
    void Promise.allSettled([
      listWorkflowCheckpoints(requestedRunId, controller.signal),
      listWorkflowArtifacts(requestedRunId, controller.signal),
      activeWorkflowType === 'full_book'
        ? getWorkflowPublication(requestedRunId, controller.signal)
        : Promise.resolve(null),
    ]).then(([checkpointResult, artifactResult, publicationResult]) => {
      if (controller.signal.aborted) return;
      const failures: string[] = [];
      if (checkpointResult.status === 'fulfilled') setCheckpoints(checkpointResult.value);
      else failures.push('checkpoint history');
      if (artifactResult.status === 'fulfilled') setArtifacts(artifactResult.value);
      else failures.push('workflow artifacts');
      if (publicationResult.status === 'fulfilled') setPublication(publicationResult.value);
      else failures.push('publication state');
      setResourceLoadFailures(failures);
    });
    return () => controller.abort();
  }, [activeRunId, activeWorkflowType, resourceRetryNonce, resourceVersionKey]);
  React.useEffect(() => {
    if (!activeRunId || !activeRunStatus || activeRunTerminal) return;
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let consecutiveFailures = 0;
    const pollingAvailable = () => document.visibilityState !== 'hidden' && navigator.onLine;
    const schedule = (delayMs: number) => {
      if (!stopped && pollingAvailable()) timer = window.setTimeout(() => void poll(), delayMs);
    };
    const poll = async () => {
      const pollController = new AbortController();
      controller = pollController;
      try {
        const updated = await getWorkflow(activeRunId, pollController.signal);
        if (stopped || pollController.signal.aborted) return;
        const current = latestWorkflowRef.current;
        if (isOlderWorkflowStatus(current, updated)) return;
        latestWorkflowRef.current = updated;
        setActiveRun(updated);
        setRuns((stored) =>
          stored.map((run) =>
            run.runId === updated.runId && !isOlderWorkflowStatus(run, updated) ? updated : run,
          ),
        );
        consecutiveFailures = 0;
        setPollFailureCount(0);
      } catch (_error) {
        if (!stopped && !pollController.signal.aborted) {
          consecutiveFailures += 1;
          setPollFailureCount((count) => count + 1);
        }
      } finally {
        if (!stopped && !pollController.signal.aborted) {
          schedule(
            consecutiveFailures === 0
              ? WORKFLOW_POLL_BASE_MS
              : workflowPollDelayMs(consecutiveFailures),
          );
        }
      }
    };
    const availabilityChanged = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      if (!pollingAvailable()) {
        controller?.abort();
        return;
      }
      schedule(0);
    };
    document.addEventListener('visibilitychange', availabilityChanged);
    window.addEventListener('online', availabilityChanged);
    window.addEventListener('offline', availabilityChanged);
    schedule(WORKFLOW_POLL_BASE_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', availabilityChanged);
      window.removeEventListener('online', availabilityChanged);
      window.removeEventListener('offline', availabilityChanged);
    };
  }, [activeRunId, activeRunStatus, activeRunTerminal]);
  React.useEffect(() => {
    setCheckpointDetail(null);
    setCheckpointDetailText('');
  }, [activeRun?.runId, activeRun?.activeCheckpoint?.id]);

  async function executeLaunch(
    key: WorkflowType,
    input: Record<string, unknown>,
    retained?: RetainedLaunch,
  ) {
    setBusy(key);
    let operation = retained ?? retainLaunchOperation(key, input, pendingLaunches.current);
    operation = updateLaunchOperation(
      operation,
      { state: 'reconciling', attempts: operation.attempts + 1, lastError: undefined },
      pendingLaunches.current,
    );
    syncPendingOperations();
    try {
      let run: WorkflowStatus;
      if (key === 'full_book') {
        run = await startFullBook(
          input as Parameters<typeof startFullBook>[0],
          operation.idempotencyKey,
        );
      } else if (key === 'quality_review') {
        run = await startQualityReview(
          input as Parameters<typeof startQualityReview>[0],
          operation.idempotencyKey,
        );
      } else if (key === 'improve_quality') {
        run = await startImproveQuality(
          input as Parameters<typeof startImproveQuality>[0],
          operation.idempotencyKey,
        );
      } else {
        run = await startGuidedImprove(
          input as Parameters<typeof startGuidedImprove>[0],
          operation.idempotencyKey,
        );
      }
      clearLaunchOperation(operation, pendingLaunches.current);
      syncPendingOperations();
      const launchedBookId = String(run.bookId);
      activeBookRef.current = launchedBookId;
      setActiveBookId(launchedBookId);
      setActiveRun(run);
      toast.success(`${workflowCopy[key].label} started`);
      void refreshReviews(launchedBookId, run.runId);
    } catch (error) {
      if (isDefinitiveLaunchFailure(error)) {
        clearLaunchOperation(operation, pendingLaunches.current);
      } else {
        operation = updateLaunchOperation(
          operation,
          {
            state: 'retryable',
            lastError: error instanceof Error ? error.message : 'Factory response was uncertain',
          },
          pendingLaunches.current,
        );
      }
      syncPendingOperations();
      const message = error instanceof Error ? error.message : 'Workflow could not start';
      toast.error(
        !isDefinitiveLaunchFailure(error)
          ? `${message}. Retry will reuse the same operation key.`
          : message,
      );
    } finally {
      setBusy(null);
    }
  }

  async function launch(key: WorkflowType) {
    if (key === 'full_book') {
      await executeLaunch(key, {
        premise,
        title: title || undefined,
        genre,
        targetWords: Number(targetWords) || 80000,
        reviewModels: model ? [model] : undefined,
      });
      return;
    }
    if (!activeBookId) {
      toast.error('Select a book first.');
      return;
    }
    const bookId = Number(activeBookId);
    if (key === 'quality_review') {
      await executeLaunch(key, { bookId, model });
      return;
    }
    if (key === 'improve_quality') {
      const selected = reviews.filter((review) => !review.stale && review.aggregates.open > 0);
      if (!selected.length) {
        toast.error('Run a current Quality Review with actionable findings first.');
        return;
      }
      await executeLaunch(key, {
        bookId,
        reviewRunIds: selected.map((review) => review.id),
        model,
      });
      return;
    }
    await executeLaunch(key, { bookId, instruction, model });
  }

  function abandonPendingOperation(operation: RetainedLaunch) {
    clearLaunchOperation(operation, pendingLaunches.current);
    syncPendingOperations();
    toast.success(`${workflowCopy[operation.workflowType].label} operation abandoned`);
  }

  async function control(action: 'pause' | 'resume' | 'cancel') {
    if (!activeRun) return;
    setBusy(action);
    try {
      setActiveRun(await controlWorkflow(activeRun.runId, action));
      toast.success(action === 'resume' ? 'Workflow resumed' : `Workflow ${action}d`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not ${action}`);
    } finally {
      setBusy(null);
    }
  }

  async function recoverStuckWorkflow() {
    if (!activeRun) return;
    setBusy('recover');
    try {
      const resumed = await controlWorkflow(activeRun.runId, 'resume');
      setActiveRun(resumed);
      setRuns((current) => current.map((run) => (run.runId === resumed.runId ? resumed : run)));
      toast.success(
        resumed.status === 'queued'
          ? 'Workflow safely re-queued'
          : 'Worker is still active; no duplicate recovery was started',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Workflow recovery failed');
    } finally {
      setBusy(null);
    }
  }

  async function loadCheckpointDetail(loadMore = false) {
    if (!activeRun?.activeCheckpoint) return;
    setBusy('checkpoint-detail');
    try {
      const offset = loadMore ? (checkpointDetail?.nextOffset ?? 0) : 0;
      const detail = await getWorkflowCheckpointDetail(
        activeRun.runId,
        activeRun.activeCheckpoint.id,
        offset,
      );
      setCheckpointDetail(detail);
      setCheckpointDetailText((current) =>
        loadMore ? current + detail.proposalChunk : detail.proposalChunk,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Checkpoint details could not be loaded',
      );
    } finally {
      setBusy(null);
    }
  }

  async function loadMoreFindings() {
    const requestedBookId = activeBookRef.current;
    if (!requestedBookId || !findingNextCursor) return;
    setBusy('findings-more');
    try {
      const page = await listBookFindings(requestedBookId, {
        state: findingState,
        model: findingModel,
        severity: findingSeverity,
        scope: findingScope,
        cursor: findingNextCursor,
        limit: 100,
      });
      if (activeBookRef.current !== requestedBookId) return;
      setFindings((current) => [...current, ...page.items]);
      setFindingNextCursor(page.nextCursor);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'More findings could not be loaded');
    } finally {
      setBusy(null);
    }
  }

  async function decide(decision: 'approved' | 'rejected') {
    if (!activeRun?.activeCheckpoint) return;
    setBusy(decision);
    try {
      setActiveRun(
        await decideWorkflowCheckpoint(activeRun.runId, activeRun.activeCheckpoint.id, decision),
      );
      toast.success(`Checkpoint ${decision}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Checkpoint decision failed');
    } finally {
      setBusy(null);
    }
  }

  async function toggleWaiver(finding: QualityFindingSummary) {
    setBusy(`waive:${finding.id}`);
    try {
      await waiveQualityFinding(
        finding.id,
        !finding.waived,
        finding.waived ? undefined : 'Waived from the Book Factory production desk.',
      );
      await refreshReviews(activeBookRef.current);
      toast.success(finding.waived ? 'Finding reopened' : 'Finding waived');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Finding could not be updated');
    } finally {
      setBusy(null);
    }
  }

  async function rollback(revision: ManuscriptRevisionSummary) {
    if (!activeBookId) return;
    if (
      !window.confirm(
        `Restore manuscript revision ${revision.id.slice(0, 8)}? A new rollback revision will preserve the current history.`,
      )
    )
      return;
    setBusy(`rollback:${revision.id}`);
    try {
      await rollbackBookRevision(activeBookId, revision.id);
      await refreshReviews(activeBookRef.current);
      toast.success('Manuscript restored as a new immutable revision');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Revision could not be restored');
    } finally {
      setBusy(null);
    }
  }

  const visibleFindings = findings.filter((finding) => {
    if (findingModel !== 'all' && finding.model !== findingModel) return false;
    if (findingSeverity !== 'all' && finding.severity !== findingSeverity) return false;
    if (findingScope !== 'all' && finding.scopeType !== findingScope) return false;
    if (findingState === 'open' && (finding.implemented || finding.waived || finding.superseded))
      return false;
    if (findingState === 'implemented' && !finding.implemented) return false;
    if (findingState === 'verified' && finding.verificationStatus !== 'passed') return false;
    if (findingState === 'waived' && !finding.waived) return false;
    if (findingState === 'stale' && !finding.stale && !finding.reviewStale) return false;
    return true;
  });
  const heartbeatAgeMs = activeRun?.lastHeartbeatAt
    ? Date.now() - new Date(activeRun.lastHeartbeatAt).getTime()
    : 0;
  const heartbeatThresholdMs = activeRun?.phase.includes('draft')
    ? 5 * 60_000
    : activeRun?.phase.includes('review')
      ? 4 * 60_000
      : 3 * 60_000;
  const workflowAppearsStuck =
    activeRun?.status === 'running' && heartbeatAgeMs > heartbeatThresholdMs;
  const loadFailures = [
    ...new Set([
      ...bookLoadFailures,
      ...resourceLoadFailures,
      ...(pollFailureCount >= 3 ? ['workflow status polling'] : []),
    ]),
  ];

  function retryDegradedData() {
    setPollFailureCount(0);
    setResourceRetryNonce((current) => current + 1);
    void refreshReviews(activeBookRef.current);
  }

  return (
    <PageTransition>
      <div className="space-y-6">
        {loadFailures.length > 0 && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-[--radius-lg] border border-warning/40 bg-warning/10 p-4 text-[length:--text-sm] text-text-primary"
          >
            <div className="flex items-start gap-3">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>
                <p className="font-medium">Workflow data is temporarily degraded</p>
                <p className="mt-1 text-text-secondary">
                  Could not refresh {loadFailures.join(', ')}. Last known data remains visible.
                </p>
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={retryDegradedData}>
              <RefreshCw className="mr-2 size-4" /> Retry
            </Button>
          </div>
        )}
        {pendingOperations.length > 0 && (
          <Card className="border-warning/40" aria-label="Pending operations">
            <CardHeader>
              <CardTitle>Pending operations</CardTitle>
              <p className="text-[length:--text-xs] text-text-muted">
                Retained launch keys reconcile uncertain Factory responses without creating a
                duplicate workflow.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {pendingOperations.map((operation) => (
                <div
                  key={operation.idempotencyKey}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[--radius-md] border border-border-muted bg-surface-sunken p-3"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-text-primary">
                        {workflowCopy[operation.workflowType].label}
                      </span>
                      <Badge variant={operation.state === 'retryable' ? 'warning' : 'info'}>
                        {operation.state}
                      </Badge>
                    </div>
                    <p className="mt-1 font-[--font-mono] text-[10px] text-text-muted">
                      {operation.idempotencyKey.slice(0, 8)} · {operation.attempts} attempt
                      {operation.attempts === 1 ? '' : 's'}
                    </p>
                    {operation.lastError && (
                      <p className="mt-1 max-w-2xl text-[length:--text-xs] text-warning">
                        {operation.lastError}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        void executeLaunch(operation.workflowType, operation.input, operation)
                      }
                    >
                      <RefreshCw className="mr-2 size-4" /> Reconcile
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => abandonPendingOperation(operation)}
                    >
                      <X className="mr-2 size-4" /> Abandon
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        <header className="grid gap-5 border-b border-border-muted pb-6 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="font-[--font-mono] text-[11px] uppercase tracking-[0.22em] text-accent-400">
              Production desk
            </p>
            <h1 className="mt-2 max-w-3xl font-[--font-display] text-[length:--text-4xl] font-bold tracking-tight text-text-primary">
              From premise to press, with every decision on the record.
            </h1>
            <p className="mt-2 max-w-2xl text-[length:--text-sm] leading-relaxed text-text-secondary">
              Launch one deliberate workflow. Reviews never alter prose; improvements retain their
              evidence, diffs, and verification state.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Select value={activeBookId ?? ''} onValueChange={setActiveBookId}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select an existing book" />
              </SelectTrigger>
              <SelectContent>
                {books.map((book) => (
                  <SelectItem key={book.id} value={book.id}>
                    {book.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={model} onValueChange={setModel} disabled={!models.length}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Configured model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((available) => (
                  <SelectItem key={available.id} value={available.id}>
                    {available.name || available.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-4">
          {(
            Object.entries(workflowCopy) as Array<
              [keyof typeof workflowCopy, (typeof workflowCopy)[keyof typeof workflowCopy]]
            >
          ).map(([key, item]) => {
            const Icon = item.icon;
            return (
              <Card key={key} className={`relative overflow-hidden border-t-2 ${item.tone}`}>
                <CardHeader className="pb-3">
                  <div className="mb-5 flex size-9 items-center justify-center rounded-[--radius-md] bg-surface-raised">
                    <Icon className="size-4 text-accent-300" />
                  </div>
                  <CardTitle>{item.label}</CardTitle>
                  <p className="min-h-12 text-[length:--text-xs] leading-relaxed text-text-muted">
                    {item.description}
                  </p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {key === 'full_book' && (
                    <>
                      <Input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder="Working title (optional)"
                      />
                      <textarea
                        value={premise}
                        onChange={(event) => setPremise(event.target.value)}
                        placeholder="Approved premise"
                        className="min-h-24 w-full resize-y rounded-[--radius-md] border border-border-default bg-surface-sunken px-3 py-2 text-[length:--text-sm] text-text-primary outline-none focus:border-accent-500"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          value={genre}
                          onChange={(event) => setGenre(event.target.value)}
                          aria-label="Genre"
                        />
                        <Input
                          value={targetWords}
                          onChange={(event) => setTargetWords(event.target.value)}
                          inputMode="numeric"
                          aria-label="Target words"
                        />
                      </div>
                    </>
                  )}
                  {key === 'quality_review' && (
                    <p className="rounded-[--radius-md] bg-surface-sunken p-3 text-[length:--text-xs] text-text-muted">
                      Uses {model || 'the configured inference model'} and preserves this round
                      independently.
                    </p>
                  )}
                  {key === 'improve_quality' && (
                    <p className="rounded-[--radius-md] bg-surface-sunken p-3 text-[length:--text-xs] text-text-muted">
                      Uses all current review rounds with open findings. {reviews.length} round
                      {reviews.length === 1 ? '' : 's'} stored.
                    </p>
                  )}
                  {key === 'guided_improve' && (
                    <textarea
                      value={instruction}
                      onChange={(event) => setInstruction(event.target.value)}
                      placeholder="Describe the change you want"
                      className="min-h-24 w-full resize-y rounded-[--radius-md] border border-border-default bg-surface-sunken px-3 py-2 text-[length:--text-sm] text-text-primary outline-none focus:border-accent-500"
                    />
                  )}
                  <Button
                    className="w-full"
                    variant={key === 'full_book' ? 'primary' : 'secondary'}
                    disabled={
                      busy !== null ||
                      (key === 'full_book' ? premise.trim().length < 10 : !activeBookId) ||
                      (key === 'quality_review' && !model) ||
                      (key === 'guided_improve' && instruction.trim().length < 3)
                    }
                    onClick={() => void launch(key)}
                  >
                    {busy === key ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <Play className="mr-2 size-4" />
                    )}
                    Start {item.label}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </section>

        <Card>
          <CardHeader>
            <CardTitle>Workflow history</CardTitle>
            <p className="text-[length:--text-xs] text-text-muted">
              Top-level runs and their editorial children remain available after reconnecting.
            </p>
          </CardHeader>
          <CardContent>
            {runs.length ? (
              <div className="space-y-3">
                {runs.map((run) => (
                  <div
                    key={run.runId}
                    className="rounded-[--radius-md] border border-border-muted p-3"
                  >
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 text-left"
                      onClick={() => setActiveRun(run)}
                    >
                      <span>
                        <span className="block font-medium text-text-primary">
                          {workflowDisplay(run.workflowType).label}
                        </span>
                        <span className="font-[--font-mono] text-[10px] text-text-muted">
                          {run.runId.slice(0, 8)} · {run.phase.replaceAll('_', ' ')}
                        </span>
                      </span>
                      <Badge variant={statusTone(run.status)}>
                        {run.status.replaceAll('_', ' ')}
                      </Badge>
                    </button>
                    {run.children.length > 0 && (
                      <div className="mt-3 grid gap-2 border-l border-border-muted pl-3 sm:grid-cols-2">
                        {run.children.map((child) => (
                          <button
                            type="button"
                            key={child.id}
                            className="flex items-center justify-between gap-2 rounded-[--radius-sm] bg-surface-sunken px-3 py-2 text-left text-[length:--text-xs]"
                            onClick={() => void getWorkflow(child.id).then(setActiveRun)}
                          >
                            <span>
                              {workflowDisplay(child.workflowType).label} ·{' '}
                              {child.phase.replaceAll('_', ' ')}
                            </span>
                            <Badge variant={statusTone(child.status)}>
                              {child.status.replaceAll('_', ' ')}
                            </Badge>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[length:--text-sm] text-text-muted">
                No workflows have been run for this book.
              </p>
            )}
          </CardContent>
        </Card>

        {activeRun && (
          <Card className="border-accent-500/30">
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <p className="font-[--font-mono] text-[10px] uppercase tracking-widest text-text-muted">
                  Live workflow
                </p>
                <CardTitle className="mt-1">
                  {workflowDisplay(activeRun.workflowType).label}
                </CardTitle>
              </div>
              <Badge variant={statusTone(activeRun.status)}>
                {activeRun.status.replaceAll('_', ' ')}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="relative grid gap-3 sm:grid-cols-4 before:absolute before:left-3 before:right-3 before:top-3 before:h-px before:bg-border-muted">
                {['Queued', 'Working', 'Reviewing', 'Release'].map((label, index) => (
                  <div key={label} className="relative">
                    <span
                      className={`mb-2 flex size-6 items-center justify-center rounded-full border text-[10px] ${Number(activeRun.progress?.percent ?? 0) >= index * 30 ? 'border-accent-400 bg-accent-500 text-white' : 'border-border-default bg-surface-sunken text-text-muted'}`}
                    >
                      {index + 1}
                    </span>
                    <p className="text-[length:--text-xs] text-text-secondary">{label}</p>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Metric label="Phase" value={activeRun.phase.replaceAll('_', ' ')} />
                <Metric
                  label="Manuscript"
                  value={`${activeRun.manuscript.words.toLocaleString()} words`}
                />
                <Metric label="Scenes" value={String(activeRun.manuscript.scenes)} />
                <Metric label="Progress" value={`${activeRun.progress?.percent ?? 0}%`} />
                <Metric
                  label="Worker heartbeat"
                  value={
                    activeRun.lastHeartbeatAt
                      ? new Date(activeRun.lastHeartbeatAt).toLocaleString()
                      : 'Not started'
                  }
                />
              </div>
              {activeRun.findings && (
                <div className="grid gap-2 sm:grid-cols-5">
                  <Metric label="Findings" value={String(activeRun.findings.total)} />
                  <Metric label="Open" value={String(activeRun.findings.open)} />
                  <Metric label="Implemented" value={String(activeRun.findings.implemented)} />
                  <Metric label="Verified" value={String(activeRun.findings.verified)} />
                  <Metric label="Waived" value={String(activeRun.findings.waived)} />
                </div>
              )}
              {activeRun.activeCheckpoint && (
                <div className="rounded-[--radius-lg] border border-warning/30 bg-warning/5 p-4">
                  <div className="flex items-center gap-2">
                    <Sparkles className="size-4 text-warning" />
                    <p className="font-medium text-text-primary">
                      Decision required:{' '}
                      {activeRun.activeCheckpoint.checkpointType.replaceAll('_', ' ')}
                    </p>
                  </div>
                  <p className="mt-3 text-[length:--text-xs] text-text-secondary">
                    {activeRun.activeCheckpoint.summary}
                  </p>
                  {activeRun.activeCheckpoint.artifactRefs.length > 0 && (
                    <p className="mt-2 break-all font-[--font-mono] text-[10px] text-text-muted">
                      References: {activeRun.activeCheckpoint.artifactRefs.join(' · ')}
                    </p>
                  )}
                  {checkpointDetailText && (
                    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] text-text-muted">
                      {checkpointDetailText}
                    </pre>
                  )}
                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => void loadCheckpointDetail(Boolean(checkpointDetailText))}
                      disabled={
                        busy !== null ||
                        (Boolean(checkpointDetailText) && checkpointDetail?.nextOffset == null)
                      }
                    >
                      {checkpointDetailText ? 'Load more details' : 'Load full details'}
                    </Button>
                    <Button onClick={() => void decide('approved')} disabled={busy !== null}>
                      <Check className="mr-2 size-4" />
                      Approve
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void decide('rejected')}
                      disabled={busy !== null}
                    >
                      <X className="mr-2 size-4" />
                      Reject
                    </Button>
                  </div>
                </div>
              )}
              {activeRun.children.length > 0 && (
                <div>
                  <p className="mb-2 text-[length:--text-xs] font-medium uppercase tracking-wide text-text-muted">
                    Editorial child runs
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {activeRun.children.map((child) => (
                      <button
                        type="button"
                        key={child.id}
                        onClick={() => void getWorkflow(child.id).then(setActiveRun)}
                        className="flex items-center justify-between rounded-[--radius-md] border border-border-muted px-3 py-2 text-left text-[length:--text-xs]"
                      >
                        <span>
                          {workflowDisplay(child.workflowType).label} ·{' '}
                          {child.phase.replaceAll('_', ' ')}
                        </span>
                        <Badge variant={statusTone(child.status)}>
                          {child.status.replaceAll('_', ' ')}
                        </Badge>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {checkpoints.length > 0 && (
                <div>
                  <p className="mb-2 text-[length:--text-xs] font-medium uppercase tracking-wide text-text-muted">
                    Checkpoint history
                  </p>
                  <div className="space-y-2">
                    {checkpoints.map((checkpoint) => (
                      <div
                        key={checkpoint.id}
                        className="flex items-center justify-between gap-3 rounded-[--radius-md] bg-surface-sunken px-3 py-2 text-[length:--text-xs]"
                      >
                        <span>{checkpoint.checkpointType.replaceAll('_', ' ')}</span>
                        <Badge variant={statusTone(checkpoint.status)}>
                          {(checkpoint.decision ?? checkpoint.status).replaceAll('_', ' ')}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {publication?.gateReport?.gates && (
                <div>
                  <p className="mb-2 text-[length:--text-xs] font-medium uppercase tracking-wide text-text-muted">
                    Release gates
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {publication.gateReport.gates.map((gate) => (
                      <div
                        key={gate.gate}
                        className="flex items-center justify-between gap-3 rounded-[--radius-md] border border-border-muted px-3 py-2 text-[length:--text-xs]"
                      >
                        <span>{gate.gate.replaceAll('_', ' ')}</span>
                        <Badge variant={gate.pass ? 'success' : 'danger'}>
                          {gate.pass ? 'passed' : 'failed'}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(publication?.artifactManifest?.artifacts?.length || artifacts.length > 0) && (
                <div>
                  <p className="mb-2 text-[length:--text-xs] font-medium uppercase tracking-wide text-text-muted">
                    Stored artifacts
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {publication?.artifactManifest?.artifacts?.map((artifact) => (
                      <Badge key={artifact.filename} variant="default">
                        {artifact.filename}
                      </Badge>
                    ))}
                    {artifacts.map((artifact) => (
                      <Badge key={artifact.id} variant="default">
                        {artifact.artifactType.replaceAll('_', ' ')}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {activeRun.failureReason && (
                <p className="rounded-[--radius-md] border border-danger/30 bg-danger/5 p-3 text-[length:--text-sm] text-danger">
                  {activeRun.failureReason}
                </p>
              )}
              {workflowAppearsStuck && (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[--radius-md] border border-warning/40 bg-warning/10 p-3 text-[length:--text-sm]"
                >
                  <span>
                    Heartbeat is older than the {Math.round(heartbeatThresholdMs / 60_000)} minute
                    threshold for {activeRun.phase.replaceAll('_', ' ')}.
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void recoverStuckWorkflow()}
                  >
                    Check and safely re-queue
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void getWorkflow(activeRun.runId).then(setActiveRun)}
                >
                  <RefreshCw className="mr-2 size-4" />
                  Refresh
                </Button>
                {!['completed', 'cancelled', 'failed', 'release_approved'].includes(
                  activeRun.status,
                ) && (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void control(activeRun.status === 'paused' ? 'resume' : 'pause')
                      }
                    >
                      {activeRun.status === 'paused' ? (
                        <Play className="mr-2 size-4" />
                      ) : (
                        <CirclePause className="mr-2 size-4" />
                      )}
                      {activeRun.status === 'paused' ? 'Resume' : 'Pause'}
                    </Button>
                    <Button variant="ghost" onClick={() => void control('cancel')}>
                      <X className="mr-2 size-4" />
                      Cancel
                    </Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Stored review rounds</CardTitle>
            <p className="text-[length:--text-xs] text-text-muted">
              Model results remain separate. Implementation and verification advance per finding.
            </p>
          </CardHeader>
          <CardContent>
            {reviews.length ? (
              <div className="divide-y divide-border-muted">
                {reviews.map((review) => (
                  <div
                    key={review.id}
                    className="grid gap-3 py-3 text-[length:--text-sm] sm:grid-cols-[1fr_auto_auto_auto_auto] sm:items-center"
                  >
                    <div>
                      <p className="font-medium text-text-primary">{review.modelUsed}</p>
                      <p className="font-[--font-mono] text-[10px] text-text-muted">
                        {review.rubricVersion} · {review.sourceRevisionId.slice(0, 8)}
                      </p>
                      <p className="mt-1 text-[10px] text-text-muted">
                        Coverage: {Number(review.coverage.scene ?? 0)} scenes ·{' '}
                        {Number(review.coverage.chapter ?? 0)} chapters ·{' '}
                        {Number(review.coverage.act ?? 0)} acts ·{' '}
                        {Number(review.coverage.book ?? 0)} book
                      </p>
                    </div>
                    <Badge variant={review.stale ? 'warning' : statusTone(review.status)}>
                      {review.stale ? 'stale' : review.status}
                    </Badge>
                    <span className="font-[--font-mono] text-text-primary">
                      {review.score == null ? '—' : review.score.toFixed(1)}
                    </span>
                    <span className="text-text-secondary">
                      {review.aggregates.implemented}/{review.aggregates.total} implemented
                    </span>
                    <span className="text-success">
                      {review.aggregates.open} open · {review.aggregates.verified} verified ·{' '}
                      {review.aggregates.stale} stale
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-[length:--text-sm] text-text-muted">
                No review rounds for this book yet. Start Quality Review to preserve the first model
                opinion.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Finding ledger</CardTitle>
            <p className="text-[length:--text-xs] text-text-muted">
              Compare model opinions without overwriting them. Implementation, verification, waiver,
              and staleness remain finding-specific.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-4">
              <FindingFilter
                label="Model"
                value={findingModel}
                onChange={setFindingModel}
                options={[...new Set(reviews.map((review) => review.modelUsed))]}
              />
              <FindingFilter
                label="Severity"
                value={findingSeverity}
                onChange={setFindingSeverity}
                options={['critical', 'high', 'medium', 'low']}
              />
              <FindingFilter
                label="Scope"
                value={findingScope}
                onChange={setFindingScope}
                options={['book', 'act', 'chapter', 'scene']}
              />
              <FindingFilter
                label="State"
                value={findingState}
                onChange={setFindingState}
                options={['open', 'implemented', 'verified', 'waived', 'stale', 'all']}
                includeAll={false}
              />
            </div>
            {visibleFindings.length ? (
              <div>
                <div className="divide-y divide-border-muted">
                  {visibleFindings.map((finding) => (
                    <article key={finding.id} className="grid gap-3 py-4 lg:grid-cols-[1fr_auto]">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={finding.severity === 'critical' ? 'danger' : 'default'}>
                            {finding.severity}
                          </Badge>
                          <span className="font-[--font-mono] text-[10px] uppercase tracking-wider text-text-muted">
                            {finding.model} · {finding.scopeType}
                            {finding.scopeId ? ` ${finding.scopeId}` : ''} · {finding.category}
                          </span>
                          {(finding.stale || finding.reviewStale) && (
                            <Badge variant="warning">stale</Badge>
                          )}
                        </div>
                        <p className="mt-2 text-[length:--text-sm] text-text-primary">
                          {finding.message}
                        </p>
                        {finding.evidence && (
                          <blockquote className="mt-2 border-l-2 border-border-default pl-3 text-[length:--text-xs] italic text-text-muted">
                            {finding.evidence}
                          </blockquote>
                        )}
                        {finding.recommendation && (
                          <p className="mt-2 text-[length:--text-xs] text-text-secondary">
                            {finding.recommendation}
                          </p>
                        )}
                      </div>
                      <div className="flex items-start gap-2 lg:flex-col lg:items-end">
                        <Badge
                          variant={finding.verificationStatus === 'passed' ? 'success' : 'default'}
                        >
                          {finding.implemented ? 'implemented' : finding.verificationStatus}
                        </Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => void toggleWaiver(finding)}
                        >
                          {finding.waived ? 'Reopen' : 'Waive'}
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
                {findingNextCursor && (
                  <Button
                    className="mt-4"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void loadMoreFindings()}
                  >
                    Load more findings
                  </Button>
                )}
              </div>
            ) : (
              <p className="py-6 text-center text-[length:--text-sm] text-text-muted">
                No findings match these filters.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Manuscript revision points</CardTitle>
            <p className="text-[length:--text-xs] text-text-muted">
              Immutable ancestry records the exact input and output of every workflow.
            </p>
          </CardHeader>
          <CardContent>
            {revisions.length ? (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {revisions.slice(0, 12).map((revision) => (
                  <div
                    key={revision.id}
                    className="rounded-[--radius-md] border border-border-muted bg-surface-sunken p-3"
                  >
                    <p className="font-[--font-mono] text-[length:--text-xs] text-text-primary">
                      {revision.id.slice(0, 8)}
                    </p>
                    <p className="mt-1 text-[length:--text-xs] text-text-muted">
                      {revision.wordCount.toLocaleString()} words · parent{' '}
                      {revision.parentRevisionId?.slice(0, 8) || 'root'}
                    </p>
                    <p className="mt-2 truncate font-[--font-mono] text-[10px] text-text-muted">
                      {JSON.stringify(revision.changedScopes)}
                    </p>
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null || revision.id === revisions[0]?.id}
                      onClick={() => void rollback(revision)}
                    >
                      Restore this point
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-[length:--text-sm] text-text-muted">
                Select a book to inspect its revision ancestry.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </PageTransition>
  );
}

function FindingFilter({
  label,
  value,
  onChange,
  options,
  includeAll = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  includeAll?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={`Filter findings by ${label.toLowerCase()}`}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {includeAll && (
          <SelectItem value="all">
            All {label === 'Severity' ? 'severities' : `${label.toLowerCase()}s`}
          </SelectItem>
        )}
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option.replaceAll('_', ' ')}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[--radius-md] border border-border-muted bg-surface-sunken p-3">
      <p className="text-[10px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className="mt-1 truncate font-[--font-mono] text-[length:--text-sm] text-text-primary">
        {value}
      </p>
    </div>
  );
}
