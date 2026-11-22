import { databaseService } from '../lib/database';
import type { Prisma } from '@prisma/client';
import { defaultModelRouter } from '../lib/ai/router';
import { TERMINAL_REASON_POLICIES } from '../lib/ai/terminalReason';
import logger from '../lib/logger';
import { withRetry } from '../lib/resilience';
import { time } from '../lib/metrics';
import type { LiveProseJudgePayload } from '../queues/liveProseJudgeQueue';
import { applySinglePassage } from './editorial/editorialApplicationService';
import { manuscriptRevisionService } from './manuscriptRevisionService';
import { documentAuthorityEnabled } from '@/documents/capabilities';
import { analyzeBoundTrace, recordBoundPreference } from '@/documents/traceAnalysis';

type JudgedCandidate = {
  candidateId: string;
  ordinal: number;
  stage: 'draft' | 'final';
  overallScore: number;
  tier: string;
  pass: boolean;
  confidence?: number | null;
  failureLabels?: string[];
};

export type ProseJudgeResult = {
  traceId: string;
  evaluationId: string;
  genreKey?: string | null;
  candidateCount: number;
  judgedCandidates: JudgedCandidate[];
};

type AuthorFeedbackFinding = {
  source: string;
  findingType: string;
  severity: string;
  title?: string;
  message: string;
  excerpt?: string;
  suggestion?: string;
  rationale?: string;
  metadata?: Record<string, unknown>;
};

type AuthorFeedbackCompareCard = {
  title: string;
  message: string;
  excerpt?: string;
  optionALabel?: string;
  optionAText: string;
  optionBLabel?: string;
  optionBText: string;
  recommendedOption?: 'a' | 'b';
  rationale?: string;
  metadata?: Record<string, unknown>;
};

type AuthorFeedbackResult = {
  judgeSummary: {
    overallScore?: number;
    tier?: string;
    pass?: boolean;
    confidence?: number | null;
    failureLabels?: string[];
    headline?: string;
    summary?: string;
    strengths?: string[];
    cautions?: string[];
  };
  findings: AuthorFeedbackFinding[];
  compareCards: AuthorFeedbackCompareCard[];
};

function stringifyJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function parseJson<T>(value?: string | null, fallback: T | null = null): T | null {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const match = raw.match(/\{[\s\S]*\}/);
  return match?.[0] ?? raw;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const OPTIONAL_PROSE_TRACE_TABLES = [
  'prose_traces',
  'prose_trace_candidates',
  'prose_findings',
  'prose_compare_cards',
  'prose_actions',
] as const;

function isMissingProseTraceTableError(error: unknown): boolean {
  if (!error) return false;

  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);

  return (
    (/P2021/i.test(message) || /no such table/i.test(message))
    && OPTIONAL_PROSE_TRACE_TABLES.some((table) => message.includes(table))
  );
}

async function withOptionalProseTraceTables<T>(
  operation: string,
  fallback: T,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingProseTraceTableError(error)) {
      logger.warn({ error, operation }, 'Prose trace tables are unavailable; returning fallback data');
      return fallback;
    }
    throw error;
  }
}

function locateExcerptOffsets(text: string, excerpt?: string | null): { fromOffset: number | null; toOffset: number | null; excerpt: string | null } {
  if (!excerpt) return { fromOffset: null, toOffset: null, excerpt: null };

  const directIndex = text.indexOf(excerpt);
  if (directIndex >= 0) {
    return {
      fromOffset: directIndex,
      toOffset: directIndex + excerpt.length,
      excerpt,
    };
  }

  const normalizedExcerpt = normalizeWhitespace(excerpt);
  if (!normalizedExcerpt) return { fromOffset: null, toOffset: null, excerpt: null };

  const paragraphs = text.split(/\n{2,}/).filter(Boolean);
  for (const paragraph of paragraphs) {
    if (normalizeWhitespace(paragraph).includes(normalizedExcerpt)) {
      const paragraphIndex = text.indexOf(paragraph);
      if (paragraphIndex >= 0) {
        return {
          fromOffset: paragraphIndex,
          toOffset: paragraphIndex + paragraph.length,
          excerpt: paragraph,
        };
      }
    }
  }

  return { fromOffset: null, toOffset: null, excerpt: excerpt.trim() || null };
}

