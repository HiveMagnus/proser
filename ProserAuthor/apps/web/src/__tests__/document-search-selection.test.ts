import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentFromText, type DocumentParagraph } from '@hivemagnus/proser-editor';
import { selectionForDocumentSearch } from '@/lib/document-search-selection';
import type { DocumentSearchHit } from '@hivemagnus/proser-contracts';
let sequence = 0;
const document = documentFromText('Quote 😀\n\nQuote 😀', () => `search-${++sequence}`);
const second = document.blocks[1] as DocumentParagraph;
const hit = async (): Promise<DocumentSearchHit> => ({
  id: 'exact-second-quote',
  sceneId: 2,
  sceneNumber: 1,
  chapterId: 1,
  wordCount: 2,
  sceneRevisionId: 'scene-source',
  sceneContentHash: 'a'.repeat(64),
  projectionSha256: Array.from(
    new Uint8Array(
      await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('Quote 😀\n\nQuote 😀')),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join(''),
  from: 10,
  to: 18,
  sourceText: 'Quote 😀',
  excerpt: 'Quote 😀',
  excerptFrom: 0,
  excerptTo: 8,
  anchors: [
    { blockId: second.id, runId: second.runs[0]!.id, start: 0, end: 8, sourceText: 'Quote 😀' },
  ],
  locations: [],
  editable: true,
});
const saved = () => ({
  sceneId: 2,
  sceneNumber: 1,
  chapterId: 1,
  wordCount: 2,
  revisionId: 'scene-source',
  bookRevisionId: 'book-source',
  contentHash: 'a'.repeat(64),
  document,
  projection: { text: 'Quote 😀\n\nQuote 😀', spans: [], wordCount: 2 },
});
afterEach(() => vi.unstubAllGlobals());
describe('exact global search selection', () => {
  it('selects the supplied second repeated quote and rejects stale or moved identities', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const match = await hit();
    expect((await selectionForDocumentSearch(saved(), match)).targets).toEqual([
      { blockId: second.id, from: 0, to: 8, sourceText: 'Quote 😀' },
    ]);
    await expect(
      selectionForDocumentSearch({ ...saved(), revisionId: 'new-scene' }, match),
    ).rejects.toThrow('revision');
    await expect(
      selectionForDocumentSearch(saved(), {
        ...match,
        anchors: [{ ...match.anchors[0]!, runId: 'nonexistent' }],
      }),
    ).rejects.toThrow('anchor');
    await expect(
      selectionForDocumentSearch(saved(), { ...match, projectionSha256: '0'.repeat(64) }),
    ).rejects.toThrow('projection');
  });
});
