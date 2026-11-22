import { Router, type Response } from 'express';
import { z, ZodError } from 'zod';

import { authenticateRequest } from '@/api/middleware/auth';
import { expensiveRouteLimit } from '@/api/middleware/expensiveRouteLimit';
import { ownedBookBudget } from '@/api/middleware/ownedBookBudget';
import { zodIssueLog } from '@/api/middleware/zodValidation';
import type { AuthenticatedRequest } from '@/api/types';
import { respondError, respondSuccess, ErrorCodes } from '@/api/utils/response';
import { workflowService, type WorkflowScope } from '@/services/workflowService';
import logger from '@/lib/logger';
import { DocumentError } from '@/documents/errors';
import { parseDocumentMutationPreconditions } from '@/api/schemas/documents';
import { editorialOptimizeSchema } from '@/api/schemas/editorial';
import { loadEditorialScope } from '@/services/editorial/scopeLoader';
import { auditLog } from '@/services/auditLogService';
import { claimNovaResource } from '@/api/middleware/novaGrant';

const router = Router();
router.use(authenticateRequest);

const scope = z.object({ type: z.enum(['book', 'act', 'chapter', 'scene']), id: z.number().int().positive().optional() }).strict().superRefine((value, ctx) => {
  if (value.type !== 'book' && !value.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: 'id is required for non-book scope' });
});
const fullBook = z.object({
  bookId: z.number().int().positive().optional(), premise: z.string().min(10).max(20_000), title: z.string().min(1).max(500).optional(),
  genre: z.string().min(1).max(200).optional(), audience: z.string().min(1).max(500).optional(), targetWords: z.number().int().min(10_000).max(250_000).default(80_000),
  pov: z.string().max(200).optional(), tense: z.string().max(100).optional(), style: z.string().max(4_000).optional(), mustInclude: z.array(z.string().max(500)).max(100).optional(),
  mustAvoid: z.array(z.string().max(500)).max(100).optional(), candidateCount: z.number().int().min(2).max(4).default(2), reviewModels: z.array(z.string().min(1).max(200)).max(3).optional(), maxEditorialRounds: z.number().int().min(1).max(3).default(3),
}).strict();
const qualityReview = z.object({ bookId: z.number().int().positive(), scope: scope.default({ type: 'book' }), model: z.string().min(1).max(200), rubricVersion: z.string().min(1).max(100).default('publishable-v1') }).strict();
const improveQuality = z.object({ bookId: z.number().int().positive(), reviewRunIds: z.array(z.string().uuid()).min(1).max(10), findingIds: z.array(z.string().uuid()).max(500).optional(), model: z.string().min(1).max(200).optional() }).strict();
const guidedImprove = z.object({ bookId: z.number().int().positive(), instruction: z.string().min(3).max(20_000), scope: scope.optional(), model: z.string().min(1).max(200).optional(), acceptanceCriteria: z.array(z.string().min(1).max(1_000)).max(50).optional() }).strict();
const decision = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(4_000).optional() }).strict();
const findingPatch = z.object({ waived: z.boolean().optional(), waiverReason: z.string().min(3).max(4_000).optional(), implemented: z.boolean().optional() }).strict().refine((value) => value.waived !== true || Boolean(value.waiverReason), { message: 'waiverReason is required when waived is true' });
const findingQuery = z.object({ state: z.enum(['open', 'implemented', 'verified', 'waived', 'stale', 'all']).optional(), model: z.string().min(1).max(200).optional(), severity: z.enum(['critical', 'high', 'medium', 'low']).optional(), scope: z.enum(['book', 'act', 'chapter', 'scene']).optional(), cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
const checkpointPage = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1_024).max(32_768).default(16_384) });

function fail(res: Response, error: unknown) {
  if (res.headersSent) return;
  if (error instanceof DocumentError) { respondError(res, error.code, error.message, error.status, error.details); return; }
  logger.error(
    error instanceof ZodError
      ? {
          schema: 'workflow-route-inline-schema',
          issues: zodIssueLog(error),
        }
      : { error: error instanceof Error ? error.message : String(error) },
    'Workflow API request failed',
  );
  const message = error instanceof Error ? error.message : String(error);
  const notFound = /not found/i.test(message);
  respondError(res, notFound ? ErrorCodes.NOT_FOUND : ErrorCodes.VALIDATION_FAILED, message, notFound ? 404 : 400);
}

