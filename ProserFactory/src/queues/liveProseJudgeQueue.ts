import { JobsOptions, Queue, QueueEvents } from 'bullmq';
import { buildQueueBaseOptions, buildQueueEventsOptions } from './connection';
import type { CanonicalGenreKey } from '../lib/genre/normalize';

export const LIVE_PROSE_JUDGE_QUEUE_NAME = 'live-prose-judge';

export type LiveProseJudgeCandidatePayload = {
  ordinal: number;
  stage: 'draft' | 'final';
  candidateType: 'base' | 'adapter' | 'revised' | 'generated';
  selectionLabel?: string;
  accepted?: boolean;
  rejected?: boolean;
  outputText: string;
  wordCount?: number;
  metadata?: Record<string, unknown>;
};

export type LiveProseJudgePayload = {
  traceId: string;
  externalRef: string;
  taskFamily: 'prose';
  traceType: 'scene-prose';
  bookId: number;
  sceneId?: number;
  chapterId?: number;
  genre?: string | null;
  genreKey?: CanonicalGenreKey | null;
  archetype?: string | null;
  instructions?: string;
  prompt?: string;
  brief?: string;
  recipeVersion: string;
  model?: string;
  adapterUsed?: string | null;
  validatorSummary?: Record<string, unknown>;
  promptContext?: Record<string, unknown>;
  candidates: LiveProseJudgeCandidatePayload[];
};

export function getLiveProseJudgeQueue(): Queue<LiveProseJudgePayload> {
  return new Queue<LiveProseJudgePayload>(LIVE_PROSE_JUDGE_QUEUE_NAME, buildQueueBaseOptions());
}

export function getLiveProseJudgeQueueEvents(): QueueEvents {
  return new QueueEvents(LIVE_PROSE_JUDGE_QUEUE_NAME, buildQueueEventsOptions());
}

export const defaultLiveProseJudgeJobOptions: JobsOptions = {
  removeOnComplete: 1000,
  removeOnFail: 1000,
  attempts: 5,
  backoff: { type: 'exponential', delay: 15000 },
  keepLogs: 20,
};
