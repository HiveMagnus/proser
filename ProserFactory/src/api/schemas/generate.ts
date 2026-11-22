import { z } from 'zod';
import { requiredStr, optionalStr, optionalInt, requiredInt } from './shared';

const documentPreview = z.object({ discussionId: z.string().uuid(), operationId: z.string().uuid() }).strict();

const MAX_CONTEXT_TOKENS = Number.parseInt(process.env.MAX_CONTEXT_TOKENS || '150000', 10);
const MAX_CONTEXT_CHARS = Math.max(40000, MAX_CONTEXT_TOKENS * 4);
const FEEDBACK_MAX_CHARS = Number.parseInt(process.env.FEEDBACK_MAX_CHARS || String(MAX_CONTEXT_CHARS), 10);

// --- Character / Location / Item ---

export const codexGenBody = z.object({
  bookId: requiredInt('bookId', 1),
  prompt: requiredStr('prompt', 1, 10000),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough();

// --- Outline ---

export const outlineBody = z.object({
  prompt: requiredStr('prompt', 1, 10000),
  numberOfActs: z.number().int().min(1).max(10).optional(),
  chaptersPerAct: z.number().int().min(1).max(20).optional(),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough();

// --- Summary ---

export const summaryBody = z.object({
  bookId: requiredInt('bookId', 1),
  prompt: optionalStr('prompt', MAX_CONTEXT_CHARS),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough();

// --- Title ---

export const titleBody = z.object({
  genre: requiredStr('genre', 1, 100),
  summary: requiredStr('summary', 1, MAX_CONTEXT_CHARS),
  prompt: requiredStr('prompt', 1, MAX_CONTEXT_CHARS),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough();

// --- Tagline ---

export const taglineBody = z.object({
  title: requiredStr('title', 1, 200),
  genre: requiredStr('genre', 1, 100),
  summary: requiredStr('summary', 1, MAX_CONTEXT_CHARS),
  prompt: requiredStr('prompt', 1, MAX_CONTEXT_CHARS),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough();

// --- Inline Suggestion ---

export const inlineSuggestionBody = z.object({
  bookId: requiredInt('bookId', 1),
  context: optionalStr('context', MAX_CONTEXT_CHARS),
  sceneId: optionalInt('sceneId', 1, 1000000000),
  documentPreview: documentPreview.optional(),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough().superRefine((value, ctx) => {
  if (!value.context && !value.documentPreview) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['context'], message: 'context or a disclosed documentPreview is required' });
});

// --- Feedback ---

export const feedbackBody = z.object({
  content: optionalStr('content', FEEDBACK_MAX_CHARS),
  bookId: optionalInt('bookId', 1, 1000000000),
  sceneId: optionalInt('sceneId', 1, 1000000000),
  documentPreview: documentPreview.optional(),
  feedbackType: optionalStr('feedbackType', 100),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough().superRefine((value, ctx) => {
  if (!value.content && !value.documentPreview) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'content or a disclosed documentPreview is required' });
});

// --- Structure generation ---

export const structureGenBody = z.object({
  bookId: requiredInt('bookId', 1),
  prompt: requiredStr('prompt', 1, MAX_CONTEXT_CHARS),
  numberOfActs: z.number().int().min(1).max(10).optional(),
  chaptersPerAct: z.number().int().min(1).max(20).optional(),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough();

// --- Prose generation ---

export const proseBody = z.object({
  bookId: requiredInt('bookId', 1),
  prompt: optionalStr('prompt', MAX_CONTEXT_CHARS),
  instructions: optionalStr('instructions', MAX_CONTEXT_CHARS),
  sceneId: optionalInt('sceneId', 1, 1000000000),
  useCodexRAG: optionalInt('useCodexRAG', 0, 1),
  codexTypes: optionalStr('codexTypes', 100),
  codexK: optionalInt('codexK', 1, 200),
  tokenBudget: optionalInt('tokenBudget', 100, MAX_CONTEXT_TOKENS),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough().superRefine((value, ctx) => {
  if (!value.prompt && !value.instructions) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prompt'],
      message: 'prompt or instructions is required',
    });
  }
});

export const proseOperationBody = z.intersection(
  z.object({ kind: z.literal('prose') }),
  proseBody,
);

const batchProseItemBody = z.object({
  sceneId: optionalInt('sceneId', 1, 1000000000),
  prompt: optionalStr('prompt', MAX_CONTEXT_CHARS),
  instructions: optionalStr('instructions', MAX_CONTEXT_CHARS),
  targetWords: optionalInt('targetWords', 50, 10000),
  pov: optionalStr('pov', 100),
  tense: optionalStr('tense', 100),
  mustInclude: z.array(z.string().max(1000)).max(40).optional(),
  mustAvoid: z.array(z.string().max(1000)).max(40).optional(),
  qualityMode: z.enum(['standard', 'strict']).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.prompt && !value.instructions && !value.sceneId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['instructions'],
      message: 'instructions, prompt, or sceneId is required',
    });
  }
});

export const batchProseBody = z.object({
  bookId: requiredInt('bookId', 1),
  items: z.array(batchProseItemBody, { error: 'items is required' }).min(1).max(24),
  maxConcurrency: optionalInt('maxConcurrency', 1, 8),
  continueOnError: z.boolean().optional(),
  saveToScene: z.boolean().optional(),
  useCodexRAG: z.boolean().optional(),
  codexTypes: optionalStr('codexTypes', 100),
  codexK: optionalInt('codexK', 1, 200),
  tokenBudget: optionalInt('tokenBudget', 100, MAX_CONTEXT_TOKENS),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough();

// --- Prose revision from skill findings ---

const revisionSource = (value: { originalText?: string; documentPreview?: unknown }, ctx: z.RefinementCtx) => {
  if (!value.originalText && !value.documentPreview) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['originalText'], message: 'originalText or a disclosed documentPreview is required' });
};

export const reviseFromFindingsBody = z.object({
  bookId: requiredInt('bookId', 1),
  sceneId: optionalInt('sceneId', 1, 1000000000),
  originalText: optionalStr('originalText', MAX_CONTEXT_CHARS),
  documentPreview: documentPreview.optional(),
  findings: z.array(z.object({
    type: z.string(),
    severity: z.enum(['error', 'warning', 'suggestion', 'info']),
    message: z.string().min(1),
    suggestion: z.string().optional(),
    confidence: z.number().min(0).max(1),
    span: z.object({ start: z.number(), end: z.number() }).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })).min(1, 'At least one finding is required'),
  sceneOutline: optionalStr('sceneOutline', MAX_CONTEXT_CHARS),
  instruction: optionalStr('instruction', MAX_CONTEXT_CHARS),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough().superRefine(revisionSource);

export const commandReviseBody = z.object({
  bookId: requiredInt('bookId', 1),
  sceneId: optionalInt('sceneId', 1, 1000000000),
  originalText: optionalStr('originalText', MAX_CONTEXT_CHARS),
  documentPreview: documentPreview.optional(),
  instruction: requiredStr('instruction', 1, MAX_CONTEXT_CHARS),
  scope: z.enum(['scene', 'paragraph']),
  sceneOutline: optionalStr('sceneOutline', MAX_CONTEXT_CHARS),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough().superRefine(revisionSource);
