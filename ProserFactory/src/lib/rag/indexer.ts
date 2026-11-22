/**
 * Embedding indexer — indexes codex entries with vector embeddings.
 *
 * Runs as index-on-write (codex create/update) and provides a backfill
 * command for existing entries. Stores embeddings in the RagChunk table.
 *
 * @module rag/indexer
 */

import { databaseService } from '@/lib/database';
import type { Prisma } from '@prisma/client';
import { generateEmbedding } from '@/lib/ai/embeddings';
import { CONFIG } from '@/core/config';
import logger from '@/lib/logger';

/** Estimate tokens: ~1 token per 4 chars */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Compress text for embedding (remove excessive whitespace) */
function compressForEmbedding(text: string, max = 2000): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * Map a codex entry type to the RAG sourceType.
 */
function mapEntryType(entryType: string): string {
  switch (entryType.toLowerCase()) {
    case 'character': return 'character';
    case 'location': return 'location';
    case 'item': return 'item';
    case 'lore': return 'world';
    default: return 'world';
  }
}

/**
 * Build chunk text from a codex entry for embedding.
 */
function buildChunkText(entry: {
  entryName: string;
  entryType: string;
  entryDescription: string | null;
  attributes: string | null;
}): string {
  return [
    `${entry.entryName} (${entry.entryType})`,
    entry.entryDescription || '',
    entry.attributes || '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Index a single codex entry: generate embedding and upsert into RagChunk.
 *
 * Gracefully degrades: if embedding generation fails, stores the chunk
 * without an embedding (keyword retrieval still works).
 */
export async function indexCodexEntry(entry: {
  id: number;
  bookId: number;
  entryType: string;
  entryName: string;
  entryDescription: string | null;
  attributes: string | null;
}): Promise<void> {
  if (!CONFIG.RAG_ORCHESTRATOR_ENABLED) return;

  const sourceId = `codex:${entry.id}`;
  const chunkText = buildChunkText(entry);
  const compressedText = compressForEmbedding(chunkText);
  const tokenCount = estimateTokens(chunkText);

  let embedding: number[] | null = null;
  let embedModel: string | null = null;

  if (CONFIG.RAG_SEMANTIC_ENABLED) {
    const result = await generateEmbedding(compressedText);
    if (result) {
      embedding = result.embedding;
      embedModel = result.model;
    }
  }

  try {
    // Upsert: find existing chunk by sourceId + bookId, or create new
    const existing = await databaseService.client.ragChunk.findFirst({
      where: { sourceId, bookId: entry.bookId },
    });

    if (existing) {
      await databaseService.client.ragChunk.update({
        where: { id: existing.id },
        data: {
          chunkText,
          embedding: embedding as Prisma.InputJsonValue,
          embedModel,
          embedVersion: CONFIG.RAG_EMBEDDING_VERSION,
          tokenCount,
          sourceType: mapEntryType(entry.entryType),
          metadata: {
            entryName: entry.entryName,
            entryType: entry.entryType,
            codexId: entry.id,
          } as Prisma.InputJsonValue,
        },
      });
    } else {
      await databaseService.client.ragChunk.create({
        data: {
          bookId: entry.bookId,
          sourceType: mapEntryType(entry.entryType),
          sourceId,
          chunkText,
          embedding: embedding as Prisma.InputJsonValue,
          embedModel,
          embedVersion: CONFIG.RAG_EMBEDDING_VERSION,
          tokenCount,
          metadata: {
            entryName: entry.entryName,
            entryType: entry.entryType,
            codexId: entry.id,
          } as Prisma.InputJsonValue,
        },
      });
    }

    logger.debug(
      { sourceId, bookId: entry.bookId, hasEmbedding: !!embedding },
      'Indexed codex entry'
    );
  } catch (err) {
    logger.warn(
      { error: (err as Error).message, sourceId },
      'Failed to index codex entry — RAG chunk not stored'
    );
  }
}

/**
 * Remove a codex entry's chunk from the RAG index.
 */
export async function removeCodexEntryIndex(
  bookId: number,
  codexId: number
): Promise<void> {
  try {
    await databaseService.client.ragChunk.deleteMany({
      where: { bookId, sourceId: `codex:${codexId}` },
    });
  } catch {
    // Table may not exist yet
  }
}

/**
 * Backfill all codex entries for a book into the RAG index.
 * Processes entries sequentially to avoid overwhelming the embedding service.
 *
 * @returns Number of entries indexed
 */
export async function backfillBookIndex(bookId: number): Promise<number> {
  const entries = await databaseService.client.codexEntry.findMany({
    where: { bookId },
    orderBy: { id: 'asc' },
  });

  let indexed = 0;
  for (const entry of entries) {
    await indexCodexEntry(entry);
    indexed++;
  }

  logger.info({ bookId, indexed, total: entries.length }, 'Backfill complete');
  return indexed;
}

/**
 * Backfill all books in the database.
 *
 * @returns Total number of entries indexed
 */
export async function backfillAllBooks(): Promise<number> {
  const books = await databaseService.client.book.findMany({
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  let total = 0;
  for (const book of books) {
    total += await backfillBookIndex(book.id);
  }

  logger.info({ total, books: books.length }, 'Full backfill complete');
  return total;
}
