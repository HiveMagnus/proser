import { processCampaignAnalysis } from '@/documents/campaignWorkflow';
import {DocumentError} from '@/documents/errors';
import {assertNewReleaseAdmission,bindReleaseAdmission,runAdmittedBackground} from '@/operations/releaseAdmission';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, QualityFinding, WorkflowRun } from '@prisma/client';

import { databaseService } from '@/lib/database';
import { defaultModelRouter } from '@/lib/ai/router';
import { VllmService, type AIProvider } from '@/lib/ai/vllm';
import { InferenceTerminalError, TERMINAL_REASON_POLICIES } from '@/lib/ai/terminalReason';
import { inferenceParams, type InferenceProfileName } from '@/lib/ai/inferenceProfiles';
import { SceneProseService } from '@/services/sceneProseService';
import { scenesService } from '@/services/scenesService';
import { getWorkflowQueue } from '@/queues/workflowQueue';
import { documentAuthorityEnabled, documentService } from '@/documents/service';
import { canonicalDocument } from '@/documents/model';
import { reviewStateAtRevision } from '@/documents/reviewState';
import { compatibilityOperationId } from '@/documents/operationIdentity';
import { runWorkflowEffect, workflowEffectNeedsRecovery } from '@/documents/workflowEffects';
import { workflowProseCandidate, workflowProseRevision } from '@/documents/workflowProse';
import { commitWorkflowDraft } from '@/documents/workflowDraft';
import { workflowCheckpointSource, assertWorkflowCheckpointSource } from '@/documents/workflowCheckpoint';
import { withRetry } from '@/lib/resilience';
import { appendHierarchy, type OutlineTree } from '@/documents/structureCommands';
import type { DocumentMutationPreconditions } from '@/documents/scope-model';
import { manuscriptRevisionService, safeRevision } from '@/services/manuscriptRevisionService';
import { characterAliases, findCharacterMention } from '@/lib/reviews/characterNameMatcher';
import { createPublicationPackage, readPublicationArtifact } from '@/services/publicationPackageService';
import { evaluateLiteraryText } from '@/services/literaryEvaluationService';
import { createWorkflowEnqueue, dispatchWorkflowOutbox } from '@/queues/workflowOutbox';
import { assertWorkflowLease, currentWorkflowExecution, renewWorkflowLease, runWithWorkflowExecution, withWorkflowLease } from '@/services/workflowExecutionContext';
import { globalAbortRegistry } from '@/events/abortRegistry';
import { classifyWorkflowFailure } from '@/services/workflowFailure';
import type { EditorialOptimizeInput } from '@/services/editorial/contracts';
import { EDITORIAL_POLICY_VERSION, EDITORIAL_LIMITS } from '@/services/editorial/editorialPolicy';
import { getEditorialPass } from '@/services/editorial/passRegistry';
import { editorialWorkflowService } from '@/services/editorial/editorialWorkflowService';
import { assertSharedResourceOperationCurrent, bindSharedResourceExecution, sealSharedResourceOperation, sharedResourceExecutionOperation } from '@/services/sharedResourceService';
import { assertBookAiAllowed, isBookAiDisabledError, runWithAiBookScope } from '@/lib/ai/bookAiPolicy';

export type WorkflowType = 'revision_campaign_analysis' | 'full_book' | 'quality_review' | 'improve_quality' | 'guided_improve' | 'editorial_optimize';
export type WorkflowScope = { type: 'book' | 'act' | 'chapter' | 'scene'; id?: number };

export interface FullBookInput {
  bookId?: number;
  premise: string;
  title?: string;
  genre?: string;
  audience?: string;
  targetWords?: number;
  pov?: string;
  tense?: string;
  style?: string;
  mustInclude?: string[];
  mustAvoid?: string[];
  candidateCount?: number;
  reviewModels?: string[];
  maxEditorialRounds?: number;
}

export interface QualityReviewInput { bookId: number; scope: WorkflowScope; model: string; rubricVersion: string }
export interface ImproveQualityInput { bookId: number; reviewRunIds: string[]; findingIds?: string[]; model?: string }
export interface GuidedImproveInput { bookId: number; instruction: string; scope?: WorkflowScope; model?: string; acceptanceCriteria?: string[] }

type AnyInput = FullBookInput | QualityReviewInput | ImproveQualityInput | GuidedImproveInput | EditorialOptimizeInput;

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => value as Prisma.InputJsonValue;
const chapterOrder: Prisma.ChapterOrderByWithRelationInput[] = [{ act: { actNumber: 'asc' } }, { chapterNumber: 'asc' }, { id: 'asc' }];
const sceneOrder: Prisma.SceneOrderByWithRelationInput[] = [{ chapter: { act: { actNumber: 'asc' } } }, { chapter: { chapterNumber: 'asc' } }, { chapterId: 'asc' }, { sceneNumber: 'asc' }, { id: 'asc' }];
export const TERMINAL_WORKFLOW_STATUSES = new Set([
  'completed',
  'cancelled',
  'failed',
  'publishable_candidate',
  'release_approved',
]);
const nonWaivableRevisionReasons = new Set(['truncated_or_empty', 'meta_or_placeholder_text']);
const workflowLeaseMs = Math.max(30_000, Number.parseInt(process.env.WORKFLOW_LEASE_MS ?? '120000', 10) || 120_000);

function boundedFailureReason(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason ?? 'Unknown generation failure');
  return message.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300);
}

function checkpointProposalSummary(proposal: Prisma.JsonValue): { summary: string; artifactRefs: string[] } {
  const artifactRefs = new Set<string>();
  const visit = (value: Prisma.JsonValue, key = ''): void => {
    if (artifactRefs.size >= 12) return;
    if (typeof value === 'string' && /(?:artifact|revision|review|run|scene|chapter|act).*id/i.test(key)) {
      artifactRefs.add(`${key}:${value}`.slice(0, 180));
      return;
    }
    if (Array.isArray(value)) value.slice(0, 20).forEach((entry) => visit(entry, key));
    else if (value && typeof value === 'object') Object.entries(value).slice(0, 30).forEach(([childKey, child]) => visit(child as Prisma.JsonValue, childKey));
  };
  visit(proposal);
  const kind = Array.isArray(proposal) ? `array with ${proposal.length} items` : proposal && typeof proposal === 'object'
    ? `object with ${Object.keys(proposal).length} fields: ${Object.keys(proposal).slice(0, 8).join(', ')}`
    : String(proposal);
  return { summary: kind.slice(0, 500), artifactRefs: [...artifactRefs] };
}

function extractObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const parsed = JSON.parse(text.slice(start, end + 1)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}

const qualityReviewSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['findings'], properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['category', 'severity', 'confidence', 'message', 'evidence', 'recommendation'], properties: {
      category: { type: 'string', enum: ['clarity', 'grammar', 'punctuation', 'repetition', 'cadence', 'specificity', 'continuity', 'pacing', 'voice', 'structure', 'canon', 'promise_payoff'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, confidence: { type: 'number', minimum: 0, maximum: 1 },
      message: { type: 'string' }, evidence: { type: ['string', 'null'] }, recommendation: { type: ['string', 'null'] },
    } } },
  },
};

const findingVerificationSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['resolved', 'rationale'], properties: {
    resolved: { type: 'boolean' }, rationale: { type: 'string' },
  },
};

const relationshipPatchSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['replacements'], properties: {
    replacements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: {
      from: { type: 'string' }, to: { type: 'string' },
    } } },
  },
};

function architectureSchema(chapterCount: number, scenesPerChapter: number): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required: ['title', 'summary', 'styleBible', 'characters', 'chapters'], properties: {
    title: { type: 'string' }, summary: { type: 'string' },
    styleBible: { type: 'object', additionalProperties: false, required: ['voice', 'pov', 'tense', 'constraints'], properties: {
      voice: { type: 'string' }, pov: { type: 'string' }, tense: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } },
    } },
    characters: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['name', 'role', 'goal', 'conflict', 'arc', 'aliases'], properties: {
      name: { type: 'string' }, role: { type: 'string' }, goal: { type: 'string' }, conflict: { type: 'string' }, arc: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } },
    } } },
    chapters: { type: 'array', minItems: chapterCount, maxItems: chapterCount, items: { type: 'object', additionalProperties: false, required: ['title', 'summary', 'scenes'], properties: {
      title: { type: 'string' }, summary: { type: 'string' }, scenes: { type: 'array', minItems: scenesPerChapter, maxItems: scenesPerChapter, items: { type: 'string' } },
    } } },
  } };
}

function openingExcerpt(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const bounded = text.slice(0, maximum);
  const boundary = bounded.lastIndexOf(' ');
  return `${bounded.slice(0, boundary > maximum * 0.8 ? boundary : maximum).trimEnd()}\n[Middle intentionally omitted from review context]`;
}

function endingExcerpt(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const bounded = text.slice(-maximum);
  const boundary = bounded.indexOf(' ');
  return `[Middle intentionally omitted from review context]\n${bounded.slice(boundary >= 0 && boundary < maximum * 0.2 ? boundary + 1 : 0).trimStart()}`;
}

function findingFingerprint(input: { scopeType: string; scopeId?: number | null; category: string; message: string; evidence?: string | null }) {
  return sha([input.scopeType, input.scopeId ?? '', input.category.toLowerCase(), input.message.toLowerCase().replace(/\W+/g, ' ').trim(), input.evidence?.toLowerCase().replace(/\W+/g, ' ').trim() ?? '']).slice(0, 40);
}

function normalizeQuote(value: string): string {
  return value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().replace(/^['"]|['"]$/g, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function evidenceMatches(source: string, evidence: string): boolean {
  const haystack = normalizeQuote(source).toLowerCase();
  const fragments = evidence
    .split(/\s*(?:\.{3}|…|\[\.\.\.\]|\[middle intentionally omitted[^\]]*\]|\s\/\s)\s*/i)
    .map((fragment) => normalizeQuote(fragment.replace(/^\[(?:prose|outline|contract)\]\s*/i, '')).toLowerCase())
    .filter((fragment) => fragment.length >= 3);
  return fragments.length > 0 && fragments.every((fragment) => haystack.includes(fragment));
}

export function isLocalizedReviewFinding(category: string, recommendation: string | null): boolean {
  const repair = recommendation?.trim() ?? '';
  const localizedVerb = /^(?:clarify|show|add|append|remove|change|adjust|update|specify|insert|replace|introduce|align|correct|revise|standardize|unify|trim|move|begin|cut|retain|ensure|verify|have|include|rephrase|transition|either)\b/i.test(repair)
    || /^[A-Z][\p{L}’'-]*\s+should\b/u.test(repair);
  const canonIdentityChange = category.toLowerCase() === 'canon' && /\b(?:name|alias|identity|gender|sister|brother|mother|father|daughter|son)\b/i.test(repair);
  return /\b(?:grammar|punctuation|repetition|cadence|clarity|specificity|voice)\b/i.test(category) || (localizedVerb && !canonIdentityChange);
}

const qualityFindingCategories = new Set(['clarity', 'grammar', 'punctuation', 'repetition', 'cadence', 'specificity', 'continuity', 'pacing', 'voice', 'structure', 'canon', 'promise_payoff']);
export function normalizeFindingCategory(value: unknown): string {
  const normalized = String(value ?? 'clarity').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (qualityFindingCategories.has(normalized)) return normalized;
  if (['logic', 'logic_consistency', 'spatial_consistency', 'chronology'].includes(normalized)) return 'continuity';
  if (['info_dump', 'show_dont_tell', 'readability', 'quality'].includes(normalized)) return 'clarity';
  return 'clarity';
}

type CanonCharacter = { entryName: string; entryDescription: string | null; attributes: string | null };

function canonicalContext(characters: CanonCharacter[]): string {
  return characters.map((character) => {
    let aliases: string[] = [];
    try {
      const attributes = character.attributes ? JSON.parse(character.attributes) as { aliases?: unknown } : {};
      if (Array.isArray(attributes.aliases)) aliases = attributes.aliases.filter((alias): alias is string => typeof alias === 'string');
    } catch { /* A malformed optional attribute must not hide the authoritative description. */ }
    return `- ${character.entryName}${aliases.length ? ` (aliases: ${aliases.join(', ')})` : ''}: ${character.entryDescription ?? 'No description recorded.'}`;
  }).join('\n');
}

function canonicalRelationshipContradictions(text: string, characters: CanonCharacter[]): number {
  let contradictions = 0;
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const character of characters) {
    const facts = `${character.entryName} ${character.entryDescription ?? ''}`.toLowerCase();
    const expected = /\b(?:sister|mother|daughter|woman|girl|female|heroine)\b/.test(facts) ? 'female'
      : /\b(?:brother|father|son|man|boy|male|hero)\b/.test(facts) ? 'male' : null;
    if (!expected) continue;
    let aliases: string[] = [];
    try {
      const attributes = character.attributes ? JSON.parse(character.attributes) as { aliases?: unknown } : {};
      if (Array.isArray(attributes.aliases)) aliases = attributes.aliases.filter((alias): alias is string => typeof alias === 'string');
    } catch { /* Ignore malformed optional aliases and retain full/first-name matching. */ }
    const names = [...new Set([character.entryName, character.entryName.split(/\s+/)[0], ...aliases].filter(Boolean))];
    const mentioned = new RegExp(`\\b(?:${names.map(escapeRegex).join('|')})\\b`, 'i');
    for (const sentence of sentences) {
      if (!mentioned.test(sentence)) continue;
      const normalized = sentence.toLowerCase();
      if (expected === 'female' && /\b(?:his|him|he|brother|father|son|man|boy|male)\b/.test(normalized)) contradictions += 1;
      if (expected === 'male' && /\b(?:hers|her|she|sister|mother|daughter|woman|girl|female)\b/.test(normalized)) contradictions += 1;
    }
  }
  return contradictions;
}

export function revisionSafety(original: string, revised: string, characters: CanonCharacter[]) {
  const safety = safeRevision(original, revised);
  if (canonicalRelationshipContradictions(revised, characters) > canonicalRelationshipContradictions(original, characters)) {
    safety.reasons.push('canon_relationship_changed');
    safety.safe = false;
  }
  return safety;
}

export function relationshipOnlyReplacement(original: string, revised: string): boolean {
  const words = (value: string) => value.match(/[\p{L}’']+/gu) ?? [];
  const before = words(original); const after = words(revised);
  if (before.length !== after.length) return false;
  const allowed = new Set(['he', 'him', 'his', 'brother', 'father', 'son', 'man', 'boy', 'male', 'she', 'her', 'hers', 'sister', 'mother', 'daughter', 'woman', 'girl', 'female']);
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] === after[index]) continue;
    if (!allowed.has(before[index].toLowerCase()) || !allowed.has(after[index].toLowerCase())) return false;
  }
  return true;
}

export function parseExactReplacements(instruction: string): Array<{ from: string; to: string }> {
  const quoted = [...instruction.matchAll(/replace exactly\s+"([^"]+)"\s+with\s+"([^"]+)"/gi)].map((match) => ({ from: match[1], to: match[2] }));
  const blocks = [...instruction.matchAll(/replace exactly\s+\[\[FROM\]\]([\s\S]*?)\[\[WITH\]\]([\s\S]*?)\[\[END\]\]/gi)].map((match) => ({ from: match[1], to: match[2] }));
  return [...quoted, ...blocks];
}

export function releaseReviewDisposition(
  revisionId: string,
  childReviews: Array<{ sourceRevisionId: string; status: string; workflowRunId: string; workflowRun: { status: string } }>,
): { action: 'start' | 'process' | 'blocked' | 'none'; runId?: string } {
  const current = childReviews.filter((review) => review.sourceRevisionId === revisionId);
  if (current.some((review) => review.status === 'completed' && review.workflowRun.status === 'completed')) return { action: 'none' };
  const recoverable = current.find((review) => ['queued', 'running', 'failed'].includes(review.workflowRun.status));
  if (recoverable) return { action: 'process', runId: recoverable.workflowRunId };
  const blocked = current.find((review) => ['paused', 'awaiting_approval'].includes(review.workflowRun.status));
  if (blocked) return { action: 'blocked', runId: blocked.workflowRunId };
  return { action: 'start' };
}

export function releaseReviewIdempotencyKey(parentRunId: string, revisionId: string): string {
  return `release-review:${parentRunId}:${revisionId}`;
}

export function scoreSceneCandidate(prose: string, wordCount: number, targetWords: number, genre: string | null, outline: string | null) {
  const evaluation = evaluateLiteraryText(prose, { genre, contract: { causalContract: outline ?? '', requiredMovement: 'goal opposition choice changed story state exit hook' } });
  const contractDimensions = new Set(['scenePurpose', 'causalMovement', 'continuity', 'endingStrength']);
  const contractRows = evaluation.dimensions.filter((dimension) => contractDimensions.has(dimension.dimension));
  const contractScore = contractRows.reduce((sum, dimension) => sum + dimension.score, 0) / Math.max(contractRows.length, 1);
  const lengthScore = Math.max(0, 100 - Math.abs(wordCount - targetWords) / Math.max(targetWords, 1) * 100);
  return { contractScore, literaryScore: evaluation.overallScore, lengthScore, selectionScore: contractScore * 0.55 + evaluation.overallScore * 0.25 + lengthScore * 0.2 };
}

export function scoreQualityFindings(findings: Array<{ severity: string; confidence: number }>, sceneCount: number): number {
  if (!findings.length) return 100;
  const weights: Record<string, number> = { critical: 20, high: 10, medium: 3, low: 1 };
  const weighted = findings.reduce((sum, finding) => sum + (weights[finding.severity] ?? 3) * Math.max(0, Math.min(1, finding.confidence)), 0);
  const maximumSeverityPenalty = Math.max(...findings.map((finding) => (weights[finding.severity] ?? 3) * Math.max(0, Math.min(1, finding.confidence))));
  return Math.max(0, Math.round((100 - weighted / Math.sqrt(Math.max(sceneCount, 1)) - maximumSeverityPenalty) * 10) / 10);
}

class WorkflowService {
  private get db() { return databaseService.client; }
  private readonly prose = new SceneProseService();

  private async event(runId: string, eventType: string, data?: unknown) {
    await this.db.workflowEvent.create({ data: { runId, eventType, data: data === undefined ? undefined : json(data) } });
  }

