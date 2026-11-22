/**
 * Skill Runner — orchestrates skill execution on generated prose.
 *
 * Runs registered skills (sync or async), aggregates findings,
 * persists results to the database, and emits metrics.
 *
 * Skills are advisory by default: findings are never auto-applied
 * and never block prose generation.
 *
 * @module skills/runner
 */

import { createHash } from 'node:crypto';
import { canonicalDocument } from '@/documents/model';
import { databaseService } from '@/lib/database';
import type { Prisma } from '@prisma/client';
import { CONFIG } from '@/core/config';
import logger from '@/lib/logger';
import { logRag } from '@/lib/ragLogger';
import { trace } from '@opentelemetry/api';
import * as skillMetrics from '@/metrics/skills';

import type {
  Skill,
  SkillInput,
  SkillResult,
  SkillRunnerOptions,
  SkillRunnerResult,
  FindingSeverity,
} from '@/lib/skills/types';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Global skill registry */
const registeredSkills = new Map<string, Skill>();

/**
 * Register a skill for execution.
 * Skills are typically registered at module load time.
 */
export function registerSkill(skill: Skill): void {
  registeredSkills.set(skill.name, skill);
  logger.info({ skillName: skill.name, version: skill.version }, 'Skill registered');
}

/**
 * Get a registered skill by name.
 */
export function getSkill(name: string): Skill | undefined {
  return registeredSkills.get(name);
}

/**
 * Get all registered skills.
 */
export function getRegisteredSkills(): Skill[] {
  return Array.from(registeredSkills.values());
}

// ---------------------------------------------------------------------------
// Input hashing (for deduplication)
// ---------------------------------------------------------------------------

export function skillInputHash(input: SkillInput): string {
  return createHash('sha256').update(canonicalDocument(input)).digest('hex');
}

// ---------------------------------------------------------------------------
// Single skill execution (with timeout)
// ---------------------------------------------------------------------------

