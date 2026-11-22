import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { databaseService } from '@/lib/database';
import { renewWorkflowLease, withWorkflowLease } from '@/services/workflowExecutionContext';

import type { EditorialFinding, EditorialPassDefinition } from './contracts';
import { anchors, sentences, textHash } from './textAnchors';
import type { EditorialSceneScope } from './scopeLoader';
import { CandidateGenerator } from './candidates/candidateGenerator';
import { validateGeneratedCandidate } from './candidates/candidateValidator';
import { blindPairwiseJudge, type StoredBlindEvaluation } from './judging/blindPairwiseJudge';
import { normalizeJudgeResult } from './judging/evaluationNormalizer';
import { escalationDecision } from './judging/judgeEscalation';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => value as Prisma.InputJsonValue;
const workflowLeaseMs = Math.max(30_000, Number.parseInt(process.env.WORKFLOW_LEASE_MS ?? '120000', 10) || 120_000);

export interface PreparedProposal {
  id: string;
  sceneId: number;
  originalText: string;
  startOffset: number;
  endOffset: number;
  sourceHash: string;
  beforeAnchor: string;
  afterAnchor: string;
  finding: EditorialFinding;
}

function passageForFinding(scene: EditorialSceneScope, finding: EditorialFinding): PreparedProposal | null {
  const span = finding.evidence[0];
  if (!span) return null;
  const sentenceRows = sentences(scene.prose);
  const matched = sentenceRows.find((row) => row.start <= span.start && row.end >= span.end);
  if (!matched || matched.text.length > 2_000 || matched.text.split(/\s+/).length > 250) return null;
  const anchor = anchors(scene.prose, matched.start, matched.end);
  return {
    id: randomUUID(), sceneId: scene.id, originalText: matched.text,
    startOffset: matched.start, endOffset: matched.end,
    sourceHash: anchor.sourceHash, beforeAnchor: anchor.beforeAnchor, afterAnchor: anchor.afterAnchor,
    finding,
  };
}

export function prepareProposals(scenes: EditorialSceneScope[], findings: EditorialFinding[], maximum: number): PreparedProposal[] {
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const prepared: PreparedProposal[] = [];
  const fingerprints = new Set<string>();
  for (const finding of findings.filter((item) => item.autofixEligible)) {
    const scene = finding.sceneId ? sceneById.get(finding.sceneId) : undefined;
    if (!scene) continue;
    const proposal = passageForFinding(scene, finding);
    if (!proposal) continue;
    const fingerprint = hash([scene.id, proposal.startOffset, proposal.endOffset, proposal.sourceHash]);
    if (fingerprints.has(fingerprint)) continue;
    if (prepared.some((item) => item.sceneId === scene.id && proposal.startOffset < item.endOffset && proposal.endOffset > item.startOffset)) continue;
    fingerprints.add(fingerprint);
    prepared.push(proposal);
    if (prepared.length >= maximum) break;
  }
  return prepared.sort((left, right) => left.sceneId - right.sceneId || left.startOffset - right.startOffset);
}

export class EditorialProposalService {
  private readonly generator = new CandidateGenerator();
  private get db() { return databaseService.client; }

