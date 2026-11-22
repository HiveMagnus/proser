import { randomUUID } from 'node:crypto';
import { compatibilityOperationId } from '@/documents/operationIdentity';
import { DocumentError } from '@/documents/errors';
import type { Prisma } from '@prisma/client';
import { Router, type Response } from 'express';
import { z } from 'zod';

import { authenticateRequest } from '@/api/middleware/auth';
import { expensiveRouteLimit } from '@/api/middleware/expensiveRouteLimit';
import { editorialPreferenceSchema, editorialProfileSchema } from '@/api/schemas/editorial';
import type { AuthenticatedRequest } from '@/api/types';
import { ErrorCodes, respondError, respondSuccess } from '@/api/utils/response';
import { databaseService } from '@/lib/database';
import { applyEditorialPatches } from '@/services/editorial/editorialApplicationService';
import { editorialProfileService } from '@/services/editorial/editorialProfileService';
import { EDITORIAL_PASSES, getEditorialPass } from '@/services/editorial/passRegistry';
import { benchmarkRunner } from '@/services/editorial/qualityLab/benchmarkRunner';
import { validateCorpus } from '@/services/editorial/qualityLab/corpusLoader';
import { manuscriptRevisionService } from '@/services/manuscriptRevisionService';
import { auditLog } from '@/services/auditLogService';
import { changedPercent } from '@/services/editorial/textDiff';
import { textHash } from '@/services/editorial/textAnchors';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const router = Router();
router.use(authenticateRequest);

const pageSchema = z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
const benchmarkSchema = z.object({
  suiteKey: z.string().max(100).optional(),
  passKey: z.enum(['line_edit_safe', 'dialogue', 'voice_preservation', 'scene_energy', 'continuity', 'name_originality', 'final_polish', 'custom']).optional(),
  live: z.boolean().default(false),
  maximumCases: z.number().int().min(1).max(50).default(20),
}).strict();
const applySchema = z.object({ candidateId: z.string().uuid() }).strict();

function fail(res: Response, error: unknown) {
  if (res.headersSent) return;
  if (error instanceof DocumentError) { respondError(res, error.code, error.message, error.status, error.details); return; }
  const message = error instanceof Error ? error.message : String(error);
  const conflict = /STALE|CONFLICT/.test(message);
  const notFound = /not found/i.test(message);
  const code = ([
    'EDITORIAL_PASS_NOT_FOUND', 'EDITORIAL_PROFILE_INVALID', 'EDITORIAL_SCOPE_INVALID',
    'EDITORIAL_SOURCE_STALE', 'EDITORIAL_BUDGET_EXCEEDED', 'EDITORIAL_PROPOSAL_STALE',
    'EDITORIAL_PROPOSAL_NOT_APPLICABLE', 'EDITORIAL_BENCHMARK_INVALID',
  ] as const).find((candidate) => message.includes(candidate));
  respondError(
    res,
    code ? ErrorCodes[code] : conflict ? ErrorCodes.CONFLICT : notFound ? ErrorCodes.NOT_FOUND : ErrorCodes.VALIDATION_FAILED,
    message,
    conflict ? 409 : notFound ? 404 : 400,
    { retryable: false, safeToRepeat: conflict || /idempotency/i.test(message) },
  );
}

async function ownedRun(userId: number, runId: string) {
  const run = await databaseService.client.editorialRun.findFirst({
    where: { workflowRunId: runId, workflowRun: { userId } },
    include: { workflowRun: { select: { status: true, phase: true, progress: true, lastHeartbeatAt: true, failureReason: true } } },
  });
  if (!run) throw new Error('Editorial run not found');
  return run;
}

async function ownedProposal(userId: number, proposalId: string) {
  const proposal = await databaseService.client.editorialProposal.findFirst({
    where: { id: proposalId, editorialRun: { workflowRun: { userId } } },
    include: { candidates: true, evaluations: { orderBy: { createdAt: 'asc' } }, editorialRun: true },
  });
  if (!proposal) throw new Error('Editorial proposal not found');
  return proposal;
}

