import { z } from 'zod';

// ─── Shared enums ──────────────────────────────────────

export const DraftStatusSchema = z.enum(['draft', 'outlining', 'writing', 'revising', 'complete']);
export const CodexEntryTypeSchema = z.enum([
  'character',
  'location',
  'item',
  'faction',
  'event',
  'rule',
  'culture',
  'relationship',
]);
export const PlotThreadStatusSchema = z.enum(['open', 'escalated', 'resolved', 'abandoned']);
export const IssueSeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);
export const BeatStatusSchema = z.enum(['pending', 'mapped', 'written', 'revised']);
export const WorkflowStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export const ExportFormatSchema = z.enum([
  'markdown',
  'text',
  'html',
  'json',
  'epub',
  'pdf',
  'docx',
]);

// ─── Pagination ────────────────────────────────────────

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const PaginatedMetaSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

// ─── Response Envelope ─────────────────────────────────

export const ApiErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});

// ─── Book Schemas ──────────────────────────────────────

export const CreateBookSchema = z.object({
  title: z.string().min(1).max(500),
  genre: z.string().max(100).optional(),
  archetype: z.string().max(100).optional(),
  targetAudience: z.string().max(200).optional(),
  writingStyle: z.string().max(200).optional(),
  summary: z.string().max(10000).optional(),
  tagline: z.string().max(500).optional(),
});

export const UpdateBookSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  genre: z.string().max(100).optional(),
  archetype: z.string().max(100).optional(),
  targetAudience: z.string().max(200).optional(),
  draftStatus: DraftStatusSchema.optional(),
  writingStyle: z.string().max(200).optional(),
  summary: z.string().max(10000).optional(),
  tagline: z.string().max(500).optional(),
  storyOutline: z.string().max(100000).optional(),
});

export const BookQuerySchema = PaginationQuerySchema.extend({
  genre: z.string().optional(),
  archetype: z.string().optional(),
  draftStatus: DraftStatusSchema.optional(),
  search: z.string().max(200).optional(),
});

// ─── Structure Schemas ─────────────────────────────────

export const CreateActSchema = z.object({
  actNumber: z.number().int().min(1),
  title: z.string().max(500).optional(),
  summary: z.string().max(10000).optional(),
});

export const UpdateActSchema = z.object({
  actNumber: z.number().int().min(1).optional(),
  title: z.string().max(500).optional(),
  summary: z.string().max(10000).optional(),
});

export const CreateChapterSchema = z.object({
  chapterNumber: z.number().int().min(1),
  title: z.string().max(500).optional(),
  summary: z.string().max(10000).optional(),
});

export const UpdateChapterSchema = z.object({
  chapterNumber: z.number().int().min(1).optional(),
  title: z.string().max(500).optional(),
  summary: z.string().max(10000).optional(),
});

export const CreateSceneSchema = z.object({
  sceneNumber: z.number().int().min(1),
  outline: z.string().max(10000).optional(),
  summary: z.string().max(10000).optional(),
  prose: z.string().max(500000).optional(),
  beatsMeta: z.string().max(50000).optional(),
});

export const UpdateSceneSchema = z.object({
  sceneNumber: z.number().int().min(1).optional(),
  outline: z.string().max(10000).optional(),
  summary: z.string().max(10000).optional(),
  prose: z.string().max(500000).optional(),
  wordCount: z.number().int().min(0).optional(),
  beatsMeta: z.string().max(50000).optional(),
});

export const BatchCreateScenesSchema = z.object({
  scenes: z.array(CreateSceneSchema).min(1).max(100),
});

// ─── Codex Schemas ─────────────────────────────────────

export const CreateCodexEntrySchema = z.object({
  entryType: CodexEntryTypeSchema,
  entryName: z.string().min(1).max(500),
  entryDescription: z.string().max(50000).optional(),
  attributes: z.string().max(50000).optional(),
});

export const UpdateCodexEntrySchema = z.object({
  entryType: CodexEntryTypeSchema.optional(),
  entryName: z.string().min(1).max(500).optional(),
  entryDescription: z.string().max(50000).optional(),
  attributes: z.string().max(50000).optional(),
});

export const CodexQuerySchema = PaginationQuerySchema.extend({
  entryType: CodexEntryTypeSchema.optional(),
  search: z.string().max(200).optional(),
});

// ─── Generation Schemas ────────────────────────────────

export const GenerateProseSchema = z.object({
  sceneId: z.string().uuid(),
  model: z.string().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32000).optional(),
  instructions: z.string().max(5000).optional(),
});

export const GenerateCharacterSchema = z.object({
  bookId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  role: z.string().max(200).optional(),
  instructions: z.string().max(5000).optional(),
});

export const GenerateOutlineSchema = z.object({
  bookId: z.string().uuid(),
  instructions: z.string().max(5000).optional(),
});

export const GenerateCodexSchema = z.object({
  bookId: z.string().uuid(),
  entryType: CodexEntryTypeSchema,
  instructions: z.string().max(5000).optional(),
});

export const GenerateTitleSchema = z.object({
  bookId: z.string().uuid(),
  count: z.number().int().min(1).max(20).default(5),
});

export const GenerateFeedbackSchema = z.object({
  bookId: z.string().uuid(),
  sceneId: z.string().uuid().optional(),
  chapterId: z.string().uuid().optional(),
});

export const GenerateSynopsisSchema = z.object({
  bookId: z.string().uuid(),
  variant: z.enum(['one-page', 'two-page', 'five-page']).default('one-page'),
});

export const GenerateLocationSchema = z.object({
  bookId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  locationType: z.string().max(100).optional(),
  instructions: z.string().max(5000).optional(),
});

export const GenerateItemSchema = z.object({
  bookId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  itemType: z.string().max(100).optional(),
  instructions: z.string().max(5000).optional(),
});

