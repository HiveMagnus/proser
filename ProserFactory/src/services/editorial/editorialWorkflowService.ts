import { revisionStyleFingerprints } from './revisionStyleFingerprints';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, WorkflowRun } from '@prisma/client';

import { globalAbortRegistry } from '@/events/abortRegistry';
import { databaseService } from '@/lib/database';
import { manuscriptRevisionService } from '@/services/manuscriptRevisionService';
import {
  assertWorkflowLease,
  currentWorkflowExecution,
  currentWorkflowLease,
  withWorkflowLease,
} from '@/services/workflowExecutionContext';
import { sealSharedResourceOperation } from '@/services/sharedResourceService';

import type {
  EditorialFinding, EditorialOptimizeInput, EditorialRunOutcome, EditorialRunSummary, EditorialSkipReason,
} from './contracts';
import { runCoreDetectors, styleFingerprint } from './detectors/coreDetectors';
import { analyzeNames } from './detectors/nameOriginalityDetector';
import {
  detectCharacterStateContradictions,
  detectPacingAndThemes,
  detectPromisePayoff,
} from './detectors/longRangeDetectors';
import { runContextualCritic } from './critics/contextualCritic';
import {
  applyEditorialPatches,
  EditorialPatchVerificationError,
  type AppliedPatchVerification,
  type EditorialPatch,
} from './editorialApplicationService';
import { EDITORIAL_POLICY_VERSION, decideApplication, resolveBudget } from './editorialPolicy';
import { editorialProfileService } from './editorialProfileService';
import { EditorialProposalService, prepareProposals } from './editorialProposalService';
import { getEditorialPass } from './passRegistry';
import { loadEditorialScope } from './scopeLoader';
import { changedWordCount } from './textDiff';
import { incrementEditorialMetric, observeEditorialDuration } from './metrics';
import { verifyCandidate } from './editorialVerificationService';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const phases = [
  'load_profile', 'load_scope', 'compute_source_fingerprints', 'deterministic_detection',
  'contextual_criticism', 'merge_findings', 'generate_proposals', 'blind_arbitration', 'select_by_policy',
  'verify_result_snapshot', 'persist_result_revision', 'post_persistence_verify',
  'compute_result_fingerprints', 'create_editorial_summary', 'finalize_editorial_run',
] as const;

type TerminalProposalOutcome = 'candidate_wins' | 'original_wins' | 'no_clear_winner' | 'policy_skip';

export function normalizeTerminalProposalOutcome(
  applied: boolean,
  skipReason: EditorialSkipReason | undefined,
  verdict: 'candidate_wins' | 'original_wins' | 'no_clear_winner' | 'invalid_comparison',
): TerminalProposalOutcome {
  if (applied) return 'candidate_wins';
  if (skipReason === 'original_wins' || verdict === 'original_wins') return 'original_wins';
  if (verdict === 'no_clear_winner') return 'no_clear_winner';
  return 'policy_skip';
}

class EditorialWorkflowService {
  private readonly proposals = new EditorialProposalService();
  private get db() { return databaseService.client; }

  private async event(runId: string, eventType: string, data: Record<string, unknown> = {}) {
    await withWorkflowLease(runId, async (tx) => {
      await tx.workflowEvent.create({ data: { runId, eventType, data: json(data) } });
    });
  }

  private async artifact(runId: string, type: string, payload: unknown, sourceRevisionId: string, resultRevisionId?: string) {
    const id = randomUUID();
    await withWorkflowLease(runId, async (tx) => {
      await tx.workflowArtifact.create({ data: {
        id, runId, artifactType: type, scopeType: 'editorial', contentHash: hash(payload),
        sourceRevisionId, resultRevisionId, payload: json(payload),
      } });
    });
    return id;
  }

  private async task(run: WorkflowRun, phase: typeof phases[number], action: () => Promise<void>) {
    await assertWorkflowLease(run.id);
    const owner = currentWorkflowLease()?.leaseOwner;
    if (!owner) throw new Error(`Workflow lease context missing for ${run.id}`);
    const taskKey = `editorial:${phase}`;
    const existing = await this.db.workflowTask.findUnique({ where: { runId_taskKey: { runId: run.id, taskKey } } });
    if (existing?.status === 'completed') return;
    await withWorkflowLease(run.id, async (tx) => {
      await tx.workflowTask.upsert({
        where: { runId_taskKey: { runId: run.id, taskKey } },
        create: {
          id: randomUUID(), runId: run.id, taskKey, taskType: phase, phase,
          scopeType: 'book', scopeId: String(run.bookId), ordinal: phases.indexOf(phase) + 1,
          dependencies: json(phases.slice(0, phases.indexOf(phase)).slice(-1)), status: 'running',
          attemptCount: 1, leaseOwner: owner, startedAt: new Date(), inputRevisionId: run.sourceRevisionId,
        },
        update: { status: 'running', attemptCount: { increment: 1 }, leaseOwner: owner, startedAt: new Date(), errorCode: null, errorMessage: null },
      });
      await tx.workflowRun.update({
        where: { id: run.id },
        data: { phase, progress: json({ phase, completed: phases.indexOf(phase), total: phases.length, percent: Math.round(phases.indexOf(phase) / phases.length * 100) }) },
      });
    });
    try {
      await action();
      const state = await this.db.workflowRun.findFirst({
        where: { id: run.id, leaseOwner: owner },
        select: { status: true },
      });
      if (state?.status === 'completed' && phase === 'finalize_editorial_run') return;
      await withWorkflowLease(run.id, async (tx) => {
        const completed = await tx.workflowTask.updateMany({
          where: { runId: run.id, taskKey, status: 'running', leaseOwner: owner },
          data: { status: 'completed', finishedAt: new Date(), outputRevisionId: run.resultRevisionId },
        });
        if (completed.count !== 1) throw new Error(`Workflow task lease lost for ${taskKey}`);
      });
    } catch (error) {
      await withWorkflowLease(run.id, async (tx) => {
        await tx.workflowTask.updateMany({
          where: { runId: run.id, taskKey, status: 'running', leaseOwner: owner },
          data: { status: 'failed', finishedAt: new Date(), errorCode: 'EDITORIAL_TASK_FAILED', errorMessage: String(error).slice(0, 2_000) },
        });
      }).catch(() => undefined);
      throw error;
    }
  }

