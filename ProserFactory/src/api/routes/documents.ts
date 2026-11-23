import { redisRateLimit } from '@/api/middleware/redisRateLimit';
import { registerRevisionCampaignRoutes } from './revisionCampaigns';
import { registerPlotThreadRoutes } from './plotThreads';
import {registerScopeDocumentPassageRoutes} from './scopeDocumentPassages';
import { readChapterTransitions } from '@/documents/chapterTransitions';
import {registerDocumentStoryProposalRoutes} from './documentStoryProposals';
import { registerDocumentDocxImportRoutes } from './documentDocxImports';
import { registerDocumentPublicationRoutes } from './documentPublications';
import { registerDocumentOperatorEffectRoutes } from './documentOperatorEffects';
import { registerDocumentCommentRoutes } from './documentComments';
import {registerDocumentSearchRoutes} from './documentSearch';
import {registerDocumentPassageRoutes} from './documentPassages';
import { Router, raw } from 'express';
import { z } from 'zod';
import { respondSuccess } from '@/api/utils/response';
import { zBody, zParams } from '@/api/middleware/zodValidation';
import { ownedBookBudget } from '@/api/middleware/ownedBookBudget';
import { documentAuthorityEnabled, documentService, DocumentError, type DocumentCommit } from '@/documents/service';
import { documentBookParams as params, documentCommitSchema as commitSchema, documentLayoutCommitSchema, documentQuickDraftSchema, requireDocumentPreconditions } from '@/api/schemas/documents';
import { readSceneGeneration, cancelSceneGeneration } from '@/documents/generation';
import { validateBookLayout } from '@/documents/scopeValidation';
import { createDocumentDiscussion, readDocumentDiscussion, requestDocumentProposal, readDocumentProposal, cancelDocumentProposal, revalidateDocumentProposal, applyDocumentProposal } from '@/documents/proposals';
import { documentDiscussionSchema, documentProposalRequestSchema, documentProposalRevalidateSchema, documentProposalApplySchema } from '@/documents/proposalValidation';
import { expensiveRouteLimit } from '@/api/middleware/expensiveRouteLimit';
import { databaseService } from '@/lib/database';
import { createDocumentQuickDraft } from '@/documents/quickDraft';
import { readDocumentTraceReview, revalidateBoundCompare, readTraceAnalysis, cancelTraceAnalysis } from '@/documents/traceAnalysis';
import { documentCompareRevalidateSchema } from '@/documents/traceValidation';
import { preserveImportOriginal, prepareLegacyBundleImport, readImportPreview, readImportOriginal, commitLegacyBundleImport } from '@/documents/imports';
import { importCommitSchema, importPreviewSchema, requireImportCommitPreconditions } from '@/documents/importValidation';
import { workflowEffectPage, cancelWorkflowEffect, listWorkflowEffects } from '@/documents/workflowEffects';
function requireComparePreconditions(req: { body?: Record<string, unknown> }, _res: unknown, next: () => void) {
  requireDocumentPreconditions(req.body, false);
  if (!req.body?.expectedSceneRevisionId) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Expected scene revision is required.', 428);
  next();
}
export function registerDocumentRoutes(router: Router) {
  registerPlotThreadRoutes(router);
  registerRevisionCampaignRoutes(router);
  router.get('/:bookId/chapter-transitions', zParams(params), async (req, res) => {
    if (!documentAuthorityEnabled()) throw new DocumentError('DOCUMENT_AUTHORITY_INACTIVE', 'Structured document migration is not active.', 503);
    res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(res, await readChapterTransitions(req.user!.id, Number(req.params.bookId)));
  });
  registerDocumentPublicationRoutes(router);
  registerDocumentOperatorEffectRoutes(router);
  registerDocumentCommentRoutes(router);
  registerDocumentSearchRoutes(router);
  registerDocumentPassageRoutes(router);
  registerScopeDocumentPassageRoutes(router);
  registerDocumentStoryProposalRoutes(router);
  registerDocumentDocxImportRoutes(router);
  router.get('/document-capabilities', (req, res) => {
    respondSuccess(res, { schemaVersion: 1, enabled: documentAuthorityEnabled(), actorId: req.user!.id, revisionPreview: 'disclosed-proposal-v1', revisionSource: 'immutable-manifest-v1', projection: 'final', globalSearch: 'manifest-cursor-v1', searchIndex: 'revision-gin-v1', passages: 'run-window-v1', orderedPassages: 'ordered-window-v1', passageOperations: 'typed-operations-v1', boundedDiscussion:'typed-draft-v1', storyDiscussion:'owned-layout-source-v1', maxPassageCharacters: 32768, maxDocumentBytes: 2 * 1024 * 1024, maxCommitBytes: 8 * 1024 * 1024 });
  });
  router.get('/document-creation-operations/:operationId', zParams(z.object({ operationId: z.string().uuid() })), async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(res, await documentService.createdBookOperation(req.user!.id, String(req.params.operationId)));
  });
  router.get('/:bookId/document-capabilities', zParams(params), ownedBookBudget({ source: 'params', required: true }), (req, res) => {
    respondSuccess(res, { schemaVersion: 1, enabled: documentAuthorityEnabled(), actorId: req.user!.id, revisionPreview: 'disclosed-proposal-v1', revisionSource: 'immutable-manifest-v1', projection: 'final', globalSearch: 'manifest-cursor-v1', searchIndex: 'revision-gin-v1', passages: 'run-window-v1', orderedPassages: 'ordered-window-v1', passageOperations: 'typed-operations-v1', boundedDiscussion:'typed-draft-v1', storyDiscussion:'owned-layout-source-v1', maxPassageCharacters: 32768, maxDocumentBytes: 2 * 1024 * 1024, maxCommitBytes: 8 * 1024 * 1024 });
  });
  router.use(['/:bookId/document-discussions', '/:bookId/document-proposals/:proposalId', '/:bookId/document-inference-operations/:operationId', '/:bookId/document-quick-drafts', '/:bookId/document-initialize', '/:bookId/document-manifest', '/:bookId/document-commits', '/:bookId/document-layout-commits', '/:bookId/document-layout-revisions/:revisionId', '/:bookId/document-scopes/:scope', '/:bookId/document-operations/:operationId', '/:bookId/document-revisions/:revisionId/restore', '/:bookId/scenes/:sceneId/document'], (_req, _res, next) => {
    if (!documentAuthorityEnabled()) return next(new DocumentError('DOCUMENT_AUTHORITY_INACTIVE', 'Structured document migration is not active.', 503));
    next();
  });
  router.post('/:bookId/document-quick-drafts', zParams(params), (req, _res, next) => { requireDocumentPreconditions(req.body, false); if (!req.body?.expectedScopes?.structure) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'The source structure revision is required.', 428); next(); }, zBody(documentQuickDraftSchema), ownedBookBudget({ source: 'params', required: true }), async (req, res) => {
    respondSuccess(res, await createDocumentQuickDraft(req.user!.id, Number(req.params.bookId), req.body), 201);
  });
  const discussionParams = params.extend({ discussionId: z.string().uuid() });
  router.use('/:bookId/document-workflow-effects', (_req, _res, next) => {
    if (!documentAuthorityEnabled()) return next(new DocumentError('DOCUMENT_AUTHORITY_INACTIVE', 'Structured document migration is not active.', 503)); next();
  });
  router.get('/:bookId/document-workflow-effects', zParams(params), async (req, res) => {
    const query = z.object({ runId: z.string().uuid(), cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    res.setHeader('Cache-Control', 'private, no-store'); respondSuccess(res, await listWorkflowEffects(req.user!.id, Number(req.params.bookId), query.runId, query.cursor, query.limit));
  });
  router.get('/:bookId/document-workflow-effects/:operationId', zParams(params.extend({ operationId: z.string().uuid() })), async (req, res) => {
    const query = z.object({ view: z.enum(['status','request','result']).default('status'), offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1024).max(32768).default(16384) }).parse(req.query);
    res.setHeader('Cache-Control', 'private, no-store'); respondSuccess(res, await workflowEffectPage(req.user!.id, Number(req.params.bookId), String(req.params.operationId), query.view, query.offset, query.limit));
  });
  router.post('/:bookId/document-workflow-effects/:operationId/cancel', zParams(params.extend({ operationId: z.string().uuid() })), zBody(z.object({}).strict()), async (req, res) => {
    respondSuccess(res, await cancelWorkflowEffect(req.user!.id, Number(req.params.bookId), String(req.params.operationId)));
  });
  router.use(['/:bookId/import-originals', '/:bookId/import-previews'], (_req, _res, next) => {
    if (!documentAuthorityEnabled()) return next(new DocumentError('DOCUMENT_AUTHORITY_INACTIVE', 'Structured document migration is not active.', 503));
    next();
  });
  const originalParams = params.extend({ originalId: z.string().uuid() });
  const previewParams = params.extend({ previewId: z.string().uuid() });
  router.post('/:bookId/import-originals/:originalId', zParams(originalParams), ownedBookBudget({ source: 'params', required: true }), redisRateLimit({ key: (req) => `import-original:${req.user?.id}`, limit: 30, windowSec: 3600 }), (req, _res, next) => { if (!req.is('application/octet-stream')) throw new DocumentError('DOCUMENT_IMPORT_MEDIA_TYPE_INVALID', 'Upload original bytes as application/octet-stream.', 415); next(); }, (req, res, next) => { raw({ type: 'application/octet-stream', limit: '32mb' })(req, res, (error: unknown) => { if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') next(new DocumentError('DOCUMENT_IMPORT_TOO_LARGE', 'Original exceeds 32 MiB.', 413)); else next(error); }); }, async (req, res) => {
    respondSuccess(res, await preserveImportOriginal(req.user!.id, Number(req.params.bookId), String(req.params.originalId), 'legacy-markdown-bundle-v1', req.body), 201);
  });
  router.get('/:bookId/import-originals/:originalId/content', zParams(originalParams), async (req, res) => {
    const original = await readImportOriginal(req.user!.id, Number(req.params.bookId), String(req.params.originalId));
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Type', original.format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/json'); res.setHeader('Content-Disposition', `attachment; filename="original-${original.id}.${original.format === 'docx' ? 'docx' : 'json'}"`); res.setHeader('Content-Length', original.byteLength); res.setHeader('X-Content-Sha256', original.sha256); res.send(Buffer.from(original.bytes));
  });
  router.post('/:bookId/import-previews', zParams(params), (req, _res, next) => { requireDocumentPreconditions(req.body, false); next(); }, zBody(importPreviewSchema), async (req, res) => {
    respondSuccess(res, await prepareLegacyBundleImport(req.user!.id, Number(req.params.bookId), req.body));
  });
  router.get('/:bookId/import-previews/:previewId', zParams(previewParams), async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store'); respondSuccess(res, await readImportPreview(req.user!.id, Number(req.params.bookId), String(req.params.previewId)));
  });
  router.post('/:bookId/import-previews/:previewId/commit', zParams(previewParams), (req, _res, next) => { requireImportCommitPreconditions(req.body); next(); }, zBody(importCommitSchema), async (req, res) => {
    respondSuccess(res, await commitLegacyBundleImport(req.user!.id, Number(req.params.bookId), String(req.params.previewId), req.body));
  });
  router.use(['/:bookId/document-traces', '/:bookId/document-analysis-operations/:operationId'], (_req, _res, next) => {
    if (!documentAuthorityEnabled()) return next(new DocumentError('DOCUMENT_AUTHORITY_INACTIVE', 'Structured document migration is not active.', 503));
    next();
  });
  router.get('/:bookId/document-traces', zParams(params), async (req, res) => {
    const sceneId = z.coerce.number().int().positive().parse(req.query.sceneId);
    res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(res, await readDocumentTraceReview(req.user!.id, Number(req.params.bookId), sceneId));
  });
  router.post('/:bookId/document-traces/:traceId/compare-cards/:cardId/revalidate', zParams(params.extend({ traceId: z.string().min(1).max(255), cardId: z.coerce.number().int().positive() })), requireComparePreconditions, zBody(documentCompareRevalidateSchema), async (req, res) => {
    respondSuccess(res, await revalidateBoundCompare(req.user!.id, Number(req.params.bookId), String(req.params.traceId), Number(req.params.cardId), req.body));
  });
  router.get('/:bookId/document-analysis-operations/:operationId', zParams(params.extend({ operationId: z.string().uuid() })), async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(res, await readTraceAnalysis(req.user!.id, Number(req.params.bookId), String(req.params.operationId)));
  });
  router.post('/:bookId/document-analysis-operations/:operationId/cancel', zParams(params.extend({ operationId: z.string().uuid() })), zBody(z.object({}).strict()), async (req, res) => {
    respondSuccess(res, await cancelTraceAnalysis(req.user!.id, Number(req.params.bookId), String(req.params.operationId)));
  });
  const proposalParams = params.extend({ proposalId: z.string().uuid() });
  router.get('/:bookId/document-discussions', zParams(params), ownedBookBudget({ source: 'params', required: true, includeDeleted: true }), async (req, res) => {
    const sceneId = z.coerce.number().int().positive().parse(req.query.sceneId);
    const discussions = await databaseService.client.documentDiscussion.findMany({ where: { bookId: Number(req.params.bookId), userId: req.user!.id, sceneId }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, bookId: true, sceneId: true, sessionId: true, snapshot: true, createdAt: true } });
    res.setHeader('Cache-Control', 'private, no-store'); respondSuccess(res, discussions);
  });
  router.get('/:bookId/document-discussions/:discussionId/proposals', zParams(discussionParams), async (req, res) => {
    await readDocumentDiscussion(req.user!.id, Number(req.params.bookId), String(req.params.discussionId));
    const proposals = await databaseService.client.documentProposal.findMany({ where: { discussionId: String(req.params.discussionId), userId: req.user!.id, bookId: Number(req.params.bookId) }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, status: true, createdAt: true } });
    res.setHeader('Cache-Control', 'private, no-store'); respondSuccess(res, proposals);
  });
  router.post('/:bookId/document-discussions', zParams(params), (req, _res, next) => { requireDocumentPreconditions(req.body, false); next(); }, zBody(documentDiscussionSchema), async (req, res) => {
    respondSuccess(res, await createDocumentDiscussion(req.user!.id, Number(req.params.bookId), req.body));
  });
  router.get('/:bookId/document-discussions/:discussionId', zParams(discussionParams), async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(res, await readDocumentDiscussion(req.user!.id, Number(req.params.bookId), String(req.params.discussionId)));
  });
  router.post('/:bookId/document-discussions/:discussionId/proposals', zParams(discussionParams), zBody(documentProposalRequestSchema), ownedBookBudget({ source: 'params', required: true }), expensiveRouteLimit('documentProposal'), async (req, res) => {
    respondSuccess(res, await requestDocumentProposal(req.user!.id, Number(req.params.bookId), String(req.params.discussionId), req.body));
  });
  router.get('/:bookId/document-proposals/:proposalId', zParams(proposalParams), async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(res, await readDocumentProposal(req.user!.id, Number(req.params.bookId), String(req.params.proposalId)));
  });
  router.post('/:bookId/document-proposals/:proposalId/cancel', zParams(proposalParams), zBody(z.object({}).strict()), async (req, res) => {
    respondSuccess(res, await cancelDocumentProposal(req.user!.id, Number(req.params.bookId), String(req.params.proposalId)));
  });
  router.post('/:bookId/document-proposals/:proposalId/revalidate', zParams(proposalParams), (req, _res, next) => { requireDocumentPreconditions(req.body, false); next(); }, zBody(documentProposalRevalidateSchema), async (req, res) => {
    respondSuccess(res, await revalidateDocumentProposal(req.user!.id, Number(req.params.bookId), String(req.params.proposalId), req.body));
  });
  router.post('/:bookId/document-proposals/:proposalId/apply', zParams(proposalParams), (req, _res, next) => { requireDocumentPreconditions(req.body, false); next(); }, zBody(documentProposalApplySchema), async (req, res) => {
    respondSuccess(res, await applyDocumentProposal(req.user!.id, Number(req.params.bookId), String(req.params.proposalId), req.body));
  });
  router.post('/:bookId/document-initialize', zParams(params), ownedBookBudget({ source: 'params', required: true }), async (req, res) => {
    respondSuccess(res, { revisionId: await documentService.initialize(req.user!.id, Number(req.params.bookId)) });
  });
  router.get('/:bookId/document-manifest', zParams(params), async (req, res) => {
    const manifest = await documentService.manifest(req.user!.id, Number(req.params.bookId));
    res.setHeader('ETag', `"${manifest.revisionId}"`); res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(res, manifest);
  });
  router.get('/:bookId/document-scopes/:scope', zParams(params.extend({ scope: z.enum(['structure', 'canon', 'layout']) })), async (req, res) => {
    const scope = await documentService.scope(req.user!.id, Number(req.params.bookId), req.params.scope as 'structure' | 'canon' | 'layout');
    res.setHeader('ETag', `"${scope.revisionId}"`); res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(res, scope);
  });
  router.get('/:bookId/scenes/:sceneId/document', zParams(params.extend({ sceneId: z.coerce.number().int().positive() })), async (req, res) => {
    const document = await documentService.read(req.user!.id, Number(req.params.bookId), Number(req.params.sceneId));
    res.setHeader('ETag', `"${document.revisionId}"`); res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(res, document);
  });
  router.use(['/:bookId/document-commits', '/:bookId/document-layout-commits', '/:bookId/document-revisions/:revisionId/restore'], zParams(params), ownedBookBudget({ source: 'params', required: true, includeDeleted: true }), (req, _res, next) => {
    if (req.method === 'POST') requireDocumentPreconditions(req.body, req.baseUrl.replace(/\/$/, '').endsWith('/document-commits'));
    if (req.method === 'POST' && req.baseUrl.replace(/\/$/, '').endsWith('/document-layout-commits') && !req.body?.expectedScopes?.layout) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Expected layout scope revision is required.', 428);
    next();
  });
  router.post('/:bookId/document-commits', zParams(params), zBody(commitSchema), async (req, res) => {
    respondSuccess(res, await documentService.commit(req.user!.id, Number(req.params.bookId), req.body as DocumentCommit));
  });
  router.post('/:bookId/document-layout-commits', zParams(params), zBody(documentLayoutCommitSchema), async (req, res) => {
    const layout = validateBookLayout(req.body.layout, { commentCandidates: !req.body.restoreFromRevisionId });
    respondSuccess(res, await documentService.mutateCatalog(req.user!.id, Number(req.params.bookId), { operationId: req.body.operationId, expectedRevisionId: req.body.expectedRevisionId, expectedScopes: req.body.expectedScopes, payload: req.body }, async () => ({ result: { changedScope: 'layout', ...(req.body.restoreFromRevisionId ? { restoredFromLayoutRevisionId: req.body.restoreFromRevisionId } : {}) }, layout, restoreLayoutFromRevisionId: req.body.restoreFromRevisionId })));
  });
  router.get('/:bookId/document-layout-revisions/:revisionId', zParams(params.extend({ revisionId: z.string().uuid() })), ownedBookBudget({ source: 'params', required: true }), async (req, res) => {
    const revision = await documentService.layoutRevision(req.user!.id, Number(req.params.bookId), String(req.params.revisionId));
    res.setHeader('ETag', `"${revision.revisionId}"`); res.setHeader('Cache-Control', 'private, no-store'); respondSuccess(res, revision);
  });
  router.get('/:bookId/document-inference-operations/:operationId', zParams(params.extend({ operationId: z.string().uuid() })), async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(res, await readSceneGeneration(req.user!.id, Number(req.params.bookId), String(req.params.operationId)));
  });
  router.post('/:bookId/document-inference-operations/:operationId/cancel', zParams(params.extend({ operationId: z.string().uuid() })), zBody(z.object({}).strict()), async (req, res) => {
    respondSuccess(res, await cancelSceneGeneration(req.user!.id, Number(req.params.bookId), String(req.params.operationId)));
  });
  router.get('/:bookId/document-operations/:operationId', zParams(params.extend({ operationId: z.string().uuid() })), async (req, res) => {
    respondSuccess(res, await documentService.operation(req.user!.id, Number(req.params.bookId), String(req.params.operationId)));
  });
  router.post('/:bookId/document-revisions/:revisionId/restore', zParams(params.extend({ revisionId: z.string().uuid() })), zBody(z.object({ expectedRevisionId: z.string().uuid(), operationId: z.string().uuid() }).strict()), ownedBookBudget({ source: 'params', required: true, includeDeleted: true }), async (req, res) => {
    respondSuccess(res, await documentService.restore(req.user!.id, Number(req.params.bookId), String(req.params.revisionId), req.body.expectedRevisionId, req.body.operationId));
  });
}
