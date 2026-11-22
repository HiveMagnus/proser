import { Request } from 'express';
import type { NovaGrant } from './middleware/novaGrant';

// Base API Response type
export interface StandardErrorObject {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  // After standardization, error is an object; allow string for backward compat during migration.
  error?: string | StandardErrorObject;
  message?: string; // Deprecated in favor of data.message
}

// Extended Express Request with user session
// Use Record<string, string> for Params to avoid Express 5's string | string[] union
// (URL path params are always single strings)
export interface AuthenticatedRequest extends Request<Record<string, string>> {
  user?: {
    id: number;
    githubId: string;
    username: string;
    email?: string;
    avatarUrl?: string;
  };
  authActor?: {
    githubId: string;
    username: string;
  };
  novaGrant?: NovaGrant;
  sharedResourceOperationId?: string;
  session?: unknown;
}

// Pagination types
export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// Book API types
export interface CreateBookRequest {
  title?: string;
  genre?: string;
  targetAudience?: string;
  summary?: string;
}

export interface UpdateBookRequest {
  title?: string;
  genre?: string;
  targetAudience?: string;
  summary?: string;
  tagline?: string;
  storyOutline?: string;
  storyArchetypeKey?: string;
  draftStatus?: string;
  selectedImageId?: number;
}

// Codex API types
export interface CreateCodexEntryRequest {
  bookId: number;
  entryType: 'character' | 'location' | 'lore' | 'item' | 'faction' | 'event' | 'rule' | 'culture' | 'relationship';
  entryName: string;
  entryDescription: string;
  attributes?: string;
}

export interface UpdateCodexEntryRequest {
  entryType?: 'character' | 'location' | 'lore' | 'item' | 'faction' | 'event' | 'rule' | 'culture' | 'relationship';
  entryName?: string;
  entryDescription?: string;
  attributes?: string;
}

// Generation API types
export interface GenerationRequest {
  bookId?: number;
  prompt?: string;
  context?: unknown;
  model?: string;
  selectedModel?: string;
  numberOfActs?: number;
  chaptersPerAct?: number;
  genre?: string;
  summary?: string;
  title?: string;
  content?: string;
  feedbackType?: string;
}

// Wizard API types
export interface StartWizardRequest {
  bookId: number;
  settings: Record<string, unknown>;
}

export interface WizardStatusResponse {
  id: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  currentPhase: number;
  currentStep: number;
  totalSteps: number;
  progress: number;
}
