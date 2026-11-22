import { describe, expect, it } from 'vitest';
import { documentFromText, projectDocument, type DocumentParagraph } from '../document-model';
import {
  splitDocumentSceneBoundary,
  joinDocumentSceneBoundary,
} from '../scene-boundary-operations';
let sequence = 0;
const id = () => `boundary-${++sequence}`;
describe('atomic scene boundary operations', () => {
  it('splits explicit Unicode spans while preserving run formatting and all following objects', () => {
    const left = documentFromText('A😀 e\u0301B\n\nFollowing', id);
    const right = documentFromText('Existing', id);
    const paragraph = left.blocks[0] as DocumentParagraph;
    paragraph.runs[0]!.style = { bold: true };
    left.blocks.push({
      type: 'image',
      id: id(),
      assetId: 7,
      sha256: 'a'.repeat(64),
      alt: 'Protected',
      width: 80,
      height: 40,
    });
    const result = splitDocumentSceneBoundary(left, right, 1, 2, paragraph.id, 3, id);
    expect(projectDocument(result.left).text).toBe('A😀');
    expect(projectDocument(result.right).text).toBe(' e\u0301B\n\nFollowing\n\n\ufffc\n\nExisting');
    expect((result.left.blocks[0] as DocumentParagraph).id).toBe(paragraph.id);
    expect((result.left.blocks[0] as DocumentParagraph).runs[0]!.id).toBe(paragraph.runs[0]!.id);
    expect((result.right.blocks[0] as DocumentParagraph).runs[0]!.style).toEqual({ bold: true });
    expect(result.right.blocks[2]).toEqual(left.blocks[2]);
    expect(result.anchorLineage[0]).toMatchObject({
      kind: 'split',
      source: { sceneId: 1, from: 3, to: 7 },
      target: { sceneId: 2, from: 0, to: 4 },
    });
    expect(() => splitDocumentSceneBoundary(left, right, 1, 2, paragraph.id, 2, id)).toThrow(
      'grapheme',
    );
    expect(() => splitDocumentSceneBoundary(left, right, 1, 2, paragraph.id, 5, id)).toThrow(
      'grapheme',
    );
    expect(projectDocument(left).text).toBe('A😀 e\u0301B\n\nFollowing\n\n\ufffc');
  });
  it('joins as a direct manual boundary retaining both physical IDs and supports pending manual review', () => {
    const left = documentFromText('Left', id);
    const right = documentFromText('Right', id);
    const direct = joinDocumentSceneBoundary(left, right, 1, 2, id);
    expect(direct.left.blocks.map((block) => block.id)).toEqual([
      left.blocks[0]!.id,
      right.blocks[0]!.id,
    ]);
    expect(direct.right.blocks).toEqual([]);
    expect(projectDocument(direct.left).text).toBe('LeftRight');
    expect(projectDocument(direct.left, 'original').text).toBe('LeftRight');
    const pending = joinDocumentSceneBoundary(left, right, 1, 2, id, true);
    expect(projectDocument(pending.left).text).toBe('LeftRight');
    expect(projectDocument(pending.left, 'original').text).toBe('Left\n\nRight');
    expect(pending.anchorLineage[0]).toMatchObject({
      kind: 'join',
      source: { sceneId: 2, runId: (right.blocks[0] as DocumentParagraph).runs[0]!.id },
      target: { sceneId: 1, blockId: right.blocks[0]!.id },
    });
  });
  it('rejects anchored partial splits and incompatible styles without changing either scene', () => {
    const left = documentFromText('Left', id);
    const right = documentFromText('Right', id);
    const paragraph = left.blocks[0] as DocumentParagraph;
    left.comments.push({
      id: id(),
      authorId: 1,
      authorName: 'Editor',
      text: 'Anchor',
      createdAt: '2026-10-05T00:00:00Z',
      resolved: false,
      anchors: [
        {
          blockId: paragraph.id,
          runId: paragraph.runs[0]!.id,
          start: 0,
          end: 4,
          sourceText: 'Left',
        },
      ],
    });
    expect(() => splitDocumentSceneBoundary(left, right, 1, 2, paragraph.id, 2, id)).toThrow(
      'review anchors',
    );
    (right.blocks[0] as DocumentParagraph).style.heading = 1;
    expect(() => joinDocumentSceneBoundary(left, right, 1, 2, id)).toThrow('incompatible styles');
  });
});
