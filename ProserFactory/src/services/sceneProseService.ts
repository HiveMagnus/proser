import { campaignPrompt, CAMPAIGN_RECIPE_VERSION } from '@/documents/campaignCitations';
import { randomUUID } from 'node:crypto';
import { buildCodexContextSection } from './codexRetrievalService';
import { documentAuthorityEnabled } from '@/documents/capabilities';
import { DocumentError } from '@/documents/errors';

import { databaseService } from '../lib/database';
import { interpolatePromptByKey } from '../prompts/service';
import { defaultModelRouter } from '../lib/ai/router';
import { autoActivateAdapter } from '../lib/ai/autoRouter';
import { vllmService, VllmService } from '../lib/ai/vllm';
import { InferenceTerminalError, TERMINAL_REASON_POLICIES } from '../lib/ai/terminalReason';
import logger from '../lib/logger';
import { withRetry } from '../lib/resilience';
import { time } from '../lib/metrics';
import { trace } from '@opentelemetry/api';
import { CONFIG } from '../core/config';
import { ragOrchestrator } from '../lib/rag/orchestrator';
import { extractMemory } from '../lib/memory';
import { runSkills } from '../lib/skills';
import { enqueueLiveProseJudge } from './liveProseJudgeService';
import { normalizeGenreKey, type CanonicalGenreKey } from '../lib/genre/normalize';
import { RECIPE_VERSION } from '../prompts/builders';
import type { OrchestratorResult } from '../lib/rag/types';
import type { SkillFinding } from '../lib/skills/types';
import { isBullmqEnabled } from '../queues/featureFlag';
import { proseTraceService } from './proseTraceService';
import type { LiveProseJudgePayload } from '../queues/liveProseJudgeQueue';
import { inferenceParams, type InferenceProfileName } from '../lib/ai/inferenceProfiles';
import type { DocumentDiscussionSnapshot, DocumentProposalProviderResult } from '@/documents/proposal-model';
import { plotThreadReviewPrompt } from '@/documents/plotThreadPrompt';
import { documentProposalPrompt } from '@/documents/proposalPrompt';

export interface ProseValidatorResult {
  name: string;
  passed: boolean;
  message: string;
  blocking: boolean;
}

/**
 * A creative-review pass is constrained to a light edit, never a replacement.
 * Small models occasionally return a one-line acknowledgement instead of the
 * revised manuscript; reject that before anything can persist it.
 */
export function isSufficientReviewRevision(originalText: string, revisedText: string, maxEditPct = 10): boolean {
  const originalWords = originalText.trim().split(/\s+/).filter(Boolean).length;
  const revisedWords = revisedText.trim().split(/\s+/).filter(Boolean).length;
  if (!revisedWords) return false;
  if (originalWords < 50) return revisedWords >= Math.max(1, Math.floor(originalWords * 0.5));
  const permittedEditPct = Math.min(Math.max(maxEditPct, 0), 50);
  const minimumRatio = Math.max(0.5, 1 - permittedEditPct / 100 - 0.2);
  return revisedWords >= Math.max(50, Math.floor(originalWords * minimumRatio));
}

export function mergeProseContinuation(existing: string, continuation: string): string {
  const maximum = Math.min(existing.length, continuation.length, 160);
  for (let size = maximum; size >= 20; size -= 1) {
    if (existing.endsWith(continuation.slice(0, size))) return existing + continuation.slice(size);
  }
  throw new InferenceTerminalError('INFERENCE_TERMINAL_INVALID', 'overlap_mismatch', 'prose', existing);
}

export interface SceneProseContext {
  // Core identifiers
  bookId: number;
  sceneId?: number;
  chapterId?: number;
  
  // Book context
  title: string;
  genre?: string;
  summary?: string;
  targetAudience?: string;
  archetypeDescription?: string;
  
  // Scene structure context
  actNumber?: number;
  actTitle?: string;
  actSummary?: string;
  chapterNumber?: number;
  chapterTitle?: string;
  chapterSummary?: string;
  sceneNumber?: number;
  sceneSummary?: string;
  sceneOutline?: string;
  
  // Continuity
  previousSceneSummary?: string;
  
  // Style preferences
  writingStyle?: string; // e.g., "third-person limited"
  pov?: string; // e.g., "third", "first"
  tense?: string; // e.g., "past", "present"
  
  // Content preferences
  targetWords?: number;
  characters?: string[]; // Character names
  instructions?: string;
  additionalContext?: string;
  mustInclude?: string[];
  mustAvoid?: string[];
  genreKey?: CanonicalGenreKey | null;
  qualityMode?: 'standard' | 'strict';
  
  // RAG options
  useCodexRAG?: boolean;
  codexTypes?: string[]; // e.g., ["character", "location", "item"]
  codexK?: number; // Number of entries to retrieve
  tokenBudget?: number; // Token budget for RAG content
}

export interface SceneProseOptions {
  selectedModel?: string;
  temperature?: number;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  /** Candidate generation can defer advisory Skill revisions to editorial review. */
  autoReviseSkills?: boolean;
  /** Durable callers retain unknown effects rather than issuing transport retries. */
  noTransportReplay?: boolean;
  frozenContext?: boolean;
  frozenSource?: { bookRevisionId: string; sceneRevisionId: string; contentHash: string };
  frozenCodex?: Array<{ id: number; entry_type: string; entry_name: string; excerpt: string }>;
}

export interface SceneProseResult {
  prose: string;
  wordCount: number;
  codexUsed?: Array<{ id: number; entry_type: string; entry_name: string; excerpt: string }>;
  model?: string;
  fromCache?: boolean;
  /** Advisory skill findings (continuity, voice drift, etc.). Never blocks generation. */
  skillFindings?: SkillFinding[];
  traceId?: string;
  recipeVersion?: string;
  genreKey?: CanonicalGenreKey | null;
  adapterUsed?: string | null;
  judgeStatus?: 'queued' | 'submitted' | 'completed' | 'failed' | 'deferred';
  draftProse?: string;
  finalProse?: string;
  validatorResults?: ProseValidatorResult[];
  revisionApplied?: boolean;
  brief?: string;
}

/**
 * Centralized Scene Prose Generation Service
 * 
 * This service standardizes prose generation across all use cases:
 * - Factory Runner
 * - Manual Generation 
 * - Scene Creation API
 * - Wizard Generation
 * - Scene Resubmit
 * 
 * Features:
 * - Unified context assembly
 * - Automatic RAG integration
 * - Consistent template usage
 * - Previous scene continuity
 * - Flexible character/codex integration
 */