export const GenerateStructureSchema = z.object({
  bookId: z.string().uuid(),
  archetype: z.string().max(100).optional(),
  actCount: z.number().int().min(1).max(10).optional(),
  instructions: z.string().max(5000).optional(),
});

export const GenerateSummarySchema = z.object({
  bookId: z.string().uuid(),
  sceneId: z.string().uuid().optional(),
  chapterId: z.string().uuid().optional(),
  instructions: z.string().max(5000).optional(),
});

export const GenerateTaglineSchema = z.object({
  bookId: z.string().uuid(),
  count: z.number().int().min(1).max(20).default(5),
});

export const GenerateInlineSuggestionSchema = z.object({
  bookId: z.string().uuid(),
  sceneId: z.string().uuid(),
  cursorPosition: z.number().int().min(0),
  surroundingText: z.string().max(10000),
  instructions: z.string().max(2000).optional(),
});

export const GenerateProseReviseSchema = z.object({
  sceneId: z.string().uuid(),
  findingIds: z.array(z.string()).min(1).max(50).optional(),
  instructions: z.string().max(5000).optional(),
});

// ─── Notes Schemas ─────────────────────────────────────

export const CreateNoteSchema = z.object({
  bookId: z.string().uuid(),
  title: z.string().max(500).optional(),
  content: z.string().min(1).max(50000),
});

export const UpdateNoteSchema = z.object({
  title: z.string().max(500).optional(),
  content: z.string().min(1).max(50000).optional(),
});

// ─── Export Schemas ────────────────────────────────────

export const ExportBookSchema = z.object({
  format: ExportFormatSchema,
  includeCodex: z.boolean().default(false),
  includeMetadata: z.boolean().default(true),
  includeSummaries: z.boolean().default(false),
  includeSynopsis: z.boolean().default(false),
});

// ─── Wizard Schemas ────────────────────────────────────

export const StartWizardSchema = z.object({
  bookId: z.string().uuid(),
  archetype: z.string().max(100).optional(),
  premise: z.string().max(5000).optional(),
  genre: z.string().max(100).optional(),
});

export const WizardControlSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel']),
});

// ─── Quality Schemas ───────────────────────────────────

export const QualityReportQuerySchema = z.object({
  includeResolved: z.coerce.boolean().default(false),
  issueType: z.string().optional(),
  severity: IssueSeveritySchema.optional(),
});

export const ReviseFromFindingsSchema = z.object({
  sceneId: z.string().uuid(),
  findingIds: z.array(z.string().uuid()).min(1).max(50),
});

// ─── SSE Event Contracts ───────────────────────────────

export const ProseStreamEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('token'), data: z.string() }),
  z.object({
    event: z.literal('meta'),
    data: z.object({
      wordCount: z.number(),
      model: z.string(),
      latencyMs: z.number(),
    }),
  }),
  z.object({ event: z.literal('error'), data: z.object({ message: z.string() }) }),
  z.object({ event: z.literal('done'), data: z.object({}) }),
]);

export const WizardStreamEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('progress'),
    data: z.object({
      phase: z.string(),
      step: z.string(),
      description: z.string(),
      status: WorkflowStatusSchema,
    }),
  }),
  z.object({ event: z.literal('error'), data: z.object({ message: z.string() }) }),
  z.object({ event: z.literal('done'), data: z.object({}) }),
]);

// ─── Memory Schemas ────────────────────────────────────

export const CanonFactTypeSchema = z.enum([
  'trait',
  'relationship',
  'possession',
  'location',
  'ability',
  'status',
  'knowledge',
  'allegiance',
  'custom',
]);

export const MemoryQuerySchema = z.object({
  bookId: z.string().uuid(),
  subject: z.string().max(200).optional(),
  factType: CanonFactTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const ApproveExtractionSchema = z.object({
  approvalId: z.string().uuid(),
  action: z.enum(['approve', 'reject']),
});

export const ExtractMemorySchema = z.object({
  bookId: z.string().uuid(),
  sceneId: z.string().uuid(),
});

// ─── ID Param Schema ───────────────────────────────────

export const IdParamSchema = z.object({
  id: z.string().uuid(),
});

export const BookIdParamSchema = z.object({
  bookId: z.string().uuid(),
});

// ─── Image Schemas ─────────────────────────────────────

export const ImageEntityTypeSchema = z.enum([
  'cover',
  'character',
  'location',
  'scene',
  'chapter',
  'act',
]);

export const GenerateImageSchema = z.object({
  prompt: z.string().min(1).max(4000),
  provider: z.enum(['forge', 'flux']).default('flux'),
  bookId: z.string().uuid().optional(),
  entityType: ImageEntityTypeSchema.optional(),
  entityId: z.string().uuid().optional(),
  width: z.coerce.number().int().min(64).max(2048).default(1024),
  height: z.coerce.number().int().min(64).max(2048).default(1024),
  steps: z.coerce.number().int().min(1).max(100).default(28),
  seed: z.coerce.number().int().default(-1),
  cfgScale: z.coerce.number().min(0).max(50).default(1),
  distilledCfgScale: z.coerce.number().min(0).max(50).optional(),
  samplerName: z.string().max(50).default('dpmpp_2m_sde'),
  scheduler: z.string().max(50).default('karras'),
  model: z.string().max(200).optional(),
  n: z.coerce.number().int().min(1).max(4).default(1),
});

export const SuggestImagePromptSchema = z.object({
  bookId: z.string().uuid(),
  targetType: ImageEntityTypeSchema,
  info: z.record(z.string(), z.unknown()).optional(),
});

export const ImageListQuerySchema = z.object({
  bookId: z.string().uuid().optional(),
  entityType: ImageEntityTypeSchema.optional(),
  entityId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
