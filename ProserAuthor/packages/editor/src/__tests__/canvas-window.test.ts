import { describe, expect, it } from 'vitest';
import {
  documentFromText,
  canonicalDocument,
  projectDocument,
  type DocumentParagraph,
} from '../document-model';
import { paragraphSelection } from '../document-selection';
import {
  canvasDocumentWindow,
  mergeCanvasDocumentWindow,
  acknowledgeCanvasWindow,
  refreshCanvasDocumentWindow,
  windowSelection,
  canvasWindowForSelection,
} from '../canvas-window';

describe('bounded Canvas passages', () => {
  it('keeps complete paragraphs and merges only the selected contiguous scope', () => {
    let sequence = 0;
    const source = documentFromText(
      'First 😀 e\u0301\n\nSecond\n\nThird\n\nFourth',
      () => `window-${++sequence}`,
    );
    const view = canvasDocumentWindow(source, 1, 10);
    expect(view.document.blocks.map((block) => block.id)).toEqual([source.blocks[1]!.id]);
    const edited = structuredClone(view.document);
    const first = edited.blocks[0]!;
    if (first.type !== 'paragraph') throw new Error('fixture');
    first.runs[0]!.text += ' edited';
    const result = mergeCanvasDocumentWindow(source, view, edited);
    expect(projectDocument(result).text).toBe(
      'First 😀 e\u0301\n\nSecond edited\n\nThird\n\nFourth',
    );
    expect(result.blocks[0]).toBe(source.blocks[0]);
    expect(result.blocks[2]).toBe(source.blocks[2]);
    expect(canonicalDocument(result.changes)).toBe(canonicalDocument(source.changes));
  });
  it('preserves outside table assets, review metadata and comments and rejects lost fences', () => {
    let sequence = 0;
    const source = documentFromText('First\n\nSecond\n\nThird', () => `protected-${++sequence}`);
    source.blocks.push({
      type: 'image',
      id: 'image',
      assetId: 7,
      sha256: 'a'.repeat(64),
      alt: 'Exact alt',
      width: 100,
      height: 50,
    });
    const view = canvasDocumentWindow(source, 1, 7);
    const result = mergeCanvasDocumentWindow(source, view, view.document);
    expect(canonicalDocument(result)).toBe(canonicalDocument(source));
    expect(result.blocks.at(-1)).toBe(source.blocks.at(-1));
    expect(() =>
      mergeCanvasDocumentWindow({ ...source, blocks: source.blocks.slice(1) }, view, view.document),
    ).toThrow('outside');
    expect(() =>
      mergeCanvasDocumentWindow(source, view, { ...view.document, blocks: [source.blocks[0]!] }),
    ).toThrow('duplicates');
  });
  it('bounds an oversized Unicode paragraph and retains exact prefix, suffix, identity and selection offsets', () => {
    let sequence = 0;
    const id = () => `slice-${++sequence}`;
    const text = '😀 e\u0301 repeated '.repeat(800);
    const source = documentFromText(text, id);
    const paragraph = source.blocks[0] as DocumentParagraph;
    const view = canvasDocumentWindow(source, 0, 100, 2);
    expect(projectDocument(view.document).text.length).toBeLessThanOrEqual(100);
    const selected = view.document.blocks[0] as DocumentParagraph;
    const original = selected.runs[0]!.text;
    const selection = paragraphSelection(view.document, selected.id, 0, 2, original)!;
    const canonical = windowSelection(view, selection, source)!;
    expect(canonical.targets[0]!.from).toBe(view.segment!.from);
    expect(canonical.runs[0]!.runId).toBe(paragraph.runs[0]!.id);
    expect(windowSelection(view, canonical, source, true)).toEqual(selection);
    expect(canvasWindowForSelection(source, canonical, 100).part).toBe(2);
    const edited = structuredClone(view.document);
    (edited.blocks[0] as DocumentParagraph).runs[0]!.text += ' typed';
    const result = mergeCanvasDocumentWindow(source, view, edited, id);
    expect(projectDocument(result).text).toBe(
      text.slice(0, view.segment!.to) + ' typed' + text.slice(view.segment!.to),
    );
    expect((result.blocks[0] as DocumentParagraph).runs).toHaveLength(1);
    expect((result.blocks[0] as DocumentParagraph).runs[0]!.id).toBe(paragraph.runs[0]!.id);
    acknowledgeCanvasWindow(view, result, edited);
    expect(canonicalDocument(mergeCanvasDocumentWindow(result, view, edited, id))).toBe(
      canonicalDocument(result),
    );
    const acknowledged = {
      ...result,
      comments: [
        {
          id: 'new',
          authorId: 7,
          authorName: 'Writer',
          text: 'Acknowledged',
          createdAt: '2026-10-05T00:00:00Z',
          resolved: false,
          anchors: [],
        },
      ],
    };
    const refreshed = refreshCanvasDocumentWindow(acknowledged, view);
    expect(refreshed.segment!.to).toBe(view.segment!.to);
    expect(projectDocument(refreshed.document).text).toBe(projectDocument(edited).text);
    expect(refreshed.document.comments).toEqual(acknowledged.comments);
    expect(() => mergeCanvasDocumentWindow(source, view, edited, id)).toThrow('source');
  });
  it('bounds oversized tables by exact cell slices while preserving complete topology, widths, images and outside bytes', () => {
    let sequence = 0;
    const id = () => `table-slice-${++sequence}`;
    const source = documentFromText('Outside', id);
    const cells = Array.from({ length: 4 }, (_, column) => ({
      id: id(),
      paragraphs: [
        documentFromText(('cell' + column + ' 😀 ').repeat(200), id).blocks[0] as DocumentParagraph,
      ],
    }));
    source.blocks.push({
      type: 'table',
      id: 'full-table',
      widths: [90, 110, 130, 150],
      rows: [{ id: 'first-row', cells }],
    });
    source.blocks.push({
      type: 'image',
      id: 'protected-image',
      assetId: 5,
      sha256: 'a'.repeat(64),
      alt: 'Original',
      width: 320,
      height: 240,
    });
    const view = canvasDocumentWindow(source, 1, 120, 3);
    expect(projectDocument(view.document).text.length).toBeLessThanOrEqual(120);
    const fragment = view.document.blocks[0]!;
    if (fragment.type !== 'table') throw new Error('fixture');
    expect(fragment.rows).toHaveLength(1);
    expect(fragment.rows[0]!.cells).toHaveLength(1);
    const edited = structuredClone(view.document);
    const table = edited.blocks[0]!;
    if (table.type !== 'table') throw new Error('fixture');
    table.rows[0]!.cells[0]!.paragraphs[0]!.runs[0]!.text += ' addition';
    const result = mergeCanvasDocumentWindow(source, view, edited, id);
    const full = result.blocks[1]!;
    if (full.type !== 'table') throw new Error('fixture');
    expect(full.widths).toEqual([90, 110, 130, 150]);
    expect(full.rows[0]!.cells).toHaveLength(4);
    expect(full.rows[0]!.cells.slice(1)).toEqual(cells.slice(1));
    expect(result.blocks[0]).toBe(source.blocks[0]);
    expect(result.blocks[2]).toBe(source.blocks[2]);
    table.widths = [500];
    expect(() => mergeCanvasDocumentWindow(source, view, edited, id)).toThrow('structure');
  });
});
