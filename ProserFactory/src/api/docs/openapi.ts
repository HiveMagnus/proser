import { campaignMutationSchema, campaignAnalysisSchema, campaignDecisionSchema } from '@/documents/campaignValidation';
import { plotThreadMutationSchema, plotThreadEvidenceSchema, plotThreadOperationSchema, plotThreadReviewSchema, plotThreadAssessmentSchema } from '@/documents/plotThreadValidation';
import { passageScopeTransferSchema, passageScopeRestoreSchema } from '@/documents/scopePassageValidation';
import { docxImportCommitSchema } from '@/documents/importValidation';
import { publicationJobSchema } from '@/documents/publicationValidation';
/**
 * OpenAPI specification generator — builds a full OpenAPI 3.0 document from
 * the project's Zod schemas via @asteasolutions/zod-to-openapi.
 *
 * Usage:
 *   import { openApiSpec } from './openapi';
 *   app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
 */

import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { creativeImageSchema } from '../schemas/creativeImports';
import { z } from 'zod';

// Extend Zod once at module load so .openapi() is available everywhere
extendZodWithOpenApi(z);

// ── Registry ───────────────────────────────────────────────────
const registry = new OpenAPIRegistry();
const registeredPaths = new Set<string>();
type OpenApiPathRegistration = Parameters<OpenAPIRegistry['registerPath']>[0];

function registerPath(registration: OpenApiPathRegistration): void {
  const key = `${String(registration.method).toUpperCase()} ${registration.path}`;
  if (registeredPaths.has(key)) {
    throw new Error(`Conflicting duplicate OpenAPI route metadata: ${key}`);
  }
  registeredPaths.add(key);
  registry.registerPath(registration);
}

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Short-lived JWT issued for ProserFactory.',
});
registry.registerComponent('securitySchemes', 'internalSecret', {
  type: 'apiKey',
  in: 'header',
  name: 'X-Internal-Secret',
});
registry.registerComponent('securitySchemes', 'metricsToken', {
  type: 'apiKey',
  in: 'header',
  name: 'X-Metrics-Token',
  description: 'Dedicated production metrics credential.',
});

// ── Import schemas ─────────────────────────────────────────────
import {
  paginationQuery, bookIdParams, idParams,
} from '../schemas/shared';
import {
  createBookBody, updateBookBody, codexSearchQuery, createCodexBody,
  saveStructureBody, reorderActsBody, reorderChaptersBody,
  actChapterBody, bookIdActIdParams, bookIdChapterIdParams,
  bookIdSceneIdParams, sceneBody, reorderScenesBody,
  bookIdNoteIdParams, noteBody, exportQuery, createExportArtifactBody,
  exportArtifactParams, readExportArtifactQuery, compatibilityProjectionQuery,
} from '../schemas/books';
import {
  codexGenBody, outlineBody, summaryBody, titleBody, taglineBody,
  inlineSuggestionBody, feedbackBody, structureGenBody, proseBody,
  proseOperationBody, batchProseBody,
} from '../schemas/generate';
import { chapterIdParams, sceneIdParams, applyFeedbackBody } from '../schemas/feedback';
import { codexIdParams, updateCodexBody } from '../schemas/codex';
import { generateImageBody, generateFluxBody } from '../schemas/images';
import { editorialOptimizeSchema, editorialProfileSchema, editorialPreferenceSchema } from '../schemas/editorial';
import { documentCommitSchema, documentLayoutCommitSchema, documentQuickDraftSchema } from '../schemas/documents';
import { documentDiscussionSchema, documentProposalRequestSchema, documentProposalRevalidateSchema, documentProposalApplySchema } from '@/documents/proposalValidation';
import { documentStoryDiscussionSchema, documentStoryProposalRevalidateSchema, documentStoryProposalApplySchema, documentStoryDraftCommitSchema } from '@/documents/storyProposalValidation';
import { documentCompareRevalidateSchema } from '@/documents/traceValidation';
import { importCommitSchema } from '@/documents/importValidation';
import {documentSearchQuery,documentSearchIndexRecoverySchema} from '@/documents/searchValidation';
import {passageOperationCommitSchema,passageBookCommitSchema,passageReviewQuery} from '@/documents/passageOperationCommits';
import {passageCommentCommitSchema,passageCommentPageQuery} from '@/documents/passageComments';
import {documentPassageQuery,documentPassageCommitSchema,documentPassageRestoreSchema} from '@/documents/passageValidation';
import {sceneCommentParams,sceneCommentReviewParams,sceneCommentRevalidation,sceneCommentResolution,layoutCommentParams,layoutCommentReviewParams,layoutCommentRevalidation,layoutCommentResolution} from '../schemas/documentComments';

// ── Helpers ────────────────────────────────────────────────────

/** Standard success envelope */
const successEnvelope = (dataSchema: z.ZodTypeAny, description: string) => ({
  description,
  content: {
    'application/json': {
      schema: z.object({ success: z.literal(true), data: dataSchema }),
    },
  },
});

/** Standard error envelope */
const errorResponse = (description: string, _status: number) => ({
  description,
  content: {
    'application/json': {
      schema: z.object({
        success: z.literal(false),
        error: z.object({
          code: z.string(),
          message: z.string(),
          details: z.any().optional(),
        }),
      }),
    },
  },
});

const authHeader = [{ bearerAuth: [] }];

