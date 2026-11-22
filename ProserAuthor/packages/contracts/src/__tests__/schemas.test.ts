import { describe, it, expect } from 'vitest';
import {
  CreateBookSchema,
  UpdateBookSchema,
  PaginationQuerySchema,
  CreateSceneSchema,
  CreateCodexEntrySchema,
  GenerateProseSchema,
  ExportBookSchema,
  IdParamSchema,
} from '../schemas/index.js';

const uuid = '550e8400-e29b-41d4-a716-446655440000';

describe('Contract schemas', () => {
  describe('CreateBookSchema', () => {
    it('accepts valid input', () => {
      const result = CreateBookSchema.safeParse({ title: 'My Novel', genre: 'Fantasy' });
      expect(result.success).toBe(true);
    });

    it('rejects missing title', () => {
      const result = CreateBookSchema.safeParse({ genre: 'Fantasy' });
      expect(result.success).toBe(false);
    });
  });

  describe('UpdateBookSchema', () => {
    it('accepts partial updates', () => {
      const result = UpdateBookSchema.safeParse({ title: 'Renamed' });
      expect(result.success).toBe(true);
    });

    it('accepts empty object', () => {
      const result = UpdateBookSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe('PaginationQuerySchema', () => {
    it('has defaults', () => {
      const result = PaginationQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(20);
      }
    });

    it('accepts custom values', () => {
      const result = PaginationQuerySchema.safeParse({ page: '3', limit: '50' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(3);
        expect(result.data.limit).toBe(50);
      }
    });
  });

  describe('CreateSceneSchema', () => {
    it('accepts valid input', () => {
      const result = CreateSceneSchema.safeParse({
        sceneNumber: 1,
      });
      expect(result.success).toBe(true);
    });

    it('rejects non-integer sceneNumber', () => {
      const result = CreateSceneSchema.safeParse({ sceneNumber: 1.5 });
      expect(result.success).toBe(false);
    });
  });

  describe('CreateCodexEntrySchema', () => {
    it('accepts valid input', () => {
      const result = CreateCodexEntrySchema.safeParse({
        entryName: 'Gandalf',
        entryType: 'character',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid entryType', () => {
      const result = CreateCodexEntrySchema.safeParse({
        entryName: 'X',
        entryType: 'INVALID',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('GenerateProseSchema', () => {
    it('accepts valid input', () => {
      const result = GenerateProseSchema.safeParse({
        sceneId: uuid,
      });
      expect(result.success).toBe(true);
    });

    it('rejects non-uuid sceneId', () => {
      const result = GenerateProseSchema.safeParse({
        sceneId: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ExportBookSchema', () => {
    it('accepts valid format', () => {
      const result = ExportBookSchema.safeParse({
        format: 'markdown',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid format', () => {
      const result = ExportBookSchema.safeParse({
        format: 'INVALID_FORMAT',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('IdParamSchema', () => {
    it('accepts uuid id', () => {
      const result = IdParamSchema.safeParse({ id: uuid });
      expect(result.success).toBe(true);
    });

    it('rejects non-uuid id', () => {
      const result = IdParamSchema.safeParse({ id: 'not-a-uuid' });
      expect(result.success).toBe(false);
    });

    it('rejects missing id', () => {
      const result = IdParamSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});