const actor = (req: AuthenticatedRequest) => req.authActor?.githubId ?? req.user!.githubId;
const startAndClaim = async <T extends { runId: string; bookId: number }>(req: AuthenticatedRequest, work: Promise<T>): Promise<T> => {
  const result = await work;
  await claimNovaResource(req, 'book', result.bookId);
  await claimNovaResource(req, 'workflow', result.runId);
  return result;
};
const idempotencyKey = (req: AuthenticatedRequest): string => {
  const value = req.header('idempotency-key')?.trim();
  if (!value) throw new Error('Idempotency-Key header is required');
  if (value.length > 200) throw new Error('Idempotency-Key header must be at most 200 characters');
  return value;
};

router.post('/full-book', ownedBookBudget({ source: 'body' }), expensiveRouteLimit('workflowFullBook'), async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await startAndClaim(req, workflowService.start(req.user!.id, 'full_book', fullBook.parse(req.body), undefined, true, actor(req), idempotencyKey(req), req.operationSignal, req.sharedResourceOperationId)), 202); } catch (error) { fail(res, error); } });
router.post('/quality-review', ownedBookBudget({ source: 'body', required: true }), expensiveRouteLimit('workflowQualityReview'), async (req: AuthenticatedRequest, res) => { try { const input = qualityReview.parse(req.body); respondSuccess(res, await startAndClaim(req, workflowService.start(req.user!.id, 'quality_review', { ...input, scope: input.scope as WorkflowScope }, undefined, true, actor(req), idempotencyKey(req), req.operationSignal, req.sharedResourceOperationId)), 202); } catch (error) { fail(res, error); } });
router.post('/improve-quality', ownedBookBudget({ source: 'body', required: true }), expensiveRouteLimit('workflowImproveQuality'), async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await startAndClaim(req, workflowService.start(req.user!.id, 'improve_quality', improveQuality.parse(req.body), undefined, true, actor(req), idempotencyKey(req), req.operationSignal, req.sharedResourceOperationId)), 202); } catch (error) { fail(res, error); } });
router.post('/guided-improve', ownedBookBudget({ source: 'body', required: true }), expensiveRouteLimit('workflowGuidedImprove'), async (req: AuthenticatedRequest, res) => { try { const input = guidedImprove.parse(req.body); respondSuccess(res, await startAndClaim(req, workflowService.start(req.user!.id, 'guided_improve', { ...input, scope: input.scope as WorkflowScope | undefined }, undefined, true, actor(req), idempotencyKey(req), req.operationSignal, req.sharedResourceOperationId)), 202); } catch (error) { fail(res, error); } });
router.post('/editorial-optimize', ownedBookBudget({ source: 'body', required: true }), expensiveRouteLimit('workflowEditorialOptimize'), async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = editorialOptimizeSchema.parse(req.body);
    const input = {
      ...parsed,
      protectedElements: parsed.protectedElements
        ? [...new Set(parsed.protectedElements.map((item) => item.trim()).filter(Boolean))]
        : undefined,
    };
    await loadEditorialScope({ userId: req.user!.id, bookId: input.bookId, scope: input.scope });
    const status = await startAndClaim(req, workflowService.start(req.user!.id, 'editorial_optimize', input, undefined, true, actor(req), idempotencyKey(req), req.operationSignal, req.sharedResourceOperationId));
    req.operationSignal?.throwIfAborted();
    await auditLog.record(req.user!.id, 'workflow_start', 'book', input.bookId, { workflowRunId: status.runId, workflowType: 'editorial_optimize', passPack: input.passPack, autonomy: input.autonomy, sourceRevisionId: status.sourceRevisionId });
    req.operationSignal?.throwIfAborted();
    respondSuccess(res, { ...status, passPack: input.passPack, statusUrl: `/api/workflows/${status.runId}` }, 202);
  } catch (error) { fail(res, error); }
});
router.get('/:runId', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.status(req.user!.id, req.params.runId)); } catch (error) { fail(res, error); } });
router.get('/:runId/events', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.listEvents(req.user!.id, req.params.runId, Number(req.query.after ?? 0), Number(req.query.limit ?? 100))); } catch (error) { fail(res, error); } });
router.get('/:runId/checkpoints', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.checkpoints(req.user!.id, req.params.runId)); } catch (error) { fail(res, error); } });
router.get('/:runId/checkpoints/:checkpointId', async (req: AuthenticatedRequest, res) => { try { const page = checkpointPage.parse(req.query); respondSuccess(res, await workflowService.checkpointDetail(req.user!.id, req.params.runId, req.params.checkpointId, page.offset, page.limit)); } catch (error) { fail(res, error); } });
router.get('/:runId/artifacts', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.artifacts(req.user!.id, req.params.runId)); } catch (error) { fail(res, error); } });
for (const action of ['pause', 'resume', 'cancel'] as const) router.post(`/:runId/${action}`, async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.control(req.user!.id, req.params.runId, action, actor(req)), 202); } catch (error) { fail(res, error); } });
router.post('/:runId/checkpoints/:checkpointId/decision', async (req: AuthenticatedRequest, res) => { try { const input = decision.parse(req.body); respondSuccess(res, await workflowService.decideCheckpoint(req.user!.id, req.params.runId, req.params.checkpointId, input.decision, input.reason, actor(req)), 202); } catch (error) { fail(res, error); } });
router.post('/:runId/finalize', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.finalize(req.user!.id, req.params.runId, actor(req)), 202); } catch (error) { fail(res, error); } });
router.get('/:runId/publication', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.publication(req.user!.id, req.params.runId)); } catch (error) { fail(res, error); } });
router.get('/:runId/publication/:filename', async (req: AuthenticatedRequest, res) => {
  try {
    const artifact = await workflowService.publicationArtifact(req.user!.id, req.params.runId, req.params.filename);
    res.setHeader('Content-Type', artifact.mediaType);
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename.replace(/["\r\n]/g, '')}"`);
    res.send(artifact.content);
  } catch (error) { fail(res, error); }
});

export const workflowBookRouter = Router();
workflowBookRouter.use(authenticateRequest);
workflowBookRouter.get('/:bookId/workflows', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.listBookRuns(req.user!.id, Number(req.params.bookId))); } catch (error) { fail(res, error); } });
workflowBookRouter.get('/:bookId/reviews', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.listReviews(req.user!.id, Number(req.params.bookId))); } catch (error) { fail(res, error); } });
workflowBookRouter.get('/:bookId/findings', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.bookFindings(req.user!.id, Number(req.params.bookId), findingQuery.parse(req.query))); } catch (error) { fail(res, error); } });
workflowBookRouter.get('/:bookId/revisions', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.revisions(req.user!.id, Number(req.params.bookId))); } catch (error) { fail(res, error); } });
workflowBookRouter.post('/:bookId/revisions/:revisionId/rollback', ownedBookBudget({ source: 'params', required: true }), expensiveRouteLimit('revisionRollback'), async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.rollbackRevision(req.user!.id, Number(req.params.bookId), req.params.revisionId, req.operationSignal, parseDocumentMutationPreconditions(req.body?.documentPreconditions))); } catch (error) { fail(res, error); } });

export const workflowReviewRouter = Router();
workflowReviewRouter.use(authenticateRequest);
workflowReviewRouter.get('/:reviewRunId/findings', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.findings(req.user!.id, req.params.reviewRunId)); } catch (error) { fail(res, error); } });

export const workflowFindingRouter = Router();
workflowFindingRouter.use(authenticateRequest);
workflowFindingRouter.patch('/:findingId', async (req: AuthenticatedRequest, res) => { try { respondSuccess(res, await workflowService.patchFinding(req.user!.id, req.params.findingId, findingPatch.parse(req.body))); } catch (error) { fail(res, error); } });

export default router;
