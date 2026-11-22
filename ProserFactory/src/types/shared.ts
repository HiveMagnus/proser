/**
 * Shared domain types — canonical definitions used by both proser-factory and proser-ui.
 *
 * This file is copied into both repos. Keep in sync manually or via a sync script.
 * proser-factory is the authoritative source.
 *
 * When a field exists in one project but not the other, it is included here
 * as optional so both sides can use the same interface.
 */

// ---------------------------------------------------------------------------
// Database / domain models
// ---------------------------------------------------------------------------

export interface User {
  id: number;
  github_id: string;
  username: string;
  email?: string;
  avatar_url?: string;
  created_at: string;
  updated_at: string;
}

export interface Book {
  id: number;
  user_id: number;
  title?: string;
  tagline?: string;
  summary?: string;
  story_outline?: string;
  genre?: string;
  target_audience?: string;
  story_archetype_key?: string;
  draft_status: 'draft' | 'final';
  created_at: string;
  updated_at: string;
  selected_image_id?: number;
}

/** All valid codex entry types. Extend here to add new ontology categories. */
export type CodexEntryType =
  | 'character'
  | 'location'
  | 'lore'
  | 'item'
  | 'faction'
  | 'event'
  | 'rule'
  | 'culture'
  | 'relationship';

/** Ordered list of all codex entry types (useful for UI selectors and iteration). */
export const CODEX_ENTRY_TYPES: readonly CodexEntryType[] = [
  'character', 'location', 'lore', 'item', 'faction',
  'event', 'rule', 'culture', 'relationship',
] as const;

export interface CodexEntry {
  id: number;
  book_id: number;
  entry_type: CodexEntryType;
  entry_name: string;
  entry_description?: string;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Act {
  id: number;
  book_id: number;
  act_number: number;
  title?: string;
  summary?: string;
  created_at: string;
  updated_at: string;
}

export interface Chapter {
  id: number;
  act_id: number;
  chapter_number: number;
  title?: string;
  outline?: string;
  summary?: string;
  created_at: string;
  updated_at: string;
}

export interface Scene {
  id: number;
  chapter_id: number;
  scene_number: number;
  title?: string;
  outline?: string;
  summary?: string;
  prose?: string;
  word_count: number;
  created_at: string;
  updated_at: string;
}

export interface GenerationHistory {
  id: number;
  user_id: number;
  entity_type: 'title' | 'tagline' | 'summary' | 'codex' | 'chapter' | 'scene' | 'prose' | 'outline';
  entity_id?: number;
  prompt: string;
  generated_content: string;
  model_used?: string;
  created_at: string;
}

export interface Note {
  id: number;
  book_id: number;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// AI generation context
// ---------------------------------------------------------------------------

export interface BookContext {
  title?: string;
  tagline?: string;
  summary?: string;
  genre?: string;
  target_audience?: string;
  archetype_description?: string;
  codex_entries?: CodexEntry[];
}

export interface ChapterContext {
  book: BookContext;
  act: Act;
  chapter_number: number;
  previous_chapters?: Chapter[];
}

export interface SceneContext {
  book: BookContext;
  act: Act;
  chapter: Chapter;
  scene_number: number;
  previous_scenes?: Scene[];
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string | { message: string; code?: string; details?: unknown };
}

export interface GenerationRequest<C = BookContext | ChapterContext | SceneContext> {
  prompt?: string;
  context?: C;
  model?: string;
}

// ---------------------------------------------------------------------------
// Codex sub-types
// ---------------------------------------------------------------------------

export interface Character {
  name: string;
  description: string;
  age?: number;
  occupation?: string;
  personality_traits?: string[];
  background?: string;
  appearance?: string;
  motivations?: string[];
  relationships?: Record<string, string>;
}

export interface Location {
  name: string;
  description: string;
  type?: string;
  geography?: string;
  climate?: string;
  culture?: string;
  notable_features?: string[];
  inhabitants?: string[];
}

export interface Item {
  name: string;
  description: string;
  type?: string;
  properties?: string[];
  history?: string;
  significance?: string;
  current_location?: string;
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

export type PromptCategory =
  | 'title'
  | 'tagline'
  | 'summary'
  | 'character'
  | 'location'
  | 'item'
  | 'faction'
  | 'event'
  | 'rule'
  | 'culture'
  | 'relationship'
  | 'codex'
  | 'outline'
  | 'structure'
  | 'feedback'
  | 'feedback-summary'
  | 'feedback-codex'
  | 'inline-suggestion'
  | 'prose'
  | 'scene-brief'
  | 'prose-draft'
  | 'prose-revise'
  | 'beats'
  | 'prose-from-beats'
  | 'prose-review'
  | 'prose-repair'
  | 'prose-revise-from-findings'
  | 'prose-fallback'
  | 'cli'
  | 'editor';

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  template: string;
  category: PromptCategory;
  isDefault: boolean;
  variables?: string[];
  /** Semver-style version for reproducibility (e.g., '1.0.0'). */
  version?: string;
  /** ISO-8601 date when this template version was last updated. */
  updatedAt?: string;
}

export interface PromptTemplates {
  [key: string]: PromptTemplate;
}
