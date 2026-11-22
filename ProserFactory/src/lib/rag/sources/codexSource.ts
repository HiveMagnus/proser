/**
 * Codex RAG source adapter.
 *
 * Fetches CodexEntry records from the database and converts them into
 * RagChunk format for the unified retrieval pipeline. Supports both
 * keyword scoring (legacy) and semantic similarity (when embeddings exist).
 *
 * @module rag/sources/codexSource
 */

import { databaseService } from '@/lib/database';
import { cosineSimilarity } from '@/lib/ai/embeddings';
import logger from '@/lib/logger';
import type { RagSource, RagQuery, RagChunk, RagSourceType } from '@/lib/rag/types';

/** Estimate tokens from text: ~1 token per 4 chars */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Compress a description to a max character length */
function compressDescription(desc: string | null | undefined, max = 400): string {
  if (!desc) return '';
  const s = desc.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Tokenize text for keyword matching */
function tokenize(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s\-_'']/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3)
      .slice(0, 50)
  );
}

/** Compute keyword overlap score between chunk text and query keywords */
function keywordScore(chunkText: string, keywords: Set<string>): number {
  if (keywords.size === 0) return 0;
  const chunkLower = chunkText.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (chunkLower.includes(kw)) hits++;
  }
  return hits / keywords.size;
}

/**
 * Map codex entry types to RAG source types.
 * Future codex types (rule, culture, etc.) will map to 'world'.
 */
function mapEntryType(entryType: string): RagSourceType {
  switch (entryType.toLowerCase()) {
    case 'character':
      return 'character';
    case 'location':
      return 'location';
    case 'lore':
      return 'world';
    case 'item':
      return 'item';
    case 'faction':
      return 'faction';
    case 'event':
      return 'event';
    case 'rule':
      return 'rule';
    case 'culture':
      return 'culture';
    case 'relationship':
      return 'relationship';
    default:
      return 'world';
  }
}

export class CodexSource implements RagSource {
  readonly name = 'codex';
  readonly sourceType: RagSourceType = 'character'; // primary, but fetches all types

  async fetch(query: RagQuery): Promise<RagChunk[]> {
    const { bookId, text, queryEmbedding, sourceTypes } = query;

    try {
      // Fetch codex entries for this book (soft-delete aware via Prisma extension)
      const entries = await databaseService.client.codexEntry.findMany({
        where: {
          bookId,
          ...(sourceTypes && sourceTypes.length > 0
            ? { entryType: { in: sourceTypes as string[] } }
            : {}),
        },
        take: 100,
        orderBy: { updatedAt: 'desc' },
      });

      const keywords = tokenize(text);

      // Also check for stored embeddings in RagChunk table
      let storedChunks: Array<{
        sourceId: string;
        embedding: unknown;
      }> = [];
      try {
        storedChunks = await databaseService.client.ragChunk.findMany({
          where: {
            bookId,
            sourceType: { in: ['character', 'location', 'item', 'world'] },
          },
          select: { sourceId: true, embedding: true },
        });
      } catch {
        // RagChunk table may not exist yet
      }

      const embeddingMap = new Map<string, number[]>();
      for (const sc of storedChunks) {
        if (sc.embedding && Array.isArray(sc.embedding)) {
          embeddingMap.set(sc.sourceId, sc.embedding as number[]);
        }
      }

      const chunks: RagChunk[] = entries.map((entry) => {
        const chunkText = [
          `${entry.entryName} (${entry.entryType})`,
          compressDescription(entry.entryDescription),
          entry.attributes ? compressDescription(entry.attributes, 200) : '',
        ]
          .filter(Boolean)
          .join('\n');

        const sourceId = `codex:${entry.id}`;
        const storedEmbedding = embeddingMap.get(sourceId);

        // Compute scores
        const kwScore = keywordScore(chunkText, keywords);
        const semanticScore =
          queryEmbedding && storedEmbedding
            ? cosineSimilarity(queryEmbedding, storedEmbedding)
            : 0;

        // Name match bonus
        const nameLower = entry.entryName.toLowerCase();
        const nameBoost = keywords.has(nameLower) ? 0.3 : 0;

        // Type boost
        const typeBoost = entry.entryType === 'character' ? 0.1 : entry.entryType === 'location' ? 0.05 : 0;

        // Recency: entries updated recently get a small boost
        const daysSinceUpdate = entry.updatedAt
          ? (Date.now() - new Date(entry.updatedAt).getTime()) / (1000 * 60 * 60 * 24)
          : 365;
        const recencyScore = Math.max(0, 1 - daysSinceUpdate / 365);

        return {
          id: sourceId,
          sourceType: mapEntryType(entry.entryType),
          sourceId,
          text: chunkText,
          embedding: storedEmbedding,
          tokenCount: estimateTokens(chunkText),
          metadata: {
            bookId,
            entryName: entry.entryName,
            entryType: entry.entryType,
            codexId: entry.id,
            updatedAt: entry.updatedAt?.toISOString(),
          },
          scores: {
            semantic: semanticScore,
            keyword: kwScore + nameBoost + typeBoost,
            recency: recencyScore,
            entityOverlap: 0, // computed later by orchestrator
            combined: 0, // computed later by reranker
          },
        };
      });

      return chunks;
    } catch (err) {
      logger.warn(
        { error: (err as Error).message, bookId },
        'CodexSource fetch failed'
      );
      return [];
    }
  }

  async invalidate(bookId: number, sourceId?: string): Promise<void> {
    try {
      if (sourceId) {
        await databaseService.client.ragChunk.deleteMany({
          where: { bookId, sourceId },
        });
      } else {
        await databaseService.client.ragChunk.deleteMany({
          where: {
            bookId,
            sourceType: { in: ['character', 'location', 'item', 'world'] },
          },
        });
      }
    } catch {
      // Table may not exist yet
    }
  }
}
