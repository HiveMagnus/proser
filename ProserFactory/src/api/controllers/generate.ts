import { createHash } from 'node:crypto';
import { Response } from 'express';
import { AuthenticatedRequest, GenerationRequest } from '../types';
import { databaseService } from '../../lib/database';
import type { Scene, Prisma } from '../../lib/database';
import { defaultModelRouter } from '../../lib/ai/router';
// Server no longer supplies user prompts; UI must provide them
import logger, { promptLogger } from '../../lib/logger';
import { time } from '../../lib/metrics';
import { logRag } from '../../lib/ragLogger';
import { respondError, respondSuccess, ErrorCodes } from '../utils/response';
import { AuthenticationError, ValidationError, NotFoundError } from '../../lib/errors';
import { SceneProseService } from '../../services/sceneProseService';
import { DEFAULT_INFERENCE_MODEL } from '../../lib/ai/vllm';
import { scenesService } from '../../services/scenesService';
import { safeInferenceLog } from '../../lib/ai/transport';
import { writeSseEvent } from '../utils/sse';
import {
  generationReplayService,
  normalizedGenerationRequest,
  GenerationIdempotencyConflictError,
  GenerationQuotaError,
  ReplayCursorExpiredError,
} from '../../services/generationReplayService';
import { documentAuthorityEnabled, DocumentError } from '@/documents/service';
import { generateOwnedScene } from '@/documents/generation';
import { parseDocumentMutationPreconditions } from '@/api/schemas/documents';
import { compatibilityRevisionProposal } from '@/documents/compatibilityProposal';
import type { SceneProseResult } from '@/services/sceneProseService';
import { scheduleGenerationOperations } from '../../services/generationOperationRunner';
import { bindSharedResourceGeneration, sealSharedResourceOperation, SharedResourceError } from '../../services/sharedResourceService';