  async heartbeat(runId: string, leaseOwner?: string) {
    const owner = leaseOwner ?? currentWorkflowExecution()?.leaseOwner;
    if (!owner) return;
    const context = currentWorkflowExecution();
    if (context?.runId === runId && context.leaseOwner === owner) {
      try {
        await renewWorkflowLease(runId, workflowLeaseMs);
      } catch {
        globalAbortRegistry.abort(runId);
      }
      return;
    }
    const now = new Date();
    const renewed = await this.db.workflowRun.updateMany({
      where: {
        id: runId,
        status: 'running',
        cancelRequested: false,
        leaseOwner: owner,
        leaseExpiresAt: { gt: now },
      },
      data: { lastHeartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + workflowLeaseMs) },
    });
    if (renewed.count !== 1) globalAbortRegistry.abort(runId);
  }

  private async ownedRun(userId: number, runId: string) {
    const run = await this.db.workflowRun.findFirst({ where: { id: runId, userId } });
    if (!run) throw new Error(`Workflow ${runId} not found`);
    return run;
  }

  async start(userId: number, workflowType: WorkflowType, input: AnyInput, parentRunId?: string, enqueue = true, actorGithubId?: string, idempotencyKey?: string, acceptanceSignal?: AbortSignal, sharedResourceOperationId?: string) {
    acceptanceSignal?.throwIfAborted();
    const configHash = sha({ workflowType, input, parentRunId: parentRunId ?? null });
    const durableKey = (idempotencyKey ?? (parentRunId ? `child:${parentRunId}:${configHash}` : `internal:${configHash}`)).trim();
    if (!durableKey || durableKey.length > 200) throw new Error('A valid idempotency key is required');
    const existing = await this.db.workflowRun.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: durableKey } } });
    if (existing) {
      if (sharedResourceOperationId) {
        await this.db.$transaction((tx) => bindSharedResourceExecution(tx, sharedResourceOperationId, 'workflow', existing.id));
      }
      return this.status(userId, existing.id);
    }
    await assertNewReleaseAdmission();
    const requestedBookId = workflowType === 'full_book' ? (input as FullBookInput).bookId : Number((input as QualityReviewInput | ImproveQualityInput | GuidedImproveInput | EditorialOptimizeInput).bookId);
    if (requestedBookId) {
      const owned = await this.db.book.count({ where: { id: requestedBookId, userId, deletedAt: null } });
      if (owned !== 1) throw new Error(`Book ${requestedBookId} not found`);
    }
    acceptanceSignal?.throwIfAborted();
    const sourceRevisionId = requestedBookId ? await manuscriptRevisionService.current(requestedBookId, acceptanceSignal) : null;
    acceptanceSignal?.throwIfAborted();
    if (workflowType === 'quality_review' && !sourceRevisionId) throw new Error('Quality Review requires a source manuscript revision');
    if (workflowType === 'editorial_optimize') {
      if (!sourceRevisionId) throw new Error('Editorial Optimize requires a source manuscript revision');
      const [activeUser, activeGlobal] = await Promise.all([
        this.db.workflowRun.count({ where: { userId, workflowType, status: { in: ['queued', 'running'] } } }),
        this.db.workflowRun.count({ where: { workflowType, status: { in: ['queued', 'running'] } } }),
      ]);
      if (activeUser >= EDITORIAL_LIMITS.maxActivePerUser || activeGlobal >= EDITORIAL_LIMITS.maxActiveGlobal) throw new Error('Editorial workflow concurrency limit reached');
    }
    let runId: string;
    try {
      runId = await this.db.$transaction(async (tx) => {
        acceptanceSignal?.throwIfAborted();
        let bookId = requestedBookId;
        // Ownership was validated before entering the transaction. For an
        // existing book the first statement here remains a write so the create
        // and subsequent workflow mutations stay in one transaction.
        if (!bookId && workflowType === 'full_book') {
          const full = input as FullBookInput;
          const data = {
            userId, title: full.title ?? 'Untitled Book', summary: full.premise,
            genre: full.genre ?? 'fiction', targetAudience: full.audience ?? 'adult', draftStatus: 'planning',
          };
          const book = documentAuthorityEnabled() ? (await documentService.createBookRecord(tx, userId, data, compatibilityOperationId('proser.workflow-book.v1', { userId, durableKey }))).result : await tx.book.create({ data });
          bookId = book.id;
        }
        acceptanceSignal?.throwIfAborted();
        if (!bookId) throw new Error('bookId is required');
        const id = randomUUID();
        await assertNewReleaseAdmission(tx);
        await tx.workflowRun.create({ data: {
          id, workflowType, parentRunId, executionParentRunId: parentRunId, bookId, userId, sourceRevisionId,
          idempotencyKey: durableKey, status: 'queued', phase: 'queued', settings: json(input), configHash,
          modelPolicy: json(this.modelPolicy(workflowType, input)), progress: json({ completed: 0, total: 1, percent: 0 }),
        } });
        await bindReleaseAdmission(tx, 'workflow', id, {bookId,revisionId:sourceRevisionId??undefined});
        await tx.workflowTask.create({ data: {
          id: randomUUID(), runId: id, taskKey: `${workflowType}:root`, taskType: workflowType,
          phase: 'queued', scopeType: 'book', scopeId: String(bookId), ordinal: 0, dependencies: json([]), status: 'pending', inputRevisionId: sourceRevisionId,
        } });
        acceptanceSignal?.throwIfAborted();
        if (workflowType === 'quality_review') {
          const review = input as QualityReviewInput;
          await tx.qualityReviewRun.create({ data: {
            id: randomUUID(), workflowRunId: id, bookId, sourceRevisionId: sourceRevisionId!,
            modelUsed: review.model, rubricVersion: review.rubricVersion, promptRecipe: 'quality-review-v1',
            scopeType: review.scope.type, scopeId: review.scope.id ?? null, coverage: json({ scene: 0, chapter: 0, act: 0, book: 0 }),
          } });
        }
        if (workflowType === 'editorial_optimize') {
          const editorial = input as EditorialOptimizeInput;
          const pass = getEditorialPass(editorial.passPack);
          await tx.editorialRun.create({ data: {
            id: randomUUID(), workflowRunId: id, bookId, sourceRevisionId: sourceRevisionId!,
            profileId: editorial.profileId, passPackKey: pass.key, passPackVersion: pass.version,
            policyVersion: EDITORIAL_POLICY_VERSION, autonomy: editorial.autonomy,
            scopeType: editorial.scope.type, scopeId: editorial.scope.id ?? null,
            requestConfig: json(editorial),
          } });
        }
        acceptanceSignal?.throwIfAborted();
        await tx.workflowEvent.create({ data: { runId: id, eventType: 'queued', data: json({ workflowType, bookId, sourceRevisionId, actorGithubId }) } });
        if (sharedResourceOperationId) {
          await bindSharedResourceExecution(tx, sharedResourceOperationId, 'workflow', id);
        }
        if (enqueue) {
          acceptanceSignal?.throwIfAborted();
          await createWorkflowEnqueue(tx, id, userId, 'workflow_created', `create:${userId}:${durableKey}`);
        }
        acceptanceSignal?.throwIfAborted();
        return id;
      });
    } catch (error) {
      const winner = await this.db.workflowRun.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: durableKey } } });
      if (!winner) throw error;
      runId = winner.id;
      if (sharedResourceOperationId) {
        await this.db.$transaction((tx) => bindSharedResourceExecution(tx, sharedResourceOperationId, 'workflow', runId));
      }
    }
    acceptanceSignal?.throwIfAborted();
    if (enqueue && process.env.NODE_ENV !== 'test') await dispatchWorkflowOutbox([runId]);
    acceptanceSignal?.throwIfAborted();
    const status = await this.status(userId, runId);
    acceptanceSignal?.throwIfAborted();
    return status;
  }

  private modelPolicy(type: WorkflowType, input: AnyInput) {
    if (type === 'full_book') return { models: (input as FullBookInput).reviewModels ?? [], candidateCount: (input as FullBookInput).candidateCount ?? 2 };
    if (type === 'editorial_optimize') return (input as EditorialOptimizeInput).modelPolicy ?? {};
    return { model: (input as QualityReviewInput | ImproveQualityInput | GuidedImproveInput).model ?? null };
  }

  async listBookRuns(userId: number, bookId: number) {
    const book = await this.db.book.findFirst({ where: { id: bookId, userId, deletedAt: null }, select: { id: true } });
    if (!book) throw new Error('Book not found');
    const runs = await this.db.workflowRun.findMany({
      where: { bookId, userId, parentRunId: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      take: 100,
    });
    return Promise.all(runs.map((run) => this.status(userId, run.id)));
  }

  private async reviewWorkflowProse(run: WorkflowRun, scene: { id: number; prose: string | null }, source: Awaited<ReturnType<typeof documentService.read>> | undefined, effectKey: string, instruction: Parameters<SceneProseService['reviewProse']>[1], options: Parameters<SceneProseService['reviewProse']>[2]) {
    const original = scene.prose ?? '';
    return source ? workflowProseRevision(this.prose, { userId: run.userId, bookId: run.bookId, runId: run.id, sceneId: scene.id, effectKey, source, original, instruction, options: options ?? {} }) : this.prose.reviewProse(original, instruction, options);
  }

  private async structuredObject(
    provider: AIProvider,
    prompt: string,
    validate: (value: Record<string, unknown>) => boolean,
    label: string,
    schema: Record<string, unknown>,
    profile: InferenceProfileName = 'structured',
    sourceRevisionId?: string,
  ): Promise<Record<string, unknown>> {
    let prior = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const request = `${prompt}${prior}\nReturn one complete JSON object only. Do not use Markdown fences or commentary.`;
      const params = inferenceParams(profile, { maxTokens: profile === 'planning' ? 8192 : 4096 });
      const perform = async (frozen: { request: string; params: typeof params; schema: Record<string, unknown> }, signal?: AbortSignal) => withRetry(async (timeoutSignal) => {
        const combined = signal ? AbortSignal.any([signal,timeoutSignal]) : timeoutSignal;
        let raw: string;
        if (provider.generateChatCompletion) {
          const result = await provider.generateChatCompletion({
            messages: [{ role: 'system', content: 'Return only the JSON object required by the supplied schema. Do not include Markdown or commentary.' }, { role: 'user', content: frozen.request }],
            responseFormat: { type: 'json_schema', json_schema: { name: label.toLowerCase().replace(/\W+/g, '_').slice(0,48), strict: true, schema: frozen.schema } },
            thinking: frozen.params.glmThinking ? 'enabled' : 'disabled', thinkingBudgetTokens: frozen.params.thinkingBudgetTokens,
            temperature: frozen.params.temperature, topP: frozen.params.topP, topK: frozen.params.topK, minP: frozen.params.minP,
            presencePenalty: frozen.params.presencePenalty, repeatPenalty: frozen.params.repeatPenalty, maxTokens: frozen.params.maxTokens,
            signal: combined, terminalPolicy: TERMINAL_REASON_POLICIES.structured,
          });
          raw = result.message.content ?? '';
        } else raw = await provider.generateText({ prompt: frozen.request, params: frozen.params, signal: combined, terminalPolicy: TERMINAL_REASON_POLICIES.structured });
        const metadata = provider instanceof VllmService ? provider.getLastInferenceMetadata() : null;
        return { raw, provenance: { providerId: provider.id, configuredModel: provider.getModel?.(), reportedModel: metadata?.reportedModel, usage: metadata?.usage, params: frozen.params, profile, label } };
      }, 1, undefined, { timeoutMs: 600000 });
      const execution = currentWorkflowExecution();
      let response: Awaited<ReturnType<typeof perform>>;
      if (documentAuthorityEnabled() && execution) {
        const run = await this.db.workflowRun.findUniqueOrThrow({ where: { id: execution.runId }, select: { id: true, userId: true, bookId: true, sourceRevisionId: true } });
        let expected = sourceRevisionId;
        if (!expected && label.endsWith('quality review') && run.sourceRevisionId) {
          const mapping = await this.db.documentLegacyRevisionMapping.findFirst({ where: { legacyRevisionId: run.sourceRevisionId, bookId: run.bookId } });
          if (!mapping) throw new Error('Historical quality source requires its complete document mapping');
          expected = mapping.documentRevisionId;
        }
        const intent = { prompt, schema, profile, label, attempt, params, providerId: provider.id, configuredModel: provider.getModel?.() };
        response = await runWorkflowEffect({ userId: run.userId, bookId: run.bookId, runId: run.id, effectKey: `structured:${label}:${sha(intent)}:attempt:${attempt}`, intent, expectedRevisionId: expected, timeoutMs: 600000 }, async () => ({ request, params, schema }), perform);
      } else response = await perform({ request, params, schema });
      const raw = response.raw;
      const parsed = extractObject(raw);
      if (parsed && validate(parsed)) return parsed;
      prior = `\nYour prior response was invalid for ${label}. Repair the structure and include every required field. Final attempt.`;
    }
    throw new Error(`${label} produced invalid structured output after 2 bounded attempts`);
  }

  private async inBatches<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
    for (let offset = 0; offset < items.length; offset += concurrency) {
      await Promise.all(items.slice(offset, offset + concurrency).map(worker));
    }
  }

  async status(userId: number, runId: string) {
    const run = await this.db.workflowRun.findFirst({ where: { id: runId, userId }, include: {
      children: { select: { id: true, workflowType: true, status: true, phase: true, progress: true } },
      checkpoints: {
        where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 1,
        select: { id: true, checkpointType: true, proposal: true },
      },
      reviewRun: { include: { findings: { select: { implemented: true, verificationStatus: true, waived: true, stale: true, superseded: true } } } },
      editorialRun: { select: { id: true, passPackKey: true, passPackVersion: true, policyVersion: true, autonomy: true, outcome: true, evidenceSummary: true, updatedAt: true } },
    } });
    if (!run) throw new Error(`Workflow ${runId} not found`);
    const manuscript = await this.db.scene.aggregate({ where: { chapter: { act: { bookId: run.bookId } }, deletedAt: null }, _sum: { wordCount: true }, _count: { id: true } });
    const findings = run.reviewRun?.findings ?? [];
    const taskProgress = async (id: string, workflowType: string, stored: Prisma.JsonValue) => {
      if (workflowType !== 'improve_quality') return stored;
      const [total, completed] = await Promise.all([
        this.db.workflowTask.count({ where: { runId: id, taskType: 'revise_finding' } }),
        this.db.workflowTask.count({ where: { runId: id, taskType: 'revise_finding', status: { in: ['completed', 'skipped'] } } }),
      ]);
      return total ? { completed, total, percent: completed >= total ? 100 : Math.min(99, Math.round(completed * 100 / total)), unit: 'findings' } : stored;
    };
    const progress = await taskProgress(run.id, run.workflowType, run.progress);
    const children = await Promise.all(run.children.map(async (child) => ({ ...child, progress: await taskProgress(child.id, child.workflowType, child.progress) })));
    const [latestCheckpoint, latestArtifact, latestPublication] = await Promise.all([
      this.db.workflowCheckpoint.findFirst({ where: { runId }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, decidedAt: true } }),
      this.db.workflowArtifact.findFirst({ where: { runId }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true } }),
      this.db.publicationPackage.findFirst({ where: { workflowRunId: runId }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, approvedAt: true } }),
    ]);
    const activeCheckpoint = run.checkpoints[0]
      ? { id: run.checkpoints[0].id, checkpointType: run.checkpoints[0].checkpointType, ...checkpointProposalSummary(run.checkpoints[0].proposal) }
      : null;
    return {
      runId: run.id, workflowType: run.workflowType, parentRunId: run.parentRunId, bookId: run.bookId,
      status: run.status, phase: run.phase, terminal: TERMINAL_WORKFLOW_STATUSES.has(run.status),
      statusVersion: run.statusVersion, progress, sourceRevisionId: run.sourceRevisionId,
      resultRevisionId: run.resultRevisionId, lastHeartbeatAt: run.lastHeartbeatAt,
      failureReason: run.failureReason, failureClass: run.failureClass,
      attempts: {
        executions: run.attemptCount,
        currentDelivery: run.deliveryAttemptCount,
        recoveries: run.recoveryCount,
        maximumDeliveryAttempts: run.maxAttempts,
      },
      manuscript: { scenes: manuscript._count.id, words: manuscript._sum.wordCount ?? 0 },
      activeCheckpoint, children,
      resourceVersions: {
        checkpoints: latestCheckpoint ? `${latestCheckpoint.id}:${latestCheckpoint.status}:${latestCheckpoint.decidedAt?.toISOString() ?? ''}` : 'none',
        artifacts: latestArtifact ? `${latestArtifact.id}:${latestArtifact.createdAt.toISOString()}` : 'none',
        publication: latestPublication ? `${latestPublication.id}:${latestPublication.status}:${latestPublication.approvedAt?.toISOString() ?? ''}` : 'none',
        editorial: run.editorialRun ? `${run.editorialRun.id}:${run.editorialRun.updatedAt.toISOString()}` : 'none',
      },
      findings: run.reviewRun ? {
        total: findings.length, open: findings.filter((f) => !f.implemented && !f.waived && !f.stale && !f.superseded).length,
        implemented: findings.filter((f) => f.implemented).length,
        verified: findings.filter((f) => f.verificationStatus === 'passed').length,
        waived: findings.filter((f) => f.waived).length, stale: findings.filter((f) => f.stale).length,
        superseded: findings.filter((f) => f.superseded).length,
      } : null,
      editorial: run.editorialRun ? {
        id: run.editorialRun.id,
        passPack: { key: run.editorialRun.passPackKey, version: run.editorialRun.passPackVersion },
        policyVersion: run.editorialRun.policyVersion,
        autonomy: run.editorialRun.autonomy,
        outcome: run.editorialRun.outcome,
        summary: run.editorialRun.evidenceSummary,
      } : null,
      createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    };
  }

  async listEvents(userId: number, runId: string, after = 0, limit = 100) {
    await this.ownedRun(userId, runId);
    return this.db.workflowEvent.findMany({ where: { runId, id: { gt: after } }, orderBy: { id: 'asc' }, take: Math.min(Math.max(limit, 1), 250) });
  }

  async artifacts(userId: number, runId: string) {
    await this.ownedRun(userId, runId);
    return this.db.workflowArtifact.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
  }

  async control(userId: number, runId: string, action: 'pause' | 'resume' | 'cancel', actorGithubId?: string) {
    const run = await this.ownedRun(userId, runId);
    if (run.workflowType === 'editorial_optimize' && action !== 'cancel') {
      throw new Error('Editorial workflows are autonomous and cannot be paused or resumed');
    }
    if (action === 'pause' && !TERMINAL_WORKFLOW_STATUSES.has(run.status)) {
      await this.db.workflowRun.update({ where: { id: runId }, data: { status: 'paused', leaseOwner: null, leaseExpiresAt: null } });
      globalAbortRegistry.abort(runId);
    }
    if (action === 'cancel' && !TERMINAL_WORKFLOW_STATUSES.has(run.status)) {
      await this.db.workflowRun.update({ where: { id: runId }, data: { status: 'cancelled', cancelRequested: true, finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
      globalAbortRegistry.abort(runId);
      const job = await getWorkflowQueue().getJob(`workflow--${runId}`); if (job && (await job.getState()) !== 'active') await job.remove();
    }
    let resumable = ['queued', 'paused', 'failed', 'awaiting_approval'].includes(run.status);
    if (action === 'resume' && run.status === 'running') {
      const job = await getWorkflowQueue().getJob(`workflow--${runId}`);
      resumable = !job || (await job.getState()) !== 'active';
    }
    if (action === 'resume' && resumable) {
      if (run.deliveryAttemptCount >= run.maxAttempts) throw new Error('Workflow delivery attempt budget is exhausted');
      if (run.status === 'awaiting_approval') {
        const pendingCheckpoint = await this.db.workflowCheckpoint.findFirst({ where: { runId, status: 'pending' }, select: { id: true } });
        if (pendingCheckpoint) throw new Error('Decide the pending checkpoint before resuming this workflow');
      }
      await this.db.$transaction(async (tx) => {
        await tx.workflowRun.update({ where: { id: runId }, data: { status: 'queued', failureReason: null, failureClass: null, cancelRequested: false, deliveryAttemptCount: 0, finishedAt: null, leaseOwner: null, leaseExpiresAt: null } });
        await createWorkflowEnqueue(tx, runId, userId, 'workflow_resumed', `resume:${runId}:${Date.now()}`);
      });
      if (process.env.NODE_ENV !== 'test') await dispatchWorkflowOutbox([runId]);
    }
    await this.event(runId, action, { priorStatus: run.status, actorGithubId });
    return this.status(userId, runId);
  }

  async checkpoints(userId: number, runId: string) {
    await this.ownedRun(userId, runId);
    return this.db.workflowCheckpoint.findMany({ where: { runId }, orderBy: { createdAt: 'asc' }, select: { id: true, checkpointType: true, status: true, decision: true, reason: true, createdAt: true, decidedAt: true } });
  }

  async checkpointDetail(userId: number, runId: string, checkpointId: string, offset = 0, limit = 16_384) {
    await this.ownedRun(userId, runId);
    const checkpoint = await this.db.workflowCheckpoint.findFirst({ where: { id: checkpointId, runId }, select: { id: true, checkpointType: true, proposal: true } });
    if (!checkpoint) throw new Error('Checkpoint not found');
    const serialized = JSON.stringify(checkpoint.proposal, null, 2);
    const start = Math.min(Math.max(offset, 0), serialized.length);
    const size = Math.min(Math.max(limit, 1_024), 32_768);
    const end = Math.min(start + size, serialized.length);
    return { id: checkpoint.id, checkpointType: checkpoint.checkpointType, proposalChunk: serialized.slice(start, end), offset: start, nextOffset: end < serialized.length ? end : null, totalCharacters: serialized.length };
  }

  async decideCheckpoint(userId: number, runId: string, checkpointId: string, decision: 'approved' | 'rejected', reason?: string, actorGithubId?: string) {
    await this.db.$transaction(async (tx) => {
      const run = await tx.workflowRun.findFirst({ where: { id: runId, userId } });
      if (!run) throw new Error(`Workflow ${runId} not found`);
      const checkpoint = await tx.workflowCheckpoint.findFirst({ where: { id: checkpointId, runId, status: 'pending' } });
      if (!checkpoint) throw new Error('Pending checkpoint not found');
      const claimed = await tx.workflowCheckpoint.updateMany({
        where: { id: checkpointId, runId, status: 'pending' },
        data: { status: 'decided', decision, reason, decidedById: userId, decidedAt: new Date() },
      });
      if (claimed.count !== 1) throw new Error('Checkpoint was already decided');
      await tx.workflowEvent.create({ data: { runId, eventType: 'checkpoint_decided', data: json({ checkpointId, decision, reason, actorGithubId }) } });
      if (decision === 'approved') {
        if (run.workflowType === 'full_book' && checkpoint.checkpointType.startsWith('editorial_')) {
          const proposal = checkpoint.proposal as { childRunId?: string };
          if (proposal.childRunId) {
            const childCheckpoint = await tx.workflowCheckpoint.findFirst({ where: { runId: proposal.childRunId, status: 'pending' }, orderBy: { createdAt: 'asc' } });
            if (childCheckpoint) {
              const childClaim = await tx.workflowCheckpoint.updateMany({
                where: { id: childCheckpoint.id, runId: proposal.childRunId, status: 'pending' },
                data: { status: 'decided', decision: 'approved', reason: 'Approved through parent Full Book editorial checkpoint', decidedById: userId, decidedAt: new Date() },
              });
              if (childClaim.count !== 1) throw new Error('Child checkpoint was already decided');
              await tx.workflowRun.updateMany({ where: { id: proposal.childRunId, parentRunId: run.id }, data: { status: 'queued', deliveryAttemptCount: 0, failureReason: null, failureClass: null } });
              await tx.workflowEvent.create({ data: { runId: proposal.childRunId, eventType: 'checkpoint_decided', data: json({ checkpointId: childCheckpoint.id, decision: 'approved', throughParentRunId: run.id }) } });
            }
          }
        }
        await tx.workflowRun.update({ where: { id: runId }, data: { status: 'queued', deliveryAttemptCount: 0, failureReason: null, failureClass: null, leaseOwner: null, leaseExpiresAt: null } });
        await createWorkflowEnqueue(tx, runId, userId, 'checkpoint_approved', `checkpoint:${checkpointId}:approved`);
      } else {
        await tx.workflowRun.update({ where: { id: runId }, data: { status: 'paused', failureReason: reason ?? 'Checkpoint rejected', leaseOwner: null, leaseExpiresAt: null } });
      }
    });
    if (decision === 'approved' && process.env.NODE_ENV !== 'test') await dispatchWorkflowOutbox([runId]);
    return this.status(userId, runId);
  }

  async process(runId: string, executionParentRunId?: string): Promise<void> {
    const run=await this.db.workflowRun.findUnique({where:{id:runId},select:{userId:true,status:true,bookId:true}});
    if(!run||['completed','release_approved','cancelled'].includes(run.status))return;
    // Provider requests made for this run are checked against its book's AI switch.
    return runWithAiBookScope([run.bookId],()=>runAdmittedBackground('workflow-execution',runId,run.userId,()=>this.processAdmitted(runId,executionParentRunId)));
  }
  private async processAdmitted(runId: string, executionParentRunId?: string): Promise<void> {
    const existingState = await this.db.workflowRun.findUnique({ where: { id: runId }, select: { status: true } });
    if (!existingState || ['completed', 'release_approved', 'cancelled'].includes(existingState.status)) return;
    const inheritedSharedResourceOperationId = currentWorkflowExecution()?.sharedResourceOperationId;
    const boundSharedResourceOperationId = inheritedSharedResourceOperationId
      ?? (await sharedResourceExecutionOperation('workflow', runId))?.operationId;
    if (boundSharedResourceOperationId) {
      await assertSharedResourceOperationCurrent(boundSharedResourceOperationId, undefined, true);
    }
    const leaseOwner = randomUUID();
    const now = new Date();
    const acquired = await this.db.workflowRun.updateMany({
      where: {
        id: runId,
        status: { in: ['queued', 'running', 'failed'] },
        cancelRequested: false,
        OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }],
        ...(executionParentRunId ? { parentRunId: executionParentRunId } : { parentRunId: null }),
      },
      data: {
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + workflowLeaseMs),
        executionParentRunId: executionParentRunId ?? null,
        status: 'running',
        startedAt: now,
        lastHeartbeatAt: now,
        failureReason: null,
        failureClass: null,
        finishedAt: null,
        attemptCount: { increment: 1 },
        deliveryAttemptCount: { increment: 1 },
      },
    });
    // Duplicate BullMQ deliveries and parent/recovery races are expected. Only
    // the compare-and-set winner is allowed to execute the workflow.
    if (acquired.count !== 1) return;
    const run = await this.db.workflowRun.findFirst({ where: { id: runId, leaseOwner } });
    if (!run) return;
    const signal = globalAbortRegistry.create(runId);
    const heartbeat = setInterval(() => { void this.heartbeat(runId, leaseOwner); }, Math.max(10_000, Math.floor(workflowLeaseMs / 3)));
    heartbeat.unref();
    try {
      await runWithWorkflowExecution({ runId, leaseOwner, signal, sharedResourceOperationId: boundSharedResourceOperationId }, async () => {
        await this.db.workflowTask.updateMany({ where: { runId }, data: { leaseOwner } });
        await this.db.workflowTask.updateMany({ where: { runId, taskKey: `${run.workflowType}:root`, leaseOwner }, data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 }, inputRevisionId: run.sourceRevisionId, errorCode: null, errorMessage: null } });
        await this.event(runId, 'started', { workflowType: run.workflowType, phase: run.phase, leaseOwner, executionParentRunId });
        try {
          await assertBookAiAllowed([run.bookId]);
          if (run.workflowType === 'revision_campaign_analysis') await processCampaignAnalysis(run);
          else if (run.workflowType === 'full_book') await this.processFullBook(run);
          else if (run.workflowType === 'quality_review') await this.processQualityReview(run);
          else if (run.workflowType === 'improve_quality') await this.processImproveQuality(run);
          else if (run.workflowType === 'guided_improve') await this.processGuidedImprove(run);
          else if (run.workflowType === 'editorial_optimize') await editorialWorkflowService.process(run);
          else throw new Error(`Unsupported workflow type ${run.workflowType}`);
        } catch (error) {
          if(error instanceof DocumentError&&error.code.startsWith('DOCUMENT_ADMISSIONS_')){
            await this.db.workflowRun.updateMany({where:{id:runId,leaseOwner,status:'running'},data:{status:'paused',failureClass:'infrastructure',failureReason:'Release admissions are closed; recover the exact retained workflow/effects before explicit resume.',finishedAt:null}});
            await this.db.workflowTask.updateMany({where:{runId,taskKey:`${run.workflowType}:root`,leaseOwner,status:'running'},data:{status:'pending',errorCode:error.code,errorMessage:'Provider dispatch was refused by the release fence; original effect IDs/deadlines remain retained.',finishedAt:null}});
            await this.event(runId,'paused',{reason:'release-admission-fence',errorCode:error.code,leaseOwner});return;
          }
          if (isBookAiDisabledError(error)) {
            // The refused provider request was never sent; resume after switching AI back on.
            await this.db.workflowRun.updateMany({ where: { id: runId, leaseOwner, status: 'running' }, data: { status: 'paused', failureClass: 'validation', failureReason: error.message, finishedAt: null } });
            await this.db.workflowTask.updateMany({ where: { runId, taskKey: `${run.workflowType}:root`, leaseOwner, status: 'running' }, data: { status: 'pending', errorCode: error.code, errorMessage: error.message, finishedAt: null } });
            await this.event(runId, 'paused', { reason: 'book-ai-disabled', errorCode: error.code, leaseOwner });
            return;
          }
          const message = boundedFailureReason(error);
          const failureClass = classifyWorkflowFailure(error);
          const current = await this.db.workflowRun.findFirst({ where: { id: runId, leaseOwner } });
          if (!current || ['awaiting_approval', 'paused', 'cancelled', 'completed', 'release_approved'].includes(current.status)) return;
          {
            const reviewRequired = workflowEffectNeedsRecovery(error) || run.workflowType !== 'editorial_optimize'
              && error instanceof InferenceTerminalError && error.code === 'INFERENCE_BLOCKED';
            const exhausted = current.deliveryAttemptCount >= current.maxAttempts;
            const paused = workflowEffectNeedsRecovery(error) || run.workflowType !== 'editorial_optimize' && (reviewRequired || exhausted);
            await this.db.workflowRun.updateMany({ where: { id: runId, leaseOwner }, data: { status: paused ? 'paused' : 'failed', failureReason: message, failureClass, finishedAt: paused ? new Date() : null } });
            if (run.workflowType === 'editorial_optimize') {
              await this.db.editorialRun.updateMany({
                where: { workflowRunId: runId },
                data: { status: 'failed', outcome: null, finishedAt: null },
              });
            }
            const effectRecovery = workflowEffectNeedsRecovery(error) ? (error as import('@/documents/errors').DocumentError).details : undefined;
            await this.db.workflowTask.updateMany({ where: { runId, taskKey: `${run.workflowType}:root`, leaseOwner }, data: { status: paused ? 'failed' : 'pending', errorCode: effectRecovery ? 'WORKFLOW_PROVIDER_RECOVERY_REQUIRED' : reviewRequired ? 'WORKFLOW_CONTENT_REVIEW_REQUIRED' : `WORKFLOW_${failureClass.toUpperCase()}_FAILURE`, errorMessage: message, ...(effectRecovery ? { validationResult: json({ effectRecovery }) } : {}), finishedAt: paused ? new Date() : null } });
            await this.event(runId, reviewRequired ? 'review_required' : 'failed', { message, failureClass, leaseOwner, effectRecovery });
          }
          throw error;
        }
      });
    } finally {
      clearInterval(heartbeat);
      globalAbortRegistry.clear(runId);
      await this.db.workflowRun.updateMany({ where: { id: runId, leaseOwner }, data: { leaseOwner: null, leaseExpiresAt: null } });
    }
  }

  private async checkpoint(run: WorkflowRun, type: string, proposal: unknown, phase: string) {
    await assertWorkflowLease(run.id);
    const existing = await this.db.workflowCheckpoint.findFirst({ where: { runId: run.id, checkpointType: type }, orderBy: { createdAt: 'desc' } });
    if (existing?.decision === 'approved') return false;
    const owner = currentWorkflowExecution()!.leaseOwner;
    if (!existing || existing.status !== 'pending') await this.db.workflowCheckpoint.create({ data: { id: randomUUID(), runId: run.id, checkpointType: type, proposal: json(proposal), leaseOwner: owner } });
    const fenced = await this.db.workflowRun.updateMany({ where: { id: run.id, leaseOwner: owner }, data: { status: 'awaiting_approval', phase, lastHeartbeatAt: new Date() } });
    if (fenced.count !== 1) throw new Error(`Workflow lease lost for ${run.id}`);
    await this.db.workflowTask.updateMany({ where: { runId: run.id, status: 'running', leaseOwner: owner }, data: { status: 'awaiting_approval' } });
    await this.event(run.id, 'checkpoint_required', { type, phase });
    return true;
  }

  private async processFullBook(run: WorkflowRun) {
    await assertWorkflowLease(run.id);
    const settings = run.settings as unknown as FullBookInput;
    if (run.phase === 'queued' || run.phase === 'structure_ready') {
      if (run.phase === 'queued') await this.buildStructure(run, settings);
      const book = await this.db.book.findUnique({ where: { id: run.bookId }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
      const wordBudget = await this.db.workflowArtifact.findFirst({ where: { runId: run.id, artifactType: 'word_budget_reconciliation' }, orderBy: { createdAt: 'desc' }, select: { payload: true } });
      if (await this.checkpoint(run, 'architecture_outline', { title: book?.title, acts: book?.acts, wordBudget: wordBudget?.payload ?? null }, 'architecture_checkpoint')) return;
    }
    if (run.phase === 'architecture_checkpoint' || run.phase === 'sample_drafting') {
      if (!(await this.draft(run, settings, true))) return;
      const first = (await this.orderedChapters(run.bookId))[0];
      if (!first?.scenes.length || first.scenes.some((scene) => !scene.prose?.trim())) throw new Error('Opening chapter sample is incomplete; reconcile before approval.');
      if (await this.checkpoint(run, 'prose_sample', { chapter: first }, 'sample_checkpoint')) return;
    }
    if (['sample_checkpoint', 'drafting', 'editorial_review'].includes(run.phase)) {
      if (!(await this.draft(run, settings, false))) return;
      const models = settings.reviewModels?.length ? settings.reviewModels : [process.env.OLLAMA_MODEL ?? 'configured-model'];
      const rounds = Math.max(1, Math.min(3, settings.maxEditorialRounds ?? 3));
      const editorialTotal = rounds * 2 + 1;
      await this.updateEditorialProgress(run.id, editorialTotal);
      const state = await this.editorialState(run.id);
      const roundReports = state.reports;
      for (let round = state.nextRound; round < rounds; round += 1) {
        const model = models[round % models.length];
        const reviewChild = await this.start(run.userId, 'quality_review', { bookId: run.bookId, scope: { type: 'book' }, model, rubricVersion: 'publishable-v1' }, run.id, false);
        await this.process(reviewChild.runId, run.id);
        await this.updateEditorialProgress(run.id, editorialTotal);
        const review = await this.db.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: reviewChild.runId }, include: { findings: true } });
        const actionable = review.findings.filter((finding) => !finding.waived && ['critical', 'high', 'medium'].includes(finding.severity));
        if (!actionable.length) { roundReports.push({ reviewRunId: review.id, findings: 0 }); break; }
        const improveChild = await this.start(run.userId, 'improve_quality', { bookId: run.bookId, reviewRunIds: [review.id], findingIds: actionable.map((finding) => finding.id), model }, run.id, false);
        await this.process(improveChild.runId, run.id);
        await this.updateEditorialProgress(run.id, editorialTotal);
        const improvementStatus = await this.db.workflowRun.findUniqueOrThrow({ where: { id: improveChild.runId } });
        roundReports.push({ reviewRunId: review.id, improvementRunId: improveChild.runId, findings: actionable.length });
        if (improvementStatus.status === 'awaiting_approval') {
          await this.saveEditorialState(run.id, { nextRound: round, reports: roundReports, pendingChildRunId: improveChild.runId });
          if (await this.checkpoint(run, `editorial_round_${round + 1}`, { childRunId: improveChild.runId, reviewRunId: review.id }, 'editorial_checkpoint')) return;
        }
        await this.saveEditorialState(run.id, { nextRound: round + 1, reports: roundReports });
      }
      // A final independent pass anchors release gates to the exact resulting revision.
      const verification = await this.start(run.userId, 'quality_review', { bookId: run.bookId, scope: { type: 'book' }, model: models[rounds % models.length], rubricVersion: 'publishable-v1-verification' }, run.id, false);
      await this.process(verification.runId, run.id);
      await this.updateEditorialProgress(run.id, editorialTotal, true);
      await this.saveEditorialState(run.id, { nextRound: rounds, reports: roundReports, verificationRunId: verification.runId });
      if (await this.checkpoint(run, 'developmental_plan', { rounds: roundReports, verificationRunId: verification.runId }, 'developmental_checkpoint')) return;
    }
    if (run.phase === 'editorial_checkpoint') {
      const state = await this.editorialState(run.id);
      if (!state.pendingChildRunId) throw new Error('Editorial checkpoint is missing its child workflow');
      await this.process(state.pendingChildRunId, run.id);
      const child = await this.db.workflowRun.findUniqueOrThrow({ where: { id: state.pendingChildRunId } });
      if (child.status !== 'completed') {
        if (child.status === 'awaiting_approval') {
          const pending = await this.db.workflowCheckpoint.findFirst({ where: { runId: child.id, status: 'pending' }, orderBy: { createdAt: 'asc' } });
          if (!pending) throw new Error('Editorial child is awaiting approval without a pending checkpoint');
          await this.saveEditorialState(run.id, { ...state, pendingChildRunId: child.id });
          if (await this.checkpoint(run, `editorial_child_${pending.id}`, { childRunId: child.id, childCheckpointId: pending.id, checkpointType: pending.checkpointType, proposal: pending.proposal }, 'editorial_checkpoint')) return;
        }
        if (child.status === 'failed' || child.status === 'paused') throw new Error(`Editorial child stopped: ${child.failureReason ?? child.status}`);
      }
      await this.saveEditorialState(run.id, { nextRound: state.nextRound + 1, reports: state.reports });
      const resumed = await this.db.workflowRun.update({ where: { id: run.id }, data: { phase: 'sample_checkpoint' } });
      await this.processFullBook(resumed);
      return;
    }
    if (run.phase === 'developmental_checkpoint' || run.phase === 'release_blocked') {
      const resultRevisionId = await manuscriptRevisionService.capture(run.bookId, run.id, [{ type: 'book', id: run.bookId }]);
      let unfinishedReviewId: string | undefined;
      if (run.phase === 'release_blocked') {
        const childReviews = await this.db.qualityReviewRun.findMany({ where: { workflowRun: { parentRunId: run.id } }, select: { sourceRevisionId: true, status: true, workflowRunId: true, workflowRun: { select: { status: true } } }, orderBy: { createdAt: 'desc' } });
        const disposition = releaseReviewDisposition(resultRevisionId, childReviews);
        if (disposition.action === 'start') {
          const models = settings.reviewModels?.length ? settings.reviewModels : [process.env.OLLAMA_MODEL ?? 'configured-model'];
          const releaseReview = await this.start(run.userId, 'quality_review', { bookId: run.bookId, scope: { type: 'book' }, model: models[0], rubricVersion: 'publishable-v1-release-recheck' }, run.id, false, undefined, releaseReviewIdempotencyKey(run.id, resultRevisionId));
          if (releaseReview.sourceRevisionId !== resultRevisionId)
            throw new Error(`Release review ${releaseReview.runId} is bound to a different source revision`);
          await this.process(releaseReview.runId, run.id);
          const prior = await this.editorialState(run.id);
          await this.saveEditorialState(run.id, { ...prior, verificationRunId: releaseReview.runId });
          unfinishedReviewId = releaseReview.runId;
        } else if (disposition.action === 'process' && disposition.runId) {
          await this.process(disposition.runId, run.id);
          unfinishedReviewId = disposition.runId;
        } else if (disposition.action === 'blocked') {
          unfinishedReviewId = disposition.runId;
        }
      }
      await this.db.workflowRun.update({ where: { id: run.id }, data: { resultRevisionId, phase: 'release' } });
      const book = await this.db.book.findUniqueOrThrow({ where: { id: run.bookId }, include: { acts: { orderBy: { actNumber: 'asc' }, include: { chapters: { orderBy: { chapterNumber: 'asc' }, include: { scenes: { where: { deletedAt: null }, orderBy: { sceneNumber: 'asc' } } } } } } } });
      const publication = await createPublicationPackage(run.id, resultRevisionId, book, { audience: settings.audience, pov: settings.pov, tense: settings.tense });
      const gateReport = await this.releaseGates(run.id, resultRevisionId, Number(settings.targetWords ?? 80000), publication.validation.pass);
      await this.db.publicationPackage.create({ data: { id: randomUUID(), workflowRunId: run.id, status: gateReport.pass ? 'publishable_candidate' : 'blocked', gateReport: json(gateReport), artifactManifest: json({ directory: publication.directory, ...publication.manifest }), validationReport: json(publication.validation) } });
      if (!gateReport.pass) {
        const unfinishedReview = unfinishedReviewId
          ? await this.db.workflowRun.findUnique({ where: { id: unfinishedReviewId }, select: { status: true } })
          : null;
        await this.db.workflowRun.update({ where: { id: run.id }, data: { status: 'paused', phase: 'release_blocked', failureReason: unfinishedReview && unfinishedReview.status !== 'completed'
          ? `Release review ${unfinishedReviewId} remains ${unfinishedReview.status}`
          : 'One or more publication release gates failed', resultRevisionId } });
        await this.event(run.id, 'release_blocked', gateReport);
        return;
      }
      if (await this.checkpoint(run, 'final_release', gateReport, 'final_checkpoint')) return;
    }
    if (run.phase === 'final_checkpoint') {
      const latest = await this.db.publicationPackage.findFirst({ where: { workflowRunId: run.id }, orderBy: { createdAt: 'desc' } });
      if (!latest || !['publishable_candidate', 'release_approved'].includes(latest.status))
        throw new Error('The latest publication package is not a publishable candidate');
      if (latest.status === 'publishable_candidate') {
        const approved = await this.db.publicationPackage.updateMany({ where: { id: latest.id, status: 'publishable_candidate' }, data: { status: 'release_approved', approvedById: run.userId, approvedAt: new Date() } });
        if (approved.count !== 1) throw new Error('The latest publication package changed before final approval');
      }
      await this.complete(run.id, 'release_approved');
    }
  }

  private async editorialState(runId: string): Promise<{ nextRound: number; reports: Array<{ reviewRunId: string; improvementRunId?: string; findings: number }>; pendingChildRunId?: string; verificationRunId?: string }> {
    const artifact = await this.db.workflowArtifact.findFirst({ where: { runId, artifactType: 'editorial_state' }, orderBy: { createdAt: 'desc' } });
    return artifact ? artifact.payload as unknown as { nextRound: number; reports: Array<{ reviewRunId: string; improvementRunId?: string; findings: number }>; pendingChildRunId?: string; verificationRunId?: string } : { nextRound: 0, reports: [] };
  }

  private async updateEditorialProgress(runId: string, total: number, finished = false): Promise<void> {
    const completed = await this.db.workflowRun.count({ where: { parentRunId: runId, status: { in: ['completed', 'release_approved'] } } });
    const effectiveCompleted = finished ? Math.max(completed, total) : completed;
    await this.db.workflowRun.update({ where: { id: runId }, data: { phase: 'editorial_review', lastHeartbeatAt: new Date(), progress: json({ completed: effectiveCompleted, total, percent: Math.round(effectiveCompleted * 100 / Math.max(total, 1)), unit: 'editorial_workflows' }) } });
  }

  private async saveEditorialState(runId: string, state: { nextRound: number; reports: Array<{ reviewRunId: string; improvementRunId?: string; findings: number }>; pendingChildRunId?: string; verificationRunId?: string }) {
    const data = { contentHash: sha(state), payload: json(state) };
    await this.db.workflowArtifact.create({ data: { id: randomUUID(), runId, artifactType: 'editorial_state', scopeType: 'book', contentHash: data.contentHash, payload: data.payload } });
  }

  private async buildStructure(run: WorkflowRun, settings: FullBookInput) {
    await assertWorkflowLease(run.id);
    const existing = await this.db.act.count({ where: { bookId: run.bookId, deletedAt: null } });
    if (existing) { await this.prepareFullBookPlan(run, settings); return; }
    const targetWords = Math.max(10000, Math.min(250000, settings.targetWords ?? 80000));
    const chapterCount = Math.max(6, Math.ceil(targetWords / 5000));
    const scenesPerChapter = Math.max(2, Math.ceil(targetWords / chapterCount / 1800));
    const documentSource = documentAuthorityEnabled() ? await documentService.manifest(run.userId, run.bookId) : undefined;
    const provider = defaultModelRouter.forRequest('structure', undefined, { noTransportReplay: documentAuthorityEnabled() });
    const parsed = await this.structuredObject(provider, `Design a ${chapterCount}-chapter ${settings.genre ?? 'fiction'} novel from this approved premise: ${settings.premise}\nAuthor requirements: ${JSON.stringify({ audience: settings.audience, targetWords, pov: settings.pov, tense: settings.tense, style: settings.style, mustInclude: settings.mustInclude ?? [], mustAvoid: settings.mustAvoid ?? [] })}. Map the required events and character resolutions to explicit scenes. Keep dates, causal dependencies and institutional authority consistent; do not resolve later events in earlier scenes.\nSchema: {"title":"...","summary":"...","styleBible":{"voice":"...","pov":"...","tense":"...","constraints":["..."]},"characters":[{"name":"...","role":"...","goal":"...","conflict":"...","arc":"...","aliases":["..."]}],"chapters":[{"title":"...","summary":"...","scenes":["goal; opposition; choice; changed state; exit hook"]}]}. Provide exactly ${chapterCount} chapters and ${scenesPerChapter} conflict-bearing scenes per chapter.`, (value) => Array.isArray(value.characters) && value.characters.some((character) => character && typeof character === 'object' && typeof (character as Record<string, unknown>).name === 'string' && String((character as Record<string, unknown>).name).trim()) && Array.isArray(value.chapters) && value.chapters.length === chapterCount && value.chapters.every((chapter) => chapter && typeof chapter === 'object' && Array.isArray((chapter as Record<string, unknown>).scenes) && ((chapter as Record<string, unknown>).scenes as unknown[]).length === scenesPerChapter), 'book architecture', architectureSchema(chapterCount, scenesPerChapter), 'planning', documentSource?.revisionId);
    const chapters = Array.isArray(parsed?.chapters) ? parsed!.chapters as Array<Record<string, unknown>> : [];
    const title = typeof parsed?.title === 'string' ? parsed.title : settings.title ?? 'Untitled Book';
    const summary = typeof parsed?.summary === 'string' ? parsed.summary : settings.premise;
    await assertWorkflowLease(run.id);
    const characters = Array.isArray(parsed.characters) ? parsed.characters.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object') : [];
    if (!characters.length) throw new Error('Book architecture omitted the required character codex');
    if (documentSource) {
      const tree: OutlineTree = { acts: Array.from({ length: 3 }, (_, index) => {
        const start = Math.floor(index * chapterCount / 3); const end = Math.floor((index + 1) * chapterCount / 3);
        return { title: `Act ${index + 1}`, summary: `Act ${index + 1} advances and escalates the central conflict.`, chapters: chapters.slice(start, end).map((chapter, chapterIndex) => ({ title: String(chapter.title ?? `Chapter ${start + chapterIndex + 1}`), summary: String(chapter.summary ?? ''), scenes: (chapter.scenes as string[]).map((outline, sceneIndex) => ({ outline, summary: `Scene ${sceneIndex + 1} of chapter ${start + chapterIndex + 1}.` })) })) };
      }) };
      await documentService.mutateCatalog(run.userId, run.bookId, { operationId: compatibilityOperationId('proser.workflow-structure.v1', { runId: run.id, source: documentSource.revisionId }), expectedRevisionId: documentSource.revisionId, expectedScopes: { structure: documentSource.scopes!.structure.revisionId, canon: documentSource.scopes!.canon.revisionId }, payload: { command: 'workflow-architecture', parsed } }, async (tx) => {
        await tx.book.update({ where: { id: run.bookId }, data: { title, summary, genre: settings.genre ?? 'fiction', targetAudience: settings.audience ?? 'adult', draftStatus: 'planning' } });
        const hierarchy = await appendHierarchy(tx, run.bookId, tree);
        for (const character of characters.slice(0, 20)) {
          const name = String(character.name ?? '').trim(); if (!name) continue;
          await tx.codexEntry.create({ data: { bookId: run.bookId, entryType: 'character', entryName: name, entryDescription: [character.role, character.goal, character.conflict, character.arc].filter(Boolean).map(String).join(' — '), attributes: JSON.stringify({ aliases: Array.isArray(character.aliases) ? character.aliases.map(String) : [], role: character.role, goal: character.goal, conflict: character.conflict, arc: character.arc }) } });
        }
        return { result: hierarchy };
      }, 'workflow');
    } else {
    await this.db.book.update({ where: { id: run.bookId }, data: { title, summary, genre: settings.genre ?? 'fiction', targetAudience: settings.audience ?? 'adult', draftStatus: 'planning' } });
    for (let actNumber = 1; actNumber <= 3; actNumber += 1) {
      const act = await this.db.act.create({ data: { bookId: run.bookId, actNumber, title: `Act ${actNumber}`, summary: `Act ${actNumber} advances and escalates the central conflict.` } });
      const start = Math.floor((actNumber - 1) * chapterCount / 3); const end = Math.floor(actNumber * chapterCount / 3);
      for (let index = start; index < end; index += 1) {
        const source = chapters[index] ?? {};
        const chapter = await this.db.chapter.create({ data: { actId: act.id, chapterNumber: index + 1, title: String(source.title ?? `Chapter ${index + 1}`), summary: String(source.summary ?? `The conflict escalates through a consequential choice in chapter ${index + 1}.`) } });
        const outlines = Array.isArray(source.scenes) ? source.scenes.map(String) : [];
        for (let sceneNumber = 1; sceneNumber <= scenesPerChapter; sceneNumber += 1) await this.db.scene.create({ data: { chapterId: chapter.id, sceneNumber, outline: outlines[sceneNumber - 1] ?? `A conflict-bearing scene in which the protagonist pursues a goal, meets opposition, makes a consequential choice, and changes the story state.`, summary: `Scene ${sceneNumber} of chapter ${index + 1}.` } });
      }
    }
    for (const character of characters.slice(0, 20)) {
      const name = String(character.name ?? '').trim();
      if (!name) continue;
      await this.db.codexEntry.create({ data: { bookId: run.bookId, entryType: 'character', entryName: name, entryDescription: [character.role, character.goal, character.conflict, character.arc].filter(Boolean).map(String).join(' — '), attributes: JSON.stringify({ aliases: Array.isArray(character.aliases) ? character.aliases.map(String) : [], role: character.role, goal: character.goal, conflict: character.conflict, arc: character.arc }) } });
    }
    }
    await this.prepareFullBookPlan(run, settings, parsed.styleBible);
  }

  private orderedChapters(bookId: number) {
    return this.db.chapter.findMany({ where: { deletedAt: null, act: { bookId, deletedAt: null } }, orderBy: chapterOrder, include: { act: true, scenes: { where: { deletedAt: null }, orderBy: [{ sceneNumber: 'asc' }, { id: 'asc' }] } } });
  }

  private async prepareFullBookPlan(run: WorkflowRun, settings: FullBookInput, generatedStyle?: unknown) {
    await assertWorkflowLease(run.id);
    const chapters = await this.orderedChapters(run.bookId);
    const scenes = chapters.flatMap((chapter) => chapter.scenes);
    if (!chapters[0]?.scenes.length || !scenes.length) throw new Error('Book architecture requires an active opening scene.');
    const characters = await this.db.codexEntry.findMany({ where: { bookId: run.bookId, entryType: 'character', deletedAt: null }, orderBy: { id: 'asc' } });
    if (!characters.length) throw new Error('Book architecture did not provide a usable named character');
    const saveArtifact = async (artifactType: string, payload: unknown, scopeType = 'book', scopeId = String(run.bookId)) => {
      const contentHash = createHash('sha256').update(canonicalDocument(payload)).digest('hex');
      if (await this.db.workflowArtifact.findFirst({ where: { runId: run.id, artifactType, scopeType, scopeId, contentHash } })) return;
      await this.db.workflowArtifact.create({ data: { id: randomUUID(), runId: run.id, artifactType, scopeType, scopeId, contentHash, payload: json(payload) } });
    };
    const priorStyle = await this.db.workflowArtifact.findFirst({ where: { run: { bookId: run.bookId }, artifactType: 'voice_style_bible' }, orderBy: { createdAt: 'desc' } });
    const inherited = generatedStyle && typeof generatedStyle === 'object' && !Array.isArray(generatedStyle) ? generatedStyle as Record<string, unknown> : (priorStyle?.payload ?? {}) as Record<string, unknown>;
    const styleBible = { ...inherited, voice: settings.style ?? inherited.voice ?? 'genre-appropriate', pov: settings.pov ?? inherited.pov ?? 'configured at launch', tense: settings.tense ?? inherited.tense ?? 'configured at launch', constraints: [...new Set([...(Array.isArray(inherited.constraints) ? inherited.constraints.map(String) : []), ...(settings.mustInclude ?? []), ...(settings.mustAvoid ?? []).map((item) => `Avoid: ${item}`)])] };
    await saveArtifact('voice_style_bible', styleBible);
    for (const character of characters) {
      const attributes = extractObject(character.attributes ?? '') ?? {};
      await saveArtifact('character_arc', { ...attributes, name: character.entryName, description: character.entryDescription });
    }
    await this.db.narrativeLedger.upsert({ where: { workflowRunId_ledgerType_ledgerKey: { workflowRunId: run.id, ledgerType: 'promise', ledgerKey: 'central-reader-promise' } }, update: {}, create: { id: randomUUID(), workflowRunId: run.id, bookId: run.bookId, ledgerType: 'promise', ledgerKey: 'central-reader-promise', introducedSceneId: scenes[0].id, dueSceneId: scenes.at(-1)!.id, payload: json({ premise: settings.premise, resolutionRequirement: 'The ending must resolve the central reader promise established by the approved premise.' }) } });
    const targetWords = Math.max(10000, Math.min(250000, settings.targetWords ?? 80000));
    const book = await this.db.book.findUniqueOrThrow({ where: { id: run.bookId } });
    await saveArtifact('architecture', { title: book.title, summary: book.summary, chapterCount: chapters.length, sceneCount: scenes.length, targetWords, orderedChapterIds: chapters.map((chapter) => chapter.id), orderedSceneIds: scenes.map((scene) => scene.id) });
    await this.reconcileWordBudgets(run, targetWords, chapters);
    await manuscriptRevisionService.capture(run.bookId, run.id, [{ type: 'structure' }]);
    await this.db.workflowRun.update({ where: { id: run.id }, data: { phase: 'structure_ready', progress: json({ completed: 1, total: 4, percent: 25 }), lastHeartbeatAt: new Date() } });
  }

  private async draft(run: WorkflowRun, settings: FullBookInput, firstChapterOnly: boolean): Promise<boolean> {
    await assertWorkflowLease(run.id);
    const leaseOwner = currentWorkflowExecution()!.leaseOwner;
    const chapters = await this.orderedChapters(run.bookId);
    const targets = firstChapterOnly ? chapters.slice(0, 1) : chapters;
    const totalScenes = chapters.reduce((sum, chapter) => sum + chapter.scenes.length, 0);
    const bookTargetWords = settings.targetWords ?? 80000;
    const sceneBudgets = await this.reconcileWordBudgets(run, bookTargetWords, chapters);
    const defaultTargetWords = Math.floor(bookTargetWords / Math.max(totalScenes, 1));
    const candidateCount = Math.max(2, Math.min(4, settings.candidateCount ?? 2));
    const book = await this.db.book.findUniqueOrThrow({ where: { id: run.bookId } });
    const currentRevisionId = await manuscriptRevisionService.current(run.bookId);
    const orderedScenes = chapters.flatMap((chapter) => chapter.scenes);
    let completedScenes = orderedScenes.filter((scene) => Boolean(scene.prose?.trim())).length;
    let draftedWords = orderedScenes.reduce((sum, scene) => sum + (scene.prose?.trim() ? Number(scene.wordCount ?? scene.prose.trim().split(/\s+/).length) : 0), 0);
    const taskPlan = new Map(orderedScenes.map((scene, ordinal) => [scene.id, {
      ordinal,
      dependencies: ordinal === 0 ? [] : [`draft:scene:${orderedScenes[ordinal - 1].id}`],
    }]));
    for (const scene of orderedScenes) {
      const plan = taskPlan.get(scene.id)!;
      await this.db.workflowTask.upsert({
        where: { runId_taskKey: { runId: run.id, taskKey: `draft:scene:${scene.id}` } },
        update: { ordinal: plan.ordinal, dependencies: json(plan.dependencies), inputRevisionId: run.sourceRevisionId, leaseOwner },
        create: {
          id: randomUUID(), runId: run.id, taskKey: `draft:scene:${scene.id}`, taskType: 'draft_scene',
          phase: 'drafting', scopeType: 'scene', scopeId: String(scene.id), ordinal: plan.ordinal,
          dependencies: json(plan.dependencies), status: scene.prose?.trim() ? 'completed' : 'pending',
          inputRevisionId: run.sourceRevisionId, leaseOwner,
          finishedAt: scene.prose?.trim() ? new Date() : null,
        },
      });
      if (scene.prose?.trim()) await this.db.workflowTask.updateMany({
        where: { runId: run.id, taskKey: `draft:scene:${scene.id}`, outputRevisionId: null },
        data: { outputRevisionId: currentRevisionId },
      });
    }
    for (const chapter of targets) for (const scene of chapter.scenes) {
      const control = await this.db.workflowRun.findUnique({ where: { id: run.id }, select: { status: true, cancelRequested: true } });
      if (!control || control.cancelRequested || control.status === 'cancelled') return false;
      if (control.status === 'paused') return false;
      if (scene.prose?.trim()) continue;
      const sourceDocument = documentAuthorityEnabled() ? await documentService.read(run.userId, run.bookId, scene.id) : undefined;
      const nominalTargetWords = sceneBudgets.get(scene.id) ?? defaultTargetWords;
      const remainingScenes = Math.max(totalScenes - completedScenes, 1);
      const catchUpTarget = Math.round(Math.max(0, bookTargetWords - draftedWords) / remainingScenes);
      const targetWords = Math.round(Math.max(nominalTargetWords * 0.75, Math.min(nominalTargetWords * 1.5, catchUpTarget)));
      await this.db.workflowTask.update({
        where: { runId_taskKey: { runId: run.id, taskKey: `draft:scene:${scene.id}` } },
        data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 }, errorCode: null, errorMessage: null },
      });
      const candidates: Array<{ blindId: string; ordinal: number; traceId?: string; prose: string; wordCount: number; contractScore: number; literaryScore: number; lengthScore: number; selectionScore: number }> = [];
      const rejected = { generation: 0, validation: 0, length: 0, duplicate: 0 };
      const generationErrors: string[] = [];
      let candidateAttempts = 0;
      const maximumCandidateAttempts = candidateCount * 3;
      while (candidates.length < candidateCount && candidateAttempts < maximumCandidateAttempts) {
        const batchSize = Math.min(candidateCount - candidates.length, maximumCandidateAttempts - candidateAttempts);
        const ordinals = Array.from({ length: batchSize }, (_, index) => candidateAttempts + index + 1);
        candidateAttempts += batchSize;
        const generated = await Promise.allSettled(ordinals.map(async (ordinal) => {
          const context = {
            bookId: run.bookId, sceneId: scene.id, title: book.title ?? 'Untitled Book', genre: book.genre ?? undefined, summary: book.summary ?? undefined,
            chapterNumber: chapter.chapterNumber, chapterTitle: chapter.title ?? undefined, chapterSummary: chapter.summary ?? undefined,
            sceneNumber: scene.sceneNumber, sceneOutline: scene.outline ?? undefined, targetWords,
            writingStyle: [settings.style, settings.pov, settings.tense].filter(Boolean).join('; '), useCodexRAG: true,
            instructions: [`Blind candidate ${ordinal}. Produce a genuinely independent approach while honoring the scene contract, its chronology, entry state and exit state. Do not preempt later scenes.`, `Book-wide requirements (distributed across the manuscript, not a literal phrase checklist for this scene): ${JSON.stringify(settings.mustInclude ?? [])}`, `Book-wide exclusions: ${JSON.stringify(settings.mustAvoid ?? [])}`].join('\n'),
          };
          const options = { selectedModel: undefined, retries: 2, timeoutMs: 600000, autoReviseSkills: false };
          return sourceDocument ? workflowProseCandidate(this.prose, { userId: run.userId, bookId: run.bookId, runId: run.id, sceneId: scene.id, ordinal, source: sourceDocument, context, options }) : this.prose.generateProse(context, options);
        }));
        // Inference may finish after a pause/cancel or a lease replacement.
        // Suppress its late output before scoring or attempting any writes.
        const latestControl = await this.db.workflowRun.findUnique({ where: { id: run.id }, select: { status: true, cancelRequested: true, leaseOwner: true } });
        if (!latestControl || latestControl.cancelRequested || latestControl.status !== 'running' || latestControl.leaseOwner !== leaseOwner) return false;
        const recovery = generated.find((candidate) => candidate.status === 'rejected' && workflowEffectNeedsRecovery(candidate.reason));
        if (recovery?.status === 'rejected') throw recovery.reason;
        for (const [index, generatedCandidate] of generated.entries()) {
          if (generatedCandidate.status === 'rejected') {
            rejected.generation += 1;
            const reason = boundedFailureReason(generatedCandidate.reason);
            if (generationErrors.length < 3 && !generationErrors.includes(reason)) generationErrors.push(reason);
            continue;
          }
          const result = generatedCandidate.value;
          const validationPassed = !(result.validatorResults ?? []).some((validation) => validation.blocking && !validation.passed);
          if (!validationPassed || !result.prose.trim()) { rejected.validation += 1; continue; }
          if (result.wordCount < Math.max(250, targetWords * 0.65)) { rejected.length += 1; continue; }
          const prose = result.prose;
          if (candidates.some((candidate) => sha(candidate.prose) === sha(prose))) { rejected.duplicate += 1; continue; }
          const scores = scoreSceneCandidate(prose, result.wordCount, targetWords, book.genre, scene.outline);
          candidates.push({ blindId: `candidate-${ordinals[index]}`, ordinal: ordinals[index], traceId: result.traceId, prose, wordCount: result.wordCount, ...scores });
        }
      }
      if (candidates.length < candidateCount) throw new Error(`Only ${candidates.length}/${candidateCount} valid blinded prose candidates for scene ${scene.id} after ${candidateAttempts} bounded attempts (${JSON.stringify({ ...rejected, generationErrors })})`);
      candidates.sort((a, b) => b.selectionScore - a.selectionScore || Math.abs(a.wordCount - targetWords) - Math.abs(b.wordCount - targetWords));
      const winner = candidates[0];
      const payload = { sceneId: scene.id, nominalTargetWords, targetWords, selectedBlindId: winner.blindId, candidateAttempts, rejected, generationErrors, selectionPolicy: '55% contract movement, 25% literary rubric, 20% dynamic word-budget fit', candidates: candidates.map((candidate) => ({ blindId: candidate.blindId, wordCount: candidate.wordCount, contractScore: Math.round(candidate.contractScore * 10) / 10, literaryScore: candidate.literaryScore, lengthScore: Math.round(candidate.lengthScore * 10) / 10, selectionScore: Math.round(candidate.selectionScore * 10) / 10, contentHash: sha(candidate.prose) })) };
      if (sourceDocument) await commitWorkflowDraft(run, sourceDocument, winner, payload);
      else {
      await scenesService.updateSceneProse(run.userId, scene.id, { prose: winner.prose });
      await this.recordSceneMemory(run, scene.id, winner.prose);
      const sceneRevisionId = await manuscriptRevisionService.capture(run.bookId, run.id, [{ type: 'scene', id: scene.id }]);
      await this.db.workflowArtifact.create({ data: { id: randomUUID(), runId: run.id, artifactType: 'scene_candidate_selection', scopeType: 'scene', scopeId: String(scene.id), contentHash: sha(payload), payload: json(payload) } });
      await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey: `draft:scene:${scene.id}` } }, data: { status: 'completed', finishedAt: new Date(), outputRevisionId: sceneRevisionId, validationResult: json({ winnerWords: winner.wordCount, candidateCount: candidates.length }) } });
      }
      completedScenes += 1;
      draftedWords += winner.wordCount;
      await this.db.workflowRun.update({ where: { id: run.id }, data: {
        phase: firstChapterOnly ? 'sample_drafting' : 'drafting',
        lastHeartbeatAt: new Date(),
        progress: json({ completed: completedScenes, total: totalScenes, percent: Math.round(completedScenes * 100 / Math.max(totalScenes, 1)), unit: 'scenes' }),
      } });
      await this.event(run.id, 'scene_completed', { sceneId: scene.id, wordCount: winner.wordCount });
    }
    await manuscriptRevisionService.capture(run.bookId, run.id, targets.flatMap((chapter) => chapter.scenes.map((scene) => ({ type: 'scene', id: scene.id }))));
    return true;
  }

  private async reconcileWordBudgets(run: WorkflowRun, targetWords: number, chapters: Array<{ id: number; actId: number; scenes: Array<{ id: number; outline: string | null }> }>): Promise<Map<number, number>> {
    await assertWorkflowLease(run.id);
    const orderedScenes = chapters.flatMap((chapter) => chapter.scenes.map((scene) => ({ ...scene, chapterId: chapter.id, actId: chapter.actId })));
    const signature = sha({ targetWords, hierarchy: orderedScenes.map((scene) => [scene.actId, scene.chapterId, scene.id]) });
    const existing = await this.db.workflowArtifact.findFirst({ where: { runId: run.id, artifactType: 'word_budget_reconciliation', contentHash: signature }, orderBy: { createdAt: 'desc' } });
    if (existing) {
      const payload = existing.payload as { sceneBudgets?: Array<{ sceneId: number; words: number }> };
      return new Map((payload.sceneBudgets ?? []).map((budget) => [budget.sceneId, budget.words]));
    }
    const base = Math.floor(targetWords / Math.max(orderedScenes.length, 1));
    const remainder = targetWords - base * orderedScenes.length;
    const sceneBudgetRows = orderedScenes.map((scene, index) => ({ sceneId: scene.id, chapterId: scene.chapterId, actId: scene.actId, words: base + (index < remainder ? 1 : 0) }));
    const chapterBudgets = chapters.map((chapter) => ({ chapterId: chapter.id, actId: chapter.actId, words: sceneBudgetRows.filter((row) => row.chapterId === chapter.id).reduce((sum, row) => sum + row.words, 0) }));
    const actIds = [...new Set(chapters.map((chapter) => chapter.actId))];
    const actBudgets = actIds.map((actId) => ({ actId, words: chapterBudgets.filter((row) => row.actId === actId).reduce((sum, row) => sum + row.words, 0) }));
    const payload = { targetWords, reconciled: true, actBudgets, chapterBudgets, sceneBudgets: sceneBudgetRows.map(({ sceneId, words }) => ({ sceneId, words })) };
    await this.db.workflowArtifact.create({ data: { id: randomUUID(), runId: run.id, artifactType: 'word_budget_reconciliation', scopeType: 'book', scopeId: String(run.bookId), contentHash: signature, payload: json(payload) } });
    for (const scene of orderedScenes) {
      const contract = { sceneId: scene.id, chapterId: scene.chapterId, targetWords: sceneBudgetRows.find((row) => row.sceneId === scene.id)!.words, causalContract: scene.outline, requiredMovement: ['goal', 'opposition', 'choice', 'changed story state', 'exit hook'], budgetReconciliationHash: signature };
      await this.db.workflowArtifact.create({ data: { id: randomUUID(), runId: run.id, artifactType: 'scene_contract', scopeType: 'scene', scopeId: String(scene.id), contentHash: sha(contract), payload: json(contract) } });
    }
    return new Map(sceneBudgetRows.map((budget) => [budget.sceneId, budget.words]));
  }

  private async recordSceneMemory(run: WorkflowRun, sceneId: number, prose: string) {
    const characters = await this.db.codexEntry.findMany({ where: { bookId: run.bookId, entryType: 'character', deletedAt: null } });
    const actors = characters.filter((character) => findCharacterMention(character, characters, prose).matched);
    const exactEnding = prose.trim().split(/\s+/).slice(-120).join(' ');
    await this.db.sceneMemoryEvent.create({ data: { bookId: run.bookId, sceneId, eventType: 'scene_complete', actors: json(actors.map((actor) => ({ codexId: actor.id, name: actor.entryName }))), summary: prose.trim().split(/(?<=[.!?])\s+/).slice(-3).join(' ').slice(0, 2000), payload: json({ exactEnding, wordCount: prose.trim().split(/\s+/).length }), ordering: sceneId } });
    for (const actor of actors) await this.db.characterState.upsert({ where: { bookId_codexId_sceneId_stateKey: { bookId: run.bookId, codexId: actor.id, sceneId, stateKey: 'appeared' } }, update: { stateValue: 'true', confidence: 1 }, create: { bookId: run.bookId, codexId: actor.id, sceneId, stateKey: 'appeared', stateValue: 'true', confidence: 1 } });
    const due = await this.db.narrativeLedger.findFirst({ where: { workflowRunId: run.id, dueSceneId: sceneId, status: 'open' } });
    if (due) await this.db.narrativeLedger.update({ where: { id: due.id }, data: { status: 'resolved', resolvedSceneId: sceneId, payload: json({ ...(due.payload as object), resolutionEvidence: exactEnding }) } });
  }

  private selectedScenes(bookId: number, scope: WorkflowScope, requireProse = true) {
    return this.db.scene.findMany({ where: {
      chapter: { deletedAt: null, act: { bookId, deletedAt: null, ...(scope.type === 'act' ? { id: scope.id } : {}) }, ...(scope.type === 'chapter' ? { id: scope.id } : {}) },
      ...(scope.type === 'scene' ? { id: scope.id } : {}), deletedAt: null, ...(requireProse ? { prose: { not: null } } : {}),
    }, orderBy: sceneOrder, include: { chapter: { include: { act: true } } } });
  }

  private async processQualityReview(run: WorkflowRun) {
    await assertWorkflowLease(run.id);
    const leaseOwner = currentWorkflowExecution()!.leaseOwner;
    const input = run.settings as unknown as QualityReviewInput;
    const review = await this.db.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: run.id } });
    const scenes = await this.selectedScenes(run.bookId, input.scope, false);
    const reviewCharacters = await this.db.codexEntry.findMany({ where: { bookId: run.bookId, entryType: 'character', deletedAt: null }, select: { entryName: true, entryDescription: true, attributes: true } });
    const reviewCanon = canonicalContext(reviewCharacters);
    const withCanon = (source: string) => `Authoritative character codex (prose may be wrong; never revise these facts in a recommendation):\n${reviewCanon}\n\n${source}`;
    const provider = defaultModelRouter.forRequest('feedback', input.model, { noTransportReplay: documentAuthorityEnabled() });
    await this.db.qualityReviewRun.update({ where: { id: review.id }, data: { status: 'running', startedAt: new Date() } });
    const chapters = new Map<number, typeof scenes>();
    for (const scene of scenes) chapters.set(scene.chapterId, [...(chapters.get(scene.chapterId) ?? []), scene]);
    const acts = new Map<number, typeof scenes>();
    for (const scene of scenes) acts.set(scene.chapter.actId, [...(acts.get(scene.chapter.actId) ?? []), scene]);
    const reviewChapters = input.scope.type === 'scene' ? new Map<number, typeof scenes>() : chapters;
    const reviewActs = ['act', 'book'].includes(input.scope.type) ? acts : new Map<number, typeof scenes>();
    const taskPlan = [
      ...scenes.map((scene) => ({ key: `review:scene:${scene.id}`, type: 'review_scene', scopeType: 'scene', scopeId: scene.id, dependencies: [] as string[] })),
      ...[...reviewChapters.entries()].map(([chapterId, chapterScenes]) => ({ key: `review:chapter:${chapterId}`, type: 'review_chapter', scopeType: 'chapter', scopeId: chapterId, dependencies: chapterScenes.map((scene) => `review:scene:${scene.id}`) })),
      ...[...reviewActs.entries()].map(([actId, actScenes]) => ({ key: `review:act:${actId}`, type: 'review_act', scopeType: 'act', scopeId: actId, dependencies: [...new Set(actScenes.map((scene) => `review:chapter:${scene.chapterId}`))] })),
      ...(input.scope.type === 'book' ? [{ key: `review:book:${run.bookId}`, type: 'review_book', scopeType: 'book', scopeId: run.bookId, dependencies: [...reviewActs.keys()].map((actId) => `review:act:${actId}`) }] : []),
    ];
    const totalReviewTasks = taskPlan.length;
    for (const [ordinal, task] of taskPlan.entries()) await this.db.workflowTask.upsert({
      where: { runId_taskKey: { runId: run.id, taskKey: task.key } },
      update: { ordinal, dependencies: json(task.dependencies), modelUsed: input.model, inputRevisionId: run.sourceRevisionId, leaseOwner },
      create: { id: randomUUID(), runId: run.id, taskKey: task.key, taskType: task.type, phase: 'review', scopeType: task.scopeType, scopeId: String(task.scopeId), ordinal, dependencies: json(task.dependencies), modelUsed: input.model, inputRevisionId: run.sourceRevisionId, leaseOwner },
    });
    const completedTaskKeys = new Set((await this.db.workflowTask.findMany({ where: { runId: run.id, status: 'completed', taskKey: { startsWith: 'review:' } }, select: { taskKey: true } })).map((task) => task.taskKey));
    let completed = completedTaskKeys.size;
    await this.db.workflowRun.update({ where: { id: run.id }, data: { phase: 'review', progress: json({ completed, total: totalReviewTasks, percent: Math.round(completed * 100 / Math.max(totalReviewTasks, 1)), unit: 'review_scopes' }) } });
    await this.inBatches(scenes.filter((scene) => !completedTaskKeys.has(`review:scene:${scene.id}`)), 2, async (scene) => {
      const taskKey = `review:scene:${scene.id}`;
      await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } } });
      if (!scene.prose?.trim()) {
        const message = `Planned scene ${scene.id} has no prose and cannot pass a full-manuscript review.`;
        const fingerprint = findingFingerprint({ scopeType: 'scene', scopeId: scene.id, category: 'missing_prose', message });
        await this.db.qualityFinding.create({ data: { id: randomUUID(), reviewRunId: review.id, fingerprint, relatedFingerprint: sha(['missing_prose', scene.id]).slice(0, 24), scopeType: 'scene', scopeId: scene.id, category: 'missing_prose', severity: 'critical', confidence: 1, message, recommendation: 'Draft the planned scene before release review.' } });
      } else await this.reviewScope(provider, review.id, 'scene', scene.id, withCanon(`Scene ${scene.sceneNumber}, Chapter ${scene.chapter.chapterNumber}\nOutline: ${scene.outline ?? ''}\n\n${scene.prose}`), 6);
      await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'completed', finishedAt: new Date(), outputRevisionId: run.sourceRevisionId, validationResult: json({ reviewed: Boolean(scene.prose?.trim()) }) } });
      completed += 1;
      await this.db.workflowRun.update({ where: { id: run.id }, data: { lastHeartbeatAt: new Date(), progress: json({ completed, total: totalReviewTasks, percent: Math.round(completed * 100 / Math.max(totalReviewTasks, 1)), unit: 'review_scopes' }) } });
    });
    await this.inBatches([...reviewChapters.entries()].filter(([chapterId]) => !completedTaskKeys.has(`review:chapter:${chapterId}`)), 2, async ([chapterId, chapterScenes]) => {
      const taskKey = `review:chapter:${chapterId}`;
      await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } } });
      const context = chapterScenes.map((scene) => {
        const prose = scene.prose ?? '';
        return `Scene ${scene.sceneNumber}\nContract: ${scene.outline ?? ''}\nOpening excerpt: ${openingExcerpt(prose, 2500)}\nEnding excerpt: ${endingExcerpt(prose, 2500)}`;
      }).join('\n\n');
      await this.reviewScope(provider, review.id, 'chapter', chapterId, withCanon(context), 5);
      await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'completed', finishedAt: new Date(), outputRevisionId: run.sourceRevisionId } });
      completed += 1;
      await this.db.workflowRun.update({ where: { id: run.id }, data: { lastHeartbeatAt: new Date(), progress: json({ completed, total: totalReviewTasks, percent: Math.round(completed * 100 / Math.max(totalReviewTasks, 1)), unit: 'review_scopes' }) } });
    });
    await this.inBatches([...reviewActs.entries()].filter(([actId]) => !completedTaskKeys.has(`review:act:${actId}`)), 2, async ([actId, actScenes]) => {
      const taskKey = `review:act:${actId}`;
      await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } } });
      const context = actScenes.map((scene) => {
        const prose = scene.prose ?? '';
        return `Chapter ${scene.chapter.chapterNumber}, scene ${scene.sceneNumber}\nContract: ${scene.outline ?? ''}\nOpening excerpt: ${openingExcerpt(prose, 450)}\nEnding excerpt: ${endingExcerpt(prose, 450)}`;
      }).join('\n\n');
      await this.reviewScope(provider, review.id, 'act', actId, withCanon(context), 5);
      await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'completed', finishedAt: new Date(), outputRevisionId: run.sourceRevisionId } });
      completed += 1;
      await this.db.workflowRun.update({ where: { id: run.id }, data: { lastHeartbeatAt: new Date(), progress: json({ completed, total: totalReviewTasks, percent: Math.round(completed * 100 / Math.max(totalReviewTasks, 1)), unit: 'review_scopes' }) } });
    });
    if (input.scope.type === 'book' && !completedTaskKeys.has(`review:book:${run.bookId}`)) {
      const taskKey = `review:book:${run.bookId}`;
      await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } } });
      const context = scenes.map((scene) => {
        const prose = scene.prose ?? '';
        return `Act ${scene.chapter.act.actNumber}, chapter ${scene.chapter.chapterNumber}, scene ${scene.sceneNumber}\nContract: ${scene.outline ?? ''}\nOpening excerpt: ${openingExcerpt(prose, 300)}\nEnding excerpt: ${endingExcerpt(prose, 300)}`;
      }).join('\n\n');
      await this.reviewScope(provider, review.id, 'book', run.bookId, withCanon(context), 8);
      await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'completed', finishedAt: new Date(), outputRevisionId: run.sourceRevisionId } });
      completed += 1;
      await this.db.workflowRun.update({ where: { id: run.id }, data: { lastHeartbeatAt: new Date(), progress: json({ completed, total: totalReviewTasks, percent: Math.round(completed * 100 / Math.max(totalReviewTasks, 1)), unit: 'review_scopes' }) } });
    }
    if (input.scope.type === 'book') {
      await this.addCharacterCoverageFindings(review.id, run.bookId, scenes.map((scene) => scene.prose ?? '').join('\n'));
    }
    const severityRows = await this.db.qualityFinding.findMany({ where: { reviewRunId: review.id, severity: { in: ['critical', 'high'] } }, select: { id: true, category: true, recommendation: true } });
    for (const finding of severityRows) {
      if (isLocalizedReviewFinding(finding.category, finding.recommendation)) await this.db.qualityFinding.update({ where: { id: finding.id }, data: { severity: 'medium' } });
    }
    const coverage = { scene: scenes.length, chapter: reviewChapters.size, act: reviewActs.size, book: input.scope.type === 'book' ? 1 : 0, characterAliasChecked: input.scope.type === 'book', continuityChecked: true };
    const scoredFindings = await this.db.qualityFinding.findMany({ where: { reviewRunId: review.id }, select: { severity: true, confidence: true } });
    const score = scoreQualityFindings(scoredFindings, scenes.length);
    await this.db.qualityReviewRun.update({ where: { id: review.id }, data: { status: 'completed', coverage: json(coverage), score, finishedAt: new Date() } });
    await this.db.workflowArtifact.create({ data: { id: randomUUID(), runId: run.id, artifactType: 'quality_review', scopeType: input.scope.type, scopeId: input.scope.id ? String(input.scope.id) : String(run.bookId), contentHash: sha({ reviewId: review.id, coverage, score }), sourceRevisionId: run.sourceRevisionId, payload: json({ reviewId: review.id, coverage, score, model: input.model, rubricVersion: input.rubricVersion }) } });
    await this.complete(run.id);
  }

  private async reviewScope(provider: AIProvider, reviewRunId: string, scopeType: string, scopeId: number, source: string, maximum: number) {
    const bounded = source.length > 60_000 ? `${source.slice(0, 30_000)}\n...[middle omitted for bounded review context]...\n${source.slice(-30_000)}` : source;
    const parsed = await this.structuredObject(provider, `Analyze this ${scopeType} for publishable fiction quality, causal continuity, character consistency, pacing, voice, structure, promises, setups, and payoffs. Severity calibration: critical means a release-blocking contradiction, missing/truncated prose, or broken core story logic; high means a substantial reader-facing defect that cannot be repaired as localized polish; medium means a clear actionable craft defect; low means optional polish. Do not fill a quota, invent evidence, repeat the same diagnosis, or report speculative preferences. Context may contain explicitly labeled opening/ending excerpts with the middle intentionally omitted; never report those excerpt boundaries or labels as manuscript truncation. Critical and high findings require an exact supporting quote and confidence of at least 0.75. Schema: {"findings":[{"category":"clarity|grammar|punctuation|repetition|cadence|specificity|continuity|pacing|voice|structure|canon|promise_payoff","severity":"critical|high|medium|low","confidence":0.0,"message":"specific diagnosis","evidence":"short exact quote when available","recommendation":"specific repair"}]}. Return at most ${maximum} non-duplicative findings; an empty findings list is valid and preferred when no concrete defect is supported.\n\n${bounded}`, (value) => Array.isArray(value.findings) && value.findings.every((item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).message === 'string'), `${scopeType} quality review`, qualityReviewSchema, 'critic');
    const findings = Array.isArray(parsed?.findings) ? parsed.findings as Array<Record<string, unknown>> : [];
    for (const item of findings.slice(0, maximum)) {
      const category = normalizeFindingCategory(item.category);
      const message = String(item.message ?? '').trim().slice(0, 2000);
      if (!message) continue;
      const evidence = item.evidence == null ? null : String(item.evidence).trim().slice(0, 500) || null;
      let severity = ['critical', 'high', 'medium', 'low'].includes(String(item.severity)) ? String(item.severity) : 'medium';
      const fingerprint = findingFingerprint({ scopeType, scopeId, category, message, evidence });
      const relationBasis = (evidence ?? message).toLowerCase().replace(/\W+/g, ' ').trim();
      const rawConfidence = Number(item.confidence ?? 0.7);
      const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0.7;
      const recommendation = item.recommendation == null ? null : String(item.recommendation).slice(0, 2000);
      if (['critical', 'high'].includes(severity) && (!evidence || normalizeQuote(evidence).length < 12 || confidence < 0.75 || !evidenceMatches(source, evidence) || !recommendation?.trim())) severity = 'medium';
      const inherentlyLocalized = isLocalizedReviewFinding(category, recommendation);
      if (['critical', 'high'].includes(severity) && inherentlyLocalized) severity = 'medium';
      await this.db.qualityFinding.upsert({ where: { reviewRunId_fingerprint: { reviewRunId, fingerprint } }, update: {}, create: {
        id: randomUUID(), reviewRunId, fingerprint,
        relatedFingerprint: sha([scopeType, scopeId, category.toLowerCase(), relationBasis]).slice(0, 24),
        scopeType, scopeId, category, severity, confidence, message, evidence,
        recommendation,
      } });
    }
  }

  private async addCharacterCoverageFindings(reviewRunId: string, bookId: number, prose: string) {
    const characters = await this.db.codexEntry.findMany({ where: { bookId, entryType: 'character', deletedAt: null } });
    for (const character of characters) {
      const matched = findCharacterMention(character, characters, prose);
      if (matched.matched) continue;
      const message = `${character.entryName} is defined in the codex but not found in the reviewed prose.`;
      const fingerprint = findingFingerprint({ scopeType: 'book', category: 'unused_character', message });
      await this.db.qualityFinding.upsert({ where: { reviewRunId_fingerprint: { reviewRunId, fingerprint } }, update: {}, create: {
        id: randomUUID(), reviewRunId, fingerprint, relatedFingerprint: sha(['unused_character', character.id]).slice(0, 24), scopeType: 'book', category: 'unused_character', severity: 'low', confidence: 0.95, message,
        evidence: `Aliases checked: ${characterAliases(character, characters).join(', ')}`, recommendation: 'Use the character, remove the codex entry, or explicitly waive the finding.',
      } });
    }
  }

  private async processImproveQuality(run: WorkflowRun) {
    await assertWorkflowLease(run.id);
    const leaseOwner = currentWorkflowExecution()!.leaseOwner;
    const input = run.settings as unknown as ImproveQualityInput;
    const reviews = await this.db.qualityReviewRun.findMany({ where: { id: { in: input.reviewRunIds }, bookId: run.bookId }, include: { findings: true } });
    if (reviews.length !== input.reviewRunIds.length) throw new Error('One or more review runs were not found for this book');
    const allowed = input.findingIds?.length ? new Set(input.findingIds) : null;
    const terminalTaskKeys = new Set((await this.db.workflowTask.findMany({ where: { runId: run.id, taskType: 'revise_finding', status: { in: ['completed', 'skipped'] } }, select: { taskKey: true } })).map((task) => task.taskKey));
    const findings = reviews.flatMap((review) => review.findings).filter((finding) => (!finding.implemented || (finding.implementingWorkflowRunId === run.id && finding.verificationStatus === 'pending')) && !finding.waived && !finding.stale && !finding.superseded && !terminalTaskKeys.has(`revise:finding:${finding.id}`) && (!allowed || allowed.has(finding.id)));
    const selectedTaskKeys = findings.map((finding) => `revise:finding:${finding.id}`);
    await this.db.workflowTask.updateMany({ where: {
      runId: run.id, taskType: 'revise_finding', status: { in: ['pending', 'running', 'awaiting_approval'] },
      ...(selectedTaskKeys.length ? { taskKey: { notIn: selectedTaskKeys } } : {}),
    }, data: { status: 'skipped', finishedAt: new Date(), validationResult: json({ reason: 'finding_no_longer_actionable' }) } });
    const sourceScenes = await this.selectedScenes(run.bookId, { type: 'book' });
    const canonCharacters = await this.db.codexEntry.findMany({
      where: { bookId: run.bookId, entryType: 'character', deletedAt: null },
      select: { entryName: true, entryDescription: true, attributes: true },
    });
    const canon = canonicalContext(canonCharacters);
    const sourceForFinding = (finding: QualityFinding) => sourceScenes.filter((scene) => {
      if (finding.scopeType === 'scene') return scene.id === finding.scopeId;
      if (finding.scopeType === 'chapter') return scene.chapterId === finding.scopeId;
      if (finding.scopeType === 'act') return scene.chapter.actId === finding.scopeId;
      return true;
    }).map((scene) => scene.prose ?? '').join('\n\n');
    const evidenceFresh = new Map<string, boolean>();
    for (const finding of findings) {
      if (finding.implemented && finding.verificationStatus === 'pending') { evidenceFresh.set(finding.id, true); continue; }
      if (finding.scopeType === 'scene' && !finding.scopeId) { evidenceFresh.set(finding.id, false); continue; }
      const source = sourceForFinding(finding);
      const fresh = Boolean(source.trim()) && (!finding.evidence || evidenceMatches(source, finding.evidence));
      evidenceFresh.set(finding.id, fresh);
      if (!fresh) await this.db.qualityFinding.update({ where: { id: finding.id }, data: { stale: true } });
    }
    const decisionFindings = findings.filter((finding) => evidenceFresh.get(finding.id));
    const conflicts = this.findConflicts(decisionFindings);
    if (conflicts.length && await this.checkpoint(run, 'conflicting_review_advice', { conflicts }, 'conflict_checkpoint')) return;
    const highImpactFindings = decisionFindings.filter((finding) => finding.scopeType !== 'scene' || ['structure', 'canon', 'pov', 'tense', 'chronology', 'ending'].includes(finding.category.toLowerCase()));
    if (highImpactFindings.length && await this.checkpoint(run, 'developmental_revision_plan', {
      findingIds: highImpactFindings.map((finding) => finding.id),
      changes: highImpactFindings.map((finding) => ({
        findingId: finding.id,
        scope: { type: finding.scopeType, id: finding.scopeId },
        category: finding.category,
        diagnosis: finding.message,
        recommendation: finding.recommendation,
      })),
      authoritativeCanon: canon,
      reason: 'Structural, canon, POV, tense, chronology, ending, and cross-scope changes require one explicit developmental approval.',
    }, 'developmental_revision_checkpoint')) return;
    const highImpactCategories = new Set(['structure', 'canon', 'pov', 'tense', 'chronology', 'ending']);
    const compatibleSceneGroups = new Map<number, QualityFinding[]>();
    for (const finding of decisionFindings) {
      if (finding.scopeType !== 'scene' || !finding.scopeId || highImpactCategories.has(finding.category.toLowerCase())) continue;
      compatibleSceneGroups.set(finding.scopeId, [...(compatibleSceneGroups.get(finding.scopeId) ?? []), finding]);
    }
    const groupedByLeader = new Map<string, QualityFinding[]>();
    const leaderByFinding = new Map<string, string>();
    for (const group of compatibleSceneGroups.values()) {
      const leader = group[0];
      groupedByLeader.set(leader.id, group);
      for (const member of group) leaderByFinding.set(member.id, leader.id);
    }
    const priorTaskForScope = new Map<string, string>();
    for (const [ordinal, finding] of findings.entries()) {
      const scopeKey = `${finding.scopeType}:${finding.scopeId ?? run.bookId}`;
      const taskKey = `revise:finding:${finding.id}`;
      const dependencies = priorTaskForScope.has(scopeKey) ? [priorTaskForScope.get(scopeKey)!] : [];
      await this.db.workflowTask.upsert({
        where: { runId_taskKey: { runId: run.id, taskKey } },
        update: { ordinal, dependencies: json(dependencies), modelUsed: input.model ?? null, leaseOwner },
        create: {
          id: randomUUID(), runId: run.id, taskKey, taskType: 'revise_finding', phase: 'revision',
          scopeType: finding.scopeType, scopeId: finding.scopeId == null ? null : String(finding.scopeId),
          ordinal, dependencies: json(dependencies), status: finding.implemented ? 'completed' : 'pending',
          modelUsed: input.model ?? null, inputRevisionId: run.sourceRevisionId, leaseOwner,
        },
      });
      priorTaskForScope.set(scopeKey, taskKey);
    }
    const changed: number[] = [];
    for (const finding of findings) {
      const taskKey = `revise:finding:${finding.id}`;
      const groupLeaderId = leaderByFinding.get(finding.id);
      if (groupLeaderId && groupLeaderId !== finding.id) continue;
      await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } } });
      if (finding.implemented && finding.verificationStatus === 'pending') {
        const verificationText = (await this.selectedScenes(run.bookId, { type: ['book', 'act', 'chapter', 'scene'].includes(finding.scopeType) ? finding.scopeType as WorkflowScope['type'] : 'book', id: finding.scopeId ?? undefined })).map((scene) => scene.prose ?? '').join('\n\n');
        const verification = await this.verifyFinding(input.model, finding, verificationText);
        await this.db.qualityFinding.update({ where: { id: finding.id }, data: { verificationStatus: verification.passed ? 'passed' : 'failed', verifiedAt: new Date(), verificationEvidence: verification.rationale } });
        await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'completed', finishedAt: new Date(), validationResult: json({ verificationStatus: verification.passed ? 'passed' : 'failed' }) } });
        continue;
      }
      if (finding.scopeType === 'scene' && !finding.scopeId) {
        await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'skipped', finishedAt: new Date(), validationResult: json({ reason: 'missing_scope_id' }) } });
        continue;
      }
      const evidenceScopeType = ['book', 'act', 'chapter', 'scene'].includes(finding.scopeType) ? finding.scopeType as WorkflowScope['type'] : 'book';
      const evidenceScenes = await this.selectedScenes(run.bookId, { type: evidenceScopeType, id: finding.scopeId ?? undefined });
      const evidenceSource = evidenceScenes.map((scene) => scene.prose ?? '').join('\n\n');
      if (!evidenceSource.trim() || (finding.evidence && !evidenceMatches(evidenceSource, finding.evidence))) {
        await this.db.qualityFinding.update({ where: { id: finding.id }, data: { stale: true } });
        await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'skipped', finishedAt: new Date(), validationResult: json({ reason: finding.evidence ? 'evidence_mismatch' : 'missing_prose', stale: true }) } });
        continue;
      }
      const highImpactCategory = ['structure', 'canon', 'pov', 'tense', 'chronology', 'ending'].includes(finding.category.toLowerCase());
      if (finding.scopeType !== 'scene' || highImpactCategory) {
        const type = ['book', 'act', 'chapter', 'scene'].includes(finding.scopeType) ? finding.scopeType as WorkflowScope['type'] : 'book';
        const scopedTargets = await this.selectedScenes(run.bookId, { type, id: finding.scopeId ?? undefined });
        // Cross-scope advice is permission to make a structural change, not
        // permission to rewrite every scene in that scope. Ground the edit in
        // the scene(s) containing the critic's exact evidence. Ungrounded broad
        // advice remains historical and unimplemented for a later human plan.
        const targets = finding.scopeType === 'scene'
          ? scopedTargets
          : finding.evidence
            ? scopedTargets.filter((target) => target.prose && evidenceMatches(target.prose, finding.evidence!))
            : [];
        if (!targets.length) {
          await this.db.qualityFinding.update({ where: { id: finding.id }, data: { verificationStatus: 'failed', verificationEvidence: 'Approved cross-scope advice had no exact scene evidence, so no prose was changed.', verifiedAt: new Date() } });
          await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'completed', finishedAt: new Date(), validationResult: json({ implemented: false, verificationStatus: 'failed', reason: 'cross_scope_evidence_not_grounded' }) } });
          continue;
        }
        const structuralChanged: number[] = [];
        for (const target of targets) {
          if (!target.prose) continue;
          const sourceDocument = documentAuthorityEnabled() ? await documentService.read(run.userId, run.bookId, target.id) : undefined;
          const checkpointType = `structural_scene:${finding.id}:${target.id}`;
          const approved = await this.db.workflowCheckpoint.findFirst({ where: { runId: run.id, checkpointType, decision: 'approved' }, orderBy: { createdAt: 'desc' } });
          const proposal = approved?.proposal as { original?: string; revised?: string } | undefined;
          if (approved) assertWorkflowCheckpointSource(proposal, sourceDocument);
          if (proposal?.original && proposal.original !== target.prose) continue;
          const revised = proposal?.revised ?? (await this.reviewWorkflowProse(run, target, sourceDocument, `structural:${finding.id}:${target.id}`, { maxEditPct: 20, instruction: `${finding.message}\n${finding.recommendation ?? 'Resolve this finding while preserving established canon.'}\n\nThe following codex is authoritative. Never follow review advice that contradicts it:\n${canon}`, sceneOutline: target.outline ?? undefined }, { selectedModel: input.model, retries: 2, timeoutMs: 300000 })).revised;
          if (revised === target.prose) continue;
          const safety = revisionSafety(target.prose, revised, canonCharacters);
          if (safety.reasons.some((reason) => nonWaivableRevisionReasons.has(reason))) throw new Error(`Revision for scene ${target.id} failed non-waivable truncation or placeholder validation`);
          if (!safety.safe && !approved && await this.checkpoint(run, checkpointType, { findingId: finding.id, sceneId: target.id, original: target.prose, revised, safety, authoritativeCanon: canon, sourceProof: workflowCheckpointSource(sourceDocument) }, 'structural_scene_checkpoint')) return;
          await scenesService.updateSceneProse(run.userId, target.id, { prose: revised }, sourceDocument ? { operationId: compatibilityOperationId('proser.workflow-structural-revision.v1', { runId: run.id, findingId: finding.id, sceneId: target.id, source: sourceDocument.revisionId }), expectedRevisionId: sourceDocument.bookRevisionId, expectedSceneRevisionId: sourceDocument.revisionId, expectedScopes: {}, origin: 'workflow' } : undefined);
          structuralChanged.push(target.id); changed.push(target.id);
        }
        if (!structuralChanged.length) {
          await this.db.qualityFinding.update({ where: { id: finding.id }, data: { verificationStatus: 'failed', verificationEvidence: 'No manuscript change was produced, so the finding was not marked implemented.', verifiedAt: new Date() } });
          await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'completed', finishedAt: new Date(), validationResult: json({ implemented: false, verificationStatus: 'failed', reason: 'no_change' }) } });
          continue;
        }
        const revisionId = await manuscriptRevisionService.capture(run.bookId, run.id, structuralChanged.map((id) => ({ type: 'scene', id })));
        const currentText = (await this.selectedScenes(run.bookId, { type, id: finding.scopeId ?? undefined })).map((scene) => scene.prose ?? '').join('\n');
        await this.db.qualityFinding.update({ where: { id: finding.id }, data: { implemented: true, implementedAt: new Date(), implementingWorkflowRunId: run.id, implementedRevisionId: revisionId, changedScopes: json(structuralChanged.map((id) => ({ type: 'scene', id }))), diffSummary: `${structuralChanged.length} approved scene revisions`, verificationStatus: 'pending' } });
        const verification = await this.verifyFinding(input.model, finding, currentText);
        await this.db.qualityFinding.update({ where: { id: finding.id }, data: { verificationStatus: verification.passed ? 'passed' : 'failed', verifiedAt: new Date(), verificationEvidence: verification.rationale } });
        await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'completed', finishedAt: new Date(), outputRevisionId: revisionId, validationResult: json({ implemented: true, verificationStatus: verification.passed ? 'passed' : 'failed' }) } });
        continue;
      }
      if (!finding.scopeId) { await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'skipped', finishedAt: new Date(), validationResult: json({ reason: 'missing_scope_id' }) } }); continue; }
      const scene = await this.db.scene.findUnique({ where: { id: finding.scopeId } }); if (!scene?.prose) { await this.db.qualityFinding.update({ where: { id: finding.id }, data: { stale: true } }); await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'skipped', finishedAt: new Date(), validationResult: json({ reason: 'missing_prose', stale: true }) } }); continue; }
      if (finding.evidence && !evidenceMatches(scene.prose, finding.evidence)) { await this.db.qualityFinding.update({ where: { id: finding.id }, data: { stale: true } }); await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey } }, data: { status: 'skipped', finishedAt: new Date(), validationResult: json({ reason: 'evidence_mismatch', stale: true }) } }); continue; }
      const sourceDocument = documentAuthorityEnabled() ? await documentService.read(run.userId, run.bookId, scene.id) : undefined;
      const revisionFindings = groupedByLeader.get(finding.id) ?? [finding];
      const groupedTaskKeys = revisionFindings.map((member) => `revise:finding:${member.id}`);
      const checkpointType = `high_impact_revision:${finding.id}`;
      const approved = await this.db.workflowCheckpoint.findFirst({ where: { runId: run.id, checkpointType, decision: 'approved' }, orderBy: { createdAt: 'desc' } });
      const approvedProposal = approved?.proposal as { original?: string; revised?: string } | undefined;
      if (approved) assertWorkflowCheckpointSource(approvedProposal, sourceDocument);
      if (approvedProposal?.original && approvedProposal.original !== scene.prose) { await this.db.qualityFinding.updateMany({ where: { id: { in: revisionFindings.map((member) => member.id) } }, data: { stale: true } }); continue; }
      const combinedInstruction = revisionFindings.map((member, index) => `${index + 1}. ${member.message}\nRecommendation: ${member.recommendation ?? 'Repair the issue while preserving canon.'}`).join('\n\n');
      const revised = approvedProposal?.revised ?? (await this.reviewWorkflowProse(run, scene, sourceDocument, `finding:${finding.id}:scene:${scene.id}`, { maxEditPct: 20, instruction: `Resolve these compatible findings in one coherent scene revision:\n\n${combinedInstruction}\n\nThe following codex is authoritative. Never follow review advice that contradicts it:\n${canon}` }, { selectedModel: input.model, retries: 2, timeoutMs: 300000 })).revised;
      if (revised === scene.prose) {
        await this.db.qualityFinding.updateMany({ where: { id: { in: revisionFindings.map((member) => member.id) } }, data: { verificationStatus: 'failed', verificationEvidence: 'No manuscript change was produced, so the finding was not marked implemented.', verifiedAt: new Date() } });
        await this.db.workflowTask.updateMany({ where: { runId: run.id, taskKey: { in: groupedTaskKeys } }, data: { status: 'completed', finishedAt: new Date(), validationResult: json({ implemented: false, verificationStatus: 'failed', reason: 'no_change' }) } });
        continue;
      }
      const safety = revisionSafety(scene.prose, revised, canonCharacters);
      if (safety.reasons.some((reason) => nonWaivableRevisionReasons.has(reason))) throw new Error(`Revision for scene ${scene.id} failed non-waivable truncation or placeholder validation`);
      if (!safety.safe) {
        if (!approved && await this.checkpoint(run, checkpointType, { findingIds: revisionFindings.map((member) => member.id), sceneId: scene.id, original: scene.prose, revised, safety, authoritativeCanon: canon, sourceProof: workflowCheckpointSource(sourceDocument) }, 'revision_checkpoint')) return;
      }
      await scenesService.updateSceneProse(run.userId, scene.id, { prose: revised }, sourceDocument ? { operationId: compatibilityOperationId('proser.workflow-scene-revision.v1', { runId: run.id, sceneId: scene.id, source: sourceDocument.revisionId }), expectedRevisionId: sourceDocument.bookRevisionId, expectedSceneRevisionId: sourceDocument.revisionId, expectedScopes: {}, origin: 'workflow' } : undefined); changed.push(scene.id);
      const revisionId = await manuscriptRevisionService.capture(run.bookId, run.id, [{ type: 'scene', id: scene.id }]);
      await this.db.qualityFinding.updateMany({ where: { id: { in: revisionFindings.map((member) => member.id) } }, data: { implemented: true, implementedAt: new Date(), implementingWorkflowRunId: run.id, implementedRevisionId: revisionId, changedScopes: json([{ type: 'scene', id: scene.id }]), diffSummary: `${Math.round(safety.diffRatio * 100)}% normalized token change addressing ${revisionFindings.length} compatible findings`, verificationStatus: 'pending' } });
      for (const member of revisionFindings) {
        const verification = await this.verifyFinding(input.model, member, revised);
        await this.db.qualityFinding.update({ where: { id: member.id }, data: { verificationStatus: verification.passed ? 'passed' : 'failed', verifiedAt: new Date(), verificationEvidence: verification.rationale } });
        await this.db.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey: `revise:finding:${member.id}` } }, data: { status: 'completed', finishedAt: new Date(), outputRevisionId: revisionId, validationResult: json({ implemented: true, groupedFindingCount: revisionFindings.length, verificationStatus: verification.passed ? 'passed' : 'failed' }) } });
        await this.event(run.id, 'finding_implemented', { findingId: member.id, sceneId: scene.id, revisionId, groupedFindingCount: revisionFindings.length, verificationStatus: verification.passed ? 'passed' : 'failed' });
      }
    }
    const resultRevisionId = await manuscriptRevisionService.capture(run.bookId, run.id, changed.map((id) => ({ type: 'scene', id })));
    await this.db.workflowRun.update({ where: { id: run.id }, data: { resultRevisionId } });
    await this.complete(run.id);
  }

  private findConflicts(findings: Array<{ id: string; relatedFingerprint: string | null; recommendation: string | null }>) {
    const groups = new Map<string, typeof findings>();
    for (const finding of findings) { const key = finding.relatedFingerprint ?? finding.id; groups.set(key, [...(groups.get(key) ?? []), finding]); }
    return [...groups.entries()].filter(([, values]) => new Set(values.map((value) => value.recommendation?.toLowerCase().trim())).size > 1).map(([fingerprint, values]) => ({ fingerprint, findingIds: values.map((value) => value.id), recommendations: values.map((value) => value.recommendation) }));
  }

  private async verifyFinding(model: string | undefined, finding: QualityFinding, source: string): Promise<{ passed: boolean; rationale: string }> {
    if (finding.evidence && !evidenceMatches(source, finding.evidence)) return { passed: true, rationale: 'The quoted source evidence is absent from the resulting manuscript revision.' };
    const bounded = source.length > 60_000 ? `${source.slice(0, 30_000)}\n...[middle omitted]...\n${source.slice(-30_000)}` : source;
    const provider = defaultModelRouter.forRequest('feedback', model, { noTransportReplay: documentAuthorityEnabled() });
    const result = await this.structuredObject(provider, `Verify only whether this stored finding has been resolved in the resulting manuscript. Finding: ${finding.message}\nRecommendation: ${finding.recommendation ?? 'Resolve the diagnosed issue.'}\nQuoted evidence: ${finding.evidence ?? 'No exact quote was stored.'}\nSchema: {"resolved":true,"rationale":"brief evidence-based reason"}.\n\n${bounded}`, (value) => typeof value.resolved === 'boolean' && typeof value.rationale === 'string', 'finding verification', findingVerificationSchema, 'critic');
    return { passed: result.resolved === true, rationale: String(result.rationale).slice(0, 2000) };
  }

  private async processGuidedImprove(run: WorkflowRun) {
    await assertWorkflowLease(run.id);
    const input = run.settings as unknown as GuidedImproveInput; const scope = input.scope ?? { type: 'book' as const };
    const structural = /\b(?:add|remove|reorder|rewrite)\s+(?:chapter|scene|act)|\b(?:pov|tense|timeline|ending|canon)\b/i.test(input.instruction);
    const scopedScenes = await this.selectedScenes(run.bookId, scope);
    const characters = await this.db.codexEntry.findMany({ where: { bookId: run.bookId, entryType: 'character', deletedAt: null } });
    const canon = canonicalContext(characters);
    const relationshipReconciliation = /\b(?:canon|codex)\b/i.test(input.instruction)
      && /\b(?:pronoun|kinship|relationship|sister|brother|mother|father|daughter|son)\b/i.test(input.instruction);
    const relationshipCharacters = characters.filter((character) => new RegExp(`\\b${escapeRegex(character.entryName)}\\b\\s+(?:is|as)\\b`, 'i').test(input.instruction));
    const relationshipCanon = relationshipCharacters.length ? relationshipCharacters : characters;
    const scenes = relationshipReconciliation
      ? scopedScenes.filter((scene) => Boolean(scene.prose) && canonicalRelationshipContradictions(scene.prose!, relationshipCanon) > 0)
      : scopedScenes;
    const referencedCharacters = characters.filter((character) => findCharacterMention(character, characters, input.instruction).matched).map((character) => ({ id: character.id, name: character.entryName }));
    const interpretedPlan = {
      instruction: input.instruction,
      scope,
      impact: structural ? 'high' : 'localized',
      affectedScenes: scenes.map((scene) => ({ id: scene.id, chapterId: scene.chapterId, outline: scene.outline ?? null })),
      referencedCharacters,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      authoritativeCanon: canon,
      policy: structural ? 'author-approved-high-impact' : 'safe-localized',
    };
    if (structural && await this.checkpoint(run, 'guided_structural_plan', interpretedPlan, 'guided_plan_checkpoint')) return;
    const changed: number[] = [];
    const changes: Array<{ sceneId: number; beforeHash: string; afterHash: string; beforeWords: number; afterWords: number; diffRatio: number; safetyReasons: string[]; canonNamesPreserved: boolean }> = [];
    for (const scene of scenes) {
      if (!scene.prose) continue;
      const sourceDocument = documentAuthorityEnabled() ? await documentService.read(run.userId, run.bookId, scene.id) : undefined;
      const checkpointType = `guided_high_impact_revision:${scene.id}`;
      const priorDecision = await this.db.workflowCheckpoint.findFirst({ where: { runId: run.id, checkpointType, status: 'decided' }, orderBy: { createdAt: 'desc' } });
      if (priorDecision?.decision === 'rejected') {
        await this.event(run.id, 'guided_change_skipped', { sceneId: scene.id, checkpointId: priorDecision.id, reason: priorDecision.reason });
        continue;
      }
      const approved = priorDecision?.decision === 'approved' ? priorDecision : null;
      const approvedProposal = approved?.proposal as { original?: string; revised?: string } | undefined;
      if (approved) assertWorkflowCheckpointSource(approvedProposal, sourceDocument);
      if (approvedProposal?.original && approvedProposal.original !== scene.prose) continue;
      let revised = approvedProposal?.revised;
      const exactReplacements = parseExactReplacements(input.instruction);
      if (!revised && exactReplacements.length) {
        revised = scene.prose;
        for (const replacement of exactReplacements) if (revised.includes(replacement.from)) revised = revised.replace(replacement.from, replacement.to);
      }
      if (!revised && relationshipReconciliation) {
        const provider = defaultModelRouter.forRequest('feedback', input.model, { noTransportReplay: documentAuthorityEnabled() });
        revised = scene.prose;
        for (let patchRound = 0; patchRound < 3; patchRound += 1) {
          const sentences = revised.split(/(?<=[.!?])\s+/);
          const contradictorySentences = [...new Set(sentences.map((sentence, index) => index > 0 ? `${sentences[index - 1]} ${sentence}` : sentence).filter((sentence) => canonicalRelationshipContradictions(sentence, relationshipCanon) > 0))];
          if (!contradictorySentences.length) break;
          const patchRecipe = await this.structuredObject(provider, `Repair only incorrect character relationship nouns and pronouns in the supplied sentences. The codex is authoritative. Return each original sentence byte-for-byte in "from" and a minimally changed replacement in "to". Do not alter unrelated wording. Schema: {"replacements":[{"from":"exact original sentence","to":"minimally corrected sentence"}]}.\n\nInstruction: ${input.instruction}\n\nCodex:\n${canon}\n\nSentences:\n${contradictorySentences.join('\n')}`, (value) => Array.isArray(value.replacements) && value.replacements.every((entry) => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).from === 'string' && typeof (entry as Record<string, unknown>).to === 'string'), 'guided canon relationship patch', relationshipPatchSchema, 'structured');
          let applied = 0;
          for (const replacement of (patchRecipe.replacements as Array<{ from: string; to: string }>).slice(0, 20)) {
            if (!revised.includes(replacement.from)) continue;
            if (!relationshipOnlyReplacement(replacement.from, replacement.to)) continue;
            if (canonicalRelationshipContradictions(replacement.to, relationshipCanon) >= canonicalRelationshipContradictions(replacement.from, relationshipCanon)) continue;
            revised = revised.replace(replacement.from, replacement.to); applied += 1;
          }
          if (!applied) break;
        }
      }
      revised ??= (await this.reviewWorkflowProse(run, scene, sourceDocument, `guided:${scene.id}`, { maxEditPct: 20, instruction: `${input.instruction}\n\nThe following codex is authoritative. Preserve every stated relationship, role, identity, and alias:\n${canon}`, sceneOutline: scene.outline ?? undefined }, { selectedModel: input.model, retries: 2, timeoutMs: 300000 })).revised;
      if (revised === scene.prose) continue;
      const safety = revisionSafety(scene.prose, revised, characters);
      if (relationshipReconciliation && relationshipOnlyReplacement(scene.prose, revised)) {
        safety.reasons = safety.reasons.filter((reason) => reason !== 'named_entities_changed');
        safety.safe = safety.reasons.length === 0;
      }
      if (safety.reasons.some((reason) => nonWaivableRevisionReasons.has(reason))) throw new Error(`Guided revision for scene ${scene.id} failed non-waivable truncation or placeholder validation`);
      if (!safety.safe) {
        if (!approved && await this.checkpoint(run, checkpointType, { sceneId: scene.id, original: scene.prose, revised, safety, instruction: input.instruction, authoritativeCanon: canon, sourceProof: workflowCheckpointSource(sourceDocument) }, 'guided_revision_checkpoint')) return;
      }
      const mentionedCharacters = characters.filter((character) => findCharacterMention(character, characters, scene.prose!).matched);
      const canonNamesPreserved = mentionedCharacters.every((character) => findCharacterMention(character, characters, revised).matched);
      await scenesService.updateSceneProse(run.userId, scene.id, { prose: revised }, sourceDocument ? { operationId: compatibilityOperationId('proser.workflow-scene-revision.v1', { runId: run.id, sceneId: scene.id, source: sourceDocument.revisionId }), expectedRevisionId: sourceDocument.bookRevisionId, expectedSceneRevisionId: sourceDocument.revisionId, expectedScopes: {}, origin: 'workflow' } : undefined); changed.push(scene.id);
      changes.push({
        sceneId: scene.id,
        beforeHash: sha(scene.prose), afterHash: sha(revised),
        beforeWords: scene.prose.trim().split(/\s+/).length, afterWords: revised.trim().split(/\s+/).length,
        diffRatio: safety.diffRatio, safetyReasons: safety.reasons, canonNamesPreserved,
      });
    }
    const sourceRevision = run.sourceRevisionId ? await this.db.manuscriptRevision.findUnique({ where: { id: run.sourceRevisionId }, select: { snapshot: true } }) : null;
    const sourceSnapshot = run.sourceRevisionId && sourceRevision ? await manuscriptRevisionService.snapshotRevision(run.bookId, run.sourceRevisionId) : undefined;
    const currentSnapshot = await manuscriptRevisionService.snapshot(run.bookId);
    const sourceById = new Map((sourceSnapshot?.scenes ?? []).map((scene) => [scene.id, scene.prose]));
    const changedAcrossAttempts = currentSnapshot.scenes.filter((scene) => sourceById.get(scene.id) !== scene.prose).map((scene) => scene.id);
    const allChanged = [...new Set([...changedAcrossAttempts, ...changed])];
    if (!allChanged.length) throw new Error('Guided Improve produced no manuscript change; revise the instruction or choose a more capable model');
    const resultRevisionId = await manuscriptRevisionService.capture(run.bookId, run.id, allChanged.map((id) => ({ type: 'scene', id })));
    const changedScenes = await this.db.scene.findMany({ where: { id: { in: allChanged } }, select: { id: true, prose: true } });
    const literary = changedScenes.map((scene) => ({ sceneId: scene.id, result: evaluateLiteraryText(scene.prose ?? '') }));
    const artifact = { instruction: input.instruction, interpretedPlan, scope, acceptanceCriteria: input.acceptanceCriteria ?? [], changedSceneIds: allChanged, diffs: changes, recoveryReconciledScopes: changedAcrossAttempts, validation: { safeEditPolicy: changes.every((change) => change.safetyReasons.length === 0) || structural, truncationAndPlaceholderChecks: changes.every((change) => change.afterWords > 0 && !change.safetyReasons.some((reason) => ['truncated_or_empty', 'meta_or_placeholder_text'].includes(reason))), canonNamesPreserved: changes.every((change) => change.canonNamesPreserved), literary: literary.map((entry) => ({ sceneId: entry.sceneId, score: entry.result.overallScore, pass: entry.result.pass, findings: entry.result.findings })) } };
    await this.db.workflowArtifact.create({ data: { id: randomUUID(), runId: run.id, artifactType: 'guided_improvement', scopeType: scope.type, scopeId: scope.id ? String(scope.id) : String(run.bookId), contentHash: sha(artifact), sourceRevisionId: run.sourceRevisionId, resultRevisionId, payload: json(artifact) } });
    await this.db.workflowRun.update({ where: { id: run.id }, data: { resultRevisionId } });
    await this.complete(run.id);
  }

  private async releaseGates(runId: string, revisionId: string, targetWords: number, exportValidation = false) {
    const run = await this.db.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    const revision = await this.db.manuscriptRevision.findUniqueOrThrow({ where: { id: revisionId } });
    const scenes = documentAuthorityEnabled() ? (await manuscriptRevisionService.snapshotRevision(run.bookId, revisionId)).scenes : await this.db.scene.findMany({ where: { chapter: { act: { bookId: run.bookId } }, deletedAt: null }, select: { prose: true } });
    const documentReview = documentAuthorityEnabled() ? await reviewStateAtRevision(run.userId, run.bookId, revisionId) : undefined;
    const childReviews = await this.db.qualityReviewRun.findMany({ where: { workflowRun: { parentRunId: runId } }, include: { findings: true } });
    const currentReview = childReviews.filter((review) => review.sourceRevisionId === revisionId);
    const critical = currentReview.flatMap((review) => review.findings).filter((finding) => ['critical', 'high'].includes(finding.severity) && !finding.waived && finding.verificationStatus !== 'passed');
    const implementedUnverified = childReviews.flatMap((review) => review.findings).filter((finding) => finding.implemented && finding.verificationStatus !== 'passed' && !finding.waived);
    const validationCoverage = currentReview.map((review) => review.coverage as { characterAliasChecked?: boolean; continuityChecked?: boolean });
    const completeCoverage = currentReview.some((review) => {
      const coverage = review.coverage as { scene?: number; chapter?: number; act?: number; book?: number };
      return coverage.scene === scenes.length && Number(coverage.chapter ?? 0) > 0 && Number(coverage.act ?? 0) > 0 && coverage.book === 1;
    });
    const budgetArtifact = await this.db.workflowArtifact.findFirst({ where: { runId, artifactType: 'word_budget_reconciliation' }, orderBy: { createdAt: 'desc' } });
    const budget = budgetArtifact?.payload as { targetWords?: number; reconciled?: boolean; actBudgets?: Array<{ words?: number }>; chapterBudgets?: Array<{ words?: number }>; sceneBudgets?: Array<{ words?: number }> } | undefined;
    const sumsToTarget = (rows: Array<{ words?: number }> | undefined) => Boolean(rows?.length) && rows!.every((row) => Number(row.words ?? 0) > 0) && rows!.reduce((sum, row) => sum + Number(row.words ?? 0), 0) === targetWords;
    const reconciledBudget = budget?.targetWords === targetWords && budget.reconciled === true && sumsToTarget(budget.actBudgets) && sumsToTarget(budget.chapterBudgets) && sumsToTarget(budget.sceneBudgets) && budget.sceneBudgets?.length === scenes.length;
    const openLedgers = await this.db.narrativeLedger.count({ where: { workflowRunId: runId, status: 'open' } });
    const gates = [
      { gate: 'complete_prose', pass: scenes.length > 0 && scenes.every((scene) => Boolean(scene.prose?.trim())), evidence: `${scenes.filter((scene) => scene.prose?.trim()).length}/${scenes.length}` },
      { gate: 'word_budget', pass: revision.wordCount >= targetWords * 0.92 && revision.wordCount <= targetWords * 1.08, evidence: `${revision.wordCount}/${targetWords}` },
      { gate: 'hierarchical_word_budget', pass: reconciledBudget, evidence: budget ?? 'Exact act/chapter/scene budget reconciliation missing' },
      { gate: 'fresh_review', pass: currentReview.length > 0 && completeCoverage, evidence: `${currentReview.length} review rounds on current revision; complete hierarchy=${completeCoverage}` },
      { gate: 'severity', pass: critical.length === 0, evidence: `${critical.length} unresolved critical/high findings` },
      ...(documentReview ? [{ gate: 'resolved_document_review', pass: documentReview.pendingChanges === 0 && documentReview.unresolvedComments === 0, evidence: `${documentReview.pendingChanges} pending changes and ${documentReview.unresolvedComments} unresolved comments on canonical revision ${documentReview.sourceBookRevisionId}` }] : []),
      { gate: 'implemented_finding_verification', pass: implementedUnverified.length === 0, evidence: `${implementedUnverified.length} implemented findings without passed verification` },
      { gate: 'character_names_aliases', pass: validationCoverage.length > 0 && validationCoverage.every((coverage) => coverage.characterAliasChecked), evidence: 'Canonical names and aliases checked against reviewed prose' },
      { gate: 'continuity_validation', pass: validationCoverage.length > 0 && validationCoverage.every((coverage) => coverage.continuityChecked), evidence: 'Scene and hierarchical continuity passes completed' },
      { gate: 'narrative_ledgers', pass: openLedgers === 0, evidence: `${openLedgers} open promises/questions` },
      { gate: 'publication_exports', pass: exportValidation, evidence: exportValidation ? 'Markdown, EPUB, DOCX, HTML, metadata, front/back matter, and cover specification validated' : 'Publication export validation failed' },
    ];
    return { pass: gates.every((gate) => gate.pass), revisionId, gates };
  }

  async listReviews(userId: number, bookId: number) {
    const book = await this.db.book.findFirst({ where: { id: bookId, userId } }); if (!book) throw new Error('Book not found');
    const current = await manuscriptRevisionService.current(bookId);
    const reviews = await this.db.qualityReviewRun.findMany({ where: { bookId }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { findings: true } }, findings: { select: { implemented: true, verificationStatus: true, waived: true, stale: true, superseded: true } } } });
    return reviews.map((review) => {
      const reviewStale = review.sourceRevisionId !== current;
      return { ...review, stale: reviewStale, aggregates: {
        total: review.findings.length,
        open: review.findings.filter((finding) => !finding.implemented && !finding.waived && !finding.superseded && !finding.stale && !reviewStale).length,
        implemented: review.findings.filter((finding) => finding.implemented).length,
        verified: review.findings.filter((finding) => finding.verificationStatus === 'passed').length,
        waived: review.findings.filter((finding) => finding.waived).length,
        stale: reviewStale ? review.findings.length : review.findings.filter((finding) => finding.stale).length,
        superseded: review.findings.filter((finding) => finding.superseded).length,
      } };
    });
  }

  async findings(userId: number, reviewRunId: string) {
    const review = await this.db.qualityReviewRun.findFirst({ where: { id: reviewRunId, book: { userId } } }); if (!review) throw new Error('Review not found');
    const { current, ancestors } = await manuscriptRevisionService.currentAncestry(review.bookId);
    const rows = await this.db.qualityFinding.findMany({ where: { reviewRunId }, orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }] });
    const reviewStale = review.sourceRevisionId !== current;
    return rows.map((finding) => ({ ...finding, stale: finding.stale || reviewStale, reviewStale, activeOnCurrentRevision: Boolean(finding.implementedRevisionId && ancestors.has(finding.implementedRevisionId)) }));
  }

  async bookFindings(userId: number, bookId: number, filters: { state?: string; model?: string; severity?: string; scope?: string; cursor?: string; limit?: number }) {
    const book = await this.db.book.findFirst({ where: { id: bookId, userId, deletedAt: null }, select: { id: true } });
    if (!book) throw new Error('Book not found');
    const { current, ancestors } = await manuscriptRevisionService.currentAncestry(bookId);
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 200);
    const reviewWhere = { bookId, ...(filters.model ? { modelUsed: filters.model } : {}), ...(filters.state === 'open' ? { sourceRevisionId: current ?? '__no_current_revision__' } : {}) };
    const stateWhere = filters.state === 'implemented' ? { implemented: true }
      : filters.state === 'verified' ? { verificationStatus: 'passed' }
      : filters.state === 'waived' ? { waived: true }
      : filters.state === 'stale' ? { OR: [{ stale: true }, { reviewRun: { sourceRevisionId: { not: current ?? '__no_current_revision__' } } }] }
      : filters.state === 'all' || !filters.state ? {}
      : { implemented: false, waived: false, stale: false, superseded: false };
    const rows = await this.db.qualityFinding.findMany({
      where: {
        reviewRun: reviewWhere,
        ...(filters.severity ? { severity: filters.severity } : {}),
        ...(filters.scope ? { scopeType: filters.scope } : {}),
        ...stateWhere,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      take: limit + 1,
      include: { reviewRun: { select: { id: true, workflowRunId: true, sourceRevisionId: true, modelUsed: true, rubricVersion: true, status: true, createdAt: true } } },
    });
    const page = rows.slice(0, limit);
    const items = page.map((finding) => {
      const reviewStale = finding.reviewRun.sourceRevisionId !== current;
      return { ...finding, stale: finding.stale || reviewStale, reviewStale, activeOnCurrentRevision: Boolean(finding.implementedRevisionId && ancestors.has(finding.implementedRevisionId)), review: finding.reviewRun };
    });
    return { items, nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null, limit };
  }

  async patchFinding(userId: number, findingId: string, input: { waived?: boolean; waiverReason?: string; implemented?: boolean }) {
    const finding = await this.db.qualityFinding.findFirst({ where: { id: findingId, reviewRun: { book: { userId } } } }); if (!finding) throw new Error('Finding not found');
    if (input.implemented !== undefined && input.implemented !== finding.implemented) throw new Error('Implementation state is workflow-managed and cannot be edited manually');
    return this.db.qualityFinding.update({ where: { id: findingId }, data: { waived: input.waived, waiverReason: input.waived ? input.waiverReason : null } });
  }

  async revisions(userId: number, bookId: number) {
    const book = await this.db.book.findFirst({ where: { id: bookId, userId } }); if (!book) throw new Error('Book not found');
    return this.db.manuscriptRevision.findMany({ where: { bookId }, orderBy: { createdAt: 'desc' }, select: { id: true, parentRevisionId: true, workflowRunId: true, contentHash: true, wordCount: true, changedScopes: true, createdAt: true } });
  }

  async rollbackRevision(userId: number, bookId: number, revisionId: string, operationSignal?: AbortSignal, preconditions?: DocumentMutationPreconditions) {
    operationSignal?.throwIfAborted();
    const book = await this.db.book.findFirst({ where: { id: bookId, userId, deletedAt: null } }); if (!book) throw new Error('Book not found');
    const resultRevisionId = await manuscriptRevisionService.restore(bookId, revisionId, operationSignal, { userId, expectedRevisionId: preconditions?.expectedRevisionId ?? '', operationId: preconditions?.operationId ?? '' });
    operationSignal?.throwIfAborted();
    return { bookId, restoredRevisionId: revisionId, resultRevisionId };
  }

  async publication(userId: number, runId: string) {
    await this.ownedRun(userId, runId);
    return this.db.publicationPackage.findFirst({ where: { workflowRunId: runId }, orderBy: { createdAt: 'desc' } });
  }

  async publicationArtifact(userId: number, runId: string, filename: string) {
    await this.ownedRun(userId, runId);
    const publication = await this.db.publicationPackage.findFirst({ where: { workflowRunId: runId }, orderBy: { createdAt: 'desc' } });
    if (!publication) throw new Error('Publication package not found');
    const manifest = publication.artifactManifest as unknown as { directory?: string; artifacts?: Array<{ filename: string; mediaType: string }> };
    const artifact = manifest.artifacts?.find((entry) => entry.filename === filename);
    if (!artifact || !manifest.directory) throw new Error('Publication artifact not found');
    return { content: await readPublicationArtifact(manifest.directory, filename), mediaType: artifact.mediaType, filename };
  }

  async finalize(userId: number, runId: string, actorGithubId?: string) {
    const run = await this.ownedRun(userId, runId);
    if (run.workflowType !== 'full_book') throw new Error('Only Full Book workflows have publication packages');
    const checkpoint = await this.db.workflowCheckpoint.findFirst({ where: { runId, checkpointType: 'final_release', status: 'pending' } });
    if (!checkpoint) throw new Error('Final release checkpoint is not ready');
    return this.decideCheckpoint(userId, runId, checkpoint.id, 'approved', 'Final release approved', actorGithubId);
  }

  private async complete(runId: string, status = 'completed') {
    await withWorkflowLease(runId, async (tx, leaseOwner) => {
      const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { workflowType: true, bookId: true, sourceRevisionId: true, resultRevisionId: true, progress: true } });
      const priorProgress = run.progress && typeof run.progress === 'object' && !Array.isArray(run.progress) ? run.progress as Record<string, unknown> : {};
      const total = typeof priorProgress.total === 'number' && priorProgress.total > 0 ? priorProgress.total : 1;
      await tx.workflowTask.updateMany({ where: { runId, status: { in: ['pending', 'running'] }, leaseOwner }, data: { status: 'completed', finishedAt: new Date() } });
      await tx.workflowTask.updateMany({ where: { runId, taskKey: `${run.workflowType}:root`, leaseOwner }, data: { outputRevisionId: run.resultRevisionId ?? run.sourceRevisionId } });
      const completedAt = new Date();
      const completed = await tx.workflowRun.updateMany({ where: { id: runId, leaseOwner }, data: { status, phase: status, progress: json({ ...priorProgress, completed: total, total, percent: 100 }), lastHeartbeatAt: completedAt, finishedAt: completedAt, leaseOwner: null, leaseExpiresAt: null } });
      if (completed.count !== 1) throw new Error(`Workflow lease lost for ${runId}`);
      await tx.workflowEvent.create({ data: { runId, eventType: status, data: {} } });
      const context = currentWorkflowExecution();
      if (context?.sharedResourceOperationId) {
        await sealSharedResourceOperation(context.sharedResourceOperationId, 'succeeded', 200, {
          success: true,
          data: { runId, bookId: run.bookId, status, resultRevisionId: run.resultRevisionId ?? run.sourceRevisionId },
        }, completedAt, tx);
      }
    });
  }
}

export const workflowService = new WorkflowService();