  async process(run: WorkflowRun): Promise<void> {
    const editorialStartedAt = performance.now();
    await assertWorkflowLease(run.id);
    await withWorkflowLease(run.id, async () => {
      await incrementEditorialMetric('runs_started');
    });
    if (run.workflowType !== 'editorial_optimize') throw new Error('Invalid editorial workflow type');
    if (!run.sourceRevisionId) throw new Error('Editorial workflow requires an exact source revision');
    const input = run.settings as unknown as EditorialOptimizeInput;
    const editorial = await this.db.editorialRun.findUnique({ where: { workflowRunId: run.id } });
    if (!editorial) throw new Error('Editorial run record missing');
    if (editorial.status === 'completed') return;

    const current = await manuscriptRevisionService.currentAncestry(run.bookId);
    if (current.current !== run.sourceRevisionId) {
      const currentRevision = current.current ? await this.db.manuscriptRevision.findUnique({ where: { id: current.current }, select: { workflowRunId: true } }) : null;
      if (currentRevision?.workflowRunId === run.id) {
        await this.reconcilePersistedRun(run, editorial.id, current.current!);
        return;
      }
      await this.finalizeSuperseded(run, editorial.id);
      return;
    }

    // A delivery can be recovered after any pre-persistence phase. Rebuild that
    // attempt from the immutable source revision instead of trusting ephemeral
    // arrays from the previous worker process. Prior events/artifacts remain as
    // an audit trail; proposal children are safe to replace until a result
    // revision exists.
    await withWorkflowLease(run.id, async (tx) => {
      await tx.editorialProposal.deleteMany({ where: { editorialRunId: editorial.id } });
      await tx.workflowTask.updateMany({
        where: { runId: run.id, taskKey: { not: 'editorial_optimize:root' } },
        data: {
          status: 'pending', finishedAt: null, outputRevisionId: null,
          errorCode: null, errorMessage: null,
        },
      });
    });

    const pass = getEditorialPass(input.passPack);
    const budget = resolveBudget(input.autonomy, input.changeBudget);
    let profile = await editorialProfileService.resolve(run.userId, run.bookId, input.profileId);
    let scenes = (await loadEditorialScope({ userId: run.userId, bookId: run.bookId, scope: input.scope })).scenes;
    let scopeMap: Record<string, unknown> = {};
    const sourceRevision = await this.db.manuscriptRevision.findUniqueOrThrow({ where: { id: run.sourceRevisionId } });
    const sourceSnapshot = await manuscriptRevisionService.snapshotRevision(run.bookId, sourceRevision.id);
    const sourceByScene = new Map(sourceSnapshot.scenes.map((scene) => [scene.id, scene.prose]));
    scenes = scenes.map((scene) => ({ ...scene, prose: sourceByScene.get(scene.id) ?? scene.prose }));
    let findings: EditorialFinding[] = [];
    let prepared = [] as ReturnType<typeof prepareProposals>;
    const selected: Array<{ proposalId: string; candidateId: string; detectorIds: string[]; patch: EditorialPatch }> = [];
    let originalWins = 0;
    let noClearWinner = 0;
    let skipped = 0;
    let verificationFailed = 0;
    let resultRevisionId: string | null = null;
    let changedWords = 0;
    let summaryArtifactId: string | null = null;
    let verificationArtifactId: string | null = null;
    let releaseEvidenceArtifactId: string | null = null;
    const verificationResults = (rows: AppliedPatchVerification[]) => rows
      .sort((left, right) => left.patchIndex - right.patchIndex)
      .map(({ patchIndex, sceneId, result }) => ({
        proposalId: selected[patchIndex].proposalId,
        candidateId: selected[patchIndex].candidateId,
        sceneId,
        detectorIds: selected[patchIndex].detectorIds,
        verificationVersion: 'editorial-verification-v1',
        passed: result.passed,
        failures: result.failures,
        warnings: result.warnings,
        sourceHash: result.sourceHash,
        candidateHash: result.candidateHash,
        changedPercent: result.changedPercent,
        referenceOverlap: result.referenceOverlap,
        styleDrift: result.styleDrift,
      }));

    await withWorkflowLease(run.id, async (tx) => {
      await tx.editorialRun.update({ where: { id: editorial.id }, data: {
        status: 'running', startedAt: editorial.startedAt ?? new Date(),
        requestConfig: json({ ...input, changeBudget: budget }),
      } });
    });
    await this.event(run.id, 'editorial_run_prepared', { editorialRunId: editorial.id, pass: pass.key, passVersion: pass.version, autonomy: input.autonomy });

    await this.task(run, 'load_profile', async () => {
      profile = await editorialProfileService.resolve(run.userId, run.bookId, input.profileId);
      await this.db.editorialRun.update({ where: { id: editorial.id }, data: { profileId: profile.id, profileVersion: profile.version, profileHash: profile.hash } });
      await this.artifact(run.id, 'editorial_resolved_profile', { id: profile.id, version: profile.version, hash: profile.hash, name: profile.name, config: profile.config, preferenceSummary: profile.preferenceSummary }, run.sourceRevisionId!);
    });
    await this.task(run, 'load_scope', async () => {
      const loaded = await loadEditorialScope({ userId: run.userId, bookId: run.bookId, scope: input.scope });
      scopeMap = loaded.scopeMap;
      await this.artifact(run.id, 'editorial_scope_map', scopeMap, run.sourceRevisionId!);
      await this.event(run.id, 'editorial_scope_loaded', { editorialRunId: editorial.id, sceneCount: scenes.length, scope: input.scope });
    });
    await this.task(run, 'compute_source_fingerprints', async () => {
      const rows = scenes.map((scene) => ({ sceneId: scene.id, fingerprint: styleFingerprint(scene.prose) }));
      for (const row of rows) await this.db.styleFingerprint.upsert({
        where: { id: hash([run.sourceRevisionId, 'scene', row.sceneId, 'style-fingerprint-v1']).slice(0, 36) },
        create: {
          id: hash([run.sourceRevisionId, 'scene', row.sceneId, 'style-fingerprint-v1']).slice(0, 36),
          bookId: run.bookId, revisionId: run.sourceRevisionId!, scopeType: 'scene', scopeId: row.sceneId,
          fingerprintVersion: 'style-fingerprint-v1', metrics: json(row.fingerprint), vectorHash: hash(row.fingerprint),
        },
        update: {},
      });
      await this.artifact(run.id, 'editorial_style_fingerprints', { version: 'style-fingerprint-v1', scopes: rows.map((row) => ({ sceneId: row.sceneId, hash: hash(row.fingerprint) })) }, run.sourceRevisionId!);
    });
    await this.task(run, 'deterministic_detection', async () => {
      const metrics: Array<{ sceneId: number; metrics: Record<string, unknown> }> = [];
      findings = scenes.flatMap((scene) => {
        const result = runCoreDetectors(scene.prose, pass.detectorKeys);
        metrics.push({ sceneId: scene.id, metrics: result.metrics });
        return result.findings.map((item) => ({ ...item, sceneId: scene.id }));
      }).slice(0, budget.maxProposals * 3);
      const longRangeScenes = scenes.map((scene, order) => ({
        id: scene.id,
        order,
        words: scene.prose.split(/\s+/).filter(Boolean).length,
        summary: scene.summary,
        outline: scene.outline,
      }));
      if (pass.detectorKeys.some((key) => ['continuity_v1', 'character_arc_v1', 'promise_payoff_v1', 'pacing_v1'].includes(key))) {
        const [states, ledgers, events] = await Promise.all([
          this.db.characterState.findMany({
            where: { bookId: run.bookId, sceneId: { in: scenes.map((scene) => scene.id) } },
            orderBy: [{ sceneId: 'asc' }, { stateKey: 'asc' }],
          }),
          this.db.narrativeLedger.findMany({
            where: { bookId: run.bookId, ledgerType: { in: ['promise', 'question', 'motif', 'time'] }, status: { not: 'superseded' } },
            take: 200,
          }),
          this.db.sceneMemoryEvent.findMany({
            where: { bookId: run.bookId, sceneId: { in: scenes.map((scene) => scene.id) } },
            select: { sceneId: true, eventType: true },
          }),
        ]);
        const codex = await this.db.codexEntry.findMany({
          where: { bookId: run.bookId, id: { in: [...new Set(states.map((item) => item.codexId))] } },
          select: { id: true, entryName: true },
        });
        const nameById = new Map(codex.map((item) => [item.id, item.entryName]));
        const orderByScene = new Map(scenes.map((scene, order) => [scene.id, order]));
        findings.push(...detectCharacterStateContradictions(states.map((item) => ({
          character: nameById.get(item.codexId) ?? `character:${item.codexId}`,
          sceneId: item.sceneId,
          order: orderByScene.get(item.sceneId) ?? item.sceneId,
          stateKey: item.stateKey,
          stateValue: item.stateValue,
        }))));
        findings.push(...detectPromisePayoff(ledgers.map((item) => ({
          key: item.ledgerKey,
          setupSceneId: item.introducedSceneId ?? undefined,
          payoffSceneId: item.resolvedSceneId ?? undefined,
          dueOrder: item.dueSceneId ? orderByScene.get(item.dueSceneId) : undefined,
          resolved: item.status === 'resolved',
        })), scenes.length - 1));
        const eventCounts = new Map<number, number>();
        for (const event of events) eventCounts.set(event.sceneId, (eventCounts.get(event.sceneId) ?? 0) + 1);
        findings.push(...detectPacingAndThemes(longRangeScenes.map((scene) => ({ ...scene, eventCount: eventCounts.get(scene.id) ?? 0 }))));
      }
      if (pass.detectorKeys.includes('name_originality_v1')) {
        const [local, other] = await Promise.all([
          this.db.codexEntry.findMany({ where: { bookId: run.bookId, deletedAt: null, entryType: { in: ['character', 'person'] } }, select: { entryName: true } }),
          this.db.codexEntry.findMany({ where: { book: { userId: run.userId, deletedAt: null, id: { not: run.bookId } }, deletedAt: null, entryType: { in: ['character', 'person'] } }, select: { entryName: true }, take: 500 }),
        ]);
        findings.push(...analyzeNames({
          names: local.map((item) => ({ name: item.entryName })),
          crossBookNames: other.map((item) => item.entryName),
          clicheNames: (profile.config.clicheNames as string[] | undefined) ?? [],
        }));
      }
      findings = findings.slice(0, budget.maxProposals * 3);
      await this.artifact(run.id, 'editorial_deterministic_metrics', { metrics }, run.sourceRevisionId!);
      await this.event(run.id, 'editorial_detector_completed', { findingCount: findings.length, sceneCount: scenes.length });
    });
    await this.task(run, 'contextual_criticism', async () => {
      const criticFindings: EditorialFinding[] = [];
      const failures: Array<{ profile: string; sceneId: number; reason: string }> = [];
      for (const scene of scenes) for (const criticKey of pass.criticKeys) {
        try {
          const result = runContextualCritic({
            profile: criticKey as Parameters<typeof runContextualCritic>[0]['profile'],
            scopeId: scene.id,
            proseExcerpt: scene.prose.slice(0, 4_000),
            contextMap: { outline: scene.outline, summary: scene.summary, profileHash: profile.hash },
            protectedElements: input.protectedElements ?? [],
            maximumFindings: 5,
            inputHash: hash([scene.id, criticKey, scene.prose, profile.hash]),
          });
          criticFindings.push(...result.findings);
        } catch (error) {
          failures.push({ profile: criticKey, sceneId: scene.id, reason: String(error).slice(0, 200) });
        }
      }
      findings.push(...criticFindings);
      await this.artifact(run.id, 'editorial_critic_summary', {
        critics: pass.criticKeys,
        findingCount: criticFindings.length,
        optionalFailures: failures,
      }, run.sourceRevisionId!);
      await this.event(run.id, 'editorial_critic_completed', { findingCount: criticFindings.length, optionalFailures: failures.length });
    });
    await this.task(run, 'merge_findings', async () => {
      const seen = new Set<string>();
      findings = findings.filter((item) => {
        const key = hash([item.sceneId, item.category, item.evidence[0]?.start, item.evidence[0]?.text]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await this.artifact(run.id, 'editorial_findings_summary', {
        count: findings.length,
        categories: Object.fromEntries([...new Set(findings.map((item) => item.category))].map((category) => [category, findings.filter((item) => item.category === category).length])),
        findings: findings.slice(0, 100).map((item) => ({ id: item.id, sceneId: item.sceneId, category: item.category, confidence: item.confidence, risk: item.risk, evidence: item.evidence.slice(0, 2) })),
      }, run.sourceRevisionId!);
    });

    if (input.autonomy !== 'review_only') {
      await this.task(run, 'generate_proposals', async () => {
        prepared = prepareProposals(scenes, findings, budget.maxProposals);
        await this.artifact(run.id, 'editorial_proposal_manifest', { count: prepared.length, ids: prepared.map((item) => item.id) }, run.sourceRevisionId!);
      });
      await this.task(run, 'blind_arbitration', async () => {
        for (const proposal of prepared) {
          if (globalAbortRegistry.get(run.id)?.aborted) throw new Error('Workflow cancelled');
          const scene = scenes.find((item) => item.id === proposal.sceneId)!;
          try {
            const evaluated = await this.proposals.createAndEvaluate({
              workflowRunId: run.id,
              editorialRunId: editorial.id, bookId: run.bookId, sourceRevisionId: run.sourceRevisionId!,
              pass, proposal,
              objective: input.objective ?? pass.description,
              context: `${scene.outline ?? ''}\n${scene.prose.slice(Math.max(0, proposal.startOffset - 750), Math.min(scene.prose.length, proposal.endOffset + 750))}`,
              protectedElements: [...new Set([...(input.protectedElements ?? []), ...((profile.config.protectedElements as string[] | undefined) ?? [])])],
              generatorModel: input.modelPolicy?.generator,
              maximumEditPercent: budget.maxChangedWordsPercentPerScene,
              autonomy: input.autonomy,
              maximumJudgeEscalations: budget.maxJudgeEscalations,
              minimumConfidence: input.acceptancePolicy?.minimumConfidence ?? 0.78,
              minimumPreferenceMargin: input.acceptancePolicy?.minimumPreferenceMargin ?? 0.15,
              signal: globalAbortRegistry.get(run.id),
            });
            const candidate = await this.db.editorialCandidate.findUniqueOrThrow({ where: { id: evaluated.candidateId } });
            const decision = decideApplication({
              autonomy: input.autonomy,
              risk: evaluated.evaluation.risk,
              confidence: evaluated.evaluation.result.confidence,
              preferenceMargin: evaluated.evaluation.result.preferenceMargin,
              hardInvariantsPassed: evaluated.evaluation.result.invariantConcerns.length === 0,
              withinBudget: true,
              materialImprovement: evaluated.evaluation.result.verdict === 'candidate_wins',
              judgesAgree: evaluated.evaluation.judgesAgree ?? evaluated.evaluation.result.verdict === 'candidate_wins',
              sourceCurrent: true, sourceMatches: true,
              maximumRisk: input.acceptancePolicy?.maximumRisk,
            });
            if (decision.apply) {
              selected.push({
                proposalId: proposal.id,
                candidateId: evaluated.candidateId,
                detectorIds: [`${proposal.finding.detectorKey}@${proposal.finding.detectorVersion}`],
                patch: {
                  sceneId: proposal.sceneId, originalText: proposal.originalText, candidateText: candidate.outputText,
                  sourceHash: proposal.sourceHash, startOffset: proposal.startOffset, endOffset: proposal.endOffset,
                  beforeAnchor: proposal.beforeAnchor, afterAnchor: proposal.afterAnchor,
                  protectedElements: input.protectedElements, maxChangedPercent: budget.maxChangedWordsPercentPerScene,
                  allowNewNames: pass.key === 'name_originality',
                },
              });
              await this.event(run.id, 'editorial_proposal_selected', { proposalId: proposal.id, sceneId: proposal.sceneId });
            } else {
              skipped += 1;
              const terminalOutcome = normalizeTerminalProposalOutcome(
                false,
                decision.skipReason,
                evaluated.evaluation.result.verdict,
              );
              if (terminalOutcome === 'original_wins') originalWins += 1;
              if (terminalOutcome === 'no_clear_winner') noClearWinner += 1;
              await withWorkflowLease(run.id, async (tx) => {
                await tx.editorialProposal.update({ where: { id: proposal.id }, data: { status: 'skipped', skipReason: decision.skipReason ?? evaluated.evaluation.result.verdict } });
              });
              await this.event(run.id, 'editorial_proposal_skipped', {
                proposalId: proposal.id,
                reason: decision.skipReason ?? evaluated.evaluation.result.verdict,
                terminalOutcome,
              });
            }
          } catch (error) {
            skipped += 1;
            await withWorkflowLease(run.id, async (tx) => {
              await tx.editorialProposal.updateMany({ where: { id: proposal.id }, data: { status: 'skipped', skipReason: 'optional_pass_failed' } });
            });
            await this.event(run.id, 'editorial_optional_pass_failed', { proposalId: proposal.id, reason: String(error).slice(0, 300) });
          }
        }
        await this.artifact(run.id, 'editorial_evaluation_manifest', { proposals: prepared.length, selected: selected.length, originalWins, noClearWinner, skipped }, run.sourceRevisionId!);
      });
      await this.task(run, 'select_by_policy', async () => {
        const totalSourceWords = scenes.reduce((sum, scene) => sum + scene.prose.split(/\s+/).filter(Boolean).length, 0);
        const requestedWords = selected.reduce((sum, item) => sum + changedWordCount(item.patch.originalText, item.patch.candidateText), 0);
        if (requestedWords / Math.max(1, totalSourceWords) * 100 > budget.maxChangedWordsPercentTotal) {
          for (const item of selected.splice(0)) {
            skipped += 1;
            await withWorkflowLease(run.id, async (tx) => {
              await tx.editorialProposal.update({ where: { id: item.proposalId }, data: { status: 'skipped', skipReason: 'change_budget_exceeded' } });
            });
          }
        }
        await this.artifact(run.id, 'editorial_policy_results', { policyVersion: EDITORIAL_POLICY_VERSION, selected: selected.map((item) => item.proposalId), skipped }, run.sourceRevisionId!);
      });
    }

    await this.task(run, 'verify_result_snapshot', async () => {
      await this.artifact(run.id, 'editorial_verification_plan', {
        selected: selected.length,
        verificationVersion: 'editorial-verification-v1',
        status: 'pending_persistence_checks',
        detectorIds: [...new Set(selected.flatMap((item) => item.detectorIds))],
      }, run.sourceRevisionId!);
      await this.event(run.id, 'editorial_result_snapshot_prepared', { selected: selected.length });
    });
    let supersededByRevisionId: string | null = null;
    await this.task(run, 'persist_result_revision', async () => {
      if (input.autonomy === 'review_only' || input.autonomy === 'propose_only' || !selected.length) {
        const evidence = {
          verificationVersion: 'editorial-verification-v1',
          checksPerformed: 0,
          selected: selected.length,
          passed: true,
          results: [],
        };
        verificationArtifactId = await this.artifact(
          run.id,
          'editorial_verification',
          evidence,
          run.sourceRevisionId!,
        );
        return;
      }
      try {
        const applied = await applyEditorialPatches({
          userId: run.userId, bookId: run.bookId, expectedRevisionId: run.sourceRevisionId!,
          workflowRunId: run.id, patches: selected.map((item) => item.patch),
        });
        resultRevisionId = applied.revisionId;
        changedWords = selected.reduce((sum, item) => sum + changedWordCount(item.patch.originalText, item.patch.candidateText), 0);
        const results = verificationResults(applied.verification);
        const evidence = {
          verificationVersion: 'editorial-verification-v1',
          checksPerformed: results.length,
          selected: selected.length,
          passed: results.every((item) => item.passed),
          detectorIds: [...new Set(results.flatMap((item) => item.detectorIds))],
          results,
        };
        verificationArtifactId = randomUUID();
        await withWorkflowLease(run.id, async (tx, leaseOwner) => {
          await tx.workflowArtifact.create({ data: {
            id: verificationArtifactId!,
            runId: run.id,
            artifactType: 'editorial_verification',
            scopeType: 'editorial',
            contentHash: hash(evidence),
            sourceRevisionId: run.sourceRevisionId,
            resultRevisionId,
            payload: json(evidence),
          } });
          for (const item of results) await tx.editorialProposal.update({
            where: { id: item.proposalId },
            data: {
              status: 'applied',
              autoApplied: true,
              appliedRevisionId: resultRevisionId,
              verificationStatus: 'passed',
              verificationEvidence: json({
                artifactId: verificationArtifactId,
                ...item,
              }),
            },
          });
          const workflowUpdated = await tx.workflowRun.updateMany({
            where: { id: run.id, leaseOwner },
            data: { resultRevisionId },
          });
          if (workflowUpdated.count !== 1) throw new Error(`Workflow lease lost for ${run.id}`);
          await tx.editorialRun.update({ where: { id: editorial.id }, data: { resultRevisionId } });
          await tx.workflowEvent.create({
            data: {
              runId: run.id,
              eventType: 'editorial_revision_persisted',
              data: json({
                resultRevisionId,
                applied: selected.length,
                verificationArtifactId,
              }),
            },
          });
        });
      } catch (error) {
        if (error instanceof EditorialPatchVerificationError) {
          const results = verificationResults(error.verification);
          const evidence = {
            verificationVersion: 'editorial-verification-v1',
            checksPerformed: results.length,
            selected: selected.length,
            passed: false,
            detectorIds: [...new Set(results.flatMap((item) => item.detectorIds))],
            failures: [...new Set(results.flatMap((item) => item.failures))],
            results,
          };
          verificationArtifactId = randomUUID();
          await withWorkflowLease(run.id, async (tx) => {
            await tx.workflowArtifact.create({ data: {
              id: verificationArtifactId!,
              runId: run.id,
              artifactType: 'editorial_verification',
              scopeType: 'editorial',
              contentHash: hash(evidence),
              sourceRevisionId: run.sourceRevisionId,
              payload: json(evidence),
            } });
            for (const item of results) await tx.editorialProposal.update({
              where: { id: item.proposalId },
              data: {
                status: 'verified_failed',
                verificationStatus: 'failed',
                skipReason: 'verification_failed',
                verificationEvidence: json({
                  artifactId: verificationArtifactId,
                  ...item,
                }),
              },
            });
            await tx.workflowEvent.create({
              data: {
                runId: run.id,
                eventType: 'editorial_verification_failed',
                data: json({
                  verificationArtifactId,
                  failures: evidence.failures,
                }),
              },
            });
          });
          verificationFailed += selected.length;
          skipped += selected.length;
          selected.splice(0);
          changedWords = 0;
          return;
        }
        if (/SOURCE_STALE|PROPOSAL_STALE/.test(String(error))) {
          supersededByRevisionId = (await manuscriptRevisionService.currentAncestry(run.bookId)).current;
          return;
        }
        throw error;
      }
    });
    if (supersededByRevisionId) {
      await this.finalizeSuperseded(run, editorial.id, {
        currentRevisionId: supersededByRevisionId,
        resultRevisionId,
        reason: 'source_revision_stale',
      });
      return;
    }
    const afterPersistence = await this.db.editorialRun.findUniqueOrThrow({
      where: { id: editorial.id },
      select: { status: true, outcome: true },
    });
    if (afterPersistence.status === 'completed' && afterPersistence.outcome === 'superseded_by_new_revision') return;
    await this.task(run, 'post_persistence_verify', async () => {
      if (!resultRevisionId) return;
      const revision = await this.db.manuscriptRevision.findUniqueOrThrow({ where: { id: resultRevisionId } });
      const headBeforeVerification = (await manuscriptRevisionService.currentAncestry(run.bookId)).current;
      if (headBeforeVerification !== resultRevisionId) {
        supersededByRevisionId = headBeforeVerification;
        return;
      }
      const snapshot = await manuscriptRevisionService.snapshot(run.bookId);
      if (snapshot.contentHash !== revision.contentHash) {
        const corruptRevisionId = resultRevisionId;
        const rollbackRevisionId = await manuscriptRevisionService.restoreIfCurrent({
          bookId: run.bookId,
          revisionId: run.sourceRevisionId!,
          expectedCurrentRevisionId: corruptRevisionId,
          workflowRunId: run.id,
        });
        if (!rollbackRevisionId) {
          supersededByRevisionId = (await manuscriptRevisionService.currentAncestry(run.bookId)).current;
          return;
        }
        verificationFailed += selected.length;
        await withWorkflowLease(run.id, async (tx) => {
          await tx.editorialProposal.updateMany({
            where: { id: { in: selected.map((item) => item.proposalId) } },
            data: { status: 'verified_failed', verificationStatus: 'failed', skipReason: 'verification_failed' },
          });
        });
        selected.splice(0);
        changedWords = 0;
        resultRevisionId = rollbackRevisionId;
        await withWorkflowLease(run.id, async (tx, leaseOwner) => {
          const workflowUpdated = await tx.workflowRun.updateMany({
            where: { id: run.id, leaseOwner },
            data: { resultRevisionId: rollbackRevisionId },
          });
          if (workflowUpdated.count !== 1) throw new Error(`Workflow lease lost for ${run.id}`);
          await tx.editorialRun.update({ where: { id: editorial.id }, data: { resultRevisionId: rollbackRevisionId } });
        });
        await this.event(run.id, 'editorial_automatic_rollback_completed', {
          corruptRevisionId,
          rollbackRevisionId,
          sourceRevisionId: run.sourceRevisionId,
        });
        return;
      }
      await this.event(run.id, 'editorial_post_verification_completed', { resultRevisionId, passed: true });
    });
    if (supersededByRevisionId) {
      await this.finalizeSuperseded(run, editorial.id, {
        currentRevisionId: supersededByRevisionId,
        resultRevisionId,
        reason: 'newer_revision_after_editorial_persistence',
      });
      return;
    }
    await this.task(run, 'compute_result_fingerprints', async () => {
      if (!resultRevisionId) return;
      const resultFingerprints = await revisionStyleFingerprints(run.bookId, resultRevisionId, scenes.filter((scene) => selected.some((proposal) => proposal.patch.sceneId === scene.id)).map((scene) => scene.id));
      for (const { sceneId, fingerprint } of resultFingerprints) {
        await this.db.styleFingerprint.create({ data: {
          id: randomUUID(), bookId: run.bookId, revisionId: resultRevisionId,
          scopeType: 'scene', scopeId: sceneId, fingerprintVersion: 'style-fingerprint-v1',
          metrics: json(fingerprint), vectorHash: hash(fingerprint),
        } });
      }
    });

    let summary!: EditorialRunSummary;
    await this.task(run, 'create_editorial_summary', async () => {
      const outcome: EditorialRunOutcome = input.autonomy === 'review_only' ? 'completed_review_only'
        : input.autonomy === 'propose_only' ? 'completed_proposals_only'
          : selected.length ? (skipped ? 'completed_with_skips' : 'completed_with_changes')
            : skipped ? 'completed_with_skips' : 'completed_no_changes';
      const totalWords = scenes.reduce((sum, scene) => sum + scene.prose.split(/\s+/).filter(Boolean).length, 0);
      const categories = [...new Set(findings.map((item) => item.category))];
      summary = {
        runId: run.id, workflowType: 'editorial_optimize', status: 'completed', outcome,
        bookId: run.bookId, scope: input.scope, sourceRevisionId: run.sourceRevisionId!,
        resultRevisionId, passPack: { key: pass.key, version: pass.version }, policyVersion: EDITORIAL_POLICY_VERSION,
        profile: { id: profile.id, version: profile.version, hash: profile.hash },
        counts: {
          scopesReviewed: scenes.length, findingsCreated: findings.length, proposalsGenerated: prepared.length,
          proposalsApplied: selected.length, originalWins, noClearWinner, skipped,
          verificationPassed: selected.length, verificationFailed,
        },
        change: { changedWords, changedWordsPercent: Math.round(changedWords / Math.max(1, totalWords) * 10_000) / 100 },
        quality: { hardInvariantsPassed: verificationFailed === 0, judgeAgreementRate: prepared.length ? Math.round((prepared.length - noClearWinner) / prepared.length * 100) / 100 : 1, styleDriftWithinProfile: true },
        unresolved: { count: findings.length - selected.length, topCategories: categories.slice(0, 5) },
        artifactIds: { summary: null, verification: verificationArtifactId, releaseEvidence: null },
        retry: { safeToRepeat: true, useSameIdempotencyKey: true },
      };
      releaseEvidenceArtifactId = await this.artifact(run.id, 'editorial_release_evidence', { hardInvariantsPassed: summary.quality.hardInvariantsPassed, sourceRevisionId: run.sourceRevisionId, resultRevisionId, noCheckpointPolicy: true, policyVersion: EDITORIAL_POLICY_VERSION }, run.sourceRevisionId!, resultRevisionId ?? undefined);
      summary.artifactIds.releaseEvidence = releaseEvidenceArtifactId;
      summaryArtifactId = await this.artifact(run.id, 'editorial_run_summary', summary, run.sourceRevisionId!, resultRevisionId ?? undefined);
      summary.artifactIds.summary = summaryArtifactId;
      await withWorkflowLease(run.id, async (tx) => {
        await tx.editorialRun.update({ where: { id: editorial.id }, data: { outcome, metrics: json(summary.change), evidenceSummary: json(summary) } });
      });
    });
    await this.task(run, 'finalize_editorial_run', async () => {
      const checkpointCount = await this.db.workflowCheckpoint.count({ where: { runId: run.id } });
      if (checkpointCount) throw new Error('Editorial workflow created a forbidden checkpoint');
      const now = new Date();
      await withWorkflowLease(run.id, async (tx, leaseOwner) => {
        await tx.editorialRun.update({ where: { id: editorial.id }, data: { status: 'completed', finishedAt: now } });
        await tx.workflowEvent.create({
          data: {
            runId: run.id,
            eventType: 'editorial_run_completed',
            data: json({ outcome: summary.outcome, applied: selected.length, skipped, summaryArtifactId }),
          },
        });
        const workflowUpdated = await tx.workflowRun.updateMany({ where: { id: run.id, leaseOwner }, data: {
          status: 'completed', phase: 'completed', resultRevisionId, finishedAt: now,
          progress: json({ phase: 'completed', completed: phases.length, total: phases.length, percent: 100, outcome: summary.outcome }),
        } });
        if (workflowUpdated.count !== 1) throw new Error(`Workflow lease lost for ${run.id}`);
        await tx.workflowTask.updateMany({
          where: { runId: run.id, taskKey: 'editorial_optimize:root', leaseOwner },
          data: { status: 'completed', phase: 'completed', finishedAt: now, outputRevisionId: resultRevisionId },
        });
        const sharedOperationId = currentWorkflowExecution()?.sharedResourceOperationId;
        if (sharedOperationId) {
          await sealSharedResourceOperation(sharedOperationId, 'succeeded', 200, { success: true, data: {
            runId: run.id, bookId: run.bookId, status: 'completed', resultRevisionId,
            outcome: summary.outcome,
          } }, now, tx);
        }
        await tx.workflowTask.updateMany({
          where: { runId: run.id, taskKey: 'editorial:finalize_editorial_run', leaseOwner },
          data: { status: 'completed', phase: 'completed', finishedAt: now, outputRevisionId: resultRevisionId },
        });
        // Publish counters while the same database transaction still owns the
        // workflow lease. PostgreSQL serializes a competing ownership update
        // until this transaction commits, so a stale worker cannot emit terminal
        // metrics after ownership changes.
        await Promise.all([
          incrementEditorialMetric('runs_completed'),
          incrementEditorialMetric(`outcome_${summary.outcome}`),
          incrementEditorialMetric('proposals_applied', selected.length),
          incrementEditorialMetric('proposals_skipped', skipped),
          observeEditorialDuration('run_total', performance.now() - editorialStartedAt),
        ]);
      });
    });
  }

  private async reconcilePersistedRun(run: WorkflowRun, editorialRunId: string, resultRevisionId: string) {
    let proposals = await this.db.editorialProposal.count({ where: { editorialRunId, autoApplied: true } });
    const verificationArtifacts = await this.db.workflowArtifact.count({
      where: { runId: run.id, artifactType: 'editorial_verification', resultRevisionId },
    });
    if (!verificationArtifacts) {
      const editorial = await this.db.editorialRun.findUniqueOrThrow({
        where: { id: editorialRunId },
        select: { requestConfig: true },
      });
      const requestConfig = editorial.requestConfig as unknown as {
        changeBudget?: { maxChangedWordsPercentPerScene?: number };
      };
      const recovered = await this.db.editorialProposal.findMany({
        where: { editorialRunId, status: 'pending' },
        include: {
          candidates: {
            where: { candidateType: 'generated' },
            take: 1,
          },
        },
      });
      const results = recovered.map((proposal) => {
        const candidate = proposal.candidates[0];
        if (!candidate) throw new Error(`Recovered editorial proposal ${proposal.id} has no generated candidate`);
        const result = verifyCandidate({
          original: proposal.originalText,
          candidate: candidate.outputText,
          expectedSourceHash: proposal.sourceHash,
          protectedElements: proposal.protectedClaims as string[],
          maxChangedPercent: requestConfig.changeBudget?.maxChangedWordsPercentPerScene ?? 18,
          allowNewNames: proposal.passKey === 'name_originality',
        });
        return {
          proposalId: proposal.id,
          candidateId: candidate.id,
          sceneId: proposal.scopeId,
          detectorIds: proposal.detectorIds as string[],
          verificationVersion: 'editorial-verification-v1',
          passed: result.passed,
          failures: result.failures,
          warnings: result.warnings,
          sourceHash: result.sourceHash,
          candidateHash: result.candidateHash,
          changedPercent: result.changedPercent,
          referenceOverlap: result.referenceOverlap,
          styleDrift: result.styleDrift,
        };
      });
      if (results.some((item) => !item.passed)) {
        throw new Error('RECOVERED_EDITORIAL_VERIFICATION_FAILED');
      }
      const evidence = {
        verificationVersion: 'editorial-verification-v1',
        recoveredAfterPersistence: true,
        checksPerformed: results.length,
        selected: results.length,
        passed: true,
        detectorIds: [...new Set(results.flatMap((item) => item.detectorIds))],
        results,
      };
      const artifactId = randomUUID();
      await withWorkflowLease(run.id, async (tx, leaseOwner) => {
        await tx.workflowArtifact.create({
          data: {
            id: artifactId,
            runId: run.id,
            artifactType: 'editorial_verification',
            scopeType: 'editorial',
            contentHash: hash(evidence),
            sourceRevisionId: run.sourceRevisionId,
            resultRevisionId,
            payload: json(evidence),
          },
        });
        for (const item of results) await tx.editorialProposal.update({
          where: { id: item.proposalId },
          data: {
            status: 'applied',
            autoApplied: true,
            appliedRevisionId: resultRevisionId,
            verificationStatus: 'passed',
            verificationEvidence: json({ artifactId, ...item }),
          },
        });
        const workflowUpdated = await tx.workflowRun.updateMany({
          where: { id: run.id, leaseOwner },
          data: { resultRevisionId },
        });
        if (workflowUpdated.count !== 1) throw new Error(`Workflow lease lost for ${run.id}`);
        await tx.editorialRun.update({
          where: { id: editorialRunId },
          data: { resultRevisionId },
        });
        await tx.workflowEvent.create({
          data: {
            runId: run.id,
            eventType: 'editorial_verification_recovered',
            data: json({ resultRevisionId, artifactId, proposals: results.length }),
          },
        });
      });
      proposals = results.length;
    }
    const now = new Date();
    await withWorkflowLease(run.id, async (tx, leaseOwner) => {
      await tx.editorialRun.update({ where: { id: editorialRunId }, data: { status: 'completed', outcome: proposals ? 'completed_with_changes' : 'completed_no_changes', resultRevisionId, finishedAt: now } });
      await tx.workflowEvent.create({
        data: { runId: run.id, eventType: 'editorial_run_reconciled', data: json({ resultRevisionId, proposals }) },
      });
      const workflowUpdated = await tx.workflowRun.updateMany({
        where: { id: run.id, leaseOwner },
        data: { status: 'completed', phase: 'completed', resultRevisionId, finishedAt: now },
      });
      if (workflowUpdated.count !== 1) throw new Error(`Workflow lease lost for ${run.id}`);
      await tx.workflowTask.updateMany({
        where: { runId: run.id, status: { not: 'completed' }, leaseOwner },
        data: { status: 'completed', finishedAt: now, outputRevisionId: resultRevisionId },
      });
      const sharedOperationId = currentWorkflowExecution()?.sharedResourceOperationId;
      if (sharedOperationId) {
        await sealSharedResourceOperation(sharedOperationId, 'succeeded', 200, { success: true, data: {
          runId: run.id, bookId: run.bookId, status: 'completed', resultRevisionId,
          outcome: proposals ? 'completed_with_changes' : 'completed_no_changes', recovered: true,
        } }, now, tx);
      }
    });
    await Promise.all([
      incrementEditorialMetric('runs_completed'),
      incrementEditorialMetric(`outcome_${proposals ? 'completed_with_changes' : 'completed_no_changes'}`),
    ]);
  }

  private async finalizeSuperseded(
    run: WorkflowRun,
    editorialRunId: string,
    details: {
      currentRevisionId?: string | null;
      resultRevisionId?: string | null;
      reason?: string;
    } = {},
  ) {
    const now = new Date();
    await withWorkflowLease(run.id, async (tx, leaseOwner) => {
      await tx.editorialProposal.updateMany({
        where: { editorialRunId, status: { in: ['pending', 'selected', 'applied'] } },
        data: { status: 'superseded', skipReason: details.reason ?? 'source_revision_stale' },
      });
      await tx.editorialRun.update({
        where: { id: editorialRunId },
        data: {
          status: 'completed',
          outcome: 'superseded_by_new_revision',
          resultRevisionId: details.resultRevisionId,
          finishedAt: now,
        },
      });
      await tx.workflowEvent.create({
        data: {
          runId: run.id,
          eventType: 'editorial_run_superseded',
          data: json({
            sourceRevisionId: run.sourceRevisionId,
            resultRevisionId: details.resultRevisionId,
            currentRevisionId: details.currentRevisionId,
            reason: details.reason ?? 'source_revision_stale',
            rerunRequired: true,
          }),
        },
      });
      const workflowUpdated = await tx.workflowRun.updateMany({
        where: { id: run.id, leaseOwner },
        data: {
          status: 'completed',
          phase: 'completed',
          resultRevisionId: details.resultRevisionId,
          finishedAt: now,
          progress: json({
            percent: 100,
            outcome: 'superseded_by_new_revision',
            currentRevisionId: details.currentRevisionId,
            rerunRequired: true,
          }),
        },
      });
      if (workflowUpdated.count !== 1) throw new Error(`Workflow lease lost for ${run.id}`);
      await tx.workflowTask.updateMany({
        where: { runId: run.id, status: { not: 'completed' }, leaseOwner },
        data: { status: 'completed', finishedAt: now },
      });
      const sharedOperationId = currentWorkflowExecution()?.sharedResourceOperationId;
      if (sharedOperationId) {
        await sealSharedResourceOperation(sharedOperationId, 'succeeded', 200, { success: true, data: {
          runId: run.id, bookId: run.bookId, status: 'completed',
          resultRevisionId: details.resultRevisionId, outcome: 'superseded_by_new_revision',
        } }, now, tx);
      }
    });
    await Promise.all([
      incrementEditorialMetric('runs_completed'),
      incrementEditorialMetric('outcome_superseded_by_new_revision'),
    ]);
  }
}

export const editorialWorkflowService = new EditorialWorkflowService();
