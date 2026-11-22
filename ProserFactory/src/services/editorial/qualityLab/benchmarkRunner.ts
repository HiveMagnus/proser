import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { databaseService } from '@/lib/database';
import { evaluateLiteraryText } from '@/services/literaryEvaluationService';

import { detectRepetition, styleFingerprint } from '../detectors/coreDetectors';
import { changedWordCount } from '../textDiff';
import { textHash } from '../textAnchors';
import { verifyCandidate } from '../editorialVerificationService';
import { EDITORIAL_POLICY_VERSION } from '../editorialPolicy';
import { CandidateGenerator } from '../candidates/candidateGenerator';
import { getEditorialPass } from '../passRegistry';
import { loadBenchmarkBaseline, loadCorpus, loadHiddenExpected } from './corpusLoader';
import { scoreBenchmark, type BenchmarkCaseScore } from './benchmarkScoring';
import { runDocumentBenchmark } from './documentBenchmark';
import { SceneProseService } from '@/services/sceneProseService';
import type { DocumentProposalProviderResult } from '@/documents/proposal-model';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

class BenchmarkRunner {
  private readonly generator = new CandidateGenerator();
  private get db() { return databaseService.client; }

  async run(
    userId: number,
    idempotencyKey: string,
    input: { suiteKey?: string; passKey?: string; live?: boolean; maximumCases?: number },
    operationSignal?: AbortSignal,
  ) {
    operationSignal?.throwIfAborted();
    const request = { suiteKey: input.suiteKey ?? 'editorial-deterministic', passKey: input.passKey ?? 'line_edit_safe', live: Boolean(input.live), maximumCases: input.maximumCases ?? 20 };
    const requestHash = hash(request);
    const existing = await this.db.evaluationRun.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
    if (existing) {
      const prior = existing.config as Record<string, unknown>;
      const priorRequest = { suiteKey: prior.suiteKey ?? 'editorial-deterministic', passKey: prior.passKey ?? 'line_edit_safe', live: Boolean(prior.live), maximumCases: prior.maximumCases ?? 20 };
      if ((prior.requestHash ?? hash(priorRequest)) !== requestHash) throw new Error('EDITORIAL_BENCHMARK_IDEMPOTENCY_CONFLICT');
      return existing;
    }
    const loaded = await loadCorpus();
    const baseline = await loadBenchmarkBaseline();
    if (input.suiteKey && input.suiteKey !== loaded.manifest.suiteKey) throw new Error('EDITORIAL_BENCHMARK_INVALID');
    const maximumCases = input.live ? 5 : 50;
    const cases = loaded.cases.slice(0, Math.min(Math.max(input.maximumCases ?? 20, 1), maximumCases));
    const codeRevision = process.env.APP_REVISION ?? process.env.GIT_REVISION ?? 'development';
    operationSignal?.throwIfAborted();
    const run = await this.db.evaluationRun.create({ data: {
      id: randomUUID(), userId, idempotencyKey, suiteKey: loaded.manifest.suiteKey,
      suiteVersion: loaded.manifest.suiteVersion, status: 'running',
      config: json({ ...request, requestHash, provider: input.live ? 'configured' : 'deterministic-fixture' }),
      codeRevision, schemaRevision: '20260726213458_editorial_engine', startedAt: new Date(),
    } });
    const scores: BenchmarkCaseScore[] = [];
    try {
    for (const item of cases) {
      operationSignal?.throwIfAborted();
      const started = performance.now();
      let candidate = item.input.candidate;
      let liveFailure: string | null = null;
      let provenance: DocumentProposalProviderResult['provenance'] | undefined;
      let producerModel = input.live ? process.env.OLLAMA_MODEL ?? 'configured-model' : 'deterministic-fixture';
      let samplingHash = hash({ deterministic: !input.live });
      let ragHash = hash({ references: item.input.references.length });
      if (input.live) {
        const timeoutMs = Math.min(
          60_000,
          Math.max(5_000, Number.parseInt(process.env.EDITORIAL_LIVE_BENCHMARK_TIMEOUT_MS ?? '45000', 10) || 45_000),
        );
        try {
          const generated = await this.generator.generate({
            original: item.input.original,
            surroundingContext: item.input.references.join('\n').slice(0, 1_500),
            objective: `Improve the passage for the ${input.passKey ?? 'line_edit_safe'} benchmark without changing its facts or voice.`,
            pass: getEditorialPass(input.passKey ?? 'line_edit_safe'),
            protectedElements: item.input.protectedElements,
            maximumEditPercent: 18,
            signal: operationSignal
              ? AbortSignal.any([operationSignal, AbortSignal.timeout(timeoutMs)])
              : AbortSignal.timeout(timeoutMs),
          });
          if (!generated.valid) throw new Error(generated.validationFailures.join(',') || 'invalid_candidate');
          candidate = generated.text;
          provenance = generated.provenance;
          producerModel = provenance?.reportedModel ?? provenance?.configuredModel ?? generated.model ?? producerModel;
          samplingHash = generated.samplingHash;
          ragHash = generated.ragHash;
        } catch (error) {
          // A live-provider failure is evidence, not an unbounded benchmark
          // hang. Retaining the original gives the scorer a conservative,
          // auditable terminal result.
          liveFailure = String(error).slice(0, 500);
          candidate = item.input.original;
        }
      }
      const verification = verifyCandidate({
        original: item.input.original, candidate,
        expectedSourceHash: textHash(item.input.original),
        protectedElements: item.input.protectedElements,
        references: item.input.references, maxChangedPercent: 80,
      });
      const sourceRepetition = detectRepetition(item.input.original).length;
      const candidateRepetition = detectRepetition(candidate).length;
      const sourceStyle = styleFingerprint(item.input.original);
      const candidateStyle = styleFingerprint(candidate);
      const styleDrift = Math.abs(sourceStyle.contractionRate - candidateStyle.contractionRate)
        + Math.abs(sourceStyle.dialogueRatio - candidateStyle.dialogueRatio)
        + Math.abs(sourceStyle.typeTokenRatio - candidateStyle.typeTokenRatio);
      const sourceScore = evaluateLiteraryText(item.input.original).overallScore;
      const candidateScore = evaluateLiteraryText(candidate).overallScore;
      const protectedCountPreserved = item.input.protectedElements.every((element) => {
        const count = (text: string) => text.toLocaleLowerCase().split(element.toLocaleLowerCase()).length - 1;
        return count(candidate) >= count(item.input.original);
      });
      const candidateWins = verification.passed
        && protectedCountPreserved
        && (candidateRepetition < sourceRepetition || candidateScore > sourceScore + 3)
        && styleDrift < 0.12;
      const verdict = candidateWins ? 'candidate_wins' : 'original_wins';
      // Hidden outcomes become visible only here, after generation/evaluation has completed.
      const expected = await loadHiddenExpected(item.id);
      const expectedMatch = verdict === expected.expectedVerdict;
      const hardInvariantCorrect = verification.passed === expected.hardInvariantPass;
      const latencyMs = Math.max(0, Math.round(performance.now() - started));
      const score: BenchmarkCaseScore = {
        verdict, expectedMatch, hardInvariantCorrect,
        expectedOriginal: expected.expectedVerdict === 'original_wins',
        retainedOriginal: verdict === 'original_wins',
        latencyMs, inferenceTokens: provenance?.usage?.totalTokens ?? 0,
        changedWords: candidateWins ? changedWordCount(item.input.original, candidate) : 0,
        escalated: false,
        position: Number.parseInt(hash(item.id).slice(0, 2), 16) % 2 ? 'a' : 'b',
        originalWords: item.input.original.split(/\s+/).length,
        candidateWords: candidate.split(/\s+/).length,
        referenceCopyDetected: item.tags.includes('reference-overlap')
          ? verification.failures.includes('reference_overlap')
          : undefined,
        styleFlatteningDetected: item.tags.includes('style-fingerprint')
          ? verification.failures.includes('style_voice_flattening')
          : undefined,
        voicePreserved: item.tags.includes('voice')
          ? verdict === expected.expectedVerdict
          : undefined,
        nameCollisionDetected: item.tags.includes('name-collision')
          ? verdict === expected.expectedVerdict
          : undefined,
        providerFailed: liveFailure !== null,
        skipReason: candidateWins ? undefined : verification.failures[0] ?? 'original_wins',
      };
      scores.push(score);
      operationSignal?.throwIfAborted();
      await this.db.evaluationCorpusCase.upsert({
        where: { id: item.id },
        create: {
          id: item.id, name: item.input.name, level: item.level,
          suiteKey: item.suiteKey, suiteVersion: item.suiteVersion, caseVersion: item.caseVersion,
          tags: json(item.tags), hidden: false, input: json({ ...item.input, candidate: '[scorer-isolated]' }),
          expected: json({ isolated: true }), invariantRules: json(item.input.protectedElements),
          inputHash: item.inputHash, expectedHash: item.expectedHash, updatedByBuildRevision: codeRevision,
        },
        update: { suiteVersion: item.suiteVersion, caseVersion: item.caseVersion, inputHash: item.inputHash, expectedHash: item.expectedHash, updatedByBuildRevision: codeRevision },
      });
      operationSignal?.throwIfAborted();
      await this.db.evaluationResult.create({ data: {
        id: randomUUID(), evaluationRunId: run.id, caseId: item.id,
        passKey: input.passKey ?? 'line_edit_safe', passVersion: '1.0.0',
        model: producerModel,
        recipeVersion: 'quality-lab-v1', samplingHash,
        ragHash, policyVersion: EDITORIAL_POLICY_VERSION,
        profileVersion: '1.0.0', judgeProfile: 'blind_pairwise_v1',
        verdict, expectedMatch, hardInvariants: json({ passed: verification.passed, correct: hardInvariantCorrect, failures: verification.failures }),
        metrics: json({ sourceScore, candidateScore, sourceRepetition, candidateRepetition, styleDrift, protectedCountPreserved, liveFailure, samplingHash, provenance, sourceHash: textHash(item.input.original), outputHash: textHash(candidate), candidate, providerOutcome: input.live ? liveFailure ? 'unverified' : 'acknowledged' : 'not-started' }),
        latencyMs, inferenceTokens: provenance?.usage?.totalTokens ?? 0,
      } });
    }
    const documentCorpus = await runDocumentBenchmark({ signal: operationSignal, maximumLiveCases: input.live ? Math.max(0, 5 - cases.length) : 0, provider: input.live ? new SceneProseService() : undefined });
    const metrics = scoreBenchmark(scores);
    const baselineComparison = Object.fromEntries(Object.entries(baseline.minimums).map(([key, minimum]) => {
      const actual = Number((metrics as Record<string, unknown>)[key] ?? 0);
      return [key, { minimum, actual, passed: actual >= minimum }];
    }));
    const release = {
      deterministic: !input.live,
      blocking: {
        structuredDocuments: documentCorpus.passed,
        providerOutcomes: !input.live || scores.every((item) => !item.providerFailed),
        hardInvariants: metrics.hardInvariantPassRate === 1,
        originalRetention: metrics.originalRetentionAccuracy === 1,
        expectedMatch: metrics.expectedMatchRate >= 0.8,
        baseline: Object.values(baselineComparison).every((item) => item.passed),
      },
      warnings: input.live && metrics.expectedMatchRate < 0.8 ? ['subjective_live_variance'] : [],
    };
    const report = {
      id: run.id, suiteKey: run.suiteKey, suiteVersion: run.suiteVersion,
      codeRevision, policyVersion: EDITORIAL_POLICY_VERSION, metrics, release, documentCorpus,
      baseline: { suiteKey: baseline.suiteKey, suiteVersion: baseline.suiteVersion, comparison: baselineComparison },
      metadata: {
        provider: input.live ? 'configured' : 'deterministic-fixture',
        caseCount: cases.length,
        structuredCaseCount: documentCorpus.caseCount,
        structuredLiveCalls: documentCorpus.liveCalls,
        maximumLiveCalls: input.live ? 5 : 0,
        databaseSchemaRevision: '20260726213458_editorial_engine',
        promptRecipes: ['quality-lab-v1'],
        sampling: { deterministic: !input.live },
        rag: { fingerprintedReferencesOnly: true },
        judgeProfiles: ['blind_pairwise_v1'],
        latencyUnit: 'milliseconds',
        tokenAccounting: 'provider-reported-or-zero',
        retries: 0,
        failures: scores.filter((item) => !item.expectedMatch).length,
        cacheHits: 0,
        cost: null,
      },
    };
    const reportHash = hash(report);
    operationSignal?.throwIfAborted();
    return this.db.evaluationRun.update({ where: { id: run.id }, data: {
      status: Object.values(release.blocking).every(Boolean) ? 'completed' : 'failed',
      metrics: json(metrics), report: json(report), reportHash, finishedAt: new Date(),
    } });
    } catch (error) {
      // Retain a terminal inspection record. Recovering the same request never
      // invokes an uncertain provider effect again, including after cancellation.
      const interrupted = { id: run.id, suiteKey: run.suiteKey, suiteVersion: run.suiteVersion, codeRevision, status: operationSignal?.aborted ? 'cancelled' : 'failed', partialCaseCount: scores.length, providerReplay: false, errorCode: operationSignal?.aborted ? 'OWNER_OR_DEADLINE_CANCELLED' : 'BENCHMARK_INTERRUPTED' };
      await this.db.evaluationRun.updateMany({ where: { id: run.id, userId, status: 'running' }, data: { status: interrupted.status, report: json(interrupted), reportHash: hash(interrupted), finishedAt: new Date() } });
      throw error;
    }
  }
}

export const benchmarkRunner = new BenchmarkRunner();