function buildJudgeSummary(result: ProseJudgeResult) {
  const finalCandidate = result.judgedCandidates.find((candidate) => candidate.stage === 'final')
    ?? result.judgedCandidates[result.judgedCandidates.length - 1];

  if (!finalCandidate) {
    return {
      headline: 'Judge results pending.',
      summary: 'No final candidate score is available yet.',
      strengths: [] as string[],
      cautions: [] as string[],
      failureLabels: [] as string[],
    };
  }

  const failureLabels = finalCandidate.failureLabels ?? [];
  const score = typeof finalCandidate.overallScore === 'number' ? finalCandidate.overallScore : null;
  const tier = finalCandidate.tier || 'unscored';
  const pass = Boolean(finalCandidate.pass);

  return {
    overallScore: score ?? undefined,
    tier,
    pass,
    confidence: finalCandidate.confidence ?? null,
    failureLabels,
    headline: score != null
      ? `Judge score ${score.toFixed(1)} • ${tier}`
      : `Judge tier ${tier}`,
    summary: pass
      ? 'The final prose passed local quality review and is ready for author review.'
      : 'The final prose was scored below the pass threshold. Review the cautions and compare cards.',
    strengths: pass ? ['The final candidate passed the local quality review.'] : [],
    cautions: failureLabels.map((label) => `Judge flagged ${label.replace(/_/g, ' ')}.`),
  };
}

function paragraphChunks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function buildFallbackFeedback(finalText: string, draftText: string | null, result: ProseJudgeResult): AuthorFeedbackResult {
  const judgeSummary = buildJudgeSummary(result);
  const findings: AuthorFeedbackFinding[] = (judgeSummary.failureLabels ?? []).slice(0, 3).map((label) => ({
    source: 'local_judge',
    findingType: label,
    severity: 'warning',
    title: label.replace(/_/g, ' '),
    message: `The local quality review flagged ${label.replace(/_/g, ' ')} in this scene.`,
    suggestion: 'Review the flagged passage and decide whether to keep the current wording or revise it.',
  }));

  const compareCards: AuthorFeedbackCompareCard[] = [];
  if (draftText && draftText.trim() && draftText.trim() !== finalText.trim()) {
    const draftParagraph = paragraphChunks(draftText)[0];
    const finalParagraph = paragraphChunks(finalText)[0];
    if (draftParagraph && finalParagraph) {
      compareCards.push({
        title: 'Opening Passage Comparison',
        message: 'Choose whether to keep the current opening or revert to the earlier draft wording.',
        excerpt: finalParagraph,
        optionALabel: 'Draft',
        optionAText: draftParagraph,
        optionBLabel: 'Final',
        optionBText: finalParagraph,
        recommendedOption: 'b',
        rationale: 'The final candidate is the version returned to the author after validation and revision.',
      });
    }
  }

  return { judgeSummary, findings, compareCards };
}

