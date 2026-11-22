import { describe, expect, it } from 'vitest';
import { documentFromText, projectDocument, type DocumentParagraph } from '@cheftaco/proser-editor';
import { insertDocumentImage } from '@/lib/document-image-editing';
let sequence = 0;
const id = () => `image-${++sequence}`;
const asset = { id: '12', sha256: 'a'.repeat(64), width: 2000, height: 1000 };
describe('owned inline image insertion', () => {
  it('inserts at a grapheme caret while retaining raw layout, source style and protected objects', () => {
    const document = documentFromText('A😀 e\u0301B', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    paragraph.runs[0]!.style = { bold: true };
    document.blocks.push({
      type: 'image',
      id: id(),
      assetId: 8,
      sha256: 'b'.repeat(64),
      alt: 'Existing',
      width: 40,
      height: 40,
    });
    const next = insertDocumentImage(document, paragraph.id, 3, 'A😀 e\u0301B', asset, 'New', id);
    expect(projectDocument(next).text).toBe('A😀\ufffc e\u0301B\n\n\ufffc');
    expect(next.layout).toEqual(document.layout);
    expect(next.blocks[1]).toEqual(document.blocks[1]);
    const runs = (next.blocks[0] as DocumentParagraph).runs;
    expect(runs[0]).toEqual({ ...paragraph.runs[0], text: 'A😀' });
    expect(runs[1]!.inlineImage).toMatchObject({
      assetId: 12,
      sha256: asset.sha256,
      width: 2000,
      height: 1000,
    });
    expect(runs[2]!.style).toEqual({ bold: true });
    expect(projectDocument(document).text).toBe('A😀 e\u0301B\n\n\ufffc');
  });
  it('rejects unverified images, stale text, split graphemes and anchored run splitting', () => {
    const document = documentFromText('A😀B', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    expect(() =>
      insertDocumentImage(document, paragraph.id, 1, 'A😀B', { ...asset, sha256: '' }, '', id),
    ).toThrow('verified');
    expect(() => insertDocumentImage(document, paragraph.id, 1, 'Stale', asset, '', id)).toThrow(
      'selection',
    );
    expect(() => insertDocumentImage(document, paragraph.id, 2, 'A😀B', asset, '', id)).toThrow(
      'grapheme',
    );
    document.comments.push({
      id: 'comment',
      authorId: 7,
      authorName: 'Writer',
      createdAt: '2026-01-01T00:00:00Z',
      text: 'Note',
      resolved: false,
      anchors: [
        { blockId: paragraph.id, runId: paragraph.runs[0]!.id, start: 0, end: 1, sourceText: 'A' },
      ],
    });
    expect(() => insertDocumentImage(document, paragraph.id, 1, 'A😀B', asset, '', id)).toThrow(
      'anchored',
    );
  });
});
