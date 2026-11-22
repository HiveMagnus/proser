/**
 * Backend domain types.
 *
 * Shared interfaces are re-exported from the local shared module so that all
 * consumers in this package can continue to `import { Book } from '@/types'`.
 * Backend-only types (AuthenticatedRequest, GenerationJob) remain here.
 */

// Re-export every shared domain type
export type {
  User,
  Book,
  CodexEntry,
  Act,
  Chapter,
  Scene,
  GenerationHistory,
  Note,
  BookContext,
  ChapterContext,
  SceneContext,
  ApiResponse,
  GenerationRequest,
  Character,
  Location,
  Item,
  PromptCategory,
  PromptTemplate,
  PromptTemplates,
} from './shared';

export { CODEX_ENTRY_TYPES } from './shared';

import type { BookContext, ChapterContext, SceneContext } from './shared';

// ---- Backend-only types ---------------------------------------------------

// Extended Express Request interface for authentication
export interface AuthenticatedRequest extends Request {
  user: {
    id: number;
    github_id: string;
    username: string;
    email?: string;
  };
}

// Job types for workers
export interface GenerationJob {
  type: 'title' | 'tagline' | 'summary' | 'outline' | 'character' | 'location' | 'item';
  userId: number;
  bookId?: number;
  context: BookContext | ChapterContext | SceneContext;
  prompt?: string;
  model?: string;
}