function delegatedGenerationId(operationId: string): string {
  const bytes = createHash('sha256').update(`proser.shared-generation.v1:${operationId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const fallbackModel = (): string =>
  process.env.OLLAMA_MODEL || process.env.VLLM_MODEL || DEFAULT_INFERENCE_MODEL;
const defaultRagTokenBudget = (): number =>
  Number.parseInt(process.env.RAG_TOKEN_BUDGET || '120000', 10) || 120000;

/** Scene loaded with its chapter/act context for batch prose generation. */
type SceneWithContext = Prisma.SceneGetPayload<{ include: { chapter: { include: { act: true } } } }>;

// Helper to persist generation history (non-blocking)
async function logHistory(params: {
userId: number;
entityType: string;
entityId?: number;
prompt: string;
generatedContent: string;
modelUsed?: string;
}) {
try {
await databaseService.client.generationHistory.create({
data: {
userId: params.userId,
entityType: params.entityType,
entityId: params.entityId,
prompt: params.prompt,
generatedContent: params.generatedContent,
modelUsed: params.modelUsed
}
});
} catch (err) {
logger.warn({ err, params }, 'Failed to log generation history');
}
}

export class GenerateController {
static async generateCharacter(req: AuthenticatedRequest, res: Response) {
try {
const { bookId, prompt, selectedModel } = req.body as GenerationRequest;
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (!bookId) throw new ValidationError('Book ID is required');

const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId: req.user.id } });
if (!book) throw new NotFoundError('Book not found');

const provider = defaultModelRouter.forRequest('character', selectedModel);
const p = String(prompt || '');
try { promptLogger.info({ route: 'generateCharacter', provider: provider.id, ...safeInferenceLog(p) }); } catch {}
let character: Record<string, unknown>;
const raw = await time('ai.generate.character', () => provider.generateText({ prompt: p }));
try { character = JSON.parse((raw.match(/\{[\s\S]*\}/) || [raw])[0]); } catch { character = { name: 'Generated Character', description: raw }; }

await logHistory({
userId: req.user.id,
entityType: 'character',
entityId: bookId,
prompt: prompt || '',
generatedContent: JSON.stringify(character),
modelUsed: selectedModel || fallbackModel()
});

return respondSuccess(res, character);
} catch (error) {
logger.error({ error }, 'Character generation failed');
throw error;
}
}

static async createOperation(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user?.id) throw new AuthenticationError('Unauthorized');
  const operationIdempotencyKey = String(req.header('Idempotency-Key') || '').trim();
  if (!operationIdempotencyKey || operationIdempotencyKey.length > 200) {
    respondError(res, ErrorCodes.VALIDATION_FAILED, 'Idempotency-Key header is required and must be at most 200 characters', 400);
    return;
  }
  try {
    const { kind: _kind, ...request } = req.body as Record<string, unknown>;
    const bookId = Number(request.bookId);
    const book = await databaseService.client.book.findFirst({
      where: { id: bookId, userId: req.user.id },
      select: { id: true },
    });
    if (!book) {
      respondError(res, ErrorCodes.NOT_FOUND, 'Book not found', 404);
      return;
    }
    if (req.sharedResourceOperationId) {
      const sharedId = req.sharedResourceOperationId;
      const generationId = delegatedGenerationId(sharedId);
      const requestHash = normalizedGenerationRequest(request).hash;
      const bound = await bindSharedResourceGeneration(sharedId, generationId, operationIdempotencyKey, requestHash);
      // Once the database records dispatch intent, an absent Redis receipt is
      // ambiguous. Redelivery may inspect it, but must never launch a second job.
      const existing = bound.created
        ? null
        : await generationReplayService.getForUser(generationId, req.user.id);
      if (!bound.created && !existing) {
        respondError(res, 'SHARED_RESOURCE_UNKNOWN_EFFECT', 'Generation dispatch is unresolved; reconcile the retained operation ID.', 409,
          { generationOperationId: generationId, sharedResourceOperationId: sharedId });
        return;
      }
      const created = existing
        ? { receipt: existing, created: false }
        : await generationReplayService.create(req.user.id, 'generate.prose', request, operationIdempotencyKey, generationId);
      if (created.receipt.operationId !== generationId || created.receipt.idempotencyKey !== operationIdempotencyKey
          || created.receipt.requestHash !== requestHash || created.receipt.route !== 'generate.prose') {
        throw new SharedResourceError('SHARED_RESOURCE_REPLAY_CONFLICT', 'Redis generation receipt differs from the durable binding.');
      }
      const response = { success: true, data: created.receipt };
      const terminal = await sealSharedResourceOperation(sharedId, 'succeeded', 202, response);
      res.once('finish', () => {
        if (created.created) setImmediate(() => void scheduleGenerationOperations());
      });
      res.status(202).json({ ...response, sharedResourceResult: terminal.resultRecord, sharedResourceEvidence: terminal.evidence });
      return;
    }
    const created = await generationReplayService.create(
      req.user.id,
      'generate.prose',
      request,
      operationIdempotencyKey,
    );
    res.once('finish', () => {
      if (created.created) setImmediate(() => void scheduleGenerationOperations());
    });
    respondSuccess(res, created.receipt, created.created ? 202 : 200);
  } catch (error) {
    if (error instanceof GenerationIdempotencyConflictError) {
      respondError(res, ErrorCodes.CONFLICT, error.message, 409);
      return;
    }
    if (error instanceof GenerationQuotaError) {
      respondError(res, ErrorCodes.RATE_LIMITED, error.message, 429, { scope: error.scope });
      return;
    }
    throw error;
  }
}

static async unresolvedOperations(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user?.id) throw new AuthenticationError('Unauthorized');
  const key = typeof req.query.idempotencyKey === 'string' ? req.query.idempotencyKey : undefined;
  respondSuccess(res, {
    operations: await generationReplayService.unresolved(req.user.id, key),
  });
}

static async lookupOperation(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user?.id) throw new AuthenticationError('Unauthorized');
  const operationIdempotencyKey =
    typeof req.query.idempotencyKey === 'string' ? req.query.idempotencyKey.trim() : '';
  if (!operationIdempotencyKey || operationIdempotencyKey.length > 200) {
    respondError(
      res,
      ErrorCodes.VALIDATION_FAILED,
      'idempotencyKey is required and must be at most 200 characters',
      400,
    );
    return;
  }
  const operation = await generationReplayService.lookupByIdempotencyKey(
    req.user.id,
    operationIdempotencyKey,
  );
  if (!operation) {
    respondError(res, ErrorCodes.NOT_FOUND, 'Generation operation not found or expired', 404);
    return;
  }
  respondSuccess(res, operation);
}

static async getOperation(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user?.id) throw new AuthenticationError('Unauthorized');
  const operation = await generationReplayService.getForUser(String(req.params.operationId), req.user.id);
  if (!operation) {
    respondError(res, ErrorCodes.NOT_FOUND, 'Generation operation not found or expired', 404);
    return;
  }
  respondSuccess(res, operation);
}

static async getOperationArtifact(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user?.id) throw new AuthenticationError('Unauthorized');
  const result = await generationReplayService.getArtifactForUser(String(req.params.operationId), req.user.id);
  if (!result) {
    respondError(res, ErrorCodes.NOT_FOUND, 'Generation artifact not found or operation is not complete', 404);
    return;
  }
  respondSuccess(res, result);
}

static async cancelOperation(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user?.id) throw new AuthenticationError('Unauthorized');
  const operation = await generationReplayService.cancel(String(req.params.operationId), req.user.id);
  if (!operation) {
    respondError(res, ErrorCodes.NOT_FOUND, 'Generation operation not found or expired', 404);
    return;
  }
  respondSuccess(res, operation, 202);
}

static async resumeStream(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user?.id) throw new AuthenticationError('Unauthorized');
  const operationId = String(req.params.operationId || '');
  const operation = await generationReplayService.getForUser(operationId, req.user.id);
  if (!operation) {
    respondError(res, ErrorCodes.NOT_FOUND, 'Generation operation not found or expired', 404);
    return;
  }
  const afterCursor = Number.parseInt(String(req.query.cursor ?? '0'), 10);
  const requestedLimit = Number.parseInt(String(req.query.limit ?? generationReplayService.maxReplayEvents), 10);
  if (!Number.isInteger(afterCursor) || afterCursor < 0 || !Number.isInteger(requestedLimit) || requestedLimit < 1) {
    respondError(res, ErrorCodes.VALIDATION_FAILED, 'cursor must be non-negative and limit must be positive', 400);
    return;
  }

  try {
    await generationReplayService.replay(operationId, req.user.id, afterCursor, requestedLimit);
  } catch (error) {
    if (error instanceof ReplayCursorExpiredError) {
      respondError(res, ErrorCodes.CONFLICT, error.message, 409, { oldestCursor: error.oldestCursor });
      return;
    }
    throw error;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let cursor = afterCursor;
  let closed = false;
  let lastHeartbeatAt = Date.now();
  res.on('close', () => { closed = true; });

  try {
    while (!closed) {
      const replay = await generationReplayService.replay(operationId, req.user.id, cursor, requestedLimit);
      if (!replay) break;
      for (const event of replay.events) {
        writeSseEvent(res, event.event, event.data);
        cursor = event.cursor;
      }
      if (!replay.hasMore && replay.status !== 'running') break;
      if (!replay.hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!closed && Date.now() - lastHeartbeatAt >= 15_000) {
          res.write(`: cursor ${cursor}\n\n`);
          lastHeartbeatAt = Date.now();
        }
      }
    }
  } catch (error) {
    if (error instanceof ReplayCursorExpiredError) {
      writeSseEvent(res, 'replay_error', { operationId, code: 'CURSOR_EXPIRED', oldestCursor: error.oldestCursor });
    } else {
      writeSseEvent(res, 'replay_error', { operationId, code: 'REPLAY_FAILED' });
    }
  }
  if (!closed) res.end();
}

static async generateLocation(req: AuthenticatedRequest, res: Response) {
try {
const { bookId, prompt, selectedModel } = req.body as GenerationRequest;
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (!bookId) throw new ValidationError('Book ID is required');

const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId: req.user.id } });
if (!book) throw new NotFoundError('Book not found');

const provider = defaultModelRouter.forRequest('location', selectedModel);
const p = String(prompt || '');
try { promptLogger.info({ route: 'generateLocation', provider: provider.id, ...safeInferenceLog(p) }); } catch {}
let location: Record<string, unknown>;
const raw = await time('ai.generate.location', () => provider.generateText({ prompt: p }));
try { location = JSON.parse((raw.match(/\{[\s\S]*\}/) || [raw])[0]); } catch { location = { name: 'Generated Location', description: raw }; }

await logHistory({
userId: req.user.id,
entityType: 'location',
entityId: bookId,
prompt: prompt || '',
generatedContent: JSON.stringify(location),
modelUsed: selectedModel || fallbackModel()
});

return respondSuccess(res, location);
} catch (error) {
logger.error({ error }, 'Location generation failed');
throw error;
}
}

static async generateItem(req: AuthenticatedRequest, res: Response) {
try {
const { bookId, prompt, selectedModel } = req.body as GenerationRequest;
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (!bookId) throw new ValidationError('Book ID is required');

const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId: req.user.id } });
if (!book) throw new NotFoundError('Book not found');

const provider = defaultModelRouter.forRequest('item', selectedModel);
const p = String(prompt || '');
try { promptLogger.info({ route: 'generateItem', provider: provider.id, ...safeInferenceLog(p) }); } catch {}
let item: Record<string, unknown>;
const raw = await time('ai.generate.item', () => provider.generateText({ prompt: p }));
try { item = JSON.parse((raw.match(/\{[\s\S]*\}/) || [raw])[0]); } catch { item = { name: 'Generated Item', description: raw }; }

await logHistory({
userId: req.user.id,
entityType: 'item',
entityId: bookId,
prompt: prompt || '',
generatedContent: JSON.stringify(item),
modelUsed: selectedModel || fallbackModel()
});

return respondSuccess(res, item);
} catch (error) {
logger.error({ error }, 'Item generation failed');
throw error;
}
}

static async generateCodexEntry(req: AuthenticatedRequest, res: Response) {
try {
const { bookId, prompt, selectedModel, entryType } = req.body as GenerationRequest & { entryType?: string };
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (!bookId) throw new ValidationError('Book ID is required');
const p = String(prompt || '').trim();
if (!p) throw new ValidationError('Prompt is required');

const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId: req.user.id } });
if (!book) throw new NotFoundError('Book not found');

const provider = defaultModelRouter.forRequest('generic', selectedModel);
try { promptLogger.info({ route: 'generateCodexEntry', provider: provider.id, ...safeInferenceLog(p) }); } catch {}
const result = await time('ai.generate.codex', () => provider.generateText({ prompt: p }));

await logHistory({
userId: req.user.id,
entityType: entryType || 'codex',
entityId: bookId,
prompt: p,
generatedContent: result,
modelUsed: selectedModel || fallbackModel()
});

return respondSuccess(res, result);
} catch (error) {
logger.error({ error }, 'Codex entry generation failed');
throw error;
}
}

static async generateOutline(req: AuthenticatedRequest, res: Response) {
try {
const { prompt, selectedModel } = req.body as GenerationRequest & { prompt?: string };
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
// UI composes the full prompt; context is optional and used only for client-side auditing
if (!prompt || String(prompt).trim().length === 0) throw new ValidationError('Prompt is required');

const provider = defaultModelRouter.forRequest('outline', selectedModel);
const p = String(prompt);
try { promptLogger.info({ route: 'generateOutline', provider: provider.id, ...safeInferenceLog(p) }); } catch {}
const outline = await time('ai.generate.outline', () => provider.generateText({ prompt: p }));

await logHistory({
userId: req.user.id,
entityType: 'outline',
prompt: p,
generatedContent: outline,
modelUsed: selectedModel || fallbackModel()
});

return respondSuccess(res, outline);
} catch (error) {
logger.error({ error }, 'Outline generation failed');
throw error;
}
}

static async generateSummary(req: AuthenticatedRequest, res: Response) {
try {
const { bookId, prompt, selectedModel } = req.body as GenerationRequest;
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (!bookId) throw new ValidationError('Book ID is required');

const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId: req.user.id } });
if (!book) throw new NotFoundError('Book not found');

const provider = defaultModelRouter.forRequest('summary', selectedModel);
const p = String(prompt || '');
try { promptLogger.info({ route: 'generateSummary', provider: provider.id, ...safeInferenceLog(p) }); } catch {}
const summary = await time('ai.generate.summary', () => provider.generateText({ prompt: p }));

await logHistory({
userId: req.user.id,
entityType: 'summary',
entityId: bookId,
prompt: prompt || `Generate summary for "${book.title}"`,
generatedContent: summary,
modelUsed: selectedModel || fallbackModel()
});

return respondSuccess(res, summary);
} catch (error) {
logger.error({ error }, 'Summary generation failed');
throw error;
}
}

static async generateTitle(req: AuthenticatedRequest, res: Response) {
try {
const { genre, summary, prompt: uiPrompt, selectedModel } = req.body as GenerationRequest & { prompt?: string };
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (!genre || !summary) throw new ValidationError('Genre and summary are required');
// UI must supply a full prompt
const provider = defaultModelRouter.forRequest('title', selectedModel);
const p = String(uiPrompt || '');
if (!p.trim()) throw new ValidationError('Prompt is required');
try { promptLogger.info({ route: 'generateTitle', provider: provider.id, ...safeInferenceLog(p) }); } catch {}
const titlesRaw = await time('ai.generate.title', () => provider.generateText({ prompt: p }));
const titles = titlesRaw.split('\n').map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);

await logHistory({
userId: req.user.id,
entityType: 'title',
prompt: 'Generate book titles',
generatedContent: titles.join('\n'),
modelUsed: selectedModel || fallbackModel()
});

return respondSuccess(res, titles);
} catch (error) {
logger.error({ error }, 'Title generation failed');
throw error;
}
}

static async generateTagline(req: AuthenticatedRequest, res: Response) {
try {
const { title, genre, summary, prompt: uiPrompt, selectedModel } = req.body as GenerationRequest & { title: string; prompt?: string };
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (!title || !genre || !summary) throw new ValidationError('Title, genre, and summary required');

const provider = defaultModelRouter.forRequest('tagline', selectedModel);
const p = String(uiPrompt || '');
if (!p.trim()) throw new ValidationError('Prompt is required');
try { promptLogger.info({ route: 'generateTagline', provider: provider.id, ...safeInferenceLog(p) }); } catch {}
const taglinesRaw = await time('ai.generate.tagline', () => provider.generateText({ prompt: p }));
const taglines = taglinesRaw.split('\n').map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);

await logHistory({
userId: req.user.id,
entityType: 'tagline',
prompt: `Generate taglines for "${title}"`,
generatedContent: taglines.join('\n'),
modelUsed: selectedModel || fallbackModel()
});

return respondSuccess(res, taglines);
} catch (error) {
logger.error({ error }, 'Tagline generation failed');
throw error;
}
}

static async generateInlineSuggestion(req: AuthenticatedRequest, res: Response) {
try {
const { context, selectedModel } = req.body as GenerationRequest;
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (documentAuthorityEnabled()) return respondSuccess(res, await compatibilityRevisionProposal(req.user.id, {
  bookId: req.body.bookId, sceneId: req.body.sceneId, originalText: typeof context === 'string' ? context : undefined,
  documentPreview: req.body.documentPreview, selectedModel,
  instruction: 'Suggest a short natural continuation of the disclosed target by proposing exact text edits. Preserve its existing facts, voice, formatting and protected objects. Do not edit any omitted content.',
}));
if (!context) throw new ValidationError('Context is required');

const provider = defaultModelRouter.forRequest('inline', selectedModel);
const p = String(context);
try { promptLogger.info({ route: 'generateInlineSuggestion', provider: provider.id, ...safeInferenceLog(p) }); } catch {}
const suggestion = await time('ai.generate.inlineSuggestion', () => provider.generateText({ prompt: p }));

await logHistory({
userId: req.user.id,
entityType: 'inline_suggestion',
prompt: 'Inline suggestion',
generatedContent: suggestion,
modelUsed: selectedModel || fallbackModel()
});

return respondSuccess(res, suggestion);
} catch (error) {
logger.error({ error }, 'Inline suggestion generation failed');
throw error;
}
}

static async generateFeedback(req: AuthenticatedRequest, res: Response) {
try {
const { content, feedbackType, selectedModel } = req.body as GenerationRequest;
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (documentAuthorityEnabled()) {
  if (!Number.isSafeInteger(req.body.bookId) || req.body.bookId < 1) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Owned bookId and a disclosed document discussion are required before feedback.', 428);
  return respondSuccess(res, await compatibilityRevisionProposal(req.user.id, {
    bookId: req.body.bookId, sceneId: req.body.sceneId, originalText: content,
    documentPreview: req.body.documentPreview, selectedModel,
    instruction: `Provide ${feedbackType || 'general'} fiction feedback on the disclosed targets. Cite exact brief evidence in the reply and propose only actionable text edits against supplied identities. Preserve facts, voice, formatting and protected objects. Never edit omitted content.`,
  }));
}
if (!content) throw new ValidationError('Content is required');

const provider = defaultModelRouter.forRequest('feedback', selectedModel);
const p = `Provide ${feedbackType || 'general'} fiction feedback. Be specific, cite brief evidence, and recommend actionable changes.\n\nCONTENT:\n${String(content)}`;
try { promptLogger.info({ route: 'generateFeedback', provider: provider.id, ...safeInferenceLog(p) }); } catch {}
const feedback = await time('ai.generate.feedback', () => provider.generateText({ prompt: p }));

await logHistory({
userId: req.user.id,
entityType: 'feedback',
prompt: `Feedback type: ${feedbackType || 'general'}`,
generatedContent: feedback,
modelUsed: selectedModel || fallbackModel()
});

return respondSuccess(res, feedback);
} catch (error) {
logger.error({ error }, 'Feedback generation failed');
throw error;
}
}

static async generateStructure(req: AuthenticatedRequest, res: Response) {
try {
const { bookId, prompt: uiPrompt, selectedModel } = req.body as GenerationRequest & { prompt?: string };
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (!bookId) throw new ValidationError('Book ID is required');

const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId: req.user.id } });
if (!book) throw new NotFoundError('Book not found');

const provider = defaultModelRouter.forRequest('structure', selectedModel);
let structure: Record<string, unknown>;
const p = String(uiPrompt || '');
if (!p.trim()) throw new ValidationError('Prompt is required');
try { promptLogger.info({ route: 'generateStructure', provider: provider.id, ...safeInferenceLog(p) }); } catch {}
const raw = await time('ai.generate.structure', () => provider.generateText({ prompt: p }));
try { structure = JSON.parse((raw.match(/\{[\s\S]*\}/) || [raw])[0]); } catch {
structure = { acts: [] };
}

await logHistory({
userId: req.user.id,
entityType: 'structure',
entityId: bookId,
prompt: p,
generatedContent: JSON.stringify(structure),
modelUsed: selectedModel || fallbackModel()
});

return respondSuccess(res, structure);
} catch (error) {
logger.error({ error }, 'Structure generation failed');
throw error;
}
}

// POST /api/generate/prose
static async generateProse(req: AuthenticatedRequest, res: Response) {
try {
const {
bookId,
prompt,
instructions,
sceneId,
useCodexRAG,
codexTypes,
codexK,
tokenBudget,
selectedModel,
targetWords,
pov,
tense,
mustInclude,
mustAvoid,
qualityMode,
genre,
} = req.body;
const normalizedInstructions = typeof instructions === 'string' && instructions.trim().length > 0 ? instructions.trim() : prompt;
const normalizedQualityMode: 'strict' | undefined = qualityMode === 'strict' ? 'strict' : undefined;
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (!bookId || !normalizedInstructions) throw new ValidationError('bookId and prompt or instructions are required');

const book = await databaseService.client.book.findFirst({ where: { id: Number(bookId), userId: req.user.id } });
if (!book) throw new NotFoundError('Book not found');

let scene: Scene | null = null;
if (sceneId) {
scene = await databaseService.client.scene.findFirst({ where: { id: Number(sceneId), chapter: { act: { bookId: Number(bookId) } } } });
if (!scene) throw new NotFoundError('Scene not found');
}

// Use centralized SceneProseService for prose generation
const sceneProseService = new SceneProseService();

// Extract context from prompt parameters (legacy compatibility)
const context = {
bookId: Number(bookId),
sceneId: sceneId ? Number(sceneId) : undefined,
title: book.title || 'Untitled',
summary: book.summary || undefined,
targetAudience: book.targetAudience || undefined,
useCodexRAG: !!useCodexRAG,
codexTypes: codexTypes ? codexTypes.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
codexK: codexK ? Number(codexK) : undefined,
tokenBudget: tokenBudget ? Number(tokenBudget) : defaultRagTokenBudget(),
// For legacy compatibility, pass the original prompt as additional context
additionalContext: prompt,
instructions: normalizedInstructions,
targetWords: targetWords ? Number(targetWords) : undefined,
pov: typeof pov === 'string' ? pov : undefined,
tense: typeof tense === 'string' ? tense : undefined,
mustInclude: Array.isArray(mustInclude)
  ? mustInclude.map((value: unknown) => String(value).trim()).filter(Boolean)
  : typeof mustInclude === 'string'
    ? mustInclude.split(',').map((value: string) => value.trim()).filter(Boolean)
    : undefined,
mustAvoid: Array.isArray(mustAvoid)
  ? mustAvoid.map((value: unknown) => String(value).trim()).filter(Boolean)
  : typeof mustAvoid === 'string'
    ? mustAvoid.split(',').map((value: string) => value.trim()).filter(Boolean)
    : undefined,
qualityMode: normalizedQualityMode,
genre: typeof genre === 'string' && genre.trim().length > 0 ? genre.trim() : book.genre || undefined,
};

const options = {
selectedModel,
timeoutMs: Number(process.env.AI_TIMEOUT_PROSE_MS ?? '120000') || 120000,
retries: 2
};

logger.info({ bookId, sceneId, useCodexRAG: !!useCodexRAG }, 'Starting centralized prose generation');

const result = await sceneProseService.generateProse(context, options);

// Log for compatibility with existing analytics
if (result.codexUsed?.length) {
try { 
logRag({ type: 'prose.rag.apply', bookId: Number(bookId), sceneId: scene?.id, count: result.codexUsed.length }); 
} catch {}
}

// Log generation history
await logHistory({
userId: req.user.id,
entityType: 'prose',
entityId: sceneId ? Number(sceneId) : Number(bookId),
prompt: normalizedInstructions,
generatedContent: result.prose,
modelUsed: result.model || selectedModel
});

logger.info({ 
bookId, 
sceneId, 
wordCount: result.wordCount, 
ragEntries: result.codexUsed?.length || 0,
model: result.model
}, 'Prose generation completed via centralized service');

return respondSuccess(res, {
prose: result.prose,
wordCount: result.wordCount,
codexUsed: result.codexUsed,
model: result.model,
traceId: result.traceId,
genreKey: result.genreKey,
recipeVersion: result.recipeVersion,
judgeStatus: result.judgeStatus,
adapterUsed: result.adapterUsed,
validatorResults: result.validatorResults,
revisionApplied: result.revisionApplied,
});

} catch (error) {
logger.error({ error, bookId: req.body.bookId, sceneId: req.body.sceneId }, 'Centralized prose generation failed');
throw error;
}
}

// POST /api/generate/prose/batch
static async batchGenerateProse(req: AuthenticatedRequest, res: Response) {
try {
const {
bookId,
items,
maxConcurrency,
continueOnError = true,
saveToScene = false,
useCodexRAG,
codexTypes,
codexK,
tokenBudget,
selectedModel,
} = req.body;
if (!req.user?.id) throw new AuthenticationError('Unauthorized');
if (!bookId || !Array.isArray(items) || items.length === 0) throw new ValidationError('bookId and items are required');

const userId = req.user.id;
const numericBookId = Number(bookId);
const book = await databaseService.client.book.findFirst({ where: { id: numericBookId, userId } });
if (!book) throw new NotFoundError('Book not found');

const envConcurrency = Number.parseInt(process.env.GENERATION_BATCH_MAX_CONCURRENT || process.env.AI_MAX_CONCURRENT || '4', 10) || 4;
const requestedConcurrency = Number(maxConcurrency || envConcurrency);
// Canonical scene jobs share evolving memory and ledgers; serialize them so an
// adjacent scene never drafts against stale state. Prompt-only alternatives
// without scene IDs remain safe to parallelize.
const hasCanonicalSceneItems = items.some((item: Record<string, unknown>) => Boolean(item.sceneId));
const effectiveConcurrency = hasCanonicalSceneItems ? 1 : Math.max(1, Math.min(8, items.length, requestedConcurrency));
let stopped = false;
let clientClosed = false;
req.on('aborted', () => { clientClosed = true; stopped = true; });
res.on('close', () => { if (!res.writableEnded) { clientClosed = true; stopped = true; } });

const service = SceneProseService.getInstance();
const results: Array<Record<string, unknown>> = new Array(items.length);
let nextIndex = 0;
let ownCommittedRevision: string | undefined;
let batchBaseRevision: string | undefined;

const parseList = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return undefined;
};

const processItem = async (index: number): Promise<void> => {
  const item = items[index] || {};
  const sceneId = item.sceneId ? Number(item.sceneId) : undefined;
  let scene: SceneWithContext | null = null;
  if (sceneId) {
    scene = await databaseService.client.scene.findFirst({
      where: {
        id: sceneId,
        deletedAt: null,
        chapter: { act: { bookId: numericBookId, book: { userId } } },
      },
      include: {
        chapter: {
          include: {
            act: true,
          },
        },
      },
    });
    if (!scene) throw new NotFoundError(`Scene ${sceneId} not found`);
  }

  const normalizedInstructions =
    typeof item.instructions === 'string' && item.instructions.trim()
      ? item.instructions.trim()
      : typeof item.prompt === 'string' && item.prompt.trim()
        ? item.prompt.trim()
        : scene?.outline || scene?.summary || `Draft prose for scene ${sceneId}.`;

  const context = {
    bookId: numericBookId,
    sceneId,
    title: book.title || 'Untitled',
    genre: typeof item.genre === 'string' && item.genre.trim().length > 0 ? item.genre.trim() : book.genre || undefined,
    summary: book.summary || undefined,
    targetAudience: book.targetAudience || undefined,
    actNumber: scene?.chapter?.act?.actNumber,
    actTitle: scene?.chapter?.act?.title ?? undefined,
    actSummary: scene?.chapter?.act?.summary ?? undefined,
    chapterId: scene?.chapterId,
    chapterNumber: scene?.chapter?.chapterNumber,
    chapterTitle: scene?.chapter?.title ?? undefined,
    chapterSummary: scene?.chapter?.summary ?? undefined,
    sceneNumber: scene?.sceneNumber,
    sceneSummary: scene?.summary ?? undefined,
    sceneOutline: scene?.outline ?? undefined,
    useCodexRAG: useCodexRAG === true,
    codexTypes: codexTypes ? String(codexTypes).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
    codexK: codexK ? Number(codexK) : undefined,
    tokenBudget: tokenBudget ? Number(tokenBudget) : defaultRagTokenBudget(),
    instructions: normalizedInstructions,
    additionalContext: item.prompt,
    targetWords: item.targetWords ? Number(item.targetWords) : undefined,
    pov: typeof item.pov === 'string' ? item.pov : undefined,
    tense: typeof item.tense === 'string' ? item.tense : undefined,
    mustInclude: parseList(item.mustInclude),
    mustAvoid: parseList(item.mustAvoid),
    qualityMode: item.qualityMode === 'strict' ? 'strict' as const : undefined,
  };

  let generated: SceneProseResult; let savedScene: unknown;
  if (documentAuthorityEnabled() && saveToScene && sceneId) {
    const expected = parseDocumentMutationPreconditions(item.documentPreconditions);
    if (!expected) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Each saved batch scene requires its source revisions and operation ID.', 428);
    batchBaseRevision ??= expected.expectedRevisionId;
    const bound = ownCommittedRevision && expected.expectedRevisionId === batchBaseRevision ? { ...expected, expectedRevisionId: ownCommittedRevision } : expected;
    const saved = await generateOwnedScene(userId, { bookId: numericBookId, sceneId, expected: bound, context, options: { selectedModel, timeoutMs: Number(process.env.AI_TIMEOUT_PROSE_MS ?? '120000') || 120000 } });
    generated = saved.generation; savedScene = saved.scene; ownCommittedRevision = saved.scene.documentRevision!.bookRevisionId;
  } else {
    generated = await service.generateProse(context, { selectedModel, timeoutMs: Number(process.env.AI_TIMEOUT_PROSE_MS ?? '120000') || 120000, retries: 2, signal: req.operationSignal });
    if (saveToScene && sceneId) savedScene = await scenesService.updateSceneProse(userId, sceneId, { prose: generated.prose });
  }

  await logHistory({
    userId,
    entityType: 'prose-batch',
    entityId: sceneId || numericBookId,
    prompt: normalizedInstructions,
    generatedContent: generated.prose,
    modelUsed: generated.model || selectedModel,
  });

  results[index] = {
    index,
    status: 'completed',
    sceneId,
    saved: Boolean(savedScene),
    documentRevision: savedScene && typeof savedScene === 'object' && 'documentRevision' in savedScene ? savedScene.documentRevision : undefined,
    prose: generated.prose,
    wordCount: generated.wordCount,
    codexUsed: generated.codexUsed,
    model: generated.model,
    traceId: generated.traceId,
    genreKey: generated.genreKey,
    recipeVersion: generated.recipeVersion,
    judgeStatus: generated.judgeStatus,
  };
};

const worker = async (): Promise<void> => {
  while (!stopped) {
    const index = nextIndex++;
    if (index >= items.length) return;
    try {
      await processItem(index);
    } catch (error) {
      results[index] = {
        index,
        status: clientClosed ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : 'Generation failed',
      };
      if (!continueOnError) stopped = true;
    }
  }
};

await Promise.all(Array.from({ length: effectiveConcurrency }, () => worker()));

for (let index = 0; index < results.length; index += 1) {
  if (!results[index]) {
    results[index] = { index, status: 'cancelled', error: clientClosed ? 'Client disconnected' : 'Batch stopped before this item ran' };
  }
}

if (clientClosed) return;

const completed = results.filter((result) => result.status === 'completed').length;
const failed = results.filter((result) => result.status === 'failed').length;
const cancelled = results.filter((result) => result.status === 'cancelled').length;
return respondSuccess(res, {
  bookId: numericBookId,
  requested: items.length,
  completed,
  failed,
  cancelled,
  maxConcurrency: effectiveConcurrency,
  saveToScene: Boolean(saveToScene),
  results,
}, failed || cancelled ? 207 : 200);
} catch (error) {
logger.error({ error, bookId: req.body.bookId }, 'Batch prose generation failed');
throw error;
}
}

/**
 * POST /api/generate/prose/revise
 *
 * Closed-loop revision: accepts original prose + skill findings,
 * produces a targeted revision that addresses the specific findings.
 */
static async reviseFromFindings(req: AuthenticatedRequest, res: Response) {
  try {
    const { bookId, sceneId, originalText, findings, sceneOutline, instruction, selectedModel } = req.body;
    if (!req.user?.id) throw new AuthenticationError('Unauthorized');

    const book = await databaseService.client.book.findFirst({ where: { id: Number(bookId), userId: req.user.id } });
    if (!book) throw new NotFoundError('Book not found');

    if (documentAuthorityEnabled()) return respondSuccess(res, await compatibilityRevisionProposal(req.user.id, {
      bookId: Number(bookId), sceneId: sceneId ? Number(sceneId) : undefined, originalText, selectedModel,
      documentPreview: req.body.documentPreview,
      instruction: [instruction || 'Address the supplied editorial findings within the disclosed targets.', `Editorial findings:\n${JSON.stringify(findings)}`].join('\n\n'),
    }));

    const sceneProseService = new SceneProseService();
    const result = await sceneProseService.reviseFromFindings(
      originalText,
      findings,
      { sceneOutline, instruction },
      {
        selectedModel,
        timeoutMs: Number(process.env.AI_TIMEOUT_REVIEW_MS ?? '60000') || 60000,
        retries: 1,
      }
    );

    // Log generation history
    await logHistory({
      userId: req.user.id,
      entityType: 'prose-revision',
      entityId: sceneId ? Number(sceneId) : Number(bookId),
      prompt: `[revise-from-findings] ${findings.length} findings`,
      generatedContent: result.revised,
      modelUsed: result.model || selectedModel,
    });

    logger.info({
      bookId,
      sceneId,
      findingsAddressed: result.findingsAddressed,
      model: result.model,
    }, 'Closed-loop prose revision completed');

    return respondSuccess(res, {
      revised: result.revised,
      findingsAddressed: result.findingsAddressed,
      model: result.model,
    });
  } catch (error) {
    logger.error({ error, bookId: req.body.bookId }, 'Prose revision from findings failed');
    throw error;
  }
}

static async commandRevise(req: AuthenticatedRequest, res: Response) {
  try {
    const { bookId, sceneId, originalText, instruction, scope, sceneOutline, selectedModel } = req.body;
    if (!req.user?.id) throw new AuthenticationError('Unauthorized');

    const book = await databaseService.client.book.findFirst({ where: { id: Number(bookId), userId: req.user.id } });
    if (!book) throw new NotFoundError('Book not found');

    if (documentAuthorityEnabled()) return respondSuccess(res, await compatibilityRevisionProposal(req.user.id, {
      bookId: Number(bookId), sceneId: sceneId ? Number(sceneId) : undefined, originalText, instruction, scope,
      selectedModel, documentPreview: req.body.documentPreview,
    }));

    const sceneProseService = new SceneProseService();
    const maxEditPct = scope === 'paragraph' ? 35 : 20;
    const result = await sceneProseService.reviewProse(
      originalText,
      {
        maxEditPct,
        instruction,
        sceneOutline,
      },
      {
        selectedModel,
        timeoutMs: Number(process.env.AI_TIMEOUT_REVIEW_MS ?? '60000') || 60000,
        retries: 1,
      },
    );

    await logHistory({
      userId: req.user.id,
      entityType: 'prose-command-revision',
      entityId: sceneId ? Number(sceneId) : Number(bookId),
      prompt: `[command-revise:${scope}] ${instruction}`,
      generatedContent: result.revised,
      modelUsed: result.model || selectedModel,
    });

    logger.info({
      bookId,
      sceneId,
      scope,
      model: result.model,
    }, 'Command-based prose revision completed');

    return respondSuccess(res, {
      revised: result.revised,
      scope,
      model: result.model,
    });
  } catch (error) {
    logger.error({ error, bookId: req.body.bookId }, 'Command-based prose revision failed');
    throw error;
  }
}
}