for (const [path, summary] of [
  ['/api/books/{bookId}/document-capabilities', 'Structured document capabilities and activation status'],
  ['/api/books/{bookId}/chapter-transitions', 'First three actual adjacent chapter endings/openings from one owned saved manuscript revision'],
  ['/api/books/{bookId}/document-manifest', 'Owned revision-bound document manifest (requires authority activation)'],
  ['/api/books/{bookId}/scenes/{sceneId}/document', 'Canonical scene document and deterministic projection'],
  ['/api/books/{bookId}/document-operations/{operationId}', 'Recover an owned durable document save receipt'],
  ['/api/books/{bookId}/document-inference-operations/{operationId}', 'Recover an owned frozen scene-generation request, provider outcome and application receipt'],
] as const) registerPath({ method: 'get', path, summary, tags: ['Documents'], security: authHeader, responses: { 200: successEnvelope(z.unknown(), summary), 503: errorResponse('Document authority inactive or unavailable', 503) } });
const campaignBase = '/api/books/{bookId}/revision-campaigns';
for (const [suffix, summary] of [['', 'List owned revision campaigns'], ['/{campaignId}', 'Read campaign plans, coverage, freshness and decisions'], ['/{campaignId}/plans/{planId}', 'Read an exact historical campaign plan'], ['/operations/{operationId}', 'Recover an exact campaign operation receipt']] as const) registerPath({ method: 'get', path: campaignBase + suffix, summary, tags: ['Revision Campaigns'], security: authHeader, responses: { 200: successEnvelope(z.unknown(), summary), 404: errorResponse('Owned campaign unavailable', 404) } });
for (const [method, suffix, summary, schema] of [
  ['post', '', 'Create a revision campaign without changing manuscript text', campaignMutationSchema],
  ['patch', '/{campaignId}', 'Update campaign rules and invalidate prior actionable plans', campaignMutationSchema],
  ['post', '/{campaignId}/analyses', 'Launch bounded whole-book planning, candidate preview or post-edit re-review; returns WorkflowRun reference', campaignAnalysisSchema],
  ['post', '/{campaignId}/plans/{planId}/decisions', 'Record explicit plan approval or a reasoned step decision; approval does not apply prose', campaignDecisionSchema],
] as const) registerPath({ method, path: campaignBase + suffix, summary, tags: ['Revision Campaigns'], security: authHeader, request: { body: { content: { 'application/json': { schema } } } }, responses: { 200: successEnvelope(z.unknown(), summary), 202: successEnvelope(z.unknown(), 'Analysis accepted'), 409: errorResponse('Campaign conflict or recovery required', 409), 412: errorResponse('Campaign source changed', 412) } });
const plotBase = '/api/books/{bookId}/plot-threads';
for (const [suffix, summary] of [
  ['', 'List owned plot threads with linked-stage coverage; archived and after query pagination'],
  ['/{threadId}', 'Read an owned thread, exact linked excerpts and latest twenty retained reviews'],
  ['/operations/{operationId}', 'Recover the exact owned thread mutation receipt'],
  ['/{threadId}/reviews/{reviewId}', 'Read an exact retained payoff review and its source staleness'],
] as const) registerPath({ method: 'get', path: plotBase + suffix, summary, tags: ['Plot Threads'], security: authHeader, responses: { 200: successEnvelope(z.unknown(), summary), 404: errorResponse('Owned source not found', 404) } });
for (const [method, suffix, summary, schema] of [
  ['post', '', 'Create an author-managed story question with operation UUID and version zero', plotThreadMutationSchema],
  ['patch', '/{threadId}', 'Update or archive a version-checked thread with an exact receipt', plotThreadMutationSchema],
  ['post', '/{threadId}/evidence', 'Attach or replace an exact saved excerpt after source validation', plotThreadEvidenceSchema],
  ['post', '/{threadId}/evidence/{evidenceId}/remove', 'Remove a link while retaining the original evidence', plotThreadOperationSchema],
  ['post', '/{threadId}/reviews', 'Review frozen linked excerpts and persist cited critique without prose mutation', plotThreadReviewSchema],
  ['post', '/{threadId}/reviews/{reviewId}/assessment', 'Save the author assessment separately from the AI assessment', plotThreadAssessmentSchema],
  ['post', '/{threadId}/reviews/{reviewId}/cancel', 'Cancel the original owned review without replay', z.object({}).strict()],
] as const) registerPath({ method, path: plotBase + suffix, summary, tags: ['Plot Threads'], security: authHeader, request: { body: { content: { 'application/json': { schema } } } }, responses: { 200: successEnvelope(z.unknown(), summary), 409: errorResponse('Thread or operation conflict', 409), 412: errorResponse('Saved source changed', 412) } });
const storySourceParams = bookIdParams.extend({storyId:z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/)});
registerPath({method:'get',path:'/api/books/{bookId}/layout-stories/{storyId}/document',summary:'Read a revision-pinned owned front/back/header/footer story with layout and content hashes',tags:['Documents'],security:authHeader,request:{params:storySourceParams,query:z.object({bookRevisionId:z.string().uuid().optional()}).strict()},responses:{200:successEnvelope(z.unknown(),'Owned canonical story and exact book/layout source'),404:errorResponse('Owned story unavailable',404),503:errorResponse('Document authority inactive',503)}});
for (const [path, summary, params, query] of [
 ['/api/books/{bookId}/document-story-discussions','List retained owned discussions for one stable layout story',bookIdParams,z.object({storyId:storySourceParams.shape.storyId}).strict()],
 ['/api/books/{bookId}/document-story-discussions/{discussionId}','Recover an owned frozen story discussion and its exact draft intents',bookIdParams.extend({discussionId:z.string().uuid()}),undefined],
 ['/api/books/{bookId}/document-story-discussions/{discussionId}/proposals','List retained proposals for the exact owned story discussion',bookIdParams.extend({discussionId:z.string().uuid()}),undefined],
 ['/api/books/{bookId}/document-story-proposals/{proposalId}','Recover an owned proposal, validation and complete sparse application receipt',bookIdParams.extend({proposalId:z.string().uuid()}),undefined],
] as const) registerPath({method:'get',path,summary,tags:['Documents'],security:authHeader,request:{params,...(query?{query}:{})},responses:{200:successEnvelope(z.unknown(),summary),404:errorResponse('Owned record unavailable',404),503:errorResponse('Document authority inactive',503)}});
for (const [path,summary,params,schema] of [
 ['/api/books/{bookId}/layout-stories/{storyId}/document-draft-commits','Commit exact typed derivative story intents through the owned layout authority',storySourceParams,documentStoryDraftCommitSchema],
 ['/api/books/{bookId}/document-story-discussions','Freeze and disclose complete owned story blocks or a validated typed draft without inference',bookIdParams,documentStoryDiscussionSchema],
 ['/api/books/{bookId}/document-story-discussions/{discussionId}/proposals','Request a durable typed text proposal from the frozen disclosed story context',bookIdParams.extend({discussionId:z.string().uuid()}),documentProposalRequestSchema],
 ['/api/books/{bookId}/document-story-proposals/{proposalId}/cancel','Cancel owned story inference while retaining uncertain or late outcomes',bookIdParams.extend({proposalId:z.string().uuid()}),z.object({}).strict()],
 ['/api/books/{bookId}/document-story-proposals/{proposalId}/revalidate','Revalidate stable story targets against the flushed book/layout source',bookIdParams.extend({proposalId:z.string().uuid()}),documentStoryProposalRevalidateSchema],
 ['/api/books/{bookId}/document-story-proposals/{proposalId}/apply','Apply exact revalidated story proposals atomically as authenticated tracked changes',bookIdParams.extend({proposalId:z.string().uuid()}),documentStoryProposalApplySchema],
] as const) registerPath({method:'post',path,summary,tags:['Documents'],security:authHeader,request:{params,body:{content:{'application/json':{schema}}}},responses:{200:successEnvelope(z.unknown(),summary),409:errorResponse('Incompatible intent, target or proposal state',409),412:errorResponse('Exact story/book/layout source changed',412),413:errorResponse('Complete context exceeds its supported budget',413),428:errorResponse('Mutation preconditions required',428),503:errorResponse('Document authority inactive',503)}});
registerPath({ method: 'post', path: '/api/books/{bookId}/document-initialize', summary: 'Explicit idempotent structured document initialization (fence legacy writers first)', tags: ['Documents'], security: authHeader, responses: { 200: successEnvelope(z.unknown(), 'Initial revision'), 503: errorResponse('Document authority inactive', 503) } });
for (const [path, summary, schema] of [
  ['/api/books/{bookId}/document-discussions', 'Prepare/disclose frozen owned saved or derivative draft context without inference', documentDiscussionSchema],
  ['/api/books/{bookId}/document-discussions/{discussionId}/proposals', 'Persist a recoverable typed text proposal from the disclosed context', documentProposalRequestSchema],
  ['/api/books/{bookId}/document-proposals/{proposalId}/revalidate', 'Explicitly revalidate stable targets against a flushed saved revision', documentProposalRevalidateSchema],
  ['/api/books/{bookId}/document-proposals/{proposalId}/apply', 'Apply selected revalidated proposals atomically as pending tracked changes', documentProposalApplySchema],
  ['/api/books/{bookId}/document-proposals/{proposalId}/cancel', 'Cancel discussion inference and suppress late application', z.object({}).strict()],
  ['/api/books/{bookId}/document-traces/{traceId}/compare-cards/{cardId}/revalidate', 'Explicitly revalidate a stable saved compare target after flushing edits', documentCompareRevalidateSchema],
  ['/api/books/{bookId}/document-analysis-operations/{operationId}/cancel', 'Cancel saved trace analysis and suppress late results', z.object({}).strict()],
  ['/api/books/{bookId}/document-workflow-effects/{operationId}/cancel', 'Cancel a pending/running owned provider effect while retaining unknown or late outcomes', z.object({}).strict()],
  ['/api/books/{bookId}/document-operator-effects/{operationId}/cancel', 'Cancel an owned CLI/operator effect without replaying uncertain provider work', z.object({}).strict()],
  ['/api/books/{bookId}/import-previews', 'Convert preserved legacy Markdown originals into a reviewable append mapping and fidelity report', z.object({ operationId: z.string().uuid(), originalId: z.string().uuid(), expectedRevisionId: z.string().uuid() }).strict()],
  ['/api/books/{bookId}/document-publication-jobs', 'Admit an owned exact-revision publication job with durable idempotency', publicationJobSchema],
  ['/api/books/{bookId}/document-publication-jobs/{jobId}/resume', 'Recover/re-render the original immutable local publication source', z.object({}).strict()],
  ['/api/books/{bookId}/document-publication-jobs/{jobId}/cancel', 'Cancel publication without changing manuscript review or completed artifacts', z.object({}).strict()],
  ['/api/books/{bookId}/docx-import-previews', 'Bounded server DOCX conversion from an already preserved immutable original', z.object({ operationId: z.string().uuid(), originalId: z.string().uuid(), expectedRevisionId: z.string().uuid() }).strict()],
  ['/api/books/{bookId}/docx-import-previews/{previewId}/commit', 'Commit reviewed DOCX conversion, authenticated imported attribution and exact loss consent', docxImportCommitSchema],
  ['/api/books/{bookId}/import-previews/{previewId}/commit', 'Commit an append import with exact loss-report consent, source scopes and a durable receipt', importCommitSchema],
] as const) registerPath({ method: 'post', path, summary, tags: ['Documents'], security: authHeader, request: { body: { content: { 'application/json': { schema } } } }, responses: { 200: successEnvelope(z.unknown(), summary), 409: errorResponse('Target, operation or proposal state conflict', 409), 412: errorResponse('Saved source revision changed', 412), 413: errorResponse('Complete context exceeds its supported budget', 413), 428: errorResponse('Mutation preconditions required', 428), 503: errorResponse('Document authority inactive', 503) } });
for (const [path, summary] of [
  ['/api/books/{bookId}/document-discussions', 'List bounded owned context snapshots for a scene'],
  ['/api/books/{bookId}/document-discussions/{discussionId}/proposals', 'List bounded owned proposal identities for restart recovery'],
  ['/api/books/{bookId}/document-discussions/{discussionId}', 'Read an owned retained discussion/context snapshot'],
  ['/api/books/{bookId}/document-proposals/{proposalId}', 'Recover an owned proposal, provider outcome and application receipt'],
  ['/api/books/{bookId}/document-traces', 'Read bounded latest scene findings and stable target states without quotation relocation'],
  ['/api/books/{bookId}/document-analysis-operations/{operationId}', 'Recover retained trace analysis without replaying an unknown provider effect'],
  ['/api/books/{bookId}/document-workflow-effects', 'List bounded owned workflow provider effect identities for restart recovery'],
  ['/api/books/{bookId}/document-workflow-effects/{operationId}', 'Read owned effect status or bounded UTF-16 pages of frozen request/retained result'],
  ['/api/books/{bookId}/document-operator-effects', 'Enumerate owned operator effects through stable bounded cursors'],
  ['/api/books/{bookId}/document-operator-effects/{operationId}', 'Recover exact operator effect status and bounded frozen request/result pages'],
  ['/api/books/{bookId}/document-publication-capabilities', 'Factory formats, real renderer availability, review modes and publication presets'],
  ['/api/books/{bookId}/document-publication-jobs', 'Owned retained publication history with bounded cursor pagination'],
  ['/api/books/{bookId}/document-publication-jobs/{jobId}', 'Recover durable job status, exact source revision and artifact download references'],
  ['/api/books/{bookId}/document-publication-artifacts/{artifactId}', 'Owned immutable artifact checksum, normalized options, renderer/fonts and validation provenance'],
  ['/api/books/{bookId}/docx-import-previews/{previewId}', 'Owned conversion report, proposed heading mapping and canonical scene previews'],
  ['/api/books/{bookId}/import-previews/{previewId}', 'Read an owned retained conversion report and heading mapping before allocating hierarchy IDs'],
] as const) registerPath({ method: 'get', path, summary, tags: ['Documents'], security: authHeader, responses: { 200: successEnvelope(z.unknown(), summary), 404: errorResponse('Owned record not found', 404), 503: errorResponse('Document authority inactive', 503) } });
registerPath({ method: 'post', path: '/api/books/{bookId}/document-inference-operations/{operationId}/cancel', summary: 'Cancel an owned scene generation; preserve provider evidence and already committed results', tags: ['Documents'], security: authHeader, request: { body: { content: { 'application/json': { schema: z.object({}).strict() } } } }, responses: { 200: successEnvelope(z.unknown(), 'Durable cancellation status'), 404: errorResponse('Owned operation not found', 404), 409: errorResponse('Resource authority conflict', 409), 503: errorResponse('Document authority inactive', 503) } });
for (const [path, mediaType, summary] of [
 ['/api/books/{bookId}/document-publication-artifacts/{artifactId}/download','application/octet-stream','Download owned immutable artifact bytes with checked SHA-256 and private cache policy'],
 ['/api/books/{bookId}/document-publication-artifacts/{artifactId}/review','application/json','Download retained review sidecar without accepting manuscript changes'],
] as const) registerPath({method:'get',path,summary,tags:['Documents'],security:authHeader,responses:{200:{description:summary,content:{[mediaType]:{schema:z.string().openapi({type:'string',format:'binary'})}}},404:errorResponse('Owned artifact not found',404)}});
registerPath({method:'post',path:'/api/books/{bookId}/docx-import-originals/{originalId}',summary:'Preserve exact owned DOCX bytes before bounded conversion; original retained on conversion failure',tags:['Documents'],security:authHeader,request:{body:{content:{'application/octet-stream':{schema:z.string().openapi({type:'string',format:'binary'})}}}},responses:{201:successEnvelope(z.unknown(),'Preserved original ID/SHA/size'),413:errorResponse('Original exceeds 32 MiB',413),415:errorResponse('Wrong upload media type',415)}});
registerPath({ method: 'get', path: '/api/books/document-capabilities', summary: 'Authenticated document capabilities before first-book creation', tags: ['Documents'], security: authHeader, responses: { 200: successEnvelope(z.unknown(), 'Document capabilities') } });
registerPath({ method: 'get', path: '/api/books/document-creation-operations/{operationId}', summary: 'Recover an owned book creation acknowledgement without repeating the mutation', tags: ['Documents'], security: authHeader, responses: { 200: successEnvelope(z.unknown(), 'Durable owned book creation receipt'), 404: errorResponse('Owned creation operation not found', 404) } });
registerPath({ method: 'post', path: '/api/books/{bookId}/document-quick-drafts', summary: 'Atomically append a mobile drafting scene and any missing hierarchy with source revisions and receipt recovery', tags: ['Documents'], security: authHeader, request: { body: { content: { 'application/json': { schema: documentQuickDraftSchema } } } }, responses: { 201: successEnvelope(z.unknown(), 'Durable quick draft receipt'), 409: errorResponse('Operation identity conflict', 409), 412: errorResponse('Stale book or structure revision', 412), 428: errorResponse('Missing revision preconditions', 428), 503: errorResponse('Document authority inactive', 503) } });
registerPath({ method: 'post', path: '/api/books/{bookId}/document-commits', summary: 'Atomic revision-guarded structured document save', tags: ['Documents'], security: authHeader, request: { body: { content: { 'application/json': { schema: documentCommitSchema } } } }, responses: { 200: successEnvelope(z.unknown(), 'Durable save receipt'), 412: errorResponse('Stale document revision', 412), 428: errorResponse('Missing document preconditions', 428), 503: errorResponse('Document authority inactive', 503) } });
registerPath({ method: 'get', path: '/api/books/{bookId}/document-scopes/{scope}', summary: 'Read an owned immutable structure, canon or layout scope', tags: ['Documents'], security: authHeader, responses: { 200: successEnvelope(z.unknown(), 'Scope content and source revision'), 404: errorResponse('Owned book not found', 404), 503: errorResponse('Document authority inactive', 503) } });
registerPath({ method: 'get', path: '/api/books/{bookId}/document-layout-revisions/{revisionId}', summary: 'Read exact owned immutable layout bytes for acknowledgement recovery and journal restoration', tags: ['Documents'], security: authHeader, responses: { 200: successEnvelope(z.unknown(), 'Layout revision ID, checksum and complete canonical scope'), 404: errorResponse('Owned layout revision not found', 404), 503: errorResponse('Document authority inactive or checksum invalid', 503) } });
registerPath({ method: 'post', path: '/api/books/{bookId}/document-layout-commits', summary: 'Commit book/chapter layout, named styles and ancillary stories with revision preconditions', tags: ['Documents'], security: authHeader, request: { body: { content: { 'application/json': { schema: documentLayoutCommitSchema } } } }, responses: { 200: successEnvelope(z.unknown(), 'Durable layout receipt'), 412: errorResponse('Stale book or scope revision', 412), 428: errorResponse('Missing preconditions', 428), 503: errorResponse('Document authority inactive', 503) } });
registerPath({ method: 'post', path: '/api/books/{bookId}/document-revisions/{revisionId}/restore', summary: 'Restore a complete scene-document manifest with a head precondition', tags: ['Documents'], security: authHeader, request: { body: { content: { 'application/json': { schema: z.object({ expectedRevisionId: z.string().uuid(), operationId: z.string().uuid() }).strict() } } } }, responses: { 200: successEnvelope(z.unknown(), 'Restoration receipt'), 409: errorResponse('Structural restoration required', 409), 412: errorResponse('Stale document revision', 412), 503: errorResponse('Document authority inactive', 503) } });