async function executeSkill(
  skill: Skill,
  input: SkillInput,
  timeoutMs: number,
  confidenceThreshold: number
): Promise<SkillResult> {
  const tracer = trace.getTracer('skill-runner');

  return await tracer.startActiveSpan(`skill.${skill.name}`, async (span) => {
    const t0 = performance.now();
    span.setAttributes({
      skillName: skill.name,
      version: skill.version,
      bookId: input.bookId,
      sceneId: input.sceneId ?? 0,
    });

    logRag({
      type: 'skill.run.start',
      bookId: input.bookId,
      sceneId: input.sceneId ?? 0,
      skillName: skill.name,
    });

    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const resultPromise = skill.analyze(input);
      const timeoutPromise = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`Skill ${skill.name} timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      const result = await Promise.race([resultPromise, timeoutPromise]);
      const latencyMs = performance.now() - t0;

      // Filter findings by confidence threshold
      result.findings = result.findings.filter(
        (f) => f.confidence >= confidenceThreshold
      );
      if (input.documentSource) result.findings = result.findings.map((finding) => ({ ...finding, metadata: { ...finding.metadata, proserDocumentSource: input.documentSource } }));
      result.latencyMs = latencyMs;
      result.inputHash = skillInputHash(input);

      span.setAttributes({
        findings: result.findings.length,
        latencyMs: Math.round(latencyMs),
        status: result.status,
      });

      logRag({
        type: 'skill.run.result',
        bookId: input.bookId,
        sceneId: input.sceneId ?? 0,
        skillName: skill.name,
        findings: result.findings.length,
        latencyMs: Math.round(latencyMs),
      });

      // Record metrics
      skillMetrics.recordSkillRunTime(latencyMs, {
        skill: skill.name,
        book_id: input.bookId,
      });
      skillMetrics.incSkillRuns({
        skill: skill.name,
        status: result.status,
        book_id: input.bookId,
      });
      skillMetrics.recordFindingsCount(result.findings.length, {
        skill: skill.name,
        book_id: input.bookId,
      });

      return result;
    } catch (error) {
      const latencyMs = performance.now() - t0;
      const isTimeout = (error as Error).message.includes('timed out');

      span.recordException(error as Error);
      span.setStatus({ code: 2, message: (error as Error).message });

      logRag({
        type: 'skill.run.error',
        bookId: input.bookId,
        sceneId: input.sceneId ?? 0,
        skillName: skill.name,
        message: (error as Error).message,
      });

      skillMetrics.incSkillRuns({
        skill: skill.name,
        status: isTimeout ? 'timeout' : 'error',
        book_id: input.bookId,
      });

      return {
        skillName: skill.name,
        version: skill.version,
        status: isTimeout ? 'timeout' as const : 'error' as const,
        findings: [],
        latencyMs,
        inputHash: skillInputHash(input),
        errorMessage: (error as Error).message,
      };
    } finally {
      clearTimeout(deadline);
      span.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistSkillResult(
  bookId: number,
  sceneId: number | undefined,
  result: SkillResult
): Promise<void> {
  try {
    await databaseService.client.skillRun.create({
      data: {
        bookId,
        sceneId: sceneId ?? null,
        skillName: result.skillName,
        version: result.version,
        status: result.status,
        latencyMs: Math.round(result.latencyMs),
        findings: result.findings as unknown as Prisma.InputJsonValue,
        inputHash: result.inputHash,
      },
    });
  } catch (error) {
    logger.warn(
      { error: (error as Error).message, skillName: result.skillName },
      'Failed to persist skill result'
    );
  }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Run registered skills on a prose draft.
 *
 * Skills run in parallel (async mode) or sequentially (sync mode).
 * Results are aggregated and returned as advisory findings.
 *
 * Never throws — skill failures are logged and recorded, but
 * never block prose generation.
 */
export async function runSkills(
  input: SkillInput,
  options: SkillRunnerOptions = {}
): Promise<SkillRunnerResult> {
  const tracer = trace.getTracer('skill-runner');

  return await tracer.startActiveSpan('skills.run', async (span) => {
    const t0 = performance.now();

    const emptyResult: SkillRunnerResult = {
      results: [],
      totalLatencyMs: 0,
      totalFindings: 0,
      severityCounts: { error: 0, warning: 0, suggestion: 0, info: 0 },
    };

    if (!CONFIG.SKILLS_RUNTIME_ENABLED || CONFIG.SKILLS_MODE === 'disabled') {
      return emptyResult;
    }

    // Determine which skills to run
    const skillsToRun = options.skillNames
      ? options.skillNames
          .map((name) => registeredSkills.get(name))
          .filter((s): s is Skill => !!s)
      : getRegisteredSkills();

    if (skillsToRun.length === 0) {
      return emptyResult;
    }

    const timeoutMs = options.timeoutMs ?? (Number(process.env.AI_TIMEOUT_SKILL_MS ?? '30000') || 30000);
    const confidenceThreshold = options.confidenceThreshold ?? CONFIG.SKILLS_CONFIDENCE_THRESHOLD;

    span.setAttributes({
      bookId: input.bookId,
      sceneId: input.sceneId ?? 0,
      skillCount: skillsToRun.length,
      mode: CONFIG.SKILLS_MODE,
    });

    try {
      let results: SkillResult[];

      if (CONFIG.SKILLS_MODE === 'sync') {
        // Sequential execution
        results = [];
        for (const skill of skillsToRun) {
          results.push(await executeSkill(skill, input, timeoutMs, confidenceThreshold));
        }
      } else {
        // Parallel execution (async mode)
        results = await Promise.all(
          skillsToRun.map((skill) =>
            executeSkill(skill, input, timeoutMs, confidenceThreshold)
          )
        );
      }

      // Aggregate
      const totalLatencyMs = performance.now() - t0;
      const severityCounts: Record<FindingSeverity, number> = { error: 0, warning: 0, suggestion: 0, info: 0 };
      let totalFindings = 0;

      for (const result of results) {
        totalFindings += result.findings.length;
        for (const finding of result.findings) {
          severityCounts[finding.severity]++;
        }
      }

      // Persist results
      await Promise.all(
        results.map((r) => persistSkillResult(input.bookId, input.sceneId, r))
      );

      span.setAttributes({
        totalFindings,
        errorsFound: severityCounts.error,
        warningsFound: severityCounts.warning,
        totalLatencyMs: Math.round(totalLatencyMs),
      });

      logger.info(
        {
          bookId: input.bookId,
          sceneId: input.sceneId,
          skillsRun: results.map((r) => r.skillName),
          totalFindings,
          severityCounts,
          totalLatencyMs: Math.round(totalLatencyMs),
        },
        'Skills run complete'
      );

      return {
        results,
        totalLatencyMs,
        totalFindings,
        severityCounts,
      };
    } catch (error) {
      span.recordException(error as Error);
      logger.error(
        { error: (error as Error).message, bookId: input.bookId },
        'Skill runner failed — non-blocking'
      );
      return { ...emptyResult, totalLatencyMs: performance.now() - t0 };
    } finally {
      span.end();
    }
  });
}
