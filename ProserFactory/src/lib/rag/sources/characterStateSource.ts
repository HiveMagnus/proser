/**
 * Character State RAG source adapter.
 *
 * Fetches current character states from the character state ledger
 * and converts them into RagChunk format for scene generation.
 *
 * @module rag/sources/characterStateSource
 */

import logger from '@/lib/logger';
import { retrieveCharacterStates } from '@/lib/memory/retrieval';
import type { RagSource, RagQuery, RagChunk } from '@/lib/rag/types';

/** Estimate tokens from text: ~1 token per 4 chars */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

export class CharacterStateSource implements RagSource {
  readonly name = 'character-state';
  readonly sourceType = 'relationship' as const;

  async fetch(query: RagQuery): Promise<RagChunk[]> {
    const { bookId, sceneId, text } = query;

    try {
      // Extract character names from query text for targeted retrieval
      const keywords = tokenize(text);

      const characterStates = await retrieveCharacterStates({
        bookId,
        sceneId,
        maxStates: 30,
      });

      const chunks: RagChunk[] = [];
      let chunkIndex = 0;

      for (const [charName, states] of characterStates) {
        if (states.length === 0) continue;

        // Build a consolidated state description for this character
        const stateParts = states.map(
          (s) => `  ${s.stateKey}: ${s.stateValue}`
        );
        const chunkText = `${charName} (current state):\n${stateParts.join('\n')}`;

        // Compute keyword relevance
        const charLower = charName.toLowerCase();
        const nameInQuery = keywords.has(charLower) ? 0.5 : 0;
        const anyWordMatch = stateParts.some((p) => {
          const pLower = p.toLowerCase();
          for (const kw of keywords) {
            if (pLower.includes(kw)) return true;
          }
          return false;
        })
          ? 0.2
          : 0;

        chunks.push({
          id: `charstate:${bookId}:${chunkIndex}`,
          sourceType: 'relationship',
          sourceId: `charstate:${bookId}:${charName}`,
          text: chunkText,
          tokenCount: estimateTokens(chunkText),
          metadata: {
            bookId,
            entryName: charName,
            entryType: 'character_state',
            stateKeys: states.map((s) => s.stateKey),
          },
          scores: {
            semantic: 0,
            keyword: nameInQuery + anyWordMatch,
            recency: 0.5, // States are inherently current
            entityOverlap: 0,
            combined: 0,
          },
        });

        chunkIndex++;
      }

      return chunks;
    } catch (err) {
      logger.warn(
        { error: (err as Error).message, bookId },
        'CharacterStateSource fetch failed'
      );
      return [];
    }
  }

  async invalidate(_bookId: number, _sourceId?: string): Promise<void> {
    // Character states are scene-bound; invalidation handled by memory extractor
  }
}