registerPath({ method: 'post', path: '/api/books/{bookId}/import-originals/{originalId}', summary: 'Preserve exact original bundle bytes before invoking conversion (1 byte to 32 MiB)', tags: ['Documents'], security: authHeader, request: { body: { required: true, content: { 'application/octet-stream': { schema: z.string().openapi({ type: 'string', format: 'binary' }) } } } }, responses: { 201: successEnvelope(z.unknown(), 'Original checksum/size and recovery ID'), 409: errorResponse('Original ID reused for different bytes', 409), 413: errorResponse('Upload exceeds 32 MiB', 413), 415: errorResponse('Original must be an octet-stream', 415), 503: errorResponse('Document authority inactive', 503) } });
registerPath({ method: 'get', path: '/api/books/{bookId}/import-originals/{originalId}/content', summary: 'Download owned preserved original bytes with exact checksum and no external fetching', tags: ['Documents'], security: authHeader, responses: { 200: { description: 'Immutable original bundle', content: { 'application/json': { schema: z.string().openapi({ type: 'string', format: 'binary' }) } } }, 404: errorResponse('Owned original not found', 404), 503: errorResponse('Original checksum invalid or document authority inactive', 503) } });

// ── System ─────────────────────────────────────────────────────

registerPath({
  method: 'get', path: '/api', summary: 'API info', tags: ['System'],
  responses: { 200: successEnvelope(z.object({ service: z.string(), version: z.string(), environment: z.string(), timestamp: z.string() }), 'API metadata') },
});