router.get('/pass-packs', (_req, res) => respondSuccess(res, EDITORIAL_PASSES.filter((item) => item.enabled).map((item) => ({
  key: item.key, version: item.version, displayName: item.displayName, description: item.description,
  supportedScopes: item.supportedScopes, defaultAutonomy: item.defaultAutonomy,
  allowedRisk: item.allowedRisk, mayChange: item.mayChange, mustPreserve: item.mustPreserve,
  defaultBudget: item.defaultBudget,
}))));
router.get('/pass-packs/:key', (req, res) => { try { respondSuccess(res, getEditorialPass(req.params.key)); } catch (error) { fail(res, error); } });

router.get('/profiles', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await editorialProfileService.list(req.user!.id)); } catch (error) { fail(res, error); } });
router.post('/profiles', async (req: AuthenticatedRequest, res) => { try { const created = await editorialProfileService.create(req.user!.id, editorialProfileSchema.parse(req.body)); await auditLog.record(req.user!.id, 'create', 'book', created.bookId ?? undefined, { editorialProfileId: created.id, version: created.version }); respondSuccess(res, created, 201); } catch (error) { fail(res, error); } });
router.get('/profiles/:id', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await editorialProfileService.owned(req.user!.id, req.params.id)); } catch (error) { fail(res, error); } });
router.put('/profiles/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const prior = await editorialProfileService.owned(req.user!.id, req.params.id);
    const input = editorialProfileSchema.parse(req.body);
    respondSuccess(res, await editorialProfileService.create(req.user!.id, { ...input, parentId: prior.id, name: input.name || prior.name }));
  } catch (error) { fail(res, error); }
});

router.get('/runs/:runId', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await ownedRun(req.user!.id, req.params.runId)); } catch (error) { fail(res, error); } });
router.get('/runs/:runId/summary', async (req: AuthenticatedRequest, res) => { try { const run = await ownedRun(req.user!.id, req.params.runId); respondSuccess(res, run.evidenceSummary ?? { status: run.status, outcome: run.outcome }); } catch (error) { fail(res, error); } });
router.get('/runs/:runId/proposals', async (req: AuthenticatedRequest, res) => {
  try {
    const run = await ownedRun(req.user!.id, req.params.runId);
    const page = pageSchema.parse(req.query);
    const proposals = await databaseService.client.editorialProposal.findMany({
      where: { editorialRunId: run.id, ...(page.cursor ? { id: { gt: page.cursor } } : {}) },
      orderBy: { id: 'asc' }, take: page.limit + 1,
      select: { id: true, scopeType: true, scopeId: true, passKey: true, passVersion: true, risk: true, confidence: true, status: true, skipReason: true, originalText: true, verificationStatus: true, createdAt: true },
    });
    const hasMore = proposals.length > page.limit;
    const current = await manuscriptRevisionService.currentAncestry(run.bookId);
    respondSuccess(res, {
      items: proposals.slice(0, page.limit).map((item) => ({
        ...item,
        stale: current.current !== run.sourceRevisionId,
        originalText: item.originalText.slice(0, 1_500),
      })),
      nextCursor: hasMore ? proposals[page.limit - 1]?.id ?? null : null,
    });
  } catch (error) { fail(res, error); }
});
router.get('/runs/:runId/proposals/:proposalId', async (req: AuthenticatedRequest, res) => {
  try {
    const run = await ownedRun(req.user!.id, req.params.runId);
    const proposal = await ownedProposal(req.user!.id, req.params.proposalId);
    if (proposal.editorialRunId !== run.id) throw new Error('Editorial proposal not found');
    const current = await manuscriptRevisionService.currentAncestry(run.bookId);
    respondSuccess(res, {
      ...proposal,
      stale: current.current !== proposal.sourceRevisionId,
      canUndo: Boolean(proposal.appliedRevisionId && current.current === proposal.appliedRevisionId),
      originalText: proposal.originalText.slice(0, 4_000),
      candidates: proposal.candidates.map((item) => ({ ...item, outputText: item.outputText.slice(0, 4_000) })),
    });
  } catch (error) { fail(res, error); }
});
router.get('/runs/:runId/evidence', async (req: AuthenticatedRequest, res) => {
  try {
    const run = await ownedRun(req.user!.id, req.params.runId);
    const artifacts = await databaseService.client.workflowArtifact.findMany({
      where: { runId: run.workflowRunId, artifactType: { in: ['editorial_findings_summary', 'editorial_verification', 'editorial_release_evidence'] } },
      orderBy: { createdAt: 'asc' },
    });
    respondSuccess(res, artifacts);
  } catch (error) { fail(res, error); }
});