export class SceneProseService {
  private static instance: SceneProseService;
  
  static getInstance(): SceneProseService {
    if (!SceneProseService.instance) {
      SceneProseService.instance = new SceneProseService();
    }
    return SceneProseService.instance;
  }

  /**
   * Stream prose token-by-token for a scene.
   *
   * Mirrors `generateProse` but yields tokens via AsyncGenerator instead of
   * buffering the full response. The caller (SSE controller) forwards each
   * token to the client.
   *
   * Returns a tuple: [AsyncGenerator<string>, metadata promise].
   * The metadata promise resolves after the generator is exhausted.
   */
  async *generateProseStream(
    context: SceneProseContext,
    options: SceneProseOptions = {}
  ): AsyncGenerator<string, SceneProseResult> {
    const tracer = trace.getTracer('scene-prose-service');
    const span = tracer.startSpan('generateProseStream');

    try {
      span.setAttributes({
        bookId: context.bookId,
        sceneId: context.sceneId || 0,
        useRAG: context.useCodexRAG || false,
        model: options.selectedModel || 'default',
      });
      const result = await this.runGenerationPipeline(context, options);
      const chunks = result.prose.match(/.{1,180}(\s|$)/g) ?? [result.prose];
      for (const chunk of chunks) {
        yield chunk;
      }

      logger.info({
        bookId: context.bookId,
        sceneId: context.sceneId,
        wordCount: result.wordCount,
        genreKey: result.genreKey,
        adapterUsed: result.adapterUsed,
        traceId: result.traceId,
      }, 'Scene prose streamed');

      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: 2, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Review and lightly revise existing prose using centralized prompt
   */
  async reviewProse(
    originalText: string,
    opts: { pov?: string; tense?: string; maxEditPct?: number; instruction?: string; sceneOutline?: string } = {},
    options: SceneProseOptions = {}
  ): Promise<{ revised: string; model?: string; provenance?: DocumentProposalProviderResult['provenance'] }> {
    const tracer = trace.getTracer('scene-prose-service');
    return await tracer.startActiveSpan('reviewProse', async (span) => {
      try {
        const provider = defaultModelRouter.forRequest('generic', options.selectedModel, { noTransportReplay: options.noTransportReplay === true });

        const prompt = interpolatePromptByKey('prose-review', {
          originalText,
          pov: opts.pov,
          tense: opts.tense,
          maxEditPct: opts.maxEditPct ?? 10,
          instruction: opts.instruction,
          sceneOutline: opts.sceneOutline,
        });

        const timeoutMs = options.timeoutMs || Number(process.env.AI_TIMEOUT_REVIEW_MS ?? '300000') || 300000;
        const retries = options.noTransportReplay ? 1 : options.retries || 1;

        const revised = await time('ai.review.prose', () =>
          withRetry(
            (signal) => provider.generateText({
              prompt,
              signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
              params: inferenceParams('revision'),
              terminalPolicy: TERMINAL_REASON_POLICIES.prose,
            }),
            retries,
            undefined,
            { timeoutMs, jitter: true, shouldRetry: (error) => !(error instanceof InferenceTerminalError) }
          )
        );

        const cleaned = revised.trim();
        const metadata = provider instanceof VllmService ? provider.getLastInferenceMetadata() : null;
        const provenance: DocumentProposalProviderResult['provenance'] = { providerId: provider.id, requestedModel: options.selectedModel, configuredModel: provider.getModel?.(), reportedModel: metadata?.reportedModel, usage: metadata?.usage, params: { ...inferenceParams('revision') }, recipe: 'prose-review', recipeVersion: '1.0.0' };
        if (!isSufficientReviewRevision(originalText, cleaned, opts.maxEditPct ?? 10)) {
          logger.warn({ originalWords: originalText.trim().split(/\s+/).filter(Boolean).length, revisedWords: cleaned.split(/\s+/).filter(Boolean).length }, 'Rejected undersized prose review output');
          return { revised: originalText, model: provider.id || options.selectedModel, provenance };
        }
        return { revised: cleaned, model: provider.id || options.selectedModel, provenance };
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: 2, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    });
  }
  async proposeDocumentEdits(snapshot: DocumentDiscussionSnapshot | import('@/documents/story-proposal-model').DocumentStoryDiscussionSnapshot, instruction: string, options: SceneProseOptions = {}): Promise<DocumentProposalProviderResult> {
    const provider = defaultModelRouter.forRequest('generic', options.selectedModel, { noTransportReplay: true });
    const prompt = documentProposalPrompt(snapshot, instruction);
    if (Buffer.byteLength(prompt) > snapshot.maxPromptBytes) throw new Error('Document context exceeds its disclosed byte budget.');
    const params = inferenceParams('revision', { maxTokens: snapshot.maxOutputTokens });
    const raw = await time('ai.document.proposal', () => withRetry((signal) => provider.generateText({ prompt, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal, params, terminalPolicy: TERMINAL_REASON_POLICIES.prose }), 1, undefined, { timeoutMs: options.timeoutMs ?? 120000 }));
    const metadata = provider instanceof VllmService ? provider.getLastInferenceMetadata() : null;
    return { raw, provenance: { providerId: provider.id, requestedModel: options.selectedModel, configuredModel: provider.getModel?.(), reportedModel: metadata?.reportedModel, usage: metadata?.usage, params: { ...params }, recipe: 'document-proposal', recipeVersion: snapshot.templateVersion } };
  }
  async analyzeDocument(snapshot: import('@/documents/proposal-model').DocumentTraceSnapshot, judge: unknown, options: SceneProseOptions = {}): Promise<DocumentProposalProviderResult> {
    const provider = defaultModelRouter.forRequest('feedback', options.selectedModel, { noTransportReplay: true });
    const prompt = interpolatePromptByKey('document-analysis', { context: JSON.stringify({ projection: snapshot.projection, sourceSceneRevisionId: snapshot.sceneRevisionId, targets: snapshot.targets.map((target) => ({ targetId: target.targetId, blockId: target.blockId, text: target.paragraphText, container: target.container })) }), judge: JSON.stringify(judge) });
    if (Buffer.byteLength(prompt) > snapshot.maxPromptBytes) throw new DocumentError('DOCUMENT_CONTEXT_TOO_LARGE', 'Complete analysis context exceeds the supported prompt budget.', 413);
    const params = inferenceParams('revision', { maxTokens: 4096 });
    const raw = await time('ai.document.analysis', () => withRetry((signal) => provider.generateText({ prompt, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal, params, terminalPolicy: TERMINAL_REASON_POLICIES.structured }), 1, undefined, { timeoutMs: options.timeoutMs ?? 120000 }));
    const metadata = provider instanceof VllmService ? provider.getLastInferenceMetadata() : null;
    return { raw, provenance: { providerId: provider.id, requestedModel: options.selectedModel, configuredModel: provider.getModel?.(), reportedModel: metadata?.reportedModel, usage: metadata?.usage, params: { ...params }, recipe: 'document-analysis', recipeVersion: '1.0.0' } };
  }
  async reviewCampaign(task: 'scan' | 'synthesize' | 'verify', context: unknown, options: SceneProseOptions = {}, maxPromptBytes = 22000, frozen?: { prompt: string; recipeVersion: string }): Promise<DocumentProposalProviderResult> {
    const provider = defaultModelRouter.forRequest('feedback', options.selectedModel, { noTransportReplay: true });
    const prompt = frozen?.prompt ?? campaignPrompt(task, context);
    if (Buffer.byteLength(prompt) > maxPromptBytes) throw new DocumentError('REVISION_CAMPAIGN_BUDGET_LIMIT', 'Complete campaign prompt exceeds its context budget.', 413);
    const params = inferenceParams('revision', { maxTokens: 8192 });
    const raw = await withRetry(signal => provider.generateText({ prompt, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal, params, terminalPolicy: TERMINAL_REASON_POLICIES.structured }), 1, undefined, { timeoutMs: options.timeoutMs ?? 120000 });
    const metadata = provider instanceof VllmService ? provider.getLastInferenceMetadata() : null;
    return { raw, provenance: { providerId: provider.id, requestedModel: options.selectedModel, configuredModel: provider.getModel?.(), reportedModel: metadata?.reportedModel, usage: metadata?.usage, params: { ...params }, recipe: 'revision-campaign', recipeVersion: frozen?.recipeVersion ?? CAMPAIGN_RECIPE_VERSION } };
  }
  async reviewPlotThread(snapshot: import('@/documents/plot-thread-model').PlotThreadReviewSnapshot, options: SceneProseOptions = {}): Promise<DocumentProposalProviderResult> {
    const provider = defaultModelRouter.forRequest('feedback', options.selectedModel, { noTransportReplay: true });
    const prompt = plotThreadReviewPrompt(snapshot);
    const params = inferenceParams('revision', { maxTokens: 4096 });
    const raw = await time('ai.plot-thread.review', () => withRetry(signal => provider.generateText({ prompt, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal, params, terminalPolicy: TERMINAL_REASON_POLICIES.structured }), 1, undefined, { timeoutMs: options.timeoutMs ?? 120000 }));
    const metadata = provider instanceof VllmService ? provider.getLastInferenceMetadata() : null;
    return { raw, provenance: { providerId: provider.id, requestedModel: options.selectedModel, configuredModel: provider.getModel?.(), reportedModel: metadata?.reportedModel, usage: metadata?.usage, params: { ...params }, recipe: 'plot-thread-review', recipeVersion: '1.0.0' } };
  }

  /**
   * Closed-loop revision: revise prose based on specific SkillFindings.
   *
   * This enables the generate → analyze → revise loop where skill findings
   * (continuity issues, voice drift, etc.) are fed back as targeted revision
   * instructions to the AI.
   */
  async reviseFromFindings(
    originalText: string,
    findings: SkillFinding[],
    opts: { sceneOutline?: string; instruction?: string } = {},
    options: SceneProseOptions = {}
  ): Promise<{ revised: string; model?: string; findingsAddressed: number }> {
    const tracer = trace.getTracer('scene-prose-service');
    return await tracer.startActiveSpan('reviseFromFindings', async (span) => {
      try {
        span.setAttributes({
          'revision.findingsCount': findings.length,
          'revision.originalLength': originalText.length,
        });

        if (!findings.length) {
          logger.info('reviseFromFindings called with no findings; returning original text');
          return { revised: originalText, findingsAddressed: 0 };
        }

        const provider = defaultModelRouter.forRequest('generic', options.selectedModel, { noTransportReplay: options.noTransportReplay === true });

        // Format findings into a structured list for the prompt
        const formattedFindings = findings
          .map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.message}${f.suggestion ? ` — Suggestion: ${f.suggestion}` : ''}`)
          .join('\n');

        const prompt = interpolatePromptByKey('prose-revise-from-findings', {
          findings: formattedFindings,
          originalText,
          sceneOutline: opts.sceneOutline,
          instruction: opts.instruction,
        });

        const timeoutMs = options.timeoutMs || Number(process.env.AI_TIMEOUT_REVIEW_MS ?? '60000') || 60000;
        const retries = options.noTransportReplay ? 1 : options.retries || 1;

        const revised = await time('ai.revise.from_findings', () =>
          withRetry(
            (signal) => provider.generateText({
              prompt,
              signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
              params: inferenceParams('revision'),
              terminalPolicy: TERMINAL_REASON_POLICIES.prose,
            }),
            retries,
            (attempt, err) => logger.warn({ attempt, err }, 'reviseFromFindings retry'),
            { timeoutMs, jitter: true, shouldRetry: (error) => !(error instanceof InferenceTerminalError) }
          )
        );

        logger.info({
          findingsCount: findings.length,
          originalLen: originalText.length,
          revisedLen: revised.trim().length,
        }, 'reviseFromFindings completed');

        return {
          revised: revised.trim(),
          model: provider.id || options.selectedModel,
          findingsAddressed: findings.length,
        };
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: 2, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Generate prose for a scene with unified context and RAG support
   */
  async generateProse(
    context: SceneProseContext, 
    options: SceneProseOptions = {}
  ): Promise<SceneProseResult> {
    const tracer = trace.getTracer('scene-prose-service');
    
    return await tracer.startActiveSpan('generateProse', async (span) => {
      try {
        span.setAttributes({
          bookId: context.bookId,
          sceneId: context.sceneId || 0,
          useRAG: context.useCodexRAG || false,
          model: options.selectedModel || 'default'
        });
        return await this.runGenerationPipeline(context, options);
        
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: 2, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async runGenerationPipeline(
    context: SceneProseContext,
    options: SceneProseOptions,
  ): Promise<SceneProseResult> {
    options.signal?.throwIfAborted();
    const normalizedContext: SceneProseContext = {
      ...context,
      instructions: context.instructions?.trim() || context.additionalContext?.trim() || undefined,
    };

    const enrichedContext = options.frozenContext ? normalizedContext : await this.enrichSceneContext(normalizedContext);
    const genreKey = enrichedContext.genreKey ?? normalizeGenreKey(enrichedContext.genre);
    enrichedContext.genreKey = genreKey;

    let ragContext: Array<{ id: number; entry_type: string; entry_name: string; excerpt: string }> = [];
    let ragSection = '';
    if (options.frozenCodex) {
      ragContext = options.frozenCodex; ragSection = buildCodexContextSection(ragContext);
    } else if (enrichedContext.useCodexRAG) {
      const ragResult = await this.applyCodexRAG(enrichedContext);
      ragContext = ragResult.entries;
      ragSection = ragResult.section;
    }

    const sceneBrief = this.buildSceneBrief(enrichedContext, ragSection);
    const beatsJson = this.extractBeatsJson(enrichedContext.instructions);

    const autoAdapter = options.selectedModel
      ? null
      : await autoActivateAdapter(genreKey ?? enrichedContext.genre ?? null);
    const resolvedModel = !options.selectedModel && autoAdapter
      ? vllmService.effectiveModel
      : options.selectedModel;

    const provider = defaultModelRouter.forRequest('generic', resolvedModel, { noTransportReplay: options.noTransportReplay === true });

    const timeoutMs = options.timeoutMs || Number(process.env.AI_TIMEOUT_PROSE_MS ?? '120000') || 120000;
    const retries = options.noTransportReplay ? 1 : options.retries ?? 2;
    const temperature = options.temperature || Number(process.env.AI_TEMP_PROSE ?? '0.7') || 0.7;
    const maxTokens = Math.max(512, Math.ceil((enrichedContext.targetWords || 900) * 1.5 * 1.2));

    const draftPrompt = this.buildDraftPrompt(enrichedContext, sceneBrief, beatsJson);
    let draftText: string;
    try {
      draftText = await this.generatePromptText(provider, draftPrompt, {
        metricKey: 'ai.generate.prose',
        retries,
        timeoutMs,
        temperature,
        maxTokens,
        profile: 'prose',
        signal: options.signal,
      });
    } catch (error) {
      if (options.noTransportReplay || !ragSection || !enrichedContext.useCodexRAG) throw error;

      logger.info({ bookId: context.bookId, sceneId: context.sceneId }, 'Retrying staged prose generation without RAG');
      const fallbackBrief = this.buildSceneBrief(enrichedContext, '');
      const fallbackPrompt = this.buildDraftPrompt(enrichedContext, fallbackBrief, beatsJson);
      draftText = await this.generatePromptText(provider, fallbackPrompt, {
        metricKey: 'ai.generate.prose.fallback',
        retries: 1,
        timeoutMs,
        temperature,
        maxTokens,
        profile: 'prose',
        signal: options.signal,
      });
      ragContext = [];
      ragSection = '';
    }

    const draftProse = this.sanitizeGeneratedProse(draftText);
    let finalProse = draftProse;
    const draftValidatorResults = this.validateProse(draftProse, enrichedContext);
    let validatorResults = draftValidatorResults;
    let revisionApplied = false;

    if (validatorResults.some((result) => result.blocking && !result.passed)) {
      const revisePrompt = this.buildRevisionPrompt(enrichedContext, sceneBrief, draftProse, validatorResults);
      const revisedText = await this.generatePromptText(provider, revisePrompt, {
        metricKey: 'ai.generate.prose.revise',
        retries: 1,
        timeoutMs,
        temperature: Math.min(temperature, 0.5),
        maxTokens,
        profile: 'revision',
        signal: options.signal,
      });
      const revisionCandidate = this.sanitizeGeneratedProse(revisedText);
      const revisionValidators = this.validateProse(revisionCandidate, enrichedContext);
      const draftBlocking = draftValidatorResults.filter((result) => result.blocking && !result.passed).length;
      const revisionBlocking = revisionValidators.filter((result) => result.blocking && !result.passed).length;
      if (isSufficientReviewRevision(draftProse, revisionCandidate, 50) && revisionBlocking < draftBlocking) {
        finalProse = revisionCandidate;
        validatorResults = revisionValidators;
        revisionApplied = true;
      } else {
        logger.warn({ bookId: context.bookId, sceneId: context.sceneId, draftWords: draftProse.split(/\s+/).filter(Boolean).length, revisionWords: revisionCandidate.split(/\s+/).filter(Boolean).length, draftBlocking, revisionBlocking }, 'Rejected invalid prose pipeline revision; retaining the usable draft');
      }
    }

    let wordCount = finalProse.split(/\s+/).filter(Boolean).length;

    if (context.sceneId && ragContext.length > 0) {
      await this.recordCodexUsage(context.sceneId, ragContext, options.frozenSource);
    }

    let skillFindings: SkillFinding[] | undefined;
    if (CONFIG.SKILLS_RUNTIME_ENABLED && context.sceneId) {
      try {
        const skillResult = await runSkills({
          bookId: context.bookId,
          sceneId: context.sceneId,
          prose: finalProse.trim(),
          sceneOutline: context.sceneOutline,
          previousSummary: context.previousSceneSummary,
          characterNames: context.characters,
          title: context.title,
          genre: context.genre,
          writingStyle: context.writingStyle,
          actNumber: context.actNumber,
          chapterNumber: context.chapterNumber,
        });
        if (skillResult.results.some((result) => result.findings.length > 0)) {
          skillFindings = skillResult.results.flatMap((result) => result.findings);
          const actionable = skillFindings.filter((finding) => ['error', 'warning'].includes(finding.severity) && finding.confidence >= 0.7);
          const autoReviseSkills = options.autoReviseSkills ?? String(process.env.SKILLS_AUTO_REVISE_ENABLED ?? 'true').toLowerCase() === 'true';
          if (actionable.length > 0 && autoReviseSkills) {
            const affectedSkills = skillResult.results.filter((result) => result.findings.some((finding) => actionable.includes(finding))).map((result) => result.skillName);
            const revision = await this.reviseFromFindings(finalProse, actionable, { sceneOutline: context.sceneOutline, instruction: 'Change only what the cited findings require; preserve accepted canon and scene purpose.' }, { selectedModel: options.selectedModel, timeoutMs, retries: 1, signal: options.signal });
            const skillRevisionCandidate = this.sanitizeGeneratedProse(revision.revised);
            if (!isSufficientReviewRevision(finalProse, skillRevisionCandidate, 20)) {
              logger.warn({ bookId: context.bookId, sceneId: context.sceneId, originalWords: finalProse.split(/\s+/).filter(Boolean).length, revisionWords: skillRevisionCandidate.split(/\s+/).filter(Boolean).length }, 'Rejected invalid skill revision; retaining the prior prose');
            } else {
              finalProse = skillRevisionCandidate;
              validatorResults = this.validateProse(finalProse, enrichedContext);
              revisionApplied = true;
              wordCount = finalProse.split(/\s+/).filter(Boolean).length;
            }
            const verification = await runSkills({
              bookId: context.bookId, sceneId: context.sceneId, prose: finalProse.trim(),
              sceneOutline: context.sceneOutline, previousSummary: context.previousSceneSummary,
              characterNames: context.characters, title: context.title, genre: context.genre,
              writingStyle: context.writingStyle, actNumber: context.actNumber, chapterNumber: context.chapterNumber,
            }, { skillNames: affectedSkills });
            skillFindings = verification.results.flatMap((result) => result.findings).map((finding) => ({ ...finding, metadata: { ...finding.metadata, verification: 'rerun_after_targeted_revision' } }));
          }
        }
      } catch (err) {
        logger.warn({ error: (err as Error).message, bookId: context.bookId }, 'Skills execution failed');
      }
    }

    // Extract memory only after the verified revision loop so persisted canon
    // always describes the actual candidate returned to the caller.
    if (!documentAuthorityEnabled() && CONFIG.RAG_MEMORY_ENABLED && context.sceneId) {
      const memoryParams = { bookId: context.bookId, sceneId: context.sceneId, prose: finalProse.trim(), sceneOutline: context.sceneOutline, characterNames: context.characters };
      if (CONFIG.MEMORY_EXTRACTION_ASYNC) extractMemory(memoryParams).catch((err) => logger.warn({ error: (err as Error).message, bookId: context.bookId, sceneId: context.sceneId }, 'Async memory extraction failed'));
      else await extractMemory(memoryParams);
    }

    const traceId = randomUUID();
    const judgePayload: LiveProseJudgePayload = {
      traceId,
      externalRef: this.buildExternalRef(traceId, enrichedContext),
      taskFamily: 'prose',
      traceType: 'scene-prose',
      bookId: enrichedContext.bookId,
      sceneId: enrichedContext.sceneId,
      chapterId: enrichedContext.chapterId,
      genre: enrichedContext.genre ?? null,
      genreKey,
      archetype: enrichedContext.archetypeDescription ?? null,
      instructions: enrichedContext.instructions,
      prompt: enrichedContext.instructions,
      brief: sceneBrief,
      recipeVersion: RECIPE_VERSION,
      model: resolvedModel || provider.id || undefined,
      adapterUsed: autoAdapter,
      validatorSummary: {
        revisionApplied,
        results: validatorResults,
      },
      promptContext: {
        sourceDocument: options.frozenSource,
        title: enrichedContext.title,
        genre: enrichedContext.genre ?? null,
        genreKey,
        targetWords: enrichedContext.targetWords ?? null,
        pov: enrichedContext.pov ?? null,
        tense: enrichedContext.tense ?? null,
        useCodexRAG: enrichedContext.useCodexRAG ?? false,
      },
      candidates: [
        {
          ordinal: 0,
          stage: 'draft',
          candidateType: autoAdapter ? 'adapter' : 'base',
          selectionLabel: autoAdapter ? `adapter:${autoAdapter}` : 'base',
          accepted: !revisionApplied,
          rejected: revisionApplied,
          outputText: draftProse,
          wordCount: draftProse.split(/\s+/).filter(Boolean).length,
          metadata: { validatorResults: draftValidatorResults },
        },
        {
          ordinal: 1,
          stage: 'final',
          candidateType: revisionApplied ? 'revised' : autoAdapter ? 'adapter' : 'base',
          selectionLabel: autoAdapter ? `adapter:${autoAdapter}` : 'base',
          accepted: true,
          rejected: false,
          outputText: options.frozenSource ? finalProse.trim() : finalProse,
          wordCount,
          metadata: {
            validatorResults,
            revisionApplied,
          },
        },
      ],
    };

    const optimisticJudgeStatus: 'queued' | 'submitted' | 'deferred' = options.frozenSource ? 'deferred' : isBullmqEnabled() ? 'queued' : 'submitted';
    try {
      await proseTraceService.createPendingTrace({
        traceId,
        judgePayload,
        judgeStatus: optimisticJudgeStatus,
      });
    } catch (error) {
      logger.warn({ error, traceId, bookId: enrichedContext.bookId, sceneId: enrichedContext.sceneId }, 'Failed to persist pending prose trace');
    }

    const judgeStatus = options.frozenSource ? 'deferred' as const : await enqueueLiveProseJudge(judgePayload);

    logger.info({
      bookId: context.bookId,
      sceneId: context.sceneId,
      wordCount,
      ragEntries: ragContext.length,
      model: provider.id || 'unknown',
      genreKey,
      adapterUsed: autoAdapter,
      traceId,
      judgeStatus,
      revisionApplied,
    }, 'Scene prose generated');

    return {
      prose: finalProse.trim(),
      wordCount,
      codexUsed: ragContext.length > 0 ? ragContext : undefined,
      model: resolvedModel || provider.id || options.selectedModel,
      fromCache: false,
      skillFindings,
      traceId,
      recipeVersion: RECIPE_VERSION,
      genreKey,
      adapterUsed: autoAdapter,
      judgeStatus,
      draftProse,
      finalProse: finalProse.trim(),
      validatorResults,
      revisionApplied,
      brief: sceneBrief,
    };
  }

  private async generatePromptText(
    provider: ReturnType<typeof defaultModelRouter.choose>,
    prompt: string,
    options: {
      metricKey: string;
      retries: number;
      timeoutMs: number;
      temperature: number;
      maxTokens: number;
      profile: InferenceProfileName;
      signal?: AbortSignal;
    },
  ): Promise<string> {
    return time(options.metricKey, async () => {
      const params = inferenceParams(options.profile, {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        glmPreserveThinking: false,
      });
      let assembled = '';
      let requestPrompt = prompt;

      for (let segment = 0; segment < 3; segment += 1) {
        try {
          const completed = await withRetry(
            (signal) => provider.generateText({
              prompt: requestPrompt,
              signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
              params,
              terminalPolicy: TERMINAL_REASON_POLICIES.prose,
            }),
            options.retries,
            undefined,
            { timeoutMs: options.timeoutMs, jitter: true, shouldRetry: (error) => !(error instanceof InferenceTerminalError) },
          );
          return assembled ? mergeProseContinuation(assembled, completed) : completed;
        } catch (error) {
          if (!(error instanceof InferenceTerminalError) || error.code !== 'INFERENCE_TRUNCATED') throw error;
          assembled = assembled
            ? mergeProseContinuation(assembled, error.partialOutput)
            : error.partialOutput;
          if (!assembled || segment === 2) {
            throw new InferenceTerminalError('INFERENCE_TRUNCATED', 'length', 'prose', assembled);
          }
          const overlap = assembled.slice(-160);
          requestPrompt = `Continue the prose below without summarizing or restarting. Begin by repeating the exact overlap excerpt, then continue to the natural end.\n\nOVERLAP EXCERPT:\n${overlap}`;
        }
      }
      throw new InferenceTerminalError('INFERENCE_TRUNCATED', 'length', 'prose', assembled);
    });
  }

  private sanitizeGeneratedProse(text: string): string {
    return this.stripReasoningPreamble(
      text
        .replace(/^```[a-z]*\s*/i, '')
        .replace(/```$/i, '')
        .trim(),
    ).trim();
  }

  private buildExternalRef(traceId: string, context: SceneProseContext): string {
    return [
      `trace:${traceId}`,
      `book:${context.bookId}`,
      context.chapterId ? `chapter:${context.chapterId}` : null,
      context.sceneId ? `scene:${context.sceneId}` : null,
    ].filter(Boolean).join('|');
  }

  private extractBeatsJson(instructions?: string): string | undefined {
    if (!instructions) return undefined;
    const jsonStart = instructions.indexOf('{');
    if (jsonStart >= 0) {
      const candidate = instructions.slice(jsonStart).trim();
      if (candidate.includes('"beats"') || candidate.includes("'beats'")) {
        return candidate;
      }
    }
    return undefined;
  }

  private buildTargetBand(targetWords?: number): string {
    const target = Math.max(250, targetWords ?? 900);
    const min = Math.max(250, Math.floor(target * 0.65));
    const max = Math.max(min + 50, Math.ceil(target * 1.35));
    return `${min}-${max} words`;
  }

  private validateProse(text: string, context: SceneProseContext): ProseValidatorResult[] {
    const results: ProseValidatorResult[] = [];
    const trimmed = text.trim();
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const target = Math.max(250, context.targetWords ?? 900);
    const minWords = Math.max(250, Math.floor(target * 0.65));
    const maxWords = Math.max(minWords + 50, Math.ceil(target * 1.35));
    const strictMode = context.qualityMode === 'strict';

    const metaLeak = /(^|\n)\s*(the user wants|we need to|let me|here'?s the|plan:|step \d+:|paragraph \d+:)/i.test(trimmed.slice(0, 400));
    results.push({
      name: 'reasoning_leakage',
      passed: !metaLeak,
      blocking: true,
      message: metaLeak ? 'Output leaked planning or meta-commentary.' : 'No planning leakage detected.',
    });

    const placeholderLeak = /<[^>\n]+>|{{[^}]+}}|\bTODO\b|```/i.test(trimmed);
    results.push({
      name: 'placeholder_leakage',
      passed: !placeholderLeak,
      blocking: true,
      message: placeholderLeak ? 'Output contains placeholders or code fences.' : 'No placeholders detected.',
    });

    const inBand = wordCount >= minWords && wordCount <= maxWords;
    results.push({
      name: 'word_count_band',
      passed: inBand,
      blocking: strictMode || wordCount < Math.floor(target * 0.45) || wordCount > Math.ceil(target * 1.65),
      message: inBand
        ? `Word count ${wordCount} is within target band ${minWords}-${maxWords}.`
        : `Word count ${wordCount} is outside target band ${minWords}-${maxWords}.`,
    });

    if (context.mustInclude?.length) {
      const missing = context.mustInclude.filter((value) => !trimmed.toLowerCase().includes(value.toLowerCase()));
      results.push({
        name: 'must_include',
        passed: missing.length === 0,
        blocking: true,
        message: missing.length === 0 ? 'All required inclusions are present.' : `Missing required inclusions: ${missing.join(', ')}`,
      });
    }

    if (context.mustAvoid?.length) {
      const present = context.mustAvoid.filter((value) => trimmed.toLowerCase().includes(value.toLowerCase()));
      results.push({
        name: 'must_avoid',
        passed: present.length === 0,
        blocking: true,
        message: present.length === 0 ? 'No forbidden content detected.' : `Found forbidden content: ${present.join(', ')}`,
      });
    }

    if (context.pov) {
      const firstPersonHits = (trimmed.match(/\b(i|me|my|mine|myself)\b/gi) ?? []).length;
      const povPassed = context.pov.startsWith('first') ? firstPersonHits >= 3 : firstPersonHits <= 2;
      results.push({
        name: 'pov_consistency',
        passed: povPassed,
        blocking: true,
        message: povPassed ? `POV appears consistent with ${context.pov}.` : `POV appears to drift away from ${context.pov}.`,
      });
    }

    if (context.tense) {
      const presentHits = (trimmed.match(/\b(is|are|do|does|has|have)\b/gi) ?? []).length;
      const pastHits = (trimmed.match(/\b(was|were|did|had)\b/gi) ?? []).length;
      const tensePassed = context.tense.startsWith('past') ? pastHits >= presentHits : presentHits >= pastHits;
      results.push({
        name: 'tense_consistency',
        passed: tensePassed,
        blocking: strictMode,
        message: tensePassed ? `Tense appears consistent with ${context.tense}.` : `Tense may drift away from ${context.tense}.`,
      });
    }

    return results;
  }

  private buildRevisionPrompt(
    context: SceneProseContext,
    sceneBrief: string,
    draftText: string,
    validatorResults: ProseValidatorResult[],
  ): string {
    return interpolatePromptByKey('prose-revise', {
      sceneBrief,
      validatorFailures: validatorResults
        .filter((result) => !result.passed)
        .map((result, index) => `${index + 1}. ${result.message}`)
        .join('\n'),
      mustInclude: context.mustInclude?.join(', '),
      mustAvoid: context.mustAvoid?.join(', '),
      draftText,
    });
  }
  
  /**
   * Enrich scene context by looking up missing information from database
   */
  private async enrichSceneContext(context: SceneProseContext): Promise<SceneProseContext> {
    const enriched = { ...context };
    
    try {
      // If we have sceneId, look up full scene context
      if (context.sceneId) {
        const scene = await databaseService.client.scene.findFirst({
          where: { id: context.sceneId },
          include: {
            chapter: {
              include: {
                act: {
                  include: { book: true }
                }
              }
            }
          }
        });
        
        if (scene) {
          const chapter = scene.chapter;
          const act = chapter.act;
          const book = act.book;
          
          // Enrich with database values if not provided
          enriched.title = enriched.title || book.title || 'Untitled';
          enriched.genre = enriched.genre || book.genre || undefined;
          enriched.summary = enriched.summary || book.summary || undefined;
          enriched.targetAudience = enriched.targetAudience || book.targetAudience || undefined;
          
          // Look up archetype description if not provided - SCENE CONTEXT
          if (!enriched.archetypeDescription && book.storyArchetypeKey) {
            const { getArchetypeDescription } = await import('../config/storyArchetypes');
            enriched.archetypeDescription = getArchetypeDescription(book.storyArchetypeKey);
            logger.info({ bookId: enriched.bookId, storyArchetypeKey: book.storyArchetypeKey, archetypeDescription: enriched.archetypeDescription }, 'Archetype lookup (scene context)');
          }
          
          enriched.actNumber = enriched.actNumber || act.actNumber;
          enriched.actTitle = enriched.actTitle || act.title || undefined;
          enriched.actSummary = enriched.actSummary || act.summary || undefined;
          
          enriched.chapterId = enriched.chapterId || chapter.id;
          enriched.chapterNumber = enriched.chapterNumber || chapter.chapterNumber;
          enriched.chapterTitle = enriched.chapterTitle || chapter.title || undefined;
          enriched.chapterSummary = enriched.chapterSummary || chapter.summary || undefined;
          
          enriched.sceneNumber = enriched.sceneNumber || scene.sceneNumber;
          enriched.sceneSummary = enriched.sceneSummary || scene.summary || undefined;
          enriched.sceneOutline = enriched.sceneOutline || scene.outline || undefined;
          
          // Look up previous scene for continuity
          if (!enriched.previousSceneSummary && scene.sceneNumber > 1) {
            const prevScene = await databaseService.client.scene.findFirst({
              where: { 
                chapterId: chapter.id, 
                sceneNumber: scene.sceneNumber - 1 
              }
            });
            enriched.previousSceneSummary = prevScene?.summary || undefined;
          }
        }
      }
      
      // If we don't have scene context but do have bookId, look up book info
      if (!context.sceneId && context.bookId) {
        const book = await databaseService.client.book.findFirst({
          where: { id: context.bookId }
        });
        
        if (book) {
          enriched.title = enriched.title || book.title || 'Untitled';
          enriched.genre = enriched.genre || book.genre || undefined;
          enriched.summary = enriched.summary || book.summary || undefined;
          enriched.targetAudience = enriched.targetAudience || book.targetAudience || undefined;
          
          // Look up archetype description if not provided - BOOK ONLY CONTEXT
          if (!enriched.archetypeDescription && book.storyArchetypeKey) {
            const { getArchetypeDescription } = await import('../config/storyArchetypes');
            enriched.archetypeDescription = getArchetypeDescription(book.storyArchetypeKey);
            logger.info({ bookId: enriched.bookId, storyArchetypeKey: book.storyArchetypeKey, archetypeDescription: enriched.archetypeDescription }, 'Archetype lookup (book only context)');
          }
        }
      }
      
      // Look up characters if not provided and we have a bookId
      if (!enriched.characters && enriched.bookId) {
        const codexEntries = await databaseService.client.codexEntry.findMany({
          where: { 
            bookId: enriched.bookId,
            entryType: 'character'
          },
          take: 5,
          orderBy: { createdAt: 'asc' }
        });
        enriched.characters = codexEntries.map(e => e.entryName);
      }
      
      // Set defaults for style if not provided
      enriched.writingStyle = enriched.writingStyle || this.deriveWritingStyle(enriched);
      enriched.targetWords = enriched.targetWords || 900;
      
    } catch (error) {
      logger.warn({ error: (error as Error).message, bookId: context.bookId }, 'Error enriching scene context');
      // Continue with whatever context we have
    }
    
    return enriched;
  }
  
  /**
   * Apply Codex RAG retrieval — dispatches to unified orchestrator or legacy path
   */
  private async applyCodexRAG(context: SceneProseContext): Promise<{
    entries: Array<{ id: number; entry_type: string; entry_name: string; excerpt: string }>;
    section: string;
  }> {
    // Use unified RAG orchestrator when feature flag is enabled
    if (CONFIG.RAG_ORCHESTRATOR_ENABLED) {
      return this.applyUnifiedRAG(context);
    }

    // Legacy path: keyword-only retrieval via CodexRetrievalService
    return this.applyLegacyRAG(context);
  }

  /**
   * Unified RAG orchestrator path (Phase 1 - Priority A)
   */
  private async applyUnifiedRAG(context: SceneProseContext): Promise<{
    entries: Array<{ id: number; entry_type: string; entry_name: string; excerpt: string }>;
    section: string;
  }> {
    try {
      const queryText = [
        context.sceneOutline,
        context.sceneSummary,
        context.previousSceneSummary,
      ]
        .filter(Boolean)
        .join(' ');

      const result: OrchestratorResult = await ragOrchestrator.compose({
        bookId: context.bookId,
        sceneId: context.sceneId,
        chapterId: context.chapterId,
        actNumber: context.actNumber,
        chapterNumber: context.chapterNumber,
        queryText,
        characterNames: context.characters,
        tokenBudget: context.tokenBudget || CONFIG.RAG_TOKEN_BUDGET,
      });

      return {
        entries: result.codexUsed,
        section: result.promptSection,
      };
    } catch (error) {
      logger.warn(
        { error: (error as Error).message, bookId: context.bookId },
        'Unified RAG failed — falling back to legacy path'
      );
      return this.applyLegacyRAG(context);
    }
  }

  /**
   * Legacy RAG path: keyword-only retrieval via CodexRetrievalService
   */
  private async applyLegacyRAG(context: SceneProseContext): Promise<{
    entries: Array<{ id: number; entry_type: string; entry_name: string; excerpt: string }>;
    section: string;
  }> {
    try {
      const { codexRetrievalService, buildCodexContextSection } = await import('../services/codexRetrievalService');
      
      const outline = context.sceneOutline || '';
      const summary = context.sceneSummary || '';
      const types = context.codexTypes;
      const k = context.codexK;
      const tokenBudget = context.tokenBudget || 700;
      
      const entries = await codexRetrievalService.getRelevantCodex({
        bookId: context.bookId,
        sceneId: context.sceneId,
        outline,
        summary,
        types: types,
        tokenBudget,
        k
      });
      
      const section = buildCodexContextSection(entries);
      
      return { entries, section: section || '' };
      
    } catch (error) {
      logger.warn({ error: (error as Error).message, bookId: context.bookId }, 'Error applying Codex RAG');
      return { entries: [], section: '' };
    }
  }
  
  /**
   * Strip reasoning model preamble from prose output.
   *
   * Reasoning models (QwQ-style) sometimes emit planning text ("We need to write...",
   * "Let me outline...", "Paragraph 1:") before the actual prose when thinking is not
   * fully suppressed. This strips that overhead and returns the real prose content.
   */
  private stripReasoningPreamble(text: string): string {
    const PLANNING_PREFIXES = [
      /^we need to\b/i,
      /^we'll\b/i,
      /^we will\b/i,
      /^let me\b/i,
      /^let's\b/i,
      /^i need to\b/i,
      /^i'll write\b/i,
      /^i'll aim\b/i,
      /^i'll\b.*\bwrite\b/i,
      /^ok(ay)?,?\s/i,
      /^so (we|i)\b/i,
      /^to (write|create|generate)\b/i,
      /^for (this|the)\b/i,
      /^paragraph \d+:/i,
      /^step \d+:/i,
      /^plan:/i,
      /^\d+\.\s+(we|let|the |plan)/i,
    ];

    const paragraphs = text.split(/\n{2,}/);

    // Find the first paragraph that is NOT planning text
    let startIdx = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      const stripped = paragraphs[i].trim();
      if (!stripped) continue;
      const isPlanning = PLANNING_PREFIXES.some((re) => re.test(stripped));
      if (!isPlanning) {
        startIdx = i;
        break;
      }
      startIdx = i + 1;
    }

    const result = paragraphs.slice(startIdx).join('\n\n').trim();
    if (result.length < 100 && text.trim().length > result.length) {
      // Fallback: if stripping removed too much, return original
      return text.trim();
    }
    return result || text.trim();
  }

  private buildSceneContextString(context: SceneProseContext): string {
    const sceneContextParts: string[] = [];

    if (context.actNumber && context.actTitle) {
      sceneContextParts.push(`Act ${context.actNumber}: ${context.actTitle}`);
    }
    if (context.actSummary) {
      sceneContextParts.push(`Act Summary: ${context.actSummary}`);
    }

    if (context.chapterNumber && context.chapterTitle) {
      sceneContextParts.push(`Chapter ${context.chapterNumber}: ${context.chapterTitle}`);
    }
    if (context.chapterSummary) {
      sceneContextParts.push(`Chapter Summary: ${context.chapterSummary}`);
    }

    if (context.sceneNumber) {
      const sceneRef = context.chapterNumber 
        ? `Scene ${context.chapterNumber}.${context.sceneNumber}`
        : `Scene ${context.sceneNumber}`;
      sceneContextParts.push(sceneRef);
    }
    if (context.sceneSummary) {
      sceneContextParts.push(`Scene Summary: ${context.sceneSummary}`);
    }
    if (context.sceneOutline) {
      sceneContextParts.push(`Scene Outline: ${context.sceneOutline}`);
    }

    if (context.previousSceneSummary) {
      sceneContextParts.push(`Previous Scene (for continuity): ${context.previousSceneSummary}`);
    }

    return sceneContextParts.join('\n');
  }

  private buildSceneBrief(context: SceneProseContext, ragSection: string): string {
    return interpolatePromptByKey('scene-brief', {
      title: context.title,
      genre: context.genre,
      genreKey: context.genreKey,
      archetypeDescription: context.archetypeDescription,
      writingStyle: context.writingStyle,
      pov: context.pov,
      tense: context.tense,
      summary: context.summary,
      characters: context.characters?.join(', '),
      sceneContext: this.buildSceneContextString(context),
      instructions: context.instructions,
      mustInclude: context.mustInclude?.join(', '),
      mustAvoid: context.mustAvoid?.join(', '),
      ragSection,
      wordCount: context.targetWords,
    });
  }

  private buildDraftPrompt(context: SceneProseContext, sceneBrief: string, beatsJson?: string): string {
    return interpolatePromptByKey('prose-draft', {
      sceneBrief,
      beatsJson,
      targetBand: this.buildTargetBand(context.targetWords),
      mustInclude: context.mustInclude?.join(', '),
      mustAvoid: context.mustAvoid?.join(', '),
    });
  }
  
  /**
   * Derive writing style from context
   */
  private deriveWritingStyle(context: SceneProseContext): string {
    if (context.pov && context.tense) {
      return `${context.pov}-person ${context.tense} tense`;
    }
    
    // Smart defaults based on target audience
    if (context.targetAudience?.includes('adult')) {
      return 'third-person limited, past tense';
    }
    
    return 'third-person limited, past tense';
  }
  
  /**
   * Record codex usage for analytics
   */
  private async recordCodexUsage(
    sceneId: number, 
    entries: Array<{ id: number; entry_type: string; entry_name: string; excerpt: string }>,
    source?: SceneProseOptions['frozenSource']
  ): Promise<void> {
    try {
      const { recordSceneCodexUsage } = await import('../services/codexRetrievalService');
      await recordSceneCodexUsage(sceneId, entries, 'prose generation', source);
    } catch (error) {
      logger.warn({ error: (error as Error).message, sceneId }, 'Error recording codex usage');
    }
  }
}

// Export singleton instance
export const sceneProseService = SceneProseService.getInstance();