  async createAndEvaluate(input: {
    workflowRunId: string;
    editorialRunId: string;
    bookId: number;
    sourceRevisionId: string;
    pass: EditorialPassDefinition;
    proposal: PreparedProposal;
    objective: string;
    context: string;
    protectedElements: string[];
    generatorModel?: string;
    maximumEditPercent: number;
    autonomy: 'review_only' | 'propose_only' | 'safe_auto' | 'max_quality_auto';
    maximumJudgeEscalations: number;
    minimumConfidence: number;
    minimumPreferenceMargin: number;
    signal?: AbortSignal;
  }): Promise<{ evaluation: StoredBlindEvaluation; candidateId: string; originalId: string }> {
    const fingerprint = hash([input.sourceRevisionId, input.pass.key, input.proposal.sceneId, input.proposal.sourceHash]);
    const originalId = randomUUID();
    await withWorkflowLease(input.workflowRunId, async (tx) => {
      await tx.editorialProposal.create({ data: {
        id: input.proposal.id,
        editorialRunId: input.editorialRunId,
        sourceRevisionId: input.sourceRevisionId,
        bookId: input.bookId,
        scopeType: 'scene',
        scopeId: input.proposal.sceneId,
        passKey: input.pass.key,
        passVersion: input.pass.version,
        risk: input.proposal.finding.risk,
        confidence: input.proposal.finding.confidence,
        fingerprint,
        sourceHash: input.proposal.sourceHash,
        originalText: input.proposal.originalText,
        beforeAnchor: input.proposal.beforeAnchor,
        afterAnchor: input.proposal.afterAnchor,
        startOffset: input.proposal.startOffset,
        endOffset: input.proposal.endOffset,
        expectedBenefits: json([input.proposal.finding.category]),
        protectedClaims: json(input.protectedElements),
        findingIds: json([input.proposal.finding.id]),
        detectorIds: json([`${input.proposal.finding.detectorKey}@${input.proposal.finding.detectorVersion}`]),
      } });
      await tx.editorialCandidate.create({ data: {
        id: originalId, proposalId: input.proposal.id, ordinal: 0, candidateType: 'original',
        outputText: input.proposal.originalText, outputHash: textHash(input.proposal.originalText),
        wordCount: input.proposal.originalText.split(/\s+/).filter(Boolean).length,
        metadata: json({ auditOnly: true }),
      } });
    });
    const generated = await this.generator.generate({
      original: input.proposal.originalText,
      surroundingContext: input.context,
      objective: input.objective,
      pass: input.pass,
      protectedElements: input.protectedElements,
      model: input.generatorModel,
      maximumEditPercent: input.maximumEditPercent,
      signal: input.signal,
    });
    // The generator is the long-running inference boundary. Renew and recheck
    // before any generated output or evaluation is written.
    await renewWorkflowLease(input.workflowRunId, workflowLeaseMs);
    const candidateValidation = validateGeneratedCandidate({
      value: generated.text,
      original: input.proposal.originalText,
      sourceHash: input.proposal.sourceHash,
      pass: input.pass,
      protectedElements: input.protectedElements,
      maximumEditPercent: input.maximumEditPercent,
    });
    if (!generated.valid || !candidateValidation.verification.passed) {
      throw new Error(`EDITORIAL_CANDIDATE_INVALID:${[...generated.validationFailures, ...candidateValidation.verification.failures].join(',')}`);
    }
    const candidateId = randomUUID();
    const evaluation = blindPairwiseJudge({
      proposalId: input.proposal.id,
      original: { id: originalId, text: input.proposal.originalText },
      candidate: { id: candidateId, text: candidateValidation.normalized },
      protectedElements: input.protectedElements,
      expectedSourceHash: input.proposal.sourceHash,
      maximumEditPercent: input.maximumEditPercent,
    });
    evaluation.result = normalizeJudgeResult(evaluation.result);
    const evaluations: StoredBlindEvaluation[] = [evaluation];
    let escalation = escalationDecision({
      autonomy: input.autonomy,
      results: evaluations.map((item) => item.result),
      maximumEscalations: input.maximumJudgeEscalations,
      minimumConfidence: input.minimumConfidence,
      minimumMargin: input.minimumPreferenceMargin,
      inferenceBudgetRemaining: true,
    });
    if (escalation.action === 'run_second') {
      evaluations.push(blindPairwiseJudge({
        proposalId: input.proposal.id,
        original: { id: originalId, text: input.proposal.originalText },
        candidate: { id: candidateId, text: candidateValidation.normalized },
        protectedElements: input.protectedElements,
        expectedSourceHash: input.proposal.sourceHash,
        maximumEditPercent: input.maximumEditPercent,
        seed: `${input.proposal.id}:independent-second`,
      }));
      escalation = escalationDecision({
        autonomy: input.autonomy,
        results: evaluations.map((item) => item.result),
        maximumEscalations: input.maximumJudgeEscalations,
        minimumConfidence: input.minimumConfidence,
        minimumMargin: input.minimumPreferenceMargin,
        inferenceBudgetRemaining: true,
      });
    }
    if (escalation.action === 'run_tiebreaker') {
      evaluations.push(blindPairwiseJudge({
        proposalId: input.proposal.id,
        original: { id: originalId, text: input.proposal.originalText },
        candidate: { id: candidateId, text: candidateValidation.normalized },
        protectedElements: input.protectedElements,
        expectedSourceHash: input.proposal.sourceHash,
        maximumEditPercent: input.maximumEditPercent,
        seed: `${input.proposal.id}:bounded-tiebreaker`,
      }));
    }
    await withWorkflowLease(input.workflowRunId, async (tx) => {
      await tx.editorialCandidate.create({ data: {
        id: candidateId, proposalId: input.proposal.id, ordinal: 1, candidateType: 'generated',
        producerProfile: 'editorial-generator-v1', producerModel: generated.model,
        recipeVersion: generated.recipeVersion, samplingHash: generated.samplingHash, ragHash: generated.ragHash,
        outputText: candidateValidation.normalized, outputHash: textHash(candidateValidation.normalized),
        wordCount: candidateValidation.normalized.split(/\s+/).filter(Boolean).length,
        metadata: json({ valid: generated.valid, validationFailures: generated.validationFailures }),
      } });
      for (const [index, item] of evaluations.entries()) await tx.editorialEvaluation.create({ data: {
        id: randomUUID(), proposalId: input.proposal.id,
        evaluatorProfile: index === 0 ? 'blind_pairwise_v1' : index === 1 ? 'blind_pairwise_adversarial_v1' : 'blind_pairwise_tiebreak_v1',
        evaluatorVersion: '1.0.0', evaluatorModel: 'deterministic-literary-rubric',
        promptRecipe: index === 0 ? 'blind-pairwise-v1' : 'blind-pairwise-independent-v1',
        candidateOrder: json(item.candidateOrder), verdict: item.result.verdict,
        preferredCandidateId: item.preferredCandidateId, confidence: item.result.confidence,
        preferenceMargin: item.result.preferenceMargin, dimensionScores: json(item.result.dimensionScores),
        rationale: item.result.rationale.slice(0, 2_000),
        hardCheckSummary: json({ concerns: item.result.invariantConcerns }),
        metadata: json({ preferredLabel: item.result.preferredLabel, evidence: item.result.evidence, identityBlind: true }),
      } });
    });
    const candidateVotes = evaluations.filter((item) => item.result.verdict === 'candidate_wins').length;
    const originalVotes = evaluations.filter((item) => item.result.verdict === 'original_wins').length;
    evaluation.judgeCount = evaluations.length;
    evaluation.judgesAgree = candidateVotes === evaluations.length || originalVotes === evaluations.length;
    if (evaluations.length > 1 && candidateVotes < 2) {
      evaluation.result = { ...evaluation.result, verdict: originalVotes ? 'original_wins' : 'no_clear_winner', preferredLabel: originalVotes ? evaluation.result.preferredLabel : null };
      evaluation.preferredCandidateId = originalVotes ? originalId : null;
    }
    return { evaluation, candidateId, originalId };
  }
}