router.post('/proposals/:proposalId/preference', async (req: AuthenticatedRequest, res) => {
  try {
    const proposal = await ownedProposal(req.user!.id, req.params.proposalId);
    const input = editorialPreferenceSchema.parse(req.body);
    if (input.candidateId && !proposal.candidates.some((item) => item.id === input.candidateId)) throw new Error('Editorial candidate not found');
    const weight = ['reject_all', 'undo_auto_edit'].includes(input.evidenceType) ? -2 : input.evidenceType === 'choose_original' ? -1 : 1;
    const evidence = await databaseService.client.editorialPreferenceEvidence.create({ data: {
      id: randomUUID(), userId: req.user!.id, bookId: proposal.bookId,
      editorialRunId: proposal.editorialRunId, proposalId: proposal.id, candidateId: input.candidateId,
      evidenceType: input.evidenceType, passKey: proposal.passKey, weight,
      featureVector: input.manualRewrite ? json({
        manualRewriteHash: textHash(input.manualRewrite),
        distanceFromOriginal: changedPercent(proposal.originalText, input.manualRewrite),
        distanceFromCandidate: input.candidateId
          ? changedPercent(proposal.candidates.find((item) => item.id === input.candidateId)?.outputText ?? '', input.manualRewrite)
          : null,
      }) : undefined,
      rationaleTags: input.rationaleTags ? json(input.rationaleTags) : undefined,
    } });
    await auditLog.record(req.user!.id, 'update', 'book', proposal.bookId, { editorialPreferenceId: evidence.id, proposalId: proposal.id, evidenceType: input.evidenceType });
    respondSuccess(res, evidence, 201);
  } catch (error) { fail(res, error); }
});
router.delete('/preferences/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const updated = await databaseService.client.editorialPreferenceEvidence.updateMany({
      where: { id: req.params.id, userId: req.user!.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (updated.count !== 1) throw new Error('Editorial preference not found');
    await auditLog.record(req.user!.id, 'delete', 'workflow_run', undefined, { editorialPreferenceId: req.params.id });
    respondSuccess(res, { id: req.params.id, deleted: true });
  } catch (error) { fail(res, error); }
});
router.get('/preferences/export', async (req: AuthenticatedRequest, res) => {
  try {
    const bookId = req.query.bookId ? z.coerce.number().int().positive().parse(req.query.bookId) : undefined;
    if (bookId) {
      const owned = await databaseService.client.book.count({ where: { id: bookId, userId: req.user!.id, deletedAt: null } });
      if (!owned) throw new Error(`Book ${bookId} not found`);
    }
    const rows = await databaseService.client.editorialPreferenceEvidence.findMany({
      where: { userId: req.user!.id, bookId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 1_000,
      include: {
        proposal: { select: { sourceRevisionId: true, passKey: true, passVersion: true, sourceHash: true } },
        candidate: { select: { outputHash: true, producerModel: true, recipeVersion: true, samplingHash: true, ragHash: true } },
      },
    });
    respondSuccess(res, {
      version: 'editorial-preference-export-v1',
      count: rows.length,
      pairs: rows.map((item) => ({
        id: item.id,
        evidenceType: item.evidenceType,
        weight: item.weight,
        rationaleTags: item.rationaleTags,
        featureVector: item.featureVector,
        pass: item.proposal ? { key: item.proposal.passKey, version: item.proposal.passVersion } : null,
        sourceRevisionId: item.proposal?.sourceRevisionId ?? null,
        sourceHash: item.proposal?.sourceHash ?? null,
        candidateHash: item.candidate?.outputHash ?? null,
        model: item.candidate?.producerModel ?? null,
        recipe: item.candidate?.recipeVersion ?? null,
        samplingHash: item.candidate?.samplingHash ?? null,
        ragHash: item.candidate?.ragHash ?? null,
        createdAt: item.createdAt,
      })),
    });
  } catch (error) { fail(res, error); }
});
router.post('/proposals/:proposalId/apply', async (req: AuthenticatedRequest, res) => {
  try {
    const proposal = await ownedProposal(req.user!.id, req.params.proposalId);
    const input = applySchema.parse(req.body);
    const candidate = proposal.candidates.find((item) => item.id === input.candidateId);
    if (!candidate || candidate.candidateType === 'original') throw new Error('EDITORIAL_PROPOSAL_NOT_APPLICABLE');
    const current = await manuscriptRevisionService.currentAncestry(proposal.bookId);
    if (current.current !== proposal.sourceRevisionId) throw new Error('EDITORIAL_PROPOSAL_STALE');
    const applied = await applyEditorialPatches({
      userId: req.user!.id, bookId: proposal.bookId, expectedRevisionId: proposal.sourceRevisionId,
      patches: [{
        sceneId: proposal.scopeId!, originalText: proposal.originalText, candidateText: candidate.outputText,
        sourceHash: proposal.sourceHash, startOffset: proposal.startOffset, endOffset: proposal.endOffset,
        beforeAnchor: proposal.beforeAnchor, afterAnchor: proposal.afterAnchor,
        protectedElements: proposal.protectedClaims as string[], maxChangedPercent: 25,
      }],
    });
    await databaseService.client.$transaction([
      databaseService.client.editorialProposal.update({ where: { id: proposal.id }, data: { status: 'optionally_applied', appliedRevisionId: applied.revisionId, verificationStatus: 'passed' } }),
      databaseService.client.editorialPreferenceEvidence.create({ data: {
        id: randomUUID(), userId: req.user!.id, bookId: proposal.bookId, editorialRunId: proposal.editorialRunId,
        proposalId: proposal.id, candidateId: candidate.id, evidenceType: 'choose_candidate', passKey: proposal.passKey, weight: 1,
      } }),
    ]);
    await auditLog.record(req.user!.id, 'update', 'book', proposal.bookId, { editorialProposalId: proposal.id, action: 'optional_apply', resultRevisionId: applied.revisionId });
    respondSuccess(res, { proposalId: proposal.id, resultRevisionId: applied.revisionId, applied: true });
  } catch (error) { fail(res, error); }
});
router.post('/proposals/:proposalId/undo', async (req: AuthenticatedRequest, res) => {
  try {
    const proposal = await ownedProposal(req.user!.id, req.params.proposalId);
    if (!proposal.appliedRevisionId) throw new Error('EDITORIAL_PROPOSAL_NOT_APPLICABLE');
    const current = await manuscriptRevisionService.currentAncestry(proposal.bookId);
    if (current.current !== proposal.appliedRevisionId) throw new Error('EDITORIAL_PROPOSAL_STALE');
    const revisionId = await manuscriptRevisionService.restore(proposal.bookId, proposal.sourceRevisionId, undefined, { userId: req.user!.id, expectedRevisionId: proposal.appliedRevisionId, operationId: compatibilityOperationId('proser.editorial-proposal-undo.v1', { userId: req.user!.id, proposalId: proposal.id, appliedRevisionId: proposal.appliedRevisionId }) });
    await databaseService.client.editorialPreferenceEvidence.create({ data: {
      id: randomUUID(), userId: req.user!.id, bookId: proposal.bookId, editorialRunId: proposal.editorialRunId,
      proposalId: proposal.id, evidenceType: 'undo_auto_edit', passKey: proposal.passKey, weight: -2,
    } });
    await auditLog.record(req.user!.id, 'restore', 'book', proposal.bookId, { editorialProposalId: proposal.id, sourceRevisionId: proposal.sourceRevisionId, resultRevisionId: revisionId });
    respondSuccess(res, { proposalId: proposal.id, resultRevisionId: revisionId, undone: true });
  } catch (error) { fail(res, error); }
});

router.post('/benchmarks', expensiveRouteLimit('editorialBenchmark'), async (req: AuthenticatedRequest, res) => {
  try {
    const key = req.header('idempotency-key')?.trim();
    if (!key || key.length > 200) throw new Error('Idempotency-Key header is required');
    const benchmark = await benchmarkRunner.run(
      req.user!.id,
      key,
      benchmarkSchema.parse(req.body),
      req.operationSignal,
    );
    req.operationSignal?.throwIfAborted();
    await auditLog.record(req.user!.id, 'create', 'workflow_run', undefined, { evaluationRunId: benchmark.id, suiteKey: benchmark.suiteKey });
    req.operationSignal?.throwIfAborted();
    respondSuccess(res, benchmark, 202);
  } catch (error) { fail(res, error); }
});
router.get('/benchmarks', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await databaseService.client.evaluationRun.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, suiteKey: true, suiteVersion: true, status: true, metrics: true, reportHash: true, createdAt: true, finishedAt: true } })); } catch (error) { fail(res, error); } });
router.get('/benchmarks/:runId', async (req: AuthenticatedRequest, res) => { try { const run = await databaseService.client.evaluationRun.findFirst({ where: { id: req.params.runId, userId: req.user!.id }, select: { id: true, suiteKey: true, suiteVersion: true, status: true, metrics: true, reportHash: true, createdAt: true, finishedAt: true } }); if (!run) throw new Error('Benchmark run not found'); respondSuccess(res, run); } catch (error) { fail(res, error); } });
router.get('/benchmarks/:runId/report', async (req: AuthenticatedRequest, res) => { try { const run = await databaseService.client.evaluationRun.findFirst({ where: { id: req.params.runId, userId: req.user!.id }, select: { report: true, reportHash: true, status: true } }); if (!run) throw new Error('Benchmark run not found'); respondSuccess(res, run); } catch (error) { fail(res, error); } });
router.get('/release-evidence', async (req: AuthenticatedRequest, res) => {
  try {
    const latest = await databaseService.client.evaluationRun.findFirst({ where: { userId: req.user!.id, status: 'completed' }, orderBy: { finishedAt: 'desc' }, select: { id: true, suiteKey: true, suiteVersion: true, reportHash: true, report: true, finishedAt: true } });
    respondSuccess(res, { latest, corpus: await validateCorpus() });
  } catch (error) { fail(res, error); }
});

