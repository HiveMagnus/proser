import { describe, it, expect } from 'vitest';
import {
  // Structure
  CreateActSchema,
  UpdateActSchema,
  CreateChapterSchema,
  UpdateChapterSchema,
  UpdateSceneSchema,
  BatchCreateScenesSchema,
  BookQuerySchema,
  BookIdParamSchema,
  // Codex
  UpdateCodexEntrySchema,
  CodexQuerySchema,
  // Generate
  GenerateCharacterSchema,
  GenerateLocationSchema,
  GenerateItemSchema,
  GenerateCodexSchema,
  GenerateOutlineSchema,
  GenerateStructureSchema,
  GenerateSummarySchema,
  GenerateTitleSchema,
  GenerateTaglineSchema,
  GenerateInlineSuggestionSchema,
  GenerateFeedbackSchema,
  GenerateSynopsisSchema,
  GenerateProseReviseSchema,
  // Notes
  CreateNoteSchema,
  UpdateNoteSchema,
  // Wizard
  StartWizardSchema,
  WizardControlSchema,
  // Quality
  QualityReportQuerySchema,
  ReviseFromFindingsSchema,
  // Memory
  MemoryQuerySchema,
  CanonFactTypeSchema,
  // Images
  GenerateImageSchema,
  SuggestImagePromptSchema,
  ImageListQuerySchema,
  // SSE events
  ProseStreamEventSchema,
  WizardStreamEventSchema,
  // Enums
  DraftStatusSchema,
  CodexEntryTypeSchema,
  PlotThreadStatusSchema,
  IssueSeveritySchema,
  WorkflowStatusSchema,
  ExportFormatSchema,
} from '../schemas/index.js';

const uuid = '550e8400-e29b-41d4-a716-446655440000';
const uuid2 = '660e8400-e29b-41d4-a716-446655440001';