registerPath({
  method: 'get', path: '/api/health', summary: 'Liveness', tags: ['System'],
  responses: { 200: successEnvelope(z.object({ status: z.string(), time: z.string() }), 'Healthy') },
});

registerPath({
  method: 'get', path: '/api/readiness', summary: 'Readiness', tags: ['System'],
  responses: {
    200: successEnvelope(z.object({ components: z.object({ database: z.enum(['ready', 'unavailable']), redis: z.enum(['healthy', 'disabled', 'unavailable']), editorialRegistry: z.enum(['ready', 'unavailable']), editorialCorpus: z.enum(['ready', 'unavailable']), workers: z.enum(['ready', 'disabled', 'unavailable']), redisPersistence: z.enum(['ready', 'disabled', 'unavailable']) }), ready: z.boolean() }), 'Ready'),
    503: errorResponse('Not ready', 503),
  },
});

registerPath({
  method: 'post', path: '/api/auth/diagnostics/rate-limit', summary: 'Run isolated rate-limit diagnostic', tags: ['System'],
  description: 'Exercises the production Redis limiter in a disposable diagnostic namespace without consuming any user or generation-route budget.',
  security: [{ internalSecret: [] }],
  responses: {
    200: successEnvelope(z.object({
      limit: z.number().int(), attempts: z.number().int(), allowed: z.number().int(), rejected: z.number().int(),
      resetAt: z.number().int(), ordinaryNamespaceUntouched: z.boolean(),
    }), 'Deterministic limiter result'),
    401: errorResponse('Invalid internal credential', 401),
    503: errorResponse('Rate-limit diagnostic unavailable', 503),
  },
});

registerPath({
  method: 'get', path: '/api/shared-resource-operations/{operationId}', summary: 'Recover a fenced Nova provider operation', tags: ['System'],
  security: authHeader,
  request: { params: z.object({ operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) }) },
  responses: { 200: successEnvelope(z.any(), 'Exact operation state and signed terminal evidence'), 404: errorResponse('Not found or outside signed recovery authority', 404) },
});

for (const [path, schema, summary] of [
  ['/api/books/{bookId}/scenes/{sceneId}/document-comments/{commentId}/revalidate', sceneCommentRevalidation, 'Revalidate explicit comment identities against the exact saved scene; never relocate quotations'],
  ['/api/books/{bookId}/scenes/{sceneId}/document-comments/{commentId}/resolve', sceneCommentResolution, 'Resolve, reopen or explicitly reanchor a comment with an idempotent retained receipt'],
] as const) registerPath({method:'post',path,summary,tags:['Documents'],security:authHeader,request:{params:sceneCommentReviewParams,body:{content:{'application/json':{schema}}}},responses:{200:successEnvelope(z.any(),'Owned source proof or committed review receipt'),428:errorResponse('Expected revisions/operation identity required',428),412:errorResponse('Source changed; reconcile explicitly',412),409:errorResponse('Exact comment identity/source proof incompatible',409)}});
registerPath({method:'get',path:'/api/books/{bookId}/scenes/{sceneId}/document-comments',summary:'Read attached and explicitly stale/orphaned comments with immutable owned source proofs',tags:['Documents'],security:authHeader,request:{params:sceneCommentParams},responses:{200:successEnvelope(z.any(),'Scene source revisions and retained comment state')}});

for (const [path, schema, summary] of [
  ['/api/books/{bookId}/layout-stories/{storyId}/document-comments/{commentId}/revalidate', layoutCommentRevalidation, 'Revalidate a classic comment against one exact owned layout-story revision'],
  ['/api/books/{bookId}/layout-stories/{storyId}/document-comments/{commentId}/resolve', layoutCommentResolution, 'Resolve, reopen or explicitly reanchor a layout-story comment with a retained operation receipt'],
] as const) registerPath({method:'post',path,summary,tags:['Documents'],security:authHeader,request:{params:layoutCommentReviewParams,body:{content:{'application/json':{schema}}}},responses:{200:successEnvelope(z.any(),'Owned layout source proof or review receipt'),428:errorResponse('Expected revisions/operation identity required',428),412:errorResponse('Layout source changed',412),409:errorResponse('Comment source incompatible',409)}});
registerPath({method:'get',path:'/api/books/{bookId}/layout-stories/{storyId}/document-comments',summary:'Read attached and detached comments from one owned front/back/header/footer story',tags:['Documents'],security:authHeader,request:{params:layoutCommentParams},responses:{200:successEnvelope(z.any(),'Exact book/layout source revisions and retained story comments')}});

registerPath({method:'get',path:'/api/books/{bookId}/document-search',summary:'Bounded global manuscript search with pinned immutable source cursors and grapheme-safe UTF-16 identities',tags:['Documents'],security:authHeader,request:{params:bookIdParams,query:documentSearchQuery},responses:{200:successEnvelope(z.any(),'Final projection hits, exact manifest/scene hashes, stable anchors and cursor; durable revision-bound GIN index with bounded payload loading'),409:errorResponse('Cursor query/owner/source conflict',409),422:errorResponse('Invalid query/cursor',422),503:errorResponse('Missing or invalid immutable search index; recover through owned bounded indexing',503)}});

// ── Books ──────────────────────────────────────────────────────

registerPath({
  method: 'get', path: '/api/books', summary: 'List books', tags: ['Books'],
  security: authHeader,
  request: { query: paginationQuery },
  responses: { 200: successEnvelope(z.array(z.any()), 'Book list') },
});

registerPath({
  method: 'post', path: '/api/books', summary: 'Create book', tags: ['Books'],
  security: authHeader,
  request: { body: { content: { 'application/json': { schema: createBookBody } } } },
  responses: { 201: successEnvelope(z.any(), 'Created book') },
});

registerPath({
  method: 'get', path: '/api/books/{id}', summary: 'Get revision-bound book metadata; includeProse=1 requests compatibility prose', tags: ['Books'],
  security: authHeader,
  request: { params: idParams, query: compatibilityProjectionQuery },
  responses: { 200: successEnvelope(z.any(), 'Immutable manifest source, hierarchy, counts and optional final prose'), 413: errorResponse('Explicit compatibility prose exceeds 8 MiB; read scene documents or publication artifacts', 413), 404: errorResponse('Not found', 404) },
});

