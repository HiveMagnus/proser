import type { Router } from 'express';
import { z } from 'zod';
import { zBody, zParams, zQuery } from '@/api/middleware/zodValidation';
import { respondSuccess } from '@/api/utils/response';
import { ownedBookBudget } from '@/api/middleware/ownedBookBudget';
import { expensiveRouteLimit } from '@/api/middleware/expensiveRouteLimit';
import { documentAuthorityEnabled } from '@/documents/capabilities';
import { DocumentError } from '@/documents/errors';
import { listPlotThreads, readPlotThread, savePlotThread, addPlotThreadEvidence, removePlotThreadEvidence,
  requestPlotThreadReview, readPlotThreadReview, cancelPlotThreadReview, assessPlotThreadReview, readPlotThreadMutation,
  plotThreadMutationSchema, plotThreadEvidenceSchema, plotThreadOperationSchema, plotThreadReviewSchema, plotThreadAssessmentSchema } from '@/documents/plotThreads';
export function registerPlotThreadRoutes(router: Router) {
  const base = '/:bookId/plot-threads';
  const book = z.object({ bookId: z.coerce.number().int().positive() });
  const thread = book.extend({ threadId: z.coerce.number().int().positive() });
  const evidence = thread.extend({ evidenceId: z.string().uuid() });
  const review = thread.extend({ reviewId: z.string().uuid() });
  router.use(base, (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!documentAuthorityEnabled()) return next(new DocumentError('DOCUMENT_AUTHORITY_INACTIVE', 'Saved document authority is required for plot threads.', 503));
    next();
  });
  const list = z.object({ archived: z.enum(['true','false']).default('false'), after: z.coerce.number().int().positive().optional() });
  router.get(base, zParams(book), zQuery(list), async (req, res) => {
    const query = list.parse(req.query);
    respondSuccess(res, await listPlotThreads(req.user!.id, Number(req.params.bookId), query.archived === 'true', query.after));
  });
  router.get(base + '/operations/:operationId', zParams(book.extend({ operationId: z.string().uuid() })), async (req, res) => respondSuccess(res, await readPlotThreadMutation(req.user!.id, Number(req.params.bookId), String(req.params.operationId))));
  router.post(base, zParams(book), zBody(plotThreadMutationSchema), async (req, res) => respondSuccess(res, await savePlotThread(req.user!.id, Number(req.params.bookId), undefined, req.body), 201));
  router.get(base + '/:threadId', zParams(thread), async (req, res) => respondSuccess(res, await readPlotThread(req.user!.id, Number(req.params.bookId), Number(req.params.threadId))));
  router.patch(base + '/:threadId', zParams(thread), zBody(plotThreadMutationSchema), async (req, res) => respondSuccess(res, await savePlotThread(req.user!.id, Number(req.params.bookId), Number(req.params.threadId), req.body)));
  router.post(base + '/:threadId/evidence', zParams(thread), zBody(plotThreadEvidenceSchema), async (req, res) => respondSuccess(res, await addPlotThreadEvidence(req.user!.id, Number(req.params.bookId), Number(req.params.threadId), req.body), 201));
  router.post(base + '/:threadId/evidence/:evidenceId/remove', zParams(evidence), zBody(plotThreadOperationSchema), async (req, res) => respondSuccess(res, await removePlotThreadEvidence(req.user!.id, Number(req.params.bookId), Number(req.params.threadId), String(req.params.evidenceId), req.body)));
  router.post(base + '/:threadId/reviews', zParams(thread), zBody(plotThreadReviewSchema), ownedBookBudget({ source: 'params', required: true }), expensiveRouteLimit('plotThreadReview'), async (req, res) => respondSuccess(res, await requestPlotThreadReview(req.user!.id, Number(req.params.bookId), Number(req.params.threadId), req.body)));
  router.get(base + '/:threadId/reviews/:reviewId', zParams(review), async (req, res) => respondSuccess(res, await readPlotThreadReview(req.user!.id, Number(req.params.bookId), Number(req.params.threadId), String(req.params.reviewId))));
  router.post(base + '/:threadId/reviews/:reviewId/cancel', zParams(review), zBody(z.object({}).strict()), async (req, res) => respondSuccess(res, await cancelPlotThreadReview(req.user!.id, Number(req.params.bookId), Number(req.params.threadId), String(req.params.reviewId))));
  router.post(base + '/:threadId/reviews/:reviewId/assessment', zParams(review), zBody(plotThreadAssessmentSchema), async (req, res) => respondSuccess(res, await assessPlotThreadReview(req.user!.id, Number(req.params.bookId), Number(req.params.threadId), String(req.params.reviewId), req.body)));
}
