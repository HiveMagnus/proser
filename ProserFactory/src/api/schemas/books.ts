import { z } from 'zod';
import { documentMutationPreconditionsSchema } from './documents';
import {
  bookIdParams, idParams, positiveIntParam,
  optionalStr, requiredStr, optionalInt, optionalIntQuery, paginationQuery,
} from './shared';

const MAX_CONTEXT_TOKENS = Number.parseInt(process.env.MAX_CONTEXT_TOKENS || '150000', 10);
const MAX_CONTEXT_CHARS = Math.max(40000, MAX_CONTEXT_TOKENS * 4);

// Active book reads default to metadata. Scene compatibility reads preserve
// their historical default but can explicitly omit prose with includeProse=0.
export const compatibilityProjectionQuery = paginationQuery.extend({
  includeProse: z.enum(['0', '1', 'false', 'true']).optional(),
}).passthrough();

// --- Books ---

export const createBookBody = z.object({
  operationId: z.string().uuid().optional(),
  title: optionalStr('title', 255),
  genre: optionalStr('genre', 100),
  targetAudience: optionalStr('targetAudience', 100),
  summary: optionalStr('summary', MAX_CONTEXT_CHARS),
}).passthrough();

export const updateBookBody = z.object({
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
  title: optionalStr('title', 255),
  genre: optionalStr('genre', 100),
  targetAudience: optionalStr('targetAudience', 100),
  summary: optionalStr('summary', MAX_CONTEXT_CHARS),
  tagline: optionalStr('tagline', 500),
  storyOutline: optionalStr('storyOutline', MAX_CONTEXT_CHARS),
  draftStatus: optionalStr('draftStatus', 100),
  storyArchetypeKey: optionalStr('storyArchetypeKey', 100),
  story_archetype_key: optionalStr('story_archetype_key', 100),
  selectedImageId: optionalInt('selectedImageId', 0),
  selected_image_id: optionalInt('selected_image_id', 0),
}).passthrough();

// --- Codex (nested under books) ---

export const codexSearchQuery = z.object({
  outline: optionalStr('outline', MAX_CONTEXT_CHARS),
  summary: optionalStr('summary', MAX_CONTEXT_CHARS),
  types: optionalStr('types', 100),
  tokenBudget: z.coerce.number().int().min(50).max(MAX_CONTEXT_TOKENS).optional(),
  k: z.coerce.number().int().min(1).max(200).optional(),
}).passthrough();

export const createCodexBody = z.object({
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
  entryType: z.enum(
    ['character', 'location', 'lore', 'item', 'faction', 'event', 'rule', 'culture', 'relationship'],
    { error: 'entryType is required' },
  ),
  entryName: requiredStr('entryName', 1, 255),
  entryDescription: optionalStr('entryDescription', 5000),
  attributes: optionalStr('attributes', 50000),
}).passthrough();

// --- Structure ---

const actItem = z.object({
  id: z.number().int().positive().optional(),
  title: optionalStr('title', 255),
  summary: optionalStr('summary', 5000),
  chapters: z.array(z.object({ id: z.number().int().positive().optional(), title: optionalStr('title', 255), summary: optionalStr('summary', 5000) }).passthrough(), { error: 'chapters must be array' }).max(500),
}).passthrough();

export const saveStructureBody = z.object({
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
  acts: z.array(actItem, { error: 'acts is required' }).min(1).max(100),
}).passthrough();

const reorderItem = z.object({ id: z.number({ error: 'id must be number' }).int() }).passthrough();

export const reorderActsBody = z.object({
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
  reorderedActs: z.array(reorderItem, { error: 'reorderedActs is required' }),
}).passthrough();

export const reorderChaptersBody = z.object({
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
  reorderedChapters: z.array(reorderItem, { error: 'reorderedChapters is required' }),
}).passthrough();

// --- Acts / Chapters (shared shape) ---

export const actChapterBody = z.object({
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
  title: optionalStr('title', 255),
  summary: optionalStr('summary', 5000),
}).passthrough();

// --- Scenes ---

export const bookIdActIdParams = z.object({
  bookId: positiveIntParam('bookId'),
  actId: positiveIntParam('actId'),
});

export const bookIdChapterIdParams = z.object({
  bookId: positiveIntParam('bookId'),
  chapterId: positiveIntParam('chapterId'),
});