describe('Contract schemas — extended coverage', () => {
  // ── Structure schemas ──────────────────────────────

  describe('CreateActSchema', () => {
    it('accepts valid act', () => {
      expect(CreateActSchema.safeParse({ actNumber: 1, title: 'Act One' }).success).toBe(true);
    });
    it('requires actNumber', () => {
      expect(CreateActSchema.safeParse({ title: 'Act One' }).success).toBe(false);
    });
    it('rejects non-integer actNumber', () => {
      expect(CreateActSchema.safeParse({ actNumber: 1.5 }).success).toBe(false);
    });
    it('rejects actNumber < 1', () => {
      expect(CreateActSchema.safeParse({ actNumber: 0 }).success).toBe(false);
    });
  });

  describe('UpdateActSchema', () => {
    it('accepts empty object', () => {
      expect(UpdateActSchema.safeParse({}).success).toBe(true);
    });
    it('accepts partial update', () => {
      expect(UpdateActSchema.safeParse({ title: 'New Title' }).success).toBe(true);
    });
  });

  describe('CreateChapterSchema', () => {
    it('accepts valid chapter', () => {
      expect(CreateChapterSchema.safeParse({ chapterNumber: 1 }).success).toBe(true);
    });
    it('rejects missing chapterNumber', () => {
      expect(CreateChapterSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('UpdateChapterSchema', () => {
    it('accepts empty object', () => {
      expect(UpdateChapterSchema.safeParse({}).success).toBe(true);
    });
    it('accepts title update', () => {
      expect(UpdateChapterSchema.safeParse({ title: 'Renamed' }).success).toBe(true);
    });
  });

  describe('UpdateSceneSchema', () => {
    it('accepts wordCount update', () => {
      const r = UpdateSceneSchema.safeParse({ wordCount: 500 });
      expect(r.success).toBe(true);
    });
    it('rejects negative wordCount', () => {
      expect(UpdateSceneSchema.safeParse({ wordCount: -1 }).success).toBe(false);
    });
  });

  describe('BatchCreateScenesSchema', () => {
    it('accepts 1-100 scenes', () => {
      const scenes = [{ sceneNumber: 1 }, { sceneNumber: 2 }];
      expect(BatchCreateScenesSchema.safeParse({ scenes }).success).toBe(true);
    });
    it('rejects empty array', () => {
      expect(BatchCreateScenesSchema.safeParse({ scenes: [] }).success).toBe(false);
    });
  });

  describe('BookQuerySchema', () => {
    it('inherits pagination defaults', () => {
      const r = BookQuerySchema.safeParse({});
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.page).toBe(1);
        expect(r.data.limit).toBe(20);
      }
    });
    it('accepts genre filter', () => {
      const r = BookQuerySchema.safeParse({ genre: 'Fantasy' });
      expect(r.success).toBe(true);
    });
    it('accepts draftStatus filter', () => {
      const r = BookQuerySchema.safeParse({ draftStatus: 'writing' });
      expect(r.success).toBe(true);
    });
    it('rejects invalid draftStatus', () => {
      expect(BookQuerySchema.safeParse({ draftStatus: 'INVALID' }).success).toBe(false);
    });
    it('accepts search param', () => {
      const r = BookQuerySchema.safeParse({ search: 'dragon' });
      expect(r.success).toBe(true);
    });
  });

  describe('BookIdParamSchema', () => {
    it('accepts valid UUID', () => {
      expect(BookIdParamSchema.safeParse({ bookId: uuid }).success).toBe(true);
    });
    it('rejects non-UUID', () => {
      expect(BookIdParamSchema.safeParse({ bookId: 'abc' }).success).toBe(false);
    });
  });

  // ── Codex schemas ──────────────────────────────────

  describe('UpdateCodexEntrySchema', () => {
    it('accepts partial update', () => {
      expect(UpdateCodexEntrySchema.safeParse({ entryName: 'Renamed' }).success).toBe(true);
    });
    it('validates entryType when present', () => {
      expect(UpdateCodexEntrySchema.safeParse({ entryType: 'INVALID' }).success).toBe(false);
    });
  });

  describe('CodexQuerySchema', () => {
    it('accepts entryType filter', () => {
      const r = CodexQuerySchema.safeParse({ entryType: 'character' });
      expect(r.success).toBe(true);
    });
    it('has pagination defaults', () => {
      const r = CodexQuerySchema.safeParse({});
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.page).toBe(1);
    });
  });

  // ── Generation schemas ─────────────────────────────

  describe('GenerateCharacterSchema', () => {
    it('requires bookId', () => {
      expect(GenerateCharacterSchema.safeParse({}).success).toBe(false);
    });
    it('accepts with optional fields', () => {
      expect(
        GenerateCharacterSchema.safeParse({
          bookId: uuid,
          name: 'Aria',
          role: 'protagonist',
        }).success,
      ).toBe(true);
    });
  });

  describe('GenerateLocationSchema', () => {
    it('accepts valid input', () => {
      expect(
        GenerateLocationSchema.safeParse({
          bookId: uuid,
          name: 'Crystal Cave',
        }).success,
      ).toBe(true);
    });
  });

  describe('GenerateItemSchema', () => {
    it('accepts valid input', () => {
      expect(
        GenerateItemSchema.safeParse({
          bookId: uuid,
          name: 'Sword of Light',
          itemType: 'weapon',
        }).success,
      ).toBe(true);
    });
  });

  describe('GenerateCodexSchema', () => {
    it('requires entryType', () => {
      expect(GenerateCodexSchema.safeParse({ bookId: uuid }).success).toBe(false);
    });
    it('validates entryType enum', () => {
      expect(
        GenerateCodexSchema.safeParse({
          bookId: uuid,
          entryType: 'character',
        }).success,
      ).toBe(true);
    });
  });

  describe('GenerateOutlineSchema', () => {
    it('accepts bookId only', () => {
      expect(GenerateOutlineSchema.safeParse({ bookId: uuid }).success).toBe(true);
    });
  });

  describe('GenerateStructureSchema', () => {
    it('accepts actCount in range', () => {
      expect(
        GenerateStructureSchema.safeParse({
          bookId: uuid,
          actCount: 3,
        }).success,
      ).toBe(true);
    });
    it('rejects actCount > 10', () => {
      expect(
        GenerateStructureSchema.safeParse({
          bookId: uuid,
          actCount: 11,
        }).success,
      ).toBe(false);
    });
  });

  describe('GenerateSummarySchema', () => {
    it('accepts with sceneId', () => {
      expect(
        GenerateSummarySchema.safeParse({
          bookId: uuid,
          sceneId: uuid,
        }).success,
      ).toBe(true);
    });
  });

  describe('GenerateTitleSchema', () => {
    it('has default count', () => {
      const r = GenerateTitleSchema.safeParse({ bookId: uuid });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.count).toBe(5);
    });
    it('rejects count > 20', () => {
      expect(
        GenerateTitleSchema.safeParse({
          bookId: uuid,
          count: 21,
        }).success,
      ).toBe(false);
    });
  });

  describe('GenerateTaglineSchema', () => {
    it('has default count = 5', () => {
      const r = GenerateTaglineSchema.safeParse({ bookId: uuid });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.count).toBe(5);
    });
  });

  describe('GenerateInlineSuggestionSchema', () => {
    it('requires all fields', () => {
      expect(
        GenerateInlineSuggestionSchema.safeParse({
          bookId: uuid,
          sceneId: uuid,
          cursorPosition: 42,
          surroundingText: 'The dragon flew...',
        }).success,
      ).toBe(true);
    });
    it('rejects negative cursorPosition', () => {
      expect(
        GenerateInlineSuggestionSchema.safeParse({
          bookId: uuid,
          sceneId: uuid,
          cursorPosition: -1,
          surroundingText: 'x',
        }).success,
      ).toBe(false);
    });
  });

  describe('GenerateFeedbackSchema', () => {
    it('accepts minimal', () => {
      expect(GenerateFeedbackSchema.safeParse({ bookId: uuid }).success).toBe(true);
    });
  });

  describe('GenerateSynopsisSchema', () => {
    it('defaults to one-page', () => {
      const r = GenerateSynopsisSchema.safeParse({ bookId: uuid });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.variant).toBe('one-page');
    });
    it('accepts five-page variant', () => {
      expect(
        GenerateSynopsisSchema.safeParse({
          bookId: uuid,
          variant: 'five-page',
        }).success,
      ).toBe(true);
    });
  });

  describe('GenerateProseReviseSchema', () => {
    it('accepts sceneId only', () => {
      expect(GenerateProseReviseSchema.safeParse({ sceneId: uuid }).success).toBe(true);
    });
    it('accepts findingIds', () => {
      expect(
        GenerateProseReviseSchema.safeParse({
          sceneId: uuid,
          findingIds: [uuid],
        }).success,
      ).toBe(true);
    });
  });

  // ── Notes schemas ──────────────────────────────────

  describe('CreateNoteSchema', () => {
    it('requires bookId + content', () => {
      expect(CreateNoteSchema.safeParse({}).success).toBe(false);
    });
    it('accepts valid note', () => {
      expect(
        CreateNoteSchema.safeParse({
          bookId: uuid,
          content: 'My note',
        }).success,
      ).toBe(true);
    });
  });

  describe('UpdateNoteSchema', () => {
    it('accepts partial update', () => {
      expect(UpdateNoteSchema.safeParse({ title: 'New Title' }).success).toBe(true);
    });
  });

  // ── Wizard schemas ─────────────────────────────────

  describe('StartWizardSchema', () => {
    it('requires bookId', () => {
      expect(StartWizardSchema.safeParse({}).success).toBe(false);
    });
    it('accepts with optional fields', () => {
      expect(
        StartWizardSchema.safeParse({
          bookId: uuid,
          archetype: 'heroes-journey',
          genre: 'Fantasy',
        }).success,
      ).toBe(true);
    });
  });

  describe('WizardControlSchema', () => {
    it('accepts pause', () => {
      expect(WizardControlSchema.safeParse({ action: 'pause' }).success).toBe(true);
    });
    it('accepts resume', () => {
      expect(WizardControlSchema.safeParse({ action: 'resume' }).success).toBe(true);
    });
    it('accepts cancel', () => {
      expect(WizardControlSchema.safeParse({ action: 'cancel' }).success).toBe(true);
    });
    it('rejects invalid action', () => {
      expect(WizardControlSchema.safeParse({ action: 'restart' }).success).toBe(false);
    });
  });

  // ── Quality schemas ────────────────────────────────

  describe('QualityReportQuerySchema', () => {
    it('defaults includeResolved to false', () => {
      const r = QualityReportQuerySchema.safeParse({});
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.includeResolved).toBe(false);
    });
    it('accepts severity filter', () => {
      expect(QualityReportQuerySchema.safeParse({ severity: 'critical' }).success).toBe(true);
    });
  });

  describe('ReviseFromFindingsSchema', () => {
    it('requires sceneId + findingIds', () => {
      expect(ReviseFromFindingsSchema.safeParse({}).success).toBe(false);
    });
    it('requires at least 1 finding', () => {
      expect(
        ReviseFromFindingsSchema.safeParse({
          sceneId: uuid,
          findingIds: [],
        }).success,
      ).toBe(false);
    });
    it('rejects > 50 findings', () => {
      const ids = Array.from({ length: 51 }, () => uuid);
      expect(
        ReviseFromFindingsSchema.safeParse({
          sceneId: uuid,
          findingIds: ids,
        }).success,
      ).toBe(false);
    });
    it('accepts valid input', () => {
      expect(
        ReviseFromFindingsSchema.safeParse({
          sceneId: uuid,
          findingIds: [uuid, uuid2],
        }).success,
      ).toBe(true);
    });
  });

  // ── Memory schemas ─────────────────────────────────

  describe('MemoryQuerySchema', () => {
    it('requires bookId', () => {
      expect(MemoryQuerySchema.safeParse({}).success).toBe(false);
    });
    it('defaults limit to 100', () => {
      const r = MemoryQuerySchema.safeParse({ bookId: uuid });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.limit).toBe(100);
    });
    it('accepts factType filter', () => {
      expect(
        MemoryQuerySchema.safeParse({
          bookId: uuid,
          factType: 'trait',
        }).success,
      ).toBe(true);
    });
  });

  describe('CanonFactTypeSchema', () => {
    it('accepts all 9 types', () => {
      const types = [
        'trait',
        'relationship',
        'possession',
        'location',
        'ability',
        'status',
        'knowledge',
        'allegiance',
        'custom',
      ];
      for (const t of types) {
        expect(CanonFactTypeSchema.safeParse(t).success).toBe(true);
      }
    });
  });

  // ── Image schemas ──────────────────────────────────

  describe('GenerateImageSchema', () => {
    it('requires prompt', () => {
      expect(GenerateImageSchema.safeParse({}).success).toBe(false);
    });
    it('has sensible defaults', () => {
      const r = GenerateImageSchema.safeParse({ prompt: 'A dragon' });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.provider).toBe('flux');
        expect(r.data.width).toBe(1024);
        expect(r.data.height).toBe(1024);
        expect(r.data.steps).toBe(28);
        expect(r.data.n).toBe(1);
      }
    });
    it('rejects width > 2048', () => {
      expect(GenerateImageSchema.safeParse({ prompt: 'x', width: 4096 }).success).toBe(false);
    });
    it('rejects n > 4', () => {
      expect(GenerateImageSchema.safeParse({ prompt: 'x', n: 5 }).success).toBe(false);
    });
  });

  describe('SuggestImagePromptSchema', () => {
    it('requires bookId + targetType', () => {
      expect(SuggestImagePromptSchema.safeParse({}).success).toBe(false);
    });
    it('accepts valid input', () => {
      expect(
        SuggestImagePromptSchema.safeParse({
          bookId: uuid,
          targetType: 'cover',
        }).success,
      ).toBe(true);
    });
    it('rejects invalid targetType', () => {
      expect(
        SuggestImagePromptSchema.safeParse({
          bookId: uuid,
          targetType: 'invalid',
        }).success,
      ).toBe(false);
    });
  });

  describe('ImageListQuerySchema', () => {
    it('has defaults', () => {
      const r = ImageListQuerySchema.safeParse({});
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.page).toBe(1);
        expect(r.data.limit).toBe(50);
      }
    });
    it('accepts bookId filter', () => {
      expect(ImageListQuerySchema.safeParse({ bookId: uuid }).success).toBe(true);
    });
  });

  // ── SSE event contracts ────────────────────────────

  describe('ProseStreamEventSchema', () => {
    it('accepts token event', () => {
      expect(
        ProseStreamEventSchema.safeParse({
          event: 'token',
          data: 'hello',
        }).success,
      ).toBe(true);
    });
    it('accepts meta event', () => {
      expect(
        ProseStreamEventSchema.safeParse({
          event: 'meta',
          data: { wordCount: 100, model: 'llama', latencyMs: 500 },
        }).success,
      ).toBe(true);
    });
    it('accepts done event', () => {
      expect(
        ProseStreamEventSchema.safeParse({
          event: 'done',
          data: {},
        }).success,
      ).toBe(true);
    });
    it('accepts error event', () => {
      expect(
        ProseStreamEventSchema.safeParse({
          event: 'error',
          data: { message: 'fail' },
        }).success,
      ).toBe(true);
    });
  });

  describe('WizardStreamEventSchema', () => {
    it('accepts progress event', () => {
      expect(
        WizardStreamEventSchema.safeParse({
          event: 'progress',
          data: {
            phase: 'genre',
            step: 'analysis',
            description: 'Analyzing...',
            status: 'running',
          },
        }).success,
      ).toBe(true);
    });
    it('accepts done event', () => {
      expect(
        WizardStreamEventSchema.safeParse({
          event: 'done',
          data: {},
        }).success,
      ).toBe(true);
    });
  });

  // ── Enum schemas ───────────────────────────────────

  describe('Enum schemas', () => {
    it('DraftStatusSchema validates', () => {
      expect(DraftStatusSchema.safeParse('draft').success).toBe(true);
      expect(DraftStatusSchema.safeParse('INVALID').success).toBe(false);
    });
    it('CodexEntryTypeSchema validates', () => {
      expect(CodexEntryTypeSchema.safeParse('character').success).toBe(true);
      expect(CodexEntryTypeSchema.safeParse('weapon').success).toBe(false);
    });
    it('PlotThreadStatusSchema validates', () => {
      for (const status of ['open', 'escalated', 'resolved', 'abandoned'])
        expect(PlotThreadStatusSchema.safeParse(status).success).toBe(true);
      expect(PlotThreadStatusSchema.safeParse('introduced').success).toBe(false);
      expect(PlotThreadStatusSchema.safeParse('expected-payoff').success).toBe(false);
    });
    it('IssueSeveritySchema validates', () => {
      expect(IssueSeveritySchema.safeParse('critical').success).toBe(true);
    });
    it('WorkflowStatusSchema validates', () => {
      expect(WorkflowStatusSchema.safeParse('running').success).toBe(true);
    });
    it('ExportFormatSchema validates', () => {
      expect(ExportFormatSchema.safeParse('epub').success).toBe(true);
      expect(ExportFormatSchema.safeParse('rtf').success).toBe(false);
    });
  });
});
