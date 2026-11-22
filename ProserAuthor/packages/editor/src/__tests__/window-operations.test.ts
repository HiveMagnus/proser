import { describe, expect, it } from 'vitest';
import { documentFromText, type DocumentParagraph } from '../document-model';
import { moveDocumentBlocks } from '../window-operations';
let sequence = 0;
const id = () => `move-${++sequence}`;
describe('complete block moves across scene scopes', () => {
  it('retains protected objects, Unicode styles and exact review/comment identities', () => {
    const source = documentFromText('Styled 😀 e\u0301\n\nRemain', id);
    const destination = documentFromText('Destination', id);
    const paragraph = source.blocks[0] as DocumentParagraph;
    paragraph.runs[0]!.style = { bold: true, font: 'Georgia', size: 18 };
    const cell = documentFromText('Cell', id).blocks[0] as DocumentParagraph;
    source.blocks.push(
      {
        type: 'table',
        id: id(),
        widths: [120],
        rows: [{ id: id(), cells: [{ id: id(), paragraphs: [cell] }] }],
      },
      {
        type: 'image',
        id: id(),
        assetId: 42,
        sha256: 'a'.repeat(64),
        alt: 'Protected image',
        width: 120,
        height: 80,
      },
    );
    source.changes.push({
      id: id(),
      kind: 'format',
      authorId: 7,
      authorName: 'Imported editor',
      createdAt: '2026-10-05T00:00:00Z',
      status: 'pending',
      origin: 'import',
      importedAuthor: 'Word editor',
      targetRunIds: [paragraph.runs[0]!.id],
      beforeStyle: {},
      afterStyle: paragraph.runs[0]!.style,
    });
    source.comments.push({
      id: id(),
      authorId: 7,
      authorName: 'Imported editor',
      importedAuthor: 'Word editor',
      createdAt: '2026-10-05T00:00:00Z',
      text: 'Exact annotation',
      resolved: false,
      anchors: [
        {
          blockId: paragraph.id,
          runId: paragraph.runs[0]!.id,
          start: 0,
          end: 6,
          sourceText: 'Styled',
        },
      ],
    });
    const moved = moveDocumentBlocks(
      source,
      destination,
      [paragraph.id, source.blocks[2]!.id, source.blocks[3]!.id],
      'end',
    );
    expect(moved.source.blocks).toEqual([source.blocks[1]]);
    expect(moved.source.changes).toEqual([]);
    expect(moved.source.comments).toEqual([]);
    expect(moved.destination.blocks.slice(1)).toEqual([
      paragraph,
      source.blocks[2],
      source.blocks[3],
    ]);
    expect(moved.destination.changes).toEqual(source.changes);
    expect(moved.destination.comments).toEqual(source.comments);
    expect(source.blocks).toHaveLength(4);
  });
  it('refuses partial annotations, duplicated identities and incompatible scene layouts', () => {
    const source = documentFromText('First\n\nSecond', id);
    const destination = documentFromText('Destination', id);
    const first = source.blocks[0] as DocumentParagraph;
    const second = source.blocks[1] as DocumentParagraph;
    source.comments.push({
      id: id(),
      authorId: 7,
      authorName: 'Editor',
      createdAt: '2026-10-05T00:00:00Z',
      text: 'Crosses boundary',
      resolved: false,
      anchors: [first, second].map((block) => ({
        blockId: block.id,
        runId: block.runs[0]!.id,
        start: 0,
        end: block.runs[0]!.text.length,
        sourceText: block.runs[0]!.text,
      })),
    });
    expect(() => moveDocumentBlocks(source, destination, [first.id], 'start')).toThrow('comment');
    expect(() => moveDocumentBlocks(source, source, [first.id, second.id], 'end')).toThrow(
      'identities',
    );
    const different = structuredClone(destination);
    different.layout.font = 'Arial';
    expect(() => moveDocumentBlocks(source, different, [first.id, second.id], 'end')).toThrow(
      'layouts',
    );
  });
});