registerPath({
  method: 'put', path: '/api/books/{id}', summary: 'Update book', tags: ['Books'],
  security: authHeader,
  request: { params: idParams, body: { content: { 'application/json': { schema: updateBookBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Updated book') },
});

registerPath({
  method: 'delete', path: '/api/books/{id}', summary: 'Delete book', tags: ['Books'],
  security: authHeader,
  request: { params: idParams },
  responses: { 200: successEnvelope(z.object({ message: z.string() }), 'Deleted') },
});

// ── Book Structure (Acts / Chapters / Scenes) ──────────────────

registerPath({
  method: 'get', path: '/api/books/{bookId}/structure', summary: 'Get book structure', tags: ['Structure'],
  security: authHeader,
  request: { params: bookIdParams },
  responses: { 200: successEnvelope(z.any(), 'Structure tree') },
});

registerPath({
  method: 'post', path: '/api/books/{bookId}/structure', summary: 'Save book structure', tags: ['Structure'],
  security: authHeader,
  request: { params: bookIdParams, body: { content: { 'application/json': { schema: saveStructureBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Saved') },
});

registerPath({
  method: 'post', path: '/api/books/{bookId}/reorder-acts', summary: 'Reorder acts', tags: ['Structure'],
  security: authHeader,
  request: { params: bookIdParams, body: { content: { 'application/json': { schema: reorderActsBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Reordered') },
});

registerPath({
  method: 'post', path: '/api/books/{bookId}/acts/{actId}/reorder-chapters', summary: 'Reorder chapters', tags: ['Structure'],
  security: authHeader,
  request: { params: bookIdActIdParams, body: { content: { 'application/json': { schema: reorderChaptersBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Reordered') },
});

registerPath({
  method: 'post', path: '/api/books/{bookId}/acts/{actId}/chapters', summary: 'Create chapter', tags: ['Structure'],
  security: authHeader,
  request: { params: bookIdActIdParams, body: { content: { 'application/json': { schema: actChapterBody } } } },
  responses: { 201: successEnvelope(z.any(), 'Created') },
});

registerPath({
  method: 'get', path: '/api/books/{bookId}/scenes/{sceneId}', summary: 'Get immutable final scene projection with exact source revisions', tags: ['Structure'],
  security: authHeader,
  request: { params: bookIdSceneIdParams, query: compatibilityProjectionQuery },
  responses: { 200: successEnvelope(z.any(), 'Final scene prose (default), counts and immutable sources; includeProse=0 requests metadata') },
});

registerPath({
  method: 'put', path: '/api/books/{bookId}/scenes/{sceneId}', summary: 'Update scene', tags: ['Structure'],
  security: authHeader,
  request: { params: bookIdSceneIdParams, body: { content: { 'application/json': { schema: sceneBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Updated') },
});

registerPath({
  method: 'post', path: '/api/books/{bookId}/chapters/{chapterId}/reorder-scenes', summary: 'Reorder scenes', tags: ['Structure'],
  security: authHeader,
  request: { params: bookIdChapterIdParams, body: { content: { 'application/json': { schema: reorderScenesBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Reordered') },
});

// ── Codex ──────────────────────────────────────────────────────

registerPath({
  method: 'get', path: '/api/books/{bookId}/codex', summary: 'List codex entries', tags: ['Codex'],
  security: authHeader,
  request: { params: bookIdParams },
  responses: { 200: successEnvelope(z.array(z.any()), 'Codex entries') },
});

registerPath({
  method: 'post', path: '/api/books/{bookId}/codex', summary: 'Create codex entry', tags: ['Codex'],
  security: authHeader,
  request: { params: bookIdParams, body: { content: { 'application/json': { schema: createCodexBody } } } },
  responses: { 201: successEnvelope(z.any(), 'Created') },
});

registerPath({
  method: 'put', path: '/api/codex/{id}', summary: 'Update codex entry', tags: ['Codex'],
  security: authHeader,
  request: { params: codexIdParams, body: { content: { 'application/json': { schema: updateCodexBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Updated') },
});

registerPath({
  method: 'delete', path: '/api/codex/{id}', summary: 'Delete codex entry', tags: ['Codex'],
  security: authHeader,
  request: { params: codexIdParams },
  responses: { 200: successEnvelope(z.object({ message: z.string() }), 'Deleted') },
});

registerPath({
  method: 'get', path: '/api/books/{bookId}/codex/search', summary: 'Search codex (RAG)', tags: ['Codex'],
  security: authHeader,
  request: { params: bookIdParams, query: codexSearchQuery },
  responses: { 200: successEnvelope(z.any(), 'Search results') },
});

// ── Notes ──────────────────────────────────────────────────────

registerPath({
  method: 'get', path: '/api/books/{bookId}/notes', summary: 'List notes', tags: ['Notes'],
  security: authHeader,
  request: { params: bookIdParams },
  responses: { 200: successEnvelope(z.array(z.any()), 'Notes') },
});

registerPath({
  method: 'post', path: '/api/books/{bookId}/notes', summary: 'Create note', tags: ['Notes'],
  security: authHeader,
  request: { params: bookIdParams, body: { content: { 'application/json': { schema: noteBody } } } },
  responses: { 201: successEnvelope(z.any(), 'Created') },
});

registerPath({
  method: 'put', path: '/api/books/{bookId}/notes/{noteId}', summary: 'Update note', tags: ['Notes'],
  security: authHeader,
  request: { params: bookIdNoteIdParams, body: { content: { 'application/json': { schema: noteBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Updated') },
});

registerPath({
  method: 'delete', path: '/api/books/{bookId}/notes/{noteId}', summary: 'Delete note', tags: ['Notes'],
  security: authHeader,
  request: { params: bookIdNoteIdParams },
  responses: { 200: successEnvelope(z.object({ message: z.string() }), 'Deleted') },
});

// ── Generation ─────────────────────────────────────────────────

const genEndpoints: Array<{ path: string; summary: string; schema: z.ZodTypeAny }> = [
  { path: '/api/generate/character', summary: 'Generate character', schema: codexGenBody },
  { path: '/api/generate/location', summary: 'Generate location', schema: codexGenBody },
  { path: '/api/generate/item', summary: 'Generate item', schema: codexGenBody },
  { path: '/api/generate/codex', summary: 'Generate generic codex entry', schema: codexGenBody },
  { path: '/api/generate/outline', summary: 'Generate outline', schema: outlineBody },
  { path: '/api/generate/summary', summary: 'Generate summary', schema: summaryBody },
  { path: '/api/generate/title', summary: 'Generate title', schema: titleBody },
  { path: '/api/generate/tagline', summary: 'Generate tagline', schema: taglineBody },
  { path: '/api/generate/inline-suggestion', summary: 'Generate inline suggestion', schema: inlineSuggestionBody },
  { path: '/api/generate/feedback', summary: 'Generate feedback', schema: feedbackBody },
  { path: '/api/generate/structure', summary: 'Generate structure', schema: structureGenBody },
  { path: '/api/generate/prose', summary: 'Generate prose', schema: proseBody },
];

for (const ep of genEndpoints) {
  registerPath({
    method: 'post', path: ep.path, summary: ep.summary, tags: ['Generation'],
    security: authHeader,
    request: { body: { content: { 'application/json': { schema: ep.schema } } } },
    responses: {
      200: successEnvelope(z.any(), 'Generated content'),
      429: errorResponse('Rate limited', 429),
    },
  });
}

const operationReceipt = z.object({
  operationId: z.string().uuid(),
  idempotencyKey: z.string(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  route: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestCursor: z.number().int().min(0),
  artifactHash: z.string().optional(),
  errorCode: z.string().optional(),
});

registerPath({
  method: 'post', path: '/api/generate/operations', summary: 'Create an idempotent durable generation operation', tags: ['Generation'],
  security: authHeader,
  request: {
    headers: z.object({ 'Idempotency-Key': z.string().min(1).max(200) }),
    body: { content: { 'application/json': { schema: proseOperationBody } } },
  },
  responses: {
    202: successEnvelope(operationReceipt, 'Durable receipt persisted before inference begins'),
    200: successEnvelope(operationReceipt, 'Existing idempotent receipt'),
    409: errorResponse('Idempotency key conflicts with a different request', 409),
    429: errorResponse('Active-operation quota reached', 429),
  },
});

registerPath({
  method: 'get', path: '/api/generate/operations/unresolved', summary: 'Reconcile user-scoped generation operations', tags: ['Generation'],
  security: authHeader,
  request: { query: z.object({ idempotencyKey: z.string().min(1).max(200).optional() }) },
  responses: { 200: successEnvelope(z.object({ operations: z.array(operationReceipt) }), 'Matching operations') },
});

registerPath({
  method: 'get', path: '/api/generate/operations/lookup', summary: 'Look up a recent operation by its exact idempotency key', tags: ['Generation'],
  security: authHeader,
  request: { query: z.object({ idempotencyKey: z.string().min(1).max(200) }) },
  responses: {
    200: successEnvelope(operationReceipt, 'Matching active or terminal operation'),
    404: errorResponse('Generation operation not found or expired', 404),
  },
});

registerPath({
  method: 'get', path: '/api/generate/operations/{operationId}/stream', summary: 'Resume a generation stream from a cursor', tags: ['Generation'],
  security: authHeader,
  request: {
    params: z.object({ operationId: z.string().uuid() }),
    query: z.object({ cursor: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(2_000).optional() }),
  },
  responses: {
    200: { description: 'Bounded replay followed by live server-sent events' },
    404: errorResponse('Generation operation not found or expired', 404),
    409: errorResponse('Replay cursor is older than the retained window', 409),
  },
});

registerPath({
  method: 'get', path: '/api/generate/operations/{operationId}/artifact', summary: 'Read the authoritative completed artifact', tags: ['Generation'],
  security: authHeader,
  request: { params: z.object({ operationId: z.string().uuid() }) },
  responses: {
    200: successEnvelope(z.object({ operation: operationReceipt, artifact: z.string() }), 'Authoritative artifact'),
    404: errorResponse('Artifact not found or operation is not complete', 404),
  },
});

registerPath({
  method: 'post', path: '/api/generate/operations/{operationId}/cancel', summary: 'Cancel generation work', tags: ['Generation'],
  security: authHeader,
  request: { params: z.object({ operationId: z.string().uuid() }) },
  responses: {
    202: successEnvelope(operationReceipt, 'Cancellation persisted and propagated'),
    404: errorResponse('Generation operation not found', 404),
  },
});

registerPath({
  method: 'post', path: '/api/generate/prose/batch', summary: 'Batch prose generation', tags: ['Generation'],
  security: authHeader,
  request: { body: { content: { 'application/json': { schema: batchProseBody } } } },
  responses: {
    200: successEnvelope(z.any(), 'Batch completed'),
    207: successEnvelope(z.any(), 'Batch completed with partial failures or cancellations'),
    429: errorResponse('Rate limited', 429),
  },
});

// ── Feedback ───────────────────────────────────────────────────

registerPath({
  method: 'post', path: '/api/chapters/{chapterId}/apply-feedback', summary: 'Apply feedback to chapter', tags: ['Feedback'],
  security: authHeader,
  request: { params: chapterIdParams, body: { content: { 'application/json': { schema: applyFeedbackBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Applied') },
});

registerPath({
  method: 'post', path: '/api/scenes/{sceneId}/apply-feedback', summary: 'Apply feedback to scene', tags: ['Feedback'],
  security: authHeader,
  request: { params: sceneIdParams, body: { content: { 'application/json': { schema: applyFeedbackBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Applied') },
});

// ── Images ─────────────────────────────────────────────────────

registerPath({
  method: 'post', path: '/api/images/generate', summary: 'Generate image (Forge)', tags: ['Images'],
  security: authHeader,
  request: { body: { content: { 'application/json': { schema: generateImageBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Generated images') },
});

registerPath({
  method: 'post', path: '/api/images/generate/flux', summary: 'Generate image (advanced Forge controls; Qwen Image 2.1 default)', tags: ['Images'],
  security: authHeader,
  request: { body: { content: { 'application/json': { schema: generateFluxBody } } } },
  responses: { 200: successEnvelope(z.any(), 'Generated images') },
});

registerPath({
  method: 'get', path: '/api/images/health', summary: 'Check image backend health', tags: ['Images'],
  responses: { 200: successEnvelope(z.any(), 'Image backend health') },
});

registerPath({
  method: 'get', path: '/api/images/list', summary: 'List generated images', tags: ['Images'],
  security: authHeader,
  responses: { 200: successEnvelope(z.any(), 'Generated image list') },
});

registerPath({
  method: 'get', path: '/api/images/{id}/content', summary: 'Read private image content', tags: ['Images'],
  security: authHeader,
  request: { params: idParams },
  responses: { 200: { description: 'Private image bytes' }, 404: errorResponse('Not found', 404) },
});

registerPath({
  method: 'delete', path: '/api/images/{id}', summary: 'Delete a private image asset', tags: ['Images'],
  security: authHeader,
  request: { params: idParams },
  responses: { 200: successEnvelope(z.object({ deleted: z.boolean() }), 'Deleted'), 404: errorResponse('Not found', 404) },
});

registerPath({
  method: 'post', path: '/api/images/suggest-prompt', summary: 'Suggest image prompt', tags: ['Images'],
  security: authHeader,
  responses: { 200: successEnvelope(z.any(), 'Suggested prompt') },
});

// ── Export ──────────────────────────────────────────────────────

registerPath({
  method: 'get', path: '/api/books/{bookId}/export', summary: 'Export book', tags: ['Books'],
  security: authHeader,
  request: { params: bookIdParams, query: exportQuery },
  responses: { 200: { description: 'Exported document' } },
});

registerPath({
  method: 'post', path: '/api/images/import', summary: 'Import a revision-bound native illustration with provenance', tags: ['Images'],
  security: authHeader, request: { body: { content: { 'application/json': { schema: creativeImageSchema } } } },
  responses: { 201: successEnvelope(z.any(), 'Native image and source attachment'), 200: successEnvelope(z.any(), 'Idempotent import replay') },
});
registerPath({
  method: 'get', path: '/api/books/{bookId}/creative-package', summary: 'Export manuscript and native imported illustrations with source manifest', tags: ['Books'],
  security: authHeader, request: { params: bookIdParams }, responses: { 200: { description: 'Private illustrated ZIP package' } },
});

registerPath({
  method: 'post', path: '/api/books/{bookId}/export-artifacts', summary: 'Create a context-efficient Markdown export artifact', tags: ['Books'],
  security: authHeader,
  request: {
    params: bookIdParams,
    body: { content: { 'application/json': { schema: createExportArtifactBody } } },
  },
  responses: { 201: successEnvelope(z.any(), 'Export artifact metadata') },
});

registerPath({
  method: 'get', path: '/api/books/{bookId}/export-artifacts/{artifactId}', summary: 'Get export artifact metadata and table of contents', tags: ['Books'],
  security: authHeader,
  request: { params: exportArtifactParams },
  responses: { 200: successEnvelope(z.any(), 'Export artifact metadata') },
});

registerPath({
  method: 'get', path: '/api/books/{bookId}/export-artifacts/{artifactId}/read', summary: 'Read a bounded book, chapter, or scene slice', tags: ['Books'],
  security: authHeader,
  request: { params: exportArtifactParams, query: readExportArtifactQuery },
  responses: { 200: successEnvelope(z.any(), 'Selected manuscript content') },
});

registerPath({
  method: 'get', path: '/api/books/{bookId}/export-artifacts/{artifactId}/download', summary: 'Download a Markdown export artifact', tags: ['Books'],
  security: authHeader,
  request: { params: exportArtifactParams },
  responses: { 200: { description: 'Markdown file attachment' } },
});

registerPath({
  method: 'delete', path: '/api/books/{bookId}/export-artifacts/{artifactId}', summary: 'Delete an export artifact', tags: ['Books'],
  security: authHeader,
  request: { params: exportArtifactParams },
  responses: { 200: successEnvelope(z.object({ artifactId: z.string(), deleted: z.literal(true) }), 'Export artifact deleted') },
});

// ── Prompts ────────────────────────────────────────────────────

registerPath({
  method: 'get', path: '/api/prompts', summary: 'List prompt templates', tags: ['Prompts'],
  security: authHeader,
  responses: { 200: successEnvelope(z.object({ prompts: z.array(z.any()) }), 'Templates') },
});

registerPath({
  method: 'get', path: '/api/prompts/{key}', summary: 'Get prompt template by key', tags: ['Prompts'],
  security: authHeader,
  request: { params: z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }) },
  responses: { 200: successEnvelope(z.any(), 'Template detail') },
});

registerPath({
  method: 'get', path: '/api/prompts/additional/{name}', summary: 'Get an additional internal prompt template', tags: ['Prompts'],
  security: authHeader,
  request: { params: z.object({ name: z.enum([
    'CHAPTER_OUTLINE_TEMPLATE',
    'SCENE_OUTLINE_TEMPLATE',
    'SCENE_SUMMARY_TEMPLATE',
    'SHORT_SUMMARY_TEMPLATE',
  ]) }) },
  responses: { 200: successEnvelope(z.any(), 'Template detail'), 404: errorResponse('Template not found', 404) },
});

// ── Metrics ────────────────────────────────────────────────────

registerPath({
  method: 'get', path: '/api/metrics', summary: 'Get server metrics', tags: ['System'],
  security: [{ metricsToken: [] }],
  responses: {
    200: successEnvelope(z.any(), 'Metrics data'),
    401: errorResponse('Invalid metrics credential', 401),
    429: errorResponse('Repeated authentication failures', 429),
  },
});

registerPath({
  method: 'post', path: '/api/metrics/ingest', summary: 'Ingest UI metrics', tags: ['System'],
  request: { body: { content: { 'application/json': { schema: z.object({ events: z.array(z.object({ name: z.string(), bookId: z.number().int().positive().optional(), value: z.number().optional(), timestamp: z.string().datetime().optional() })).min(1).max(50) }) } } } },
  responses: { 204: { description: 'Ingested' }, 400: errorResponse('Invalid event batch', 400), 429: errorResponse('Rate limited', 429) },
});

// Routes exercised by the bundled Hermes plugin. These registrations keep the
// executable plugin contract and the published API document decision-complete.
const hermesContractPaths: Array<{ method: 'get' | 'post' | 'put' | 'delete' | 'patch'; path: string }> = [
  { method: 'post', path: '/api/books/{bookId}/acts' },
  { method: 'put', path: '/api/books/{bookId}/acts/{actId}' },
  { method: 'delete', path: '/api/books/{bookId}/acts/{actId}' },
  { method: 'put', path: '/api/books/{bookId}/chapters/{chapterId}' },
  { method: 'delete', path: '/api/books/{bookId}/chapters/{chapterId}' },
  { method: 'get', path: '/api/books/{bookId}/scenes' },
  { method: 'get', path: '/api/books/{bookId}/chapters/{chapterId}/scenes' },
  { method: 'post', path: '/api/books/{bookId}/chapters/{chapterId}/scenes' },
  { method: 'delete', path: '/api/books/{bookId}/scenes/{sceneId}' },
  { method: 'post', path: '/api/books/{bookId}/scenes/{sceneId}/regenerate' },
  { method: 'get', path: '/api/books/{bookId}/scenes/{sceneId}/prose/traces/latest' },
  { method: 'post', path: '/api/books/{bookId}/scenes/{sceneId}/prose/preferences' },
  { method: 'get', path: '/api/codex/{id}' },
  { method: 'post', path: '/api/generate/prose/revise' },
  { method: 'post', path: '/api/generate/prose/command-revise' },
  { method: 'get', path: '/api/settings' },
  { method: 'put', path: '/api/settings' },
  { method: 'get', path: '/api/models' },
  { method: 'get', path: '/api/models/status' },
  { method: 'post', path: '/api/workflows/full-book' },
  { method: 'post', path: '/api/workflows/quality-review' },
  { method: 'post', path: '/api/workflows/improve-quality' },
  { method: 'post', path: '/api/workflows/guided-improve' },
  { method: 'get', path: '/api/editorial/pass-packs' },
  { method: 'get', path: '/api/editorial/pass-packs/{key}' },
  { method: 'get', path: '/api/editorial/profiles' },
  { method: 'get', path: '/api/editorial/profiles/{id}' },
  { method: 'get', path: '/api/editorial/runs/{runId}/summary' },
  { method: 'get', path: '/api/editorial/runs/{runId}/proposals' },
  { method: 'get', path: '/api/editorial/runs/{runId}/proposals/{proposalId}' },
  { method: 'get', path: '/api/editorial-runs/{runId}' },
  { method: 'get', path: '/api/editorial-runs/{runId}/summary' },
  { method: 'get', path: '/api/editorial-runs/{runId}/proposals' },
  { method: 'get', path: '/api/editorial-runs/{runId}/proposals/{proposalId}' },
  { method: 'get', path: '/api/editorial-runs/{runId}/evidence' },
  { method: 'get', path: '/api/books/{bookId}/editorial-profile/resolved' },
  { method: 'post', path: '/api/editorial/proposals/{proposalId}/apply' },
  { method: 'get', path: '/api/editorial/benchmarks/{runId}' },
  { method: 'get', path: '/api/editorial/benchmarks/{runId}/report' },
  { method: 'get', path: '/api/workflows/{runId}' },
  { method: 'get', path: '/api/workflows/{runId}/events' },
  { method: 'get', path: '/api/workflows/{runId}/checkpoints' },
  { method: 'get', path: '/api/workflows/{runId}/checkpoints/{checkpointId}' },
  { method: 'get', path: '/api/workflows/{runId}/artifacts' },
  { method: 'post', path: '/api/workflows/{runId}/pause' },
  { method: 'post', path: '/api/workflows/{runId}/resume' },
  { method: 'post', path: '/api/workflows/{runId}/cancel' },
  { method: 'post', path: '/api/workflows/{runId}/checkpoints/{checkpointId}/decision' },
  { method: 'post', path: '/api/workflows/{runId}/finalize' },
  { method: 'get', path: '/api/workflows/{runId}/publication' },
  { method: 'get', path: '/api/workflows/{runId}/publication/{filename}' },
  { method: 'get', path: '/api/books/{bookId}/workflows' },
  { method: 'get', path: '/api/books/{bookId}/reviews' },
  { method: 'get', path: '/api/books/{bookId}/revisions' },
  { method: 'post', path: '/api/books/{bookId}/revisions/{revisionId}/rollback' },
  { method: 'get', path: '/api/reviews/{reviewRunId}/findings' },
  { method: 'get', path: '/api/books/{bookId}/findings' },
  { method: 'patch', path: '/api/findings/{findingId}' },
];
for (const route of hermesContractPaths) {
  registerPath({
    ...route,
    summary: 'Hermes-supported API operation',
    tags: ['Hermes'],
    security: authHeader,
    responses: { 200: successEnvelope(z.any(), 'Successful operation'), 401: errorResponse('Authentication required', 401), 404: errorResponse('Not found', 404) },
  });
}

registerPath({
  method: 'post',
  path: '/api/workflows/editorial-optimize',
  summary: 'Launch an autonomous editorial workflow',
  description: 'Starts one idempotent, checkpoint-free editorial workflow. Risky or disputed edits are skipped and the run reaches a terminal result.',
  tags: ['Editorial'],
  security: authHeader,
  request: {
    headers: z.object({ 'idempotency-key': z.string().min(1).max(200) }),
    body: { content: { 'application/json': { schema: editorialOptimizeSchema } } },
  },
  responses: {
    202: successEnvelope(z.object({
      runId: z.string().uuid(), workflowType: z.literal('editorial_optimize'),
      sourceRevisionId: z.string().uuid(), passPack: z.string(), statusUrl: z.string(),
    }).passthrough(), 'Editorial workflow accepted'),
    400: errorResponse('Invalid editorial request', 400),
    401: errorResponse('Authentication required', 401),
    409: errorResponse('Editorial source or idempotency conflict', 409),
  },
});

registerPath({
  method: 'post', path: '/api/editorial/profiles', summary: 'Create an immutable editorial profile version', tags: ['Editorial'], security: authHeader,
  request: { body: { content: { 'application/json': { schema: editorialProfileSchema } } } },
  responses: { 201: successEnvelope(z.any(), 'Profile created'), 400: errorResponse('Invalid profile', 400) },
});
registerPath({
  method: 'put', path: '/api/editorial/profiles/{id}', summary: 'Create the next editorial profile version', tags: ['Editorial'], security: authHeader,
  request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: editorialProfileSchema } } } },
  responses: { 200: successEnvelope(z.any(), 'Profile version created'), 404: errorResponse('Profile not found', 404) },
});
registerPath({
  method: 'post', path: '/api/editorial/proposals/{proposalId}/preference', summary: 'Record optional editorial preference evidence', tags: ['Editorial'], security: authHeader,
  request: { params: z.object({ proposalId: z.string().uuid() }), body: { content: { 'application/json': { schema: editorialPreferenceSchema } } } },
  responses: { 201: successEnvelope(z.any(), 'Preference recorded'), 404: errorResponse('Proposal not found', 404) },
});
registerPath({
  method: 'post', path: '/api/editorial/benchmarks', summary: 'Run a bounded Quality Lab benchmark', tags: ['Quality Lab'], security: authHeader,
  request: {
    headers: z.object({ 'idempotency-key': z.string().min(1).max(200) }),
    body: { content: { 'application/json': { schema: z.object({ suiteKey: z.string().optional(), passKey: z.string().optional(), live: z.boolean().default(false), maximumCases: z.number().int().min(1).max(50).default(20) }) } } },
  },
  responses: { 202: successEnvelope(z.any(), 'Benchmark accepted'), 400: errorResponse('Invalid benchmark', 400) },
});

registerPath({
  method: 'put', path: '/api/admin/models/settings', summary: 'Update global inference settings', tags: ['Administration'],
  security: [{ internalSecret: [] }],
  responses: { 200: successEnvelope(z.any(), 'Updated'), 401: errorResponse('Internal authentication required', 401), 403: errorResponse('Host not allowed', 403) },
});

registerPath({
  method: 'get', path: '/api/admin/models/probe', summary: 'Probe an allowlisted inference host', tags: ['Administration'],
  security: [{ internalSecret: [] }],
  responses: { 200: successEnvelope(z.array(z.any()), 'Models'), 401: errorResponse('Internal authentication required', 401), 403: errorResponse('Host not allowed', 403) },
});

// ── Generate the document ──────────────────────────────────────

registerPath({method:'post',path:'/api/books/{bookId}/document-search-index/recover',summary:'Create or verify bounded immutable historical search indexes without changing document heads',tags:['Documents'],security:authHeader,request:{params:bookIdParams,body:{content:{'application/json':{schema:documentSearchIndexRecoverySchema}}}},responses:{200:successEnvelope(z.any(),'Index recovery counts and exact revision cursor; repeat safely'),404:errorResponse('Owned book missing',404),503:errorResponse('Mismatched evidence preserved for reconciliation',503)}});

registerPath({method:'get',path:'/api/books/{bookId}/scenes/{sceneId}/document-passages',summary:'Ordered bounded immutable final/original/markup paragraphs, table slices and objects with qualified source coordinates',tags:['Documents'],security:authHeader,request:{params:bookIdParams.extend({sceneId:z.coerce.number().int().positive()}),query:documentPassageQuery},responses:{200:successEnvelope(z.any(),'Bounded passage; stable run hashes, next cursor and explicit omitted-object/review counts'),404:errorResponse('Owned scene missing',404),409:errorResponse('Checksum-invalid immutable source',409),413:errorResponse('Unrepresentable grapheme or excessive review metadata',413),422:errorResponse('Invalid passage bounds or cursor',422)}});
registerPath({method:'post',path:'/api/books/{bookId}/scenes/{sceneId}/document-passages',summary:'Atomically apply qualified text operations to a frozen bounded passage without uploading or returning complete scene bodies',tags:['Documents'],security:authHeader,request:{params:bookIdParams.extend({sceneId:z.coerce.number().int().positive()}),body:{content:{'application/json':{schema:documentPassageCommitSchema}}}},responses:{200:successEnvelope(z.any(),'Exact sparse operation receipt, scene references and bounded committed passage'),428:errorResponse('Mutation preconditions missing',428),412:errorResponse('Book, scene or passage source stale',412),409:errorResponse('Overlapping, protected or incompatible target',409)}});

registerPath({method:'post',path:'/api/books/{bookId}/scenes/{sceneId}/document-passages/restore',summary:'Restore a complete owned scene revision without uploading or returning its complete body',tags:['Documents'],security:authHeader,request:{params:bookIdParams.extend({sceneId:z.coerce.number().int().positive()}),body:{content:{'application/json':{schema:documentPassageRestoreSchema}}}},responses:{200:successEnvelope(z.any(),'New restoration revision and exact sparse operation receipt with bounded restored passage'),428:errorResponse('Mutation preconditions missing',428),412:errorResponse('Current source changed',412),409:errorResponse('Incomplete or unowned restoration source',409)}});

registerPath({method:'post',path:'/api/books/{bookId}/scenes/{sceneId}/document-passages/operations',summary:'Atomically commit typed source-qualified text, formatting, structure, object and review intents',tags:['Documents'],security:authHeader,request:{params:bookIdParams.extend({sceneId:z.coerce.number().int().positive()}),body:{content:{'application/json':{schema:passageOperationCommitSchema}}}},responses:{200:successEnvelope(z.any(),'Sparse committed passage, post-attribution operation mappings and created identities'),428:errorResponse('Source preconditions missing',428),412:errorResponse('Exact source changed',412),409:errorResponse('Protected or incompatible operation',409)}});
registerPath({method:'post',path:'/api/books/{bookId}/document-passage-commits',summary:'Commit up to eight changed passage scopes atomically against one immutable book head',tags:['Documents'],security:authHeader,request:{params:bookIdParams,body:{content:{'application/json':{schema:passageBookCommitSchema}}}},responses:{200:successEnvelope(z.any(),'Atomic changed scene references and bounded acknowledged passages'),428:errorResponse('Preconditions missing',428),412:errorResponse('Any source scope changed',412),409:errorResponse('Incompatible compound operation',409)}});
registerPath({method:'post',path:'/api/books/{bookId}/document-passage-transfers',summary:'Atomically move qualified complete blocks or split/join scene boundaries against two immutable source scopes',tags:['Documents'],security:authHeader,request:{params:bookIdParams,body:{content:{'application/json':{schema:passageScopeTransferSchema}}}},responses:{200:successEnvelope(z.any(),'Sparse committed source/destination passages with exact operation lineage'),428:errorResponse('Preconditions missing',428),412:errorResponse('Either owned source changed',412),409:errorResponse('Protected or incompatible transfer',409)}});
registerPath({method:'post',path:'/api/books/{bookId}/document-passage-scope-restores',summary:'Restore affected complete scene scopes atomically while checking unchanged structure, layout and unrelated scopes',tags:['Documents'],security:authHeader,request:{params:bookIdParams,body:{content:{'application/json':{schema:passageScopeRestoreSchema}}}},responses:{200:successEnvelope(z.any(),'Sparse acknowledged passages from the complete restored scene revisions'),428:errorResponse('Preconditions missing',428),412:errorResponse('Any expected scope changed',412),409:errorResponse('Incomplete or incompatible restoration',409)}});
registerPath({method:'get',path:'/api/books/{bookId}/scenes/{sceneId}/document-passages/review-history',summary:'Read an owned immutable bounded review-history page by exact record digest',tags:['Documents'],security:authHeader,request:{params:bookIdParams.extend({sceneId:z.coerce.number().int().positive()}),query:passageReviewQuery},responses:{200:successEnvelope(z.any(),'Bounded retained resolution history'),412:errorResponse('Source or record digest changed',412)}});
registerPath({method:'post',path:'/api/books/{bookId}/scenes/{sceneId}/document-passages/comments',summary:'Create or explicitly resolve/reanchor an authenticated comment against visible stable passage ranges',tags:['Documents'],security:authHeader,request:{params:bookIdParams.extend({sceneId:z.coerce.number().int().positive()}),body:{content:{'application/json':{schema:passageCommentCommitSchema}}}},responses:{200:successEnvelope(z.any(),'Sparse acknowledged comment and passage'),428:errorResponse('Preconditions missing',428),412:errorResponse('Comment or source changed',412),409:errorResponse('Target is outside the qualified passage',409)}});
registerPath({method:'get',path:'/api/books/{bookId}/scenes/{sceneId}/document-passages/comments/{commentId}',summary:'Read immutable comment text and bounded anchors while preserving complete history on Factory',tags:['Documents'],security:authHeader,request:{params:bookIdParams.extend({sceneId:z.coerce.number().int().positive(),commentId:z.string().min(1).max(128)}),query:passageCommentPageQuery},responses:{200:successEnvelope(z.any(),'Owned immutable comment page'),412:errorResponse('Source or record changed',412)}});
const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiSpec = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    title: 'Proser API',
    version: '1.2.0',
    description: 'API for the Proser AI-powered book authoring & generation platform.',
  },
  servers: [{ url: '/', description: 'Current service origin' }],
  tags: [
    { name: 'System', description: 'Health, readiness, metrics' },
    { name: 'Books', description: 'Book CRUD' },
    { name: 'Structure', description: 'Acts, chapters, scenes' },
    { name: 'Codex', description: 'Character, location, item entries' },
    { name: 'Notes', description: 'Book notes' },
    { name: 'Generation', description: 'AI text generation' },
    { name: 'Workflows', description: 'Durable book and editorial workflows' },
    { name: 'Editorial', description: 'Autonomous editorial passes, profiles, proposals, and evidence' },
    { name: 'Quality Lab', description: 'Versioned deterministic and live editorial benchmarks' },
    { name: 'Feedback', description: 'AI feedback and application' },
    { name: 'Images', description: 'Image generation' },
    { name: 'Prompts', description: 'Prompt template management' },
  ],
  security: [],
  externalDocs: {
    description: 'Project documentation',
    url: 'https://github.com/your-repo/proser',
  },
});