async function generateAuthorFeedback(
  params: {
    finalText: string;
    draftText: string | null;
    promptText?: string | null;
    brief?: string | null;
    genreKey?: string | null;
    recipeVersion?: string | null;
    judgeResult: ProseJudgeResult;
    modelUsed?: string | null;
  },
): Promise<AuthorFeedbackResult> {
  const fallback = buildFallbackFeedback(params.finalText, params.draftText, params.judgeResult);

  try {
    const provider = defaultModelRouter.choose('feedback', params.modelUsed ?? undefined);
    if (params.modelUsed && 'setModel' in provider) {
      provider.setModel?.(params.modelUsed);
    }

    const prompt = [
      'You are Proser Author Feedback, a strict fiction editor.',
      'Return only JSON with keys: judgeSummary, findings, compareCards.',
      'judgeSummary fields: headline, summary, strengths[], cautions[].',
      'finding fields: source, findingType, severity, title, message, excerpt, suggestion, rationale.',
      'compareCards fields: title, message, excerpt, optionALabel, optionAText, optionBLabel, optionBText, recommendedOption, rationale.',
      'Rules:',
      '- Use at most 4 findings and at most 3 compareCards.',
      '- Any excerpt must be copied verbatim from the final prose.',
      '- compareCards must use optionAText and optionBText as ready-to-apply prose alternatives for the excerpt.',
      '- Prefer passage-level issues over global notes.',
      '- If no trustworthy compare card exists, return an empty array.',
      params.genreKey ? `Genre: ${params.genreKey}` : '',
      params.promptText ? `Instructions:\n${params.promptText}` : '',
      params.brief ? `Brief:\n${params.brief}` : '',
      `Judge summary seed:\n${JSON.stringify(fallback.judgeSummary)}`,
      'Final prose:',
      params.finalText,
      params.draftText ? `Earlier draft:\n${params.draftText}` : '',
    ].filter(Boolean).join('\n\n');

    const raw = await time('ai.generate.authorFeedback', () =>
      withRetry(
        (signal) => provider.generateText({ prompt, signal, terminalPolicy: TERMINAL_REASON_POLICIES.structured }),
        1,
      ),
    );

    const parsed = JSON.parse(extractJsonObject(raw)) as Partial<AuthorFeedbackResult>;
    return {
      judgeSummary: {
        ...fallback.judgeSummary,
        ...(parsed.judgeSummary ?? {}),
      },
      findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 4).map((finding) => ({
        source: typeof finding.source === 'string' ? finding.source : 'author_feedback',
        findingType: typeof finding.findingType === 'string' ? finding.findingType : 'style',
        severity: typeof finding.severity === 'string' ? finding.severity : 'warning',
        title: typeof finding.title === 'string' ? finding.title : undefined,
        message: typeof finding.message === 'string' ? finding.message : 'Review this passage.',
        excerpt: typeof finding.excerpt === 'string' ? finding.excerpt : undefined,
        suggestion: typeof finding.suggestion === 'string' ? finding.suggestion : undefined,
        rationale: typeof finding.rationale === 'string' ? finding.rationale : undefined,
      })) : fallback.findings,
      compareCards: Array.isArray(parsed.compareCards) ? parsed.compareCards.slice(0, 3).map((card) => ({
        title: typeof card.title === 'string' ? card.title : 'Passage Comparison',
        message: typeof card.message === 'string' ? card.message : 'Choose the stronger passage.',
        excerpt: typeof card.excerpt === 'string' ? card.excerpt : undefined,
        optionALabel: typeof card.optionALabel === 'string' ? card.optionALabel : 'Option A',
        optionAText: typeof card.optionAText === 'string' ? card.optionAText : (typeof card.excerpt === 'string' ? card.excerpt : ''),
        optionBLabel: typeof card.optionBLabel === 'string' ? card.optionBLabel : 'Option B',
        optionBText: typeof card.optionBText === 'string' ? card.optionBText : (typeof card.excerpt === 'string' ? card.excerpt : ''),
        recommendedOption: card.recommendedOption === 'a' || card.recommendedOption === 'b'
          ? card.recommendedOption
          : undefined,
        rationale: typeof card.rationale === 'string' ? card.rationale : undefined,
      })).filter((card) => Boolean(card.optionAText.trim()) && Boolean(card.optionBText.trim())) : fallback.compareCards,
    };
  } catch (error) {
    logger.warn({ error, traceId: params.judgeResult.traceId }, 'Falling back to deterministic author feedback');
    return fallback;
  }
}

type ProseTraceWithRelations = Prisma.ProseTraceGetPayload<{
  include: { candidates: true; findings: true; compareCards: true; actions: true };
}>;

