import { describe, expect, it } from 'vitest';
import { documentFromText } from '../document-model';
import { paragraphSelection, canvasSelection } from '../document-selection';
import { documentToCanvas, identityOf } from '../canvas-adapter';
import { ElementType, EditorZone, type IElement } from '@hivemagnus/canvas-word-engine';

const fixture = () => {
  let sequence = 0;
  const document = documentFromText(
    'Repeated 😀 e\u0301 text\n\nRepeated 😀 e\u0301 text',
    () => `selection-${++sequence}`,
  );
  const first = document.blocks[0];
  const second = document.blocks[1];
  if (first?.type !== 'paragraph' || second?.type !== 'paragraph') throw new Error('fixture');
  second.runs = [
    { id: 'bold-run', text: 'Repeated ', style: { bold: true } },
    { id: 'unicode-run', text: '😀 e\u0301 text', style: { italic: true } },
  ];
  return { document, first, second };
};
describe('canonical semantic selection', () => {
  it('retains the exact repeated paragraph and offsets across differently formatted runs', () => {
    const { document, second } = fixture();
    const selection = paragraphSelection(document, second.id, 7, 14, 'Repeated 😀 e\u0301 text');
    expect(selection?.targets).toEqual([
      { blockId: second.id, from: 7, to: 14, sourceText: 'd 😀 e\u0301' },
    ]);
    expect(selection?.runs).toEqual([
      { blockId: second.id, runId: 'bold-run', from: 7, to: 9 },
      { blockId: second.id, runId: 'unicode-run', from: 0, to: 5 },
    ]);
  });
  it('rejects partial graphemes, stale DOM text and missing identities', () => {
    const { document, second } = fixture();
    const text = 'Repeated 😀 e\u0301 text';
    expect(() => paragraphSelection(document, second.id, 9, 10, text)).toThrow('grapheme');
    expect(() => paragraphSelection(document, second.id, 12, 13, text)).toThrow('grapheme');
    expect(() => paragraphSelection(document, second.id, 0, 8, 'Changed DOM text')).toThrow(
      'canonical',
    );
    expect(() => paragraphSelection(document, 'missing-id', 0, 8, text)).toThrow('stale');
    expect(() => paragraphSelection(document, second.id, -1, 8, text)).toThrow('canonical');
    expect(paragraphSelection(document, second.id, 0, 0, text)).toBeUndefined();
  });
  it('freezes table, row and cell identities instead of retaining their numeric positions', () => {
    const { document, second } = fixture();
    document.blocks.splice(1, 1, {
      type: 'table',
      id: 'table',
      widths: [100],
      rows: [{ id: 'row', cells: [{ id: 'cell', paragraphs: [second] }] }],
    });
    const selection = paragraphSelection(document, second.id, 9, 14, 'Repeated 😀 e\u0301 text');
    expect(selection?.container).toEqual({ tableId: 'table', rowId: 'row', cellId: 'cell' });
    expect(selection?.targets[0]).toEqual({
      blockId: second.id,
      from: 9,
      to: 14,
      sourceText: '😀 e\u0301',
    });
  });
});

describe('native wrapped range selection', () => {
  it.each([ElementType.TITLE, ElementType.LIST])(
    'retains exact repeated Unicode targets inside a %s wrapper',
    (type) => {
      const { document, first, second } = fixture();
      const main = documentToCanvas(document).main;
      const prefix = main.filter((element) => identityOf(element)?.blockId === first.id);
      const selected = main.filter((element) => identityOf(element)?.blockId === second.id);
      const command = {
        getRange: () => ({ startIndex: prefix.length, endIndex: prefix.length + selected.length }),
        getSurroundElementList: () => [{ type, value: '', valueList: prefix }],
        getRuntimeElementList: () => main,
        getRangeContext: () => ({
          isCollapsed: false,
          isTable: false,
          zone: EditorZone.MAIN,
          selectionElementList: [
            {
              type,
              value: '',
              valueList: [
                {
                  type: ElementType.HYPERLINK,
                  value: '',
                  url: 'https://example.com',
                  valueList: selected,
                },
              ],
            },
          ],
        }),
      } as unknown as Parameters<typeof canvasSelection>[0];
      const selection = canvasSelection(command, document)!;
      expect(selection.targets).toEqual([
        {
          blockId: second.id,
          from: 0,
          to: 'Repeated 😀 e\u0301 text'.length,
          sourceText: 'Repeated 😀 e\u0301 text',
        },
      ]);
      expect(selection.runs.map((run) => run.runId)).toEqual(['bold-run', 'unicode-run']);
      expect(selection.container).toEqual({});
    },
  );
  it('keeps protected objects inside neutral wrappers protected', () => {
    const { document } = fixture();
    document.blocks.push({
      type: 'image',
      id: 'protected-image',
      assetId: 42,
      sha256: 'a'.repeat(64),
      alt: 'Preserved image',
      width: 32,
      height: 32,
    });
    const main = documentToCanvas(document).main;
    const image = main.find((element) => element.type === ElementType.IMAGE)!;
    const command = {
      getRange: () => ({ startIndex: 0, endIndex: 1 }),
      getSurroundElementList: () => [],
      getRuntimeElementList: () => main,
      getRangeContext: () => ({
        isCollapsed: false,
        isTable: false,
        zone: EditorZone.MAIN,
        selectionElementList: [
          { type: ElementType.TITLE, value: '', valueList: [image] },
        ] as IElement[],
      }),
    } as unknown as Parameters<typeof canvasSelection>[0];
    expect(() => canvasSelection(command, document)).toThrow('protected object');
  });
});
