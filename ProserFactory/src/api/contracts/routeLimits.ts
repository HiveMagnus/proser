import type { RequestHandler } from 'express';

import { redisRateLimit } from '../middleware/redisRateLimit';

interface RouteLimitContract {
  method: 'GET' | 'POST';
  path: string;
  key: string;
  limit: number;
  windowSec: number;
}

export interface ExpensiveRouteLimitContract {
  method: 'GET' | 'POST';
  path: string;
  key: string;
  userConcurrency: number;
  bookConcurrency: number;
  dailyPerUser: number;
  dailyPerBook: number;
  maxPayloadBytes: number;
  timeoutMs: number;
  lifecycle: 'synchronous' | 'acceptance';
}

export const METRICS_AUTH_FAILURE_LIMIT = 5;
export const METRICS_AUTH_FAILURE_WINDOW_SEC = 60;

export const GENERATION_RATE_LIMITS = {
  operationCreate: { method: 'POST', path: '/api/generate/operations', key: 'operations:create', limit: 15, windowSec: 60 },
  operationUnresolved: { method: 'GET', path: '/api/generate/operations/unresolved', key: 'operations:unresolved', limit: 60, windowSec: 60 },
  operationLookup: { method: 'GET', path: '/api/generate/operations/lookup', key: 'operations:lookup', limit: 60, windowSec: 60 },
  operationStream: { method: 'GET', path: '/api/generate/operations/{operationId}/stream', key: 'replay', limit: 30, windowSec: 60 },
  operationRead: { method: 'GET', path: '/api/generate/operations/{operationId}', key: 'operations:read', limit: 60, windowSec: 60 },
  operationArtifact: { method: 'GET', path: '/api/generate/operations/{operationId}/artifact', key: 'operations:artifact', limit: 30, windowSec: 60 },
  operationCancel: { method: 'POST', path: '/api/generate/operations/{operationId}/cancel', key: 'operations:cancel', limit: 30, windowSec: 60 },
  character: { method: 'POST', path: '/api/generate/character', key: 'character', limit: 30, windowSec: 60 },
  location: { method: 'POST', path: '/api/generate/location', key: 'location', limit: 30, windowSec: 60 },
  item: { method: 'POST', path: '/api/generate/item', key: 'item', limit: 30, windowSec: 60 },
  codex: { method: 'POST', path: '/api/generate/codex', key: 'codex', limit: 30, windowSec: 60 },
  outline: { method: 'POST', path: '/api/generate/outline', key: 'outline', limit: 15, windowSec: 60 },
  summary: { method: 'POST', path: '/api/generate/summary', key: 'summary', limit: 30, windowSec: 60 },
  title: { method: 'POST', path: '/api/generate/title', key: 'title', limit: 20, windowSec: 60 },
  tagline: { method: 'POST', path: '/api/generate/tagline', key: 'tagline', limit: 20, windowSec: 60 },
  inlineSuggestion: { method: 'POST', path: '/api/generate/inline-suggestion', key: 'inline', limit: 60, windowSec: 60 },
  feedback: { method: 'POST', path: '/api/generate/feedback', key: 'feedback', limit: 40, windowSec: 60 },
  structure: { method: 'POST', path: '/api/generate/structure', key: 'structure', limit: 10, windowSec: 60 },
  proseBatch: { method: 'POST', path: '/api/generate/prose/batch', key: 'prose:batch', limit: 5, windowSec: 60 },
  prose: { method: 'POST', path: '/api/generate/prose', key: 'prose', limit: 15, windowSec: 60 },
  proseRevise: { method: 'POST', path: '/api/generate/prose/revise', key: 'prose:revise', limit: 15, windowSec: 60 },
  commandRevise: { method: 'POST', path: '/api/generate/prose/command-revise', key: 'prose:command-revise', limit: 20, windowSec: 60 },
} as const satisfies Record<string, RouteLimitContract>;

