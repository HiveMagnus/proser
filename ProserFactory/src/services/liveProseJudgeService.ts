import { randomUUID } from 'node:crypto';

import logger from '../lib/logger';
import { isBullmqEnabled } from '../queues/featureFlag';
import {
  defaultLiveProseJudgeJobOptions,
  getLiveProseJudgeQueue,
  type LiveProseJudgeCandidatePayload,
  type LiveProseJudgePayload,
} from '../queues/liveProseJudgeQueue';
import type { ProseJudgeResult } from './proseTraceService';
import { proseTraceService } from './proseTraceService';
import { evaluateLiteraryText } from './literaryEvaluationService';

function toFailureLabel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function scoreTier(score: number): string {
  if (score >= 92) return 'excellent';
  if (score >= 84) return 'strong';
  if (score >= 76) return 'workable';
  if (score >= 68) return 'needs_revision';
  return 'weak';
}

function evaluateCandidate(
  payload: LiveProseJudgePayload,
  candidate: LiveProseJudgeCandidatePayload,
  ordinal: number,
): ProseJudgeResult['judgedCandidates'][number] {
  const evaluation = evaluateLiteraryText(candidate.outputText, { genre: payload.genreKey });
  const score = evaluation.overallScore;
  const failureLabels = evaluation.findings.map((item) => toFailureLabel(item.type));

  return {
    candidateId: `local-${payload.traceId}-${ordinal}`,
    ordinal: candidate.ordinal,
    stage: candidate.stage,
    overallScore: score,
    tier: scoreTier(score),
    pass: evaluation.pass,
    confidence: evaluation.confidence,
    failureLabels,
  };
}

export async function submitLiveProseJudge(payload: LiveProseJudgePayload): Promise<ProseJudgeResult> {
  const judgedCandidates = payload.candidates.map((candidate, index) =>
    evaluateCandidate(payload, candidate, index),
  );

  return {
    traceId: payload.traceId,
    evaluationId: randomUUID(),
    genreKey: payload.genreKey ?? null,
    candidateCount: judgedCandidates.length,
    judgedCandidates,
  };
}

export async function enqueueLiveProseJudge(payload: LiveProseJudgePayload): Promise<'queued' | 'completed' | 'failed'> {
  if (isBullmqEnabled()) {
    try {
      const queue = getLiveProseJudgeQueue();
      await queue.add('judge', payload, {
        ...defaultLiveProseJudgeJobOptions,
        jobId: payload.traceId,
      });
      return 'queued';
    } catch (error) {
      logger.warn({ error, traceId: payload.traceId }, 'Failed to enqueue local prose evaluation job');
      return 'failed';
    }
  }

  try {
    const result = await submitLiveProseJudge(payload);
    await proseTraceService.finalizeTraceFromEvaluation(payload.traceId, result);
    return 'completed';
  } catch (error) {
    await proseTraceService.markTraceFailed(
      payload.traceId,
      error instanceof Error ? error.message : String(error),
    );
    logger.warn({ error, traceId: payload.traceId }, 'Local prose evaluation failed');
    return 'failed';
  }
}