export const bookIdSceneIdParams = z.object({
  bookId: positiveIntParam('bookId'),
  sceneId: positiveIntParam('sceneId'),
});

export const bookIdActIdChapterIdParams = bookIdActIdParams;

export const sceneGenerationBody = z.object({
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
  generationOperationId: z.string().uuid().optional(),
  generate: z.boolean().optional(),
  useCodexRAG: z.boolean().optional(),
  codexTypes: optionalStr('codexTypes', 100),
  codexK: optionalInt('codexK', 1, 200),
  tokenBudget: optionalInt('tokenBudget', 100, MAX_CONTEXT_TOKENS),
  selectedModel: optionalStr('selectedModel', 100),
}).passthrough();
export const sceneBody = sceneGenerationBody.extend({
  title: optionalStr('title', 255),
  prose: optionalStr('prose', 50000),
  summary: optionalStr('summary', 5000),
  outline: optionalStr('outline', 10000),
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
}).passthrough();

export const batchScenesBody = z.object({
  scenes: z.array(z.object({}).passthrough(), { error: 'scenes is required' }).min(1),
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
}).passthrough();

export const reorderScenesBody = z.object({
  reorderedScenes: z.array(reorderItem, { error: 'reorderedScenes is required' }),
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
}).passthrough();

// --- Notes ---

export const bookIdNoteIdParams = z.object({
  bookId: positiveIntParam('bookId'),
  noteId: positiveIntParam('noteId'),
});

export const noteBody = z.object({
  content: optionalStr('content', 10000),
}).passthrough();

// --- Export ---

export const exportQuery = z.object({
  format: z.enum(['markdown', 'html', 'rtf']).optional(),
  includeCodex: z.coerce.boolean().optional(),
  includeMetadata: z.coerce.boolean().optional(),
  includeSummaries: z.coerce.boolean().optional(),
  download: z.coerce.boolean().optional(),
}).passthrough();

export const createExportArtifactBody = z.object({
  operationId:z.string().uuid().optional(),
  expectedRevisionId:z.string().uuid().optional(),
  mode:z.enum(['retain-review','final','original']).optional(),
  preset:z.enum(['saved','submission-manuscript','print-book']).optional(),
  format: z.literal('markdown').optional(),
  includeCodex: z.boolean().optional(),
  includeMetadata: z.boolean().optional(),
  includeSummaries: z.boolean().optional(),
}).strict();

export const exportArtifactParams = z.object({
  bookId: positiveIntParam('bookId'),
  artifactId: z.union([z.string().regex(/^[a-f0-9]{64}$/), z.string().uuid()]),
}).strict();

export const readExportArtifactQuery = z.object({
  scope: z.enum(['book', 'chapter', 'scene']),
  actNumber: optionalIntQuery('actNumber'),
  chapterId: optionalIntQuery('chapterId'),
  chapterNumber: optionalIntQuery('chapterNumber'),
  sceneId: optionalIntQuery('sceneId'),
  sceneNumber: optionalIntQuery('sceneNumber'),
  offset: z.coerce.number().int().min(0).optional(),
  maxChars: z.coerce.number().int().min(1).max(120000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.scope === 'chapter' && value.chapterId === undefined && value.chapterNumber === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'chapterId or chapterNumber is required for chapter scope' });
  }
  if (value.scope === 'scene' && value.sceneId === undefined && value.sceneNumber === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sceneId or sceneNumber is required for scene scope' });
  }
});

// Re-export shared params for convenience
export { bookIdParams, idParams, paginationQuery };

export const writingStatsQuery = z.object({
  days: z.coerce.number().int().min(7).max(365).optional(),
  tz: z.string().max(64).optional(),
}).strict();

const nullableGoalInt = (name: string, max: number) =>
  z.number({ error: `${name} must be a whole number or null` }).int(`${name} must be a whole number`).min(1, `${name} must be at least 1`).max(max, `${name} must not exceed ${max}`).nullable();

export const writingGoalBody = z.object({
  targetWords: nullableGoalInt('targetWords', 10_000_000),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'deadline must be a YYYY-MM-DD date')
    .refine((value) => { const date = new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }, 'deadline must be a real calendar date')
    .nullable(),
  dailyWords: nullableGoalInt('dailyWords', 1_000_000),
}).strict();

export const recommendationsQuery = z.object({
  tz: z.string().max(64).optional(),
}).strict();