function mapTraceRecord(record: ProseTraceWithRelations) {
  return {
    traceId: record.traceId,
    status: record.status,
    judgeStatus: record.judgeStatus,
    recipeVersion: record.recipeVersion,
    genreKey: record.genreKey,
    adapterUsed: record.adapterUsed,
    modelUsed: record.modelUsed,
    promptText: record.promptText,
    brief: record.brief,
    judgeSummary: parseJson<Record<string, unknown>>(record.judgeSummaryJson, {}),
    validatorResults: parseJson<unknown[]>(record.validatorResultsJson, []) ?? [],
    errorMessage: record.errorMessage,
    candidates: (record.candidates ?? []).map((candidate) => ({
      ordinal: candidate.ordinal,
      stage: candidate.stage,
      candidateType: candidate.candidateType,
      selectionLabel: candidate.selectionLabel,
      accepted: candidate.accepted,
      rejected: candidate.rejected,
      outputText: candidate.outputText,
      wordCount: candidate.wordCount,
      overallScore: candidate.overallScore,
      tier: candidate.tier,
      metadata: parseJson<Record<string, unknown>>(candidate.metadataJson, {}),
    })),
    inlineFindings: (record.findings ?? []).map((finding) => ({
      id: finding.id,
      source: finding.source,
      findingType: finding.findingType,
      severity: finding.severity,
      title: finding.title,
      message: finding.message,
      excerpt: finding.excerpt,
      suggestion: finding.suggestion,
      rationale: finding.rationale,
      fromOffset: finding.fromOffset,
      toOffset: finding.toOffset,
      metadata: parseJson<Record<string, unknown>>(finding.metadataJson, {}),
      dismissedAt: finding.dismissedAt,
    })),
    compareCards: (record.compareCards ?? []).map((card) => ({
      id: card.id,
      findingId: card.proseFindingId,
      title: card.title,
      message: card.message,
      excerpt: card.excerpt,
      optionALabel: card.optionALabel,
      optionAText: card.optionAText,
      optionBLabel: card.optionBLabel,
      optionBText: card.optionBText,
      recommendedOption: card.recommendedOption,
      rationale: card.rationale,
      fromOffset: card.fromOffset,
      toOffset: card.toOffset,
      status: card.status,
      metadata: parseJson<Record<string, unknown>>(card.metadataJson, {}),
    })),
    actions: (record.actions ?? []).map((action) => ({
      id: action.id,
      actionType: action.actionType,
      findingId: action.proseFindingId,
      compareCardId: action.proseCompareCardId,
      metadata: parseJson<Record<string, unknown>>(action.metadataJson, {}),
      createdAt: action.createdAt,
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function findTraceForUser(userId: number, where: Record<string, unknown>) {
  return databaseService.client.proseTrace.findFirst({
    where: {
      ...where,
      userId,
    },
    include: {
      candidates: { orderBy: { ordinal: 'asc' } },
      findings: { orderBy: { createdAt: 'asc' } },
      compareCards: { orderBy: { createdAt: 'asc' } },
      actions: { orderBy: { createdAt: 'desc' } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

function applyChoiceToSceneProse(
  currentProse: string,
  card: { excerpt?: string | null; fromOffset?: number | null; toOffset?: number | null },
  chosenText: string,
): { prose: string; applied: boolean } {
  const excerpt = card.excerpt?.trim();
  if (excerpt) {
    const index = currentProse.indexOf(excerpt);
    if (index >= 0) {
      return {
        prose: `${currentProse.slice(0, index)}${chosenText}${currentProse.slice(index + excerpt.length)}`,
        applied: true,
      };
    }
  }

  if (
    typeof card.fromOffset === 'number'
    && typeof card.toOffset === 'number'
    && card.fromOffset >= 0
    && card.toOffset > card.fromOffset
    && card.toOffset <= currentProse.length
  ) {
    return {
      prose: `${currentProse.slice(0, card.fromOffset)}${chosenText}${currentProse.slice(card.toOffset)}`,
      applied: true,
    };
  }

  return { prose: currentProse, applied: false };
}

export class ProseTraceService {
  async createPendingTrace(params: {
    traceId: string;
    judgePayload: LiveProseJudgePayload;
    judgeStatus: 'queued' | 'submitted' | 'failed' | 'deferred';
  }): Promise<void> {
    const { traceId, judgePayload, judgeStatus } = params;
    const prisma = databaseService.client;

    const book = await prisma.book.findUnique({
      where: { id: judgePayload.bookId },
      select: { id: true, userId: true },
    });
    if (!book) {
      logger.warn({ traceId, bookId: judgePayload.bookId }, 'Skipping pending prose trace creation because the book was not found');
      return;
    }

    const scene = judgePayload.sceneId
      ? await prisma.scene.findUnique({
        where: { id: judgePayload.sceneId },
        select: {
          id: true,
          chapterId: true,
          chapter: {
            select: {
              actId: true,
            },
          },
        },
      })
      : null;

    const chapterId = judgePayload.chapterId ?? scene?.chapterId ?? null;
    const actId = scene?.chapter.actId ?? null;

    const trace = await prisma.proseTrace.upsert({
      where: { traceId },
      update: {
        status: judgeStatus === 'failed' ? 'failed' : 'pending',
        judgeStatus,
        recipeVersion: judgePayload.recipeVersion,
        genreKey: judgePayload.genreKey ?? null,
        adapterUsed: judgePayload.adapterUsed ?? null,
        modelUsed: judgePayload.model ?? null,
        promptText: judgePayload.prompt ?? judgePayload.instructions ?? null,
        brief: judgePayload.brief ?? null,
        promptContextJson: stringifyJson(judgePayload.promptContext),
        validatorResultsJson: stringifyJson(judgePayload.validatorSummary?.results ?? []),
        errorMessage: judgeStatus === 'failed' ? 'Live judge submission was not scheduled.' : null,
      },
      create: {
        traceId,
        userId: book.userId,
        bookId: book.id,
        actId,
        chapterId,
        sceneId: judgePayload.sceneId ?? null,
        status: judgeStatus === 'failed' ? 'failed' : 'pending',
        judgeStatus,
        recipeVersion: judgePayload.recipeVersion,
        genreKey: judgePayload.genreKey ?? null,
        adapterUsed: judgePayload.adapterUsed ?? null,
        modelUsed: judgePayload.model ?? null,
        promptText: judgePayload.prompt ?? judgePayload.instructions ?? null,
        brief: judgePayload.brief ?? null,
        promptContextJson: stringifyJson(judgePayload.promptContext),
        validatorResultsJson: stringifyJson(judgePayload.validatorSummary?.results ?? []),
        errorMessage: judgeStatus === 'failed' ? 'Live judge submission was not scheduled.' : null,
      },
    });

    await prisma.proseTraceCandidate.deleteMany({ where: { proseTraceId: trace.id } });
    if (judgePayload.candidates.length > 0) {
      await prisma.proseTraceCandidate.createMany({
        data: judgePayload.candidates.map((candidate) => ({
          proseTraceId: trace.id,
          ordinal: candidate.ordinal,
          stage: candidate.stage,
          candidateType: candidate.candidateType,
          selectionLabel: candidate.selectionLabel ?? null,
          accepted: candidate.accepted ?? null,
          rejected: candidate.rejected ?? null,
          outputText: candidate.outputText,
          wordCount: candidate.wordCount ?? candidate.outputText.split(/\s+/).filter(Boolean).length,
          metadataJson: stringifyJson(candidate.metadata),
        })),
      });
    }
  }

  async finalizeTraceFromEvaluation(traceId: string, result: ProseJudgeResult): Promise<void> {
    if (documentAuthorityEnabled()) { await analyzeBoundTrace(traceId, result); return; }
    const prisma = databaseService.client;
    const trace = await prisma.proseTrace.findUnique({
      where: { traceId },
      include: {
        candidates: { orderBy: { ordinal: 'asc' } },
      },
    });

    if (!trace) {
      logger.warn({ traceId }, 'Skipping prose trace finalize because the trace record does not exist');
      return;
    }

    for (const judged of result.judgedCandidates) {
      const candidate = trace.candidates.find((entry) => entry.ordinal === judged.ordinal);
      if (!candidate) continue;

      const currentMetadata = parseJson<Record<string, unknown>>(candidate.metadataJson, {}) ?? {};
      await prisma.proseTraceCandidate.update({
        where: { id: candidate.id },
        data: {
          overallScore: judged.overallScore,
          tier: judged.tier,
          metadataJson: stringifyJson({
            ...currentMetadata,
            pass: judged.pass,
            confidence: judged.confidence ?? null,
            failureLabels: judged.failureLabels ?? [],
            candidateId: judged.candidateId,
          }),
        },
      });
    }

    const updatedTrace = await prisma.proseTrace.findUnique({
      where: { traceId },
      include: {
        candidates: { orderBy: { ordinal: 'asc' } },
      },
    });
    if (!updatedTrace) return;

    const finalCandidate = updatedTrace.candidates.find((candidate) => candidate.stage === 'final')
      ?? updatedTrace.candidates[updatedTrace.candidates.length - 1];
    const draftCandidate = updatedTrace.candidates.find((candidate) => candidate.stage === 'draft') ?? null;
    const finalText = finalCandidate?.outputText ?? '';

    const feedback = await generateAuthorFeedback({
      finalText,
      draftText: draftCandidate?.outputText ?? null,
      promptText: updatedTrace.promptText,
      brief: updatedTrace.brief,
      genreKey: updatedTrace.genreKey,
      recipeVersion: updatedTrace.recipeVersion,
      judgeResult: result,
      modelUsed: updatedTrace.modelUsed,
    });

    await prisma.$transaction(async (tx) => {
      await tx.proseFinding.deleteMany({ where: { proseTraceId: updatedTrace.id } });
      await tx.proseCompareCard.deleteMany({ where: { proseTraceId: updatedTrace.id } });

      const findings = feedback.findings.map((finding) => {
        const offsets = locateExcerptOffsets(finalText, finding.excerpt);
        return {
          proseTraceId: updatedTrace.id,
          source: finding.source,
          findingType: finding.findingType,
          severity: finding.severity,
          title: finding.title ?? null,
          message: finding.message,
          excerpt: offsets.excerpt,
          suggestion: finding.suggestion ?? null,
          rationale: finding.rationale ?? null,
          fromOffset: offsets.fromOffset,
          toOffset: offsets.toOffset,
          metadataJson: stringifyJson(finding.metadata),
        };
      });

      if (findings.length > 0) {
        await tx.proseFinding.createMany({ data: findings });
      }

      const createdFindings = await tx.proseFinding.findMany({
        where: { proseTraceId: updatedTrace.id },
        orderBy: { createdAt: 'asc' },
      });

      const compareCards = feedback.compareCards.map((card) => {
        const offsets = locateExcerptOffsets(finalText, card.excerpt);
        const matchedFinding = offsets.excerpt
          ? createdFindings.find((finding) => finding.excerpt === offsets.excerpt)
          : null;

        return {
          proseTraceId: updatedTrace.id,
          proseFindingId: matchedFinding?.id ?? null,
          title: card.title,
          message: card.message,
          excerpt: offsets.excerpt,
          optionALabel: card.optionALabel ?? 'Option A',
          optionAText: card.optionAText,
          optionBLabel: card.optionBLabel ?? 'Option B',
          optionBText: card.optionBText,
          recommendedOption: card.recommendedOption ?? null,
          rationale: card.rationale ?? null,
          fromOffset: offsets.fromOffset,
          toOffset: offsets.toOffset,
          metadataJson: stringifyJson(card.metadata),
        };
      });

      if (compareCards.length > 0) {
        await tx.proseCompareCard.createMany({ data: compareCards });
      }

      await tx.proseTrace.update({
        where: { id: updatedTrace.id },
        data: {
          status: 'ready',
          judgeStatus: 'completed',
          judgeSummaryJson: stringifyJson(feedback.judgeSummary),
          errorMessage: null,
        },
      });
    });
  }

  async markTraceFailed(traceId: string, errorMessage: string): Promise<void> {
    await databaseService.client.proseTrace.updateMany({
      where: { traceId },
      data: {
        status: 'failed',
        judgeStatus: 'failed',
        errorMessage,
      },
    });
  }

  async getTraceForUser(userId: number, traceId: string) {
    const trace = await withOptionalProseTraceTables(
      'getTraceForUser',
      null,
      () => findTraceForUser(userId, { traceId }),
    );
    return trace ? mapTraceRecord(trace) : null;
  }

  async getLatestTraceForScene(userId: number, bookId: number, sceneId: number) {
    const trace = await withOptionalProseTraceTables(
      'getLatestTraceForScene',
      null,
      () => findTraceForUser(userId, {
        bookId,
        sceneId,
      }),
    );

    if (!trace) return null;

    return mapTraceRecord(trace);
  }

  async getBookQualityOverview(userId: number, bookId: number) {
    const scenes = await databaseService.client.scene.findMany({
      where: {
        deletedAt: null,
        chapter: {
          act: {
            bookId,
            book: { userId },
          },
        },
      },
      include: {
        chapter: {
          select: {
            title: true,
            chapterNumber: true,
          },
        },
      },
      orderBy: [
        { chapter: { chapterNumber: 'asc' } },
        { sceneNumber: 'asc' },
      ],
    });

    const loadTraces = () => databaseService.client.proseTrace.findMany({
        where: {
          bookId,
          userId,
          sceneId: { not: null },
        },
        include: {
          findings: true,
        },
        orderBy: { createdAt: 'desc' },
      });

    const traces = await withOptionalProseTraceTables(
      'getBookQualityOverview',
      [] as Awaited<ReturnType<typeof loadTraces>>,
      loadTraces,
    );

    const latestByScene = new Map<number, typeof traces[number]>();
    for (const trace of traces) {
      if (trace.sceneId == null || latestByScene.has(trace.sceneId)) continue;
      latestByScene.set(trace.sceneId, trace);
    }

    const chapters = new Map<number, { chapterId: number; chapter: string; score: number; issues: number; reviewed: boolean }>();
    const issues: Array<Record<string, unknown>> = [];
    let totalScore = 0;
    let reviewedSceneCount = 0;

    for (const scene of scenes) {
      const trace = latestByScene.get(scene.id);
      const judgeSummary = parseJson<Record<string, unknown>>(trace?.judgeSummaryJson, {}) ?? {};
      const score = typeof judgeSummary.overallScore === 'number' ? judgeSummary.overallScore : 0;
      const chapterEntry = chapters.get(scene.chapterId) ?? {
        chapterId: scene.chapterId,
        chapter: scene.chapter.title || `Chapter ${scene.chapter.chapterNumber}`,
        score: 0,
        issues: 0,
        reviewed: false,
      };

      if (trace && score > 0) {
        chapterEntry.score += score;
        chapterEntry.reviewed = true;
        reviewedSceneCount += 1;
        totalScore += score;
      }

      const findingCount = trace?.findings.length ?? 0;
      chapterEntry.issues += findingCount;
      chapters.set(scene.chapterId, chapterEntry);

      for (const finding of trace?.findings ?? []) {
        issues.push({
          id: finding.id,
          sceneId: scene.id,
          sceneNumber: scene.sceneNumber,
          chapter: chapterEntry.chapter,
          severity: finding.severity,
          category: finding.findingType,
          title: finding.title || finding.message,
          description: finding.message,
          suggestion: finding.suggestion,
          fixable: Boolean(finding.suggestion),
          traceId: trace?.traceId,
        });
      }
    }

    const chapterQualities = [...chapters.values()].map((chapter) => {
      const sceneCount = scenes.filter((scene) => scene.chapterId === chapter.chapterId).length || 1;
      return {
        chapter: chapter.chapter,
        score: chapter.reviewed ? Math.round((chapter.score / sceneCount) * 10) / 10 : 0,
        issues: chapter.issues,
        reviewed: chapter.reviewed,
      };
    });

    return {
      overallScore: reviewedSceneCount > 0 ? Math.round((totalScore / reviewedSceneCount) * 10) / 10 : 0,
      reviewedSceneCount,
      chapterQualities,
      issues,
    };
  }

  async recordPreference(params: {
    userId: number;
    bookId: number;
    sceneId: number;
    traceId: string;
    compareCardId: number;
    chosen: 'a' | 'b';
    applyChosen: boolean;
    rationale?: string;
    operationId?: string; expectedRevisionId?: string; expectedSceneRevisionId?: string; validationId?: string;
  }) {
    if (documentAuthorityEnabled()) {
      const documentReceipt = await recordBoundPreference(params);
      const trace = await this.getTraceForUser(params.userId, params.traceId);
      return trace ? { ...trace, documentReceipt } : null;
    }
    const trace = await databaseService.client.proseTrace.findFirst({
      where: {
        traceId: params.traceId,
        userId: params.userId,
        bookId: params.bookId,
        sceneId: params.sceneId,
      },
      include: {
        compareCards: true,
        findings: true,
        scene: true,
      },
    });

    if (!trace) {
      return null;
    }

    const compareCard = trace.compareCards.find((card) => card.id === params.compareCardId);
    if (!compareCard) {
      return null;
    }

    const chosenText = params.chosen === 'a' ? compareCard.optionAText : compareCard.optionBText;
    const metadata: Record<string, unknown> = {
      chosen: params.chosen,
      applyChosen: params.applyChosen,
      rationale: params.rationale ?? null,
      bookId: params.bookId,
      sceneId: params.sceneId,
      compareCardId: compareCard.id,
      findingId: compareCard.proseFindingId,
    };

    let applied = false;
    if (params.applyChosen && trace.scene?.prose) {
      if (trace.scene.updatedAt && compareCard.createdAt && trace.scene.updatedAt > compareCard.createdAt) {
        throw new Error('EDITORIAL_PROPOSAL_STALE');
      }
      const next = applyChoiceToSceneProse(trace.scene.prose, compareCard, chosenText);
      const original = compareCard.excerpt?.trim()
        || (typeof compareCard.fromOffset === 'number' && typeof compareCard.toOffset === 'number'
          ? trace.scene.prose.slice(compareCard.fromOffset, compareCard.toOffset)
          : '');
      const startOffset = original ? trace.scene.prose.indexOf(original) : -1;
      if (next.applied && original && startOffset >= 0) {
        const sourceRevisionId = await manuscriptRevisionService.current(params.bookId);
        const revisionId = await applySinglePassage({
          userId: params.userId, bookId: params.bookId, sceneId: trace.scene.id,
          expectedRevisionId: sourceRevisionId, originalPassage: original,
          replacement: chosenText, startOffset, endOffset: startOffset + original.length,
          maxChangedPercent: 50,
        });
        metadata.resultRevisionId = revisionId;
        applied = true;
      }
    }

    await databaseService.client.$transaction(async (tx) => {
      await tx.proseCompareCard.update({
        where: { id: compareCard.id },
        data: {
          status: params.chosen === 'a' ? 'chosen_a' : 'chosen_b',
        },
      });

      await tx.proseAction.create({
        data: {
          proseTraceId: trace.id,
          userId: params.userId,
          bookId: params.bookId,
          sceneId: params.sceneId,
          proseFindingId: compareCard.proseFindingId ?? null,
          proseCompareCardId: compareCard.id,
          actionType: params.chosen === 'a' ? 'choose_option_a' : 'choose_option_b',
          metadataJson: stringifyJson({
            ...metadata,
            applied,
            excerpt: compareCard.excerpt,
            fromOffset: compareCard.fromOffset,
            toOffset: compareCard.toOffset,
          }),
        },
      });
    });

    return this.getTraceForUser(params.userId, params.traceId);
  }
}

export const proseTraceService = new ProseTraceService();