export const EXPENSIVE_ROUTE_LIMITS = {
  revisionCampaignAnalysis: { method: 'POST', path: '/api/books/{bookId}/revision-campaigns/{campaignId}/analyses', key: 'revision-campaign:analysis', userConcurrency: 2, bookConcurrency: 1, dailyPerUser: 100, dailyPerBook: 50, maxPayloadBytes: 16_384, timeoutMs: 30_000, lifecycle: 'acceptance' },
  documentProposal: { method: 'POST', path: '/api/books/{bookId}/document-discussions/{discussionId}/proposals', key: 'document:proposal', userConcurrency: 2, bookConcurrency: 1, dailyPerUser: 100, dailyPerBook: 50, maxPayloadBytes: 16_384, timeoutMs: 130_000, lifecycle: 'synchronous' },
  plotThreadReview: { method: 'POST', path: '/api/books/{bookId}/plot-threads/{threadId}/reviews', key: 'plot-thread:review', userConcurrency: 2, bookConcurrency: 1, dailyPerUser: 100, dailyPerBook: 50, maxPayloadBytes: 16_384, timeoutMs: 130_000, lifecycle: 'synchronous' },
  editorialBenchmark: { method: 'POST', path: '/api/editorial/benchmarks', key: 'editorial:benchmark', userConcurrency: 1, bookConcurrency: 0, dailyPerUser: 10, dailyPerBook: 0, maxPayloadBytes: 16_384, timeoutMs: 300_000, lifecycle: 'synchronous' },
  bookExport: { method: 'GET', path: '/api/books/{bookId}/export', key: 'book:export', userConcurrency: 2, bookConcurrency: 1, dailyPerUser: 100, dailyPerBook: 30, maxPayloadBytes: 0, timeoutMs: 120_000, lifecycle: 'synchronous' },
  bookCreativePackage: { method: 'GET', path: '/api/books/{bookId}/creative-package', key: 'book:creative-package', userConcurrency: 2, bookConcurrency: 1, dailyPerUser: 100, dailyPerBook: 30, maxPayloadBytes: 0, timeoutMs: 120_000, lifecycle: 'synchronous' },
  exportArtifactCreate: { method: 'POST', path: '/api/books/{bookId}/export-artifacts', key: 'book:export-artifact', userConcurrency: 2, bookConcurrency: 1, dailyPerUser: 100, dailyPerBook: 30, maxPayloadBytes: 16_384, timeoutMs: 120_000, lifecycle: 'synchronous' },
  revisionRollback: { method: 'POST', path: '/api/books/{bookId}/revisions/{revisionId}/rollback', key: 'book:rollback', userConcurrency: 1, bookConcurrency: 1, dailyPerUser: 30, dailyPerBook: 10, maxPayloadBytes: 1_024, timeoutMs: 60_000, lifecycle: 'synchronous' },
  bookReset: { method: 'POST', path: '/api/books/{bookId}/reset', key: 'book:reset', userConcurrency: 1, bookConcurrency: 1, dailyPerUser: 5, dailyPerBook: 2, maxPayloadBytes: 1_024, timeoutMs: 120_000, lifecycle: 'synchronous' },
  workflowFullBook: { method: 'POST', path: '/api/workflows/full-book', key: 'workflow:full-book', userConcurrency: 1, bookConcurrency: 1, dailyPerUser: 3, dailyPerBook: 2, maxPayloadBytes: 65_536, timeoutMs: 30_000, lifecycle: 'acceptance' },
  workflowQualityReview: { method: 'POST', path: '/api/workflows/quality-review', key: 'workflow:quality-review', userConcurrency: 2, bookConcurrency: 1, dailyPerUser: 30, dailyPerBook: 10, maxPayloadBytes: 16_384, timeoutMs: 30_000, lifecycle: 'acceptance' },
  workflowImproveQuality: { method: 'POST', path: '/api/workflows/improve-quality', key: 'workflow:improve-quality', userConcurrency: 2, bookConcurrency: 1, dailyPerUser: 30, dailyPerBook: 10, maxPayloadBytes: 32_768, timeoutMs: 30_000, lifecycle: 'acceptance' },
  workflowGuidedImprove: { method: 'POST', path: '/api/workflows/guided-improve', key: 'workflow:guided-improve', userConcurrency: 2, bookConcurrency: 1, dailyPerUser: 30, dailyPerBook: 10, maxPayloadBytes: 32_768, timeoutMs: 30_000, lifecycle: 'acceptance' },
  workflowEditorialOptimize: { method: 'POST', path: '/api/workflows/editorial-optimize', key: 'workflow:editorial-optimize', userConcurrency: 2, bookConcurrency: 1, dailyPerUser: 30, dailyPerBook: 10, maxPayloadBytes: 65_536, timeoutMs: 30_000, lifecycle: 'acceptance' },
} as const satisfies Record<string, ExpensiveRouteLimitContract>;

export type GenerationRateLimitName = keyof typeof GENERATION_RATE_LIMITS;
export type ExpensiveRouteLimitName = keyof typeof EXPENSIVE_ROUTE_LIMITS;

export function generationRateLimit(name: GenerationRateLimitName): RequestHandler {
  const contract = GENERATION_RATE_LIMITS[name];
  return redisRateLimit({
    key: (req) => `gen:${req.user?.id}:${contract.key}`,
    limit: contract.limit,
    windowSec: contract.windowSec,
  });
}
