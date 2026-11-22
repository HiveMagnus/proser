import { describe, expect, it } from 'vitest';
import {
  documentFromText,
  projectDocument,
  resolveChange,
  type DocumentParagraph,
} from '../document-model';
import { editManualParagraphText, trackManualDocumentEdit } from '../manual-review-editing';
import { formatDocumentParagraph, formatDocumentSelection } from '../semantic-operations';
import { paragraphSelection } from '../document-selection';
let sequence = 0;
const id = () => `manual-${++sequence}`;
describe('authenticated manual review editing', () => {
  it('continues the same actor insertion without replacing its attribution or original text', () => {
    const original = documentFromText('A😀B', id);
    const block = original.blocks[0] as DocumentParagraph;
    const first = editManualParagraphText(original, block.id, 'A😀OneB', 7, true, id);
    expect(first.changes).toHaveLength(1);
    const tracked = structuredClone(first.changes[0]!);
    const next = editManualParagraphText(first, block.id, 'A😀One twoB', 7, true, id);
    expect(next.changes).toEqual([tracked]);
    expect(projectDocument(next).text).toBe('A😀One twoB');
    expect(projectDocument(next, 'original').text).toBe('A😀B');
    const erased = editManualParagraphText(next, block.id, 'A😀B', 7, true, id);
    expect(projectDocument(erased).text).toBe('A😀B');
    expect(erased.changes[0]!.targetRunIds).toEqual(tracked.targetRunIds);
  });
  it('tracks deletion and formatting reversibly while preserving paragraph identities', () => {
    const original = documentFromText('Alpha beta', id);
    const block = original.blocks[0] as DocumentParagraph;
    const deleted = editManualParagraphText(original, block.id, 'Alpha', 7, true, id);
    expect(projectDocument(deleted).text).toBe('Alpha');
    expect(projectDocument(deleted, 'original').text).toBe('Alpha beta');
    expect(deleted.changes.some((change) => change.kind === 'deletion')).toBe(true);
    const selected = paragraphSelection(original, block.id, 0, 5, 'Alpha beta')!;
    const formatted = formatDocumentSelection(original, selected, { bold: true }, id, 7);
    const tracked = trackManualDocumentEdit(original, formatted, 7, id);
    expect(tracked.changes.filter((change) => change.kind === 'format')).toHaveLength(1);
    expect(tracked.blocks[0]!.id).toBe(block.id);
    const heading = trackManualDocumentEdit(
      original,
      formatDocumentParagraph(original, block.id, { heading: 2 }, 7),
      7,
      id,
    );
    expect(heading.changes[0]).toMatchObject({
      kind: 'paragraphFormat',
      status: 'pending',
      targetBlockIds: [block.id],
      beforeParagraphStyle: {},
      afterParagraphStyle: { heading: 2 },
    });
  });
  it('protects another actor insertion and protected inline assets', () => {
    const original = documentFromText('AB', id);
    const block = original.blocks[0] as DocumentParagraph;
    const inserted = editManualParagraphText(original, block.id, 'AoneB', 7, true, id);
    expect(() => editManualParagraphText(inserted, block.id, 'AtwoB', 8, true, id)).toThrow();
    block.runs.push({
      id: id(),
      text: '',
      style: {},
      inlineImage: { assetId: 2, sha256: 'a'.repeat(64), width: 20, height: 10, alt: 'Kept' },
    });
    expect(() => editManualParagraphText(original, block.id, 'AB', 7, true, id)).toThrow();
  });
  it('edits later paragraphs and later table-cell paragraphs without including structural separators', () => {
    const document = documentFromText('First\n\nSecond', id);
    const second = document.blocks[1] as DocumentParagraph;
    const changed = editManualParagraphText(document, second.id, 'Second added', 7, false, id);
    expect(projectDocument(changed).text).toBe('First\n\nSecond added');
    expect(changed.blocks[0]).toEqual(document.blocks[0]);
    const cellFirst = documentFromText('Cell first', id).blocks[0] as DocumentParagraph;
    const cellSecond = documentFromText('Cell second', id).blocks[0] as DocumentParagraph;
    document.blocks.push({
      type: 'table',
      id: id(),
      widths: [100],
      rows: [{ id: id(), cells: [{ id: id(), paragraphs: [cellFirst, cellSecond] }] }],
    });
    const cellChanged = editManualParagraphText(
      document,
      cellSecond.id,
      'Cell second added',
      7,
      true,
      id,
    );
    expect(projectDocument(cellChanged).text).toBe(
      'First\n\nSecond\n\nCell first\n\nCell second added',
    );
    expect(projectDocument(cellChanged, 'original').text).toBe(projectDocument(document).text);
    const table = cellChanged.blocks[2];
    if (table?.type !== 'table') throw new Error('fixture');
    expect(table.rows[0]!.cells[0]!.paragraphs[0]).toEqual(cellFirst);
  });
  it('refuses pasted text concealed by a native paragraph-boundary review record', () => {
    const original = documentFromText('AB', id);
    const left = original.blocks[0] as DocumentParagraph;
    const pasted = documentFromText('Anew\n\nB', id);
    const first = pasted.blocks[0] as DocumentParagraph;
    const second = pasted.blocks[1] as DocumentParagraph;
    first.id = left.id;
    first.boundaryChangeId = 'split';
    pasted.changes.push({
      id: 'split',
      kind: 'paragraphSplit',
      status: 'pending',
      origin: 'manual',
      authorId: 7,
      authorName: 'Writer',
      createdAt: '2026-10-05T00:00:00Z',
      targetRunIds: [],
      targetBlockIds: [first.id, second.id],
    });
    expect(() => trackManualDocumentEdit(original, pasted, 7, id)).toThrow('untracked text');
  });
  it('qualifies the right physical paragraph for typing through a hidden join boundary', () => {
    const source = documentFromText('A\n\nB', id);
    const left = source.blocks[0] as DocumentParagraph;
    const right = source.blocks[1] as DocumentParagraph;
    left.boundaryChangeId = 'joined';
    source.changes.push({
      id: 'joined',
      kind: 'paragraphJoin',
      targetRunIds: [],
      targetBlockIds: [left.id, right.id],
      status: 'pending',
      origin: 'manual',
      authorId: 7,
      authorName: 'Writer',
      createdAt: '2026-10-05T00:00:00Z',
    });
    expect(projectDocument(source).text).toBe('AB');
    const typed = editManualParagraphText(source, right.id, 'XB', 7, true, id);
    expect(projectDocument(typed).text).toBe('AXB');
    expect(projectDocument(typed, 'original').text).toBe('A\n\nB');
    expect((typed.blocks[0] as DocumentParagraph).runs).toEqual(left.runs);
    const insertion = typed.changes.find((change) => change.kind === 'insertion')!;
    const afterReject = resolveChange(typed, insertion.id, 'rejected');
    expect(projectDocument(afterReject).text).toBe('AB');
    const native = structuredClone(source);
    (native.blocks[1] as DocumentParagraph).runs[0]!.text = 'XB';
    const nativeTracked = trackManualDocumentEdit(source, native, 7, id);
    expect(projectDocument(nativeTracked).text).toBe('AXB');
    expect(projectDocument(nativeTracked, 'original').text).toBe('A\n\nB');
    expect(nativeTracked.changes.filter((change) => change.kind === 'insertion')).toHaveLength(1);
  });
});
