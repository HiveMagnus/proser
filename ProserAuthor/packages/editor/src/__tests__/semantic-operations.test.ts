import { describe, expect, it } from 'vitest';
import { documentFromText, type DocumentParagraph } from '../document-model';
import { paragraphSelection } from '../document-selection';
import { formatDocumentSelection, formatDocumentParagraph } from '../semantic-operations';
let sequence = 0;
const id = () => `format-${++sequence}`;
describe('canonical semantic formatting', () => {
  it('formats a table-cell grapheme range while retaining immutable comment source evidence', () => {
    const document = documentFromText('Other', id);
    const paragraph = documentFromText('A😀e\u0301Z', id).blocks[0] as DocumentParagraph;
    const oldRun = paragraph.runs[0]!;
    document.blocks.push({
      type: 'table',
      id: id(),
      widths: [120],
      rows: [{ id: id(), cells: [{ id: id(), paragraphs: [paragraph] }] }],
    });
    document.comments.push({
      id: id(),
      authorId: 1,
      authorName: 'Author',
      createdAt: '2026-10-05T00:00:00Z',
      text: 'Exact anchor',
      resolved: false,
      anchors: [
        { blockId: paragraph.id, runId: oldRun.id, start: 0, end: 6, sourceText: oldRun.text },
      ],
    });
    const selection = paragraphSelection(document, paragraph.id, 1, 5, oldRun.text)!;
    const next = formatDocumentSelection(document, selection, { bold: true, italic: true }, id);
    const table = next.blocks[1];
    if (table?.type !== 'table') throw new Error('fixture');
    const runs = table.rows[0]!.cells[0]!.paragraphs[0]!.runs;
    expect(runs.map((run) => run.text)).toEqual(['A', '😀e\u0301', 'Z']);
    expect(runs[0]!.id).toBe(oldRun.id);
    expect(runs[1]!.style).toEqual({ bold: true, italic: true });
    expect(next.comments).toEqual(document.comments);
    expect(next.comments[0]!.anchors[0]!.runId).toBe(oldRun.id);
    expect(next.comments[0]!.anchors[0]!.sourceText).toBe(oldRun.text);
    expect(next.blocks[0]).toEqual(document.blocks[0]);
    expect(document.blocks[1]).not.toEqual(next.blocks[1]);
  });
  it('refuses stale text, split graphemes and unresolved review targets', () => {
    const document = documentFromText('A😀Z', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    const selection = paragraphSelection(document, paragraph.id, 1, 3, 'A😀Z')!;
    expect(() =>
      formatDocumentSelection(
        document,
        { ...selection, targets: [{ ...selection.targets[0]!, from: 2 }] },
        { bold: true },
        id,
      ),
    ).toThrow('grapheme');
    expect(() =>
      formatDocumentSelection(
        document,
        { ...selection, targets: [{ ...selection.targets[0]!, sourceText: 'wrong' }] },
        { bold: true },
        id,
      ),
    ).toThrow('changed');
    document.changes.push({
      id: id(),
      authorId: 1,
      authorName: 'AI review',
      createdAt: '2026-10-05T00:00:00Z',
      kind: 'format',
      origin: 'ai',
      status: 'pending',
      targetRunIds: [paragraph.runs[0]!.id],
      beforeStyle: {},
      afterStyle: { bold: true },
    });
    expect(() => formatDocumentSelection(document, selection, { italic: true }, id)).toThrow(
      'pending',
    );
    expect(() => formatDocumentParagraph(document, paragraph.id, { heading: 2 })).toThrow(
      'pending',
    );
  });
  it('updates only the addressed paragraph style without flattening mixed runs', () => {
    const document = documentFromText('Styled\n\nOther', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    paragraph.runs[0]!.style = { font: 'Georgia', size: 18, italic: true };
    const next = formatDocumentParagraph(document, paragraph.id, {
      heading: 2,
      alignment: 'center',
      keepWithNext: true,
    });
    expect((next.blocks[0] as DocumentParagraph).runs).toEqual(paragraph.runs);
    expect((next.blocks[0] as DocumentParagraph).style).toMatchObject({
      heading: 2,
      alignment: 'center',
    });
    expect(next.blocks[1]).toEqual(document.blocks[1]);
  });
  it('does not forge historical review attribution when formatting a resolved insertion', () => {
    const document = documentFromText('Accepted text', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    const run = paragraph.runs[0]!;
    run.changeId = 'accepted';
    document.changes.push({
      id: 'accepted',
      kind: 'insertion',
      status: 'accepted',
      origin: 'ai',
      authorId: 9,
      authorName: 'Original reviewer',
      createdAt: '2026-10-05T00:00:00Z',
      targetRunIds: [run.id],
    });
    const selected = paragraphSelection(document, paragraph.id, 2, 6, run.text)!;
    const next = formatDocumentSelection(document, selected, { italic: true }, id, 7);
    const formatted = next.blocks[0] as DocumentParagraph;
    expect(next.changes).toEqual(document.changes);
    expect(formatted.runs[0]!.changeId).toBe('accepted');
    expect(formatted.runs.slice(1).every((run) => !run.changeId)).toBe(true);
  });
});
