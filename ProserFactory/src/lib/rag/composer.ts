/**
 * Context Composer — assembles RAG chunks into formatted prompt sections.
 *
 * Takes reranked, budget-allocated chunks and produces structured context
 * sections with headers, formatted content, and provenance data. Enforces
 * hard token budgets and provides token-efficient compact templates.
 *
 * @module rag/composer
 */

import crypto from 'crypto';
import type {
  RagChunk,
  RagSourceType,
  ContextSection,
  ComposedContext,
  RagManifest,
  RagDiagnostics,
} from '@/lib/rag/types';

// ---------------------------------------------------------------------------
// Section headers by source type
// ---------------------------------------------------------------------------

const SECTION_HEADERS: Record<RagSourceType, string> = {
  character: '[Character Context]',
  location: '[Location Context]',
  item: '[Item Context]',
  faction: '[Faction Context]',
  event: '[Event Context]',
  rule: '[Rule Context]',
  culture: '[Culture Context]',
  world: '[World Context]',
  timeline: '[Continuity State]',
  thread: '[Active Narrative Threads]',
  style: '[Style Guide]',
  relationship: '[Relationship Dynamics]',
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a single chunk into a compact, prompt-ready line */
function formatChunk(chunk: RagChunk): string {
  const name = chunk.metadata.entryName || chunk.sourceId;
  const type = chunk.metadata.entryType
    ? ` (${chunk.metadata.entryType})`
    : '';
  // Use the text directly but ensure single-line compactness
  const text = chunk.text.replace(/\n+/g, ' ').trim();
  return `- ${name}${type}: ${text}`;
}

/** Estimate token count for text: ~1 token per 4 chars */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface ComposerOptions {
  /** Hard token budget for the entire composed context */
  totalBudget: number;
  /** Per-source budget overrides (fraction of totalBudget) */
  sourceBudgets?: Partial<Record<RagSourceType, number>>;
}

/**
 * Compose reranked chunks into structured context sections.
 *
 * Groups chunks by source type, formats them with section headers,
 * and enforces hard token limits. Returns both the structured sections
 * and a single formatted prompt section string.
 */
export function composeContext(
  chunks: RagChunk[],
  options: ComposerOptions,
  diagnosticsPartial: Partial<RagDiagnostics> = {}
): ComposedContext {
  const { totalBudget } = options;

  // Group chunks by source type (preserve reranked order within groups)
  const groups = new Map<RagSourceType, RagChunk[]>();
  for (const chunk of chunks) {
    const group = groups.get(chunk.sourceType) || [];
    group.push(chunk);
    groups.set(chunk.sourceType, group);
  }

  // Section ordering: characters first, then locations, items, world, etc.
  const sectionOrder: RagSourceType[] = [
    'character',
    'relationship',
    'location',
    'item',
    'world',
    'timeline',
    'thread',
    'style',
  ];

  const sections: ContextSection[] = [];
  let totalTokenCount = 0;
  const sourceBreakdown: RagDiagnostics['sourceBreakdown'] = [];

  for (const sourceType of sectionOrder) {
    const group = groups.get(sourceType);
    if (!group || group.length === 0) continue;

    const header = SECTION_HEADERS[sourceType];
    const lines: string[] = [header];
    const sectionChunks: RagChunk[] = [];
    let sectionTokens = estimateTokens(header + '\n');

    for (const chunk of group) {
      const line = formatChunk(chunk);
      const lineTokens = estimateTokens(line + '\n');

      // Enforce total budget
      if (totalTokenCount + sectionTokens + lineTokens > totalBudget) {
        break;
      }

      lines.push(line);
      sectionChunks.push(chunk);
      sectionTokens += lineTokens;
    }

    if (sectionChunks.length > 0) {
      lines.push('---');
      sectionTokens += estimateTokens('---\n');
      totalTokenCount += sectionTokens;

      sections.push({
        header,
        content: lines.join('\n'),
        tokenCount: sectionTokens,
        sourceType,
        chunks: sectionChunks,
      });

      sourceBreakdown.push({
        sourceType,
        candidates: group.length,
        selected: sectionChunks.length,
        tokensUsed: sectionTokens,
      });
    }
  }

  // Build manifest for cache keying and provenance
  const manifest = buildManifest(sections);

  // Build diagnostics
  const diagnostics: RagDiagnostics = {
    path: 'unified',
    semanticAvailable: diagnosticsPartial.semanticAvailable ?? false,
    retrievalTimeMs: diagnosticsPartial.retrievalTimeMs ?? 0,
    compositionTimeMs: diagnosticsPartial.compositionTimeMs ?? 0,
    totalCandidates: diagnosticsPartial.totalCandidates ?? 0,
    totalSelected: chunks.length,
    tokenBudgetUsed: totalTokenCount,
    tokenBudgetTotal: totalBudget,
    sourceBreakdown,
    fallbackReasons: diagnosticsPartial.fallbackReasons ?? [],
  };

  return {
    sections,
    totalTokenCount,
    manifest,
    diagnostics,
  };
}

/**
 * Format a ComposedContext into a single prompt-ready string.
 */
export function formatPromptSection(ctx: ComposedContext): string {
  if (ctx.sections.length === 0) return '';
  return ctx.sections.map((s) => s.content).join('\n\n');
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function buildManifest(sections: ContextSection[]): RagManifest {
  const sources = sections.map((s) => ({
    type: s.sourceType,
    ids: s.chunks.map((c) => c.sourceId),
    k: s.chunks.length,
  }));

  const hashInput = JSON.stringify(sources);
  const hash = crypto.createHash('sha1').update(hashInput).digest('hex');

  return { sources, hash };
}