export const editorialBookRouter = Router();
editorialBookRouter.use(authenticateRequest);
editorialBookRouter.get('/:bookId/editorial-runs', async (req: AuthenticatedRequest, res) => {
  try {
    const bookId = Number(req.params.bookId);
    const owned = await databaseService.client.book.count({ where: { id: bookId, userId: req.user!.id, deletedAt: null } });
    if (!owned) throw new Error(`Book ${bookId} not found`);
    respondSuccess(res, await databaseService.client.editorialRun.findMany({ where: { bookId }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, workflowRunId: true, passPackKey: true, passPackVersion: true, autonomy: true, scopeType: true, scopeId: true, status: true, outcome: true, sourceRevisionId: true, resultRevisionId: true, evidenceSummary: true, createdAt: true, finishedAt: true } }));
  } catch (error) { fail(res, error); }
});
editorialBookRouter.post('/:bookId/editorial-profile/activate', async (req: AuthenticatedRequest, res) => { try { const body = z.object({ profileId: z.string().uuid() }).strict().parse(req.body); const bookId = Number(req.params.bookId); const resolved = await editorialProfileService.activate(req.user!.id, bookId, body.profileId); await auditLog.record(req.user!.id, 'update', 'book', bookId, { editorialProfileId: body.profileId, resolvedHash: resolved.hash }); respondSuccess(res, resolved); } catch (error) { fail(res, error); } });
editorialBookRouter.get('/:bookId/editorial-profile/resolved', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await editorialProfileService.resolve(req.user!.id, Number(req.params.bookId))); } catch (error) { fail(res, error); } });

export default router;
