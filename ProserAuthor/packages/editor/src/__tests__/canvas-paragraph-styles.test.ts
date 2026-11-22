import { describe, expect, it } from 'vitest';
import { ElementType, ListType, TitleLevel, type IElement } from '@hivemagnus/canvas-word-engine';
import { documentFromText, type DocumentParagraph } from '../document-model';
import { canvasToDocument, documentToCanvas, headingFontSize } from '../canvas-adapter';
let sequence = 0;
const id = () => `paragraph-style-${++sequence}`;
describe('Canvas paragraph style exchange', () => {
  it('keeps a newly typed soft line break in its original paragraph', () => {
    const document = documentFromText('A', id);
    const data = documentToCanvas(document);
    data.main.push({ value: '\n', paragraphBreak: false }, { value: 'B' });
    const restored = canvasToDocument(data, document, id);
    expect(restored.blocks).toHaveLength(1);
    expect(restored.blocks[0]?.id).toBe(document.blocks[0]?.id);
    const paragraph = restored.blocks[0] as DocumentParagraph;
    expect(paragraph.runs.map((run) => run.text).join('')).toBe('A\nB');
    expect(canvasToDocument(documentToCanvas(restored), restored, id)).toEqual(restored);
  });
  it('projects paragraph revisions and joined boundaries without flattening physical identities', () => {
    const document = documentFromText('Left\n\nRight', id);
    const left = document.blocks[0] as DocumentParagraph;
    const right = document.blocks[1] as DocumentParagraph;
    left.boundaryChangeId = 'boundary';
    document.changes.push({
      id: 'boundary',
      kind: 'paragraphJoin',
      status: 'pending',
      targetRunIds: [],
      targetBlockIds: [left.id, right.id],
      authorId: 1,
      authorName: 'Editor',
      createdAt: '2026-10-05T00:00:00Z',
      origin: 'manual',
    });
    const final = documentToCanvas(document, 'final');
    expect(final.main.filter((element) => element.value === '\n')).toHaveLength(0);
    expect(canvasToDocument(final, document, id)).toEqual(document);
    expect(
      documentToCanvas(document, 'original').main.filter((element) => element.value === '\n'),
    ).toHaveLength(1);
    left.style = { heading: 2, alignment: 'center' };
    document.changes.push({
      id: 'paragraph-format',
      kind: 'paragraphFormat',
      status: 'pending',
      targetRunIds: [],
      targetBlockIds: [left.id],
      beforeParagraphStyle: {},
      afterParagraphStyle: left.style,
      authorId: 1,
      authorName: 'Editor',
      createdAt: '2026-10-05T00:00:00Z',
      origin: 'manual',
    });
    expect(documentToCanvas(document, 'original').main[0]!.level).toBeUndefined();
    expect(documentToCanvas(document, 'final').main[0]!.level).toBe(TitleLevel.SECOND);
  });
  it('renders heading defaults while preserving implicit canonical run styles on serialization', () => {
    const document = documentFromText('Heading 😀\n\nBody', id);
    const heading = document.blocks[0] as DocumentParagraph;
    heading.style = { heading: 2, name: 'Heading 2', alignment: 'center' };
    const data = documentToCanvas(document);
    const run = data.main[0]!;
    expect(run.level).toBe(TitleLevel.SECOND);
    expect(run.titleId).toBe(heading.id);
    expect(run.size).toBe(headingFontSize(2, document.layout.fontSize));
    expect(run.bold).toBe(true);
    expect(canvasToDocument(data, document, id)).toEqual(document);
    const compressed = {
      ...data,
      main: [
        {
          type: ElementType.TITLE,
          value: '',
          level: TitleLevel.SECOND,
          titleId: heading.id,
          valueList: [{ ...run, level: undefined }],
        },
        ...data.main.slice(1),
      ],
    };
    expect(canvasToDocument(compressed, document, id)).toEqual(document);
  });
  it('retains contiguous numbered list identity across paragraphs and table cells without flattening styles', () => {
    const document = documentFromText('First\n\nSecond\n\nPlain\n\nNew list', id);
    for (const index of [0, 1, 3])
      (document.blocks[index] as DocumentParagraph).style.list = 'number';
    const cellParagraphs = documentFromText('Cell one\n\nCell two', id)
      .blocks as DocumentParagraph[];
    cellParagraphs.forEach((paragraph) => (paragraph.style.list = 'bullet'));
    document.blocks.push({
      type: 'table',
      id: id(),
      widths: [100],
      rows: [{ id: id(), cells: [{ id: id(), paragraphs: cellParagraphs }] }],
    });
    const data = documentToCanvas(document);
    const runs = data.main.filter((element) => element.type === ElementType.TEXT);
    expect(runs[0]!.listId).toBe(runs[1]!.listId);
    expect(runs[3]!.listId).not.toBe(runs[0]!.listId);
    expect(runs[0]!.listType).toBe(ListType.OL);
    const table = data.main.at(-1)!;
    const cell = table.trList![0]!.tdList[0]!.value;
    expect(cell[0]!.listId).toBe(cell[2]!.listId);
    expect(cell[0]!.listType).toBe(ListType.UL);
    expect(canvasToDocument(data, document, id)).toEqual(document);
    const compressed: IElement[] = [
      {
        type: ElementType.LIST,
        value: '',
        listType: ListType.OL,
        listId: runs[0]!.listId,
        valueList: data.main.slice(0, 3).map((element) => ({ ...element, listType: undefined })),
      },
      ...data.main.slice(3),
    ];
    expect(canvasToDocument({ ...data, main: compressed }, document, id)).toEqual(document);
  });
  it('detects heading/list removal rather than resurrecting stale extension formatting', () => {
    const document = documentFromText('Heading\n\nListed', id);
    (document.blocks[0] as DocumentParagraph).style = { heading: 1, name: 'Heading 1' };
    (document.blocks[1] as DocumentParagraph).style = { list: 'bullet', name: 'Bulleted list' };
    const data = documentToCanvas(document);
    for (const element of data.main) {
      delete element.level;
      delete element.titleId;
      delete element.size;
      delete element.bold;
      delete element.listId;
      delete element.listType;
      delete element.listStyle;
    }
    const changed = canvasToDocument(data, document, id);
    expect((changed.blocks[0] as DocumentParagraph).style).toMatchObject({
      name: 'Normal',
      heading: undefined,
    });
    expect((changed.blocks[1] as DocumentParagraph).style).toMatchObject({
      name: 'Normal',
      list: undefined,
    });
    expect((changed.blocks[0] as DocumentParagraph).runs[0]!.style).toEqual({});
  });
  it('fits table widths visually while preserving source dimensions and column identities', () => {
    const document = documentFromText('Body', id);
    const paragraphs = documentFromText('Cell', id).blocks as DocumentParagraph[];
    document.blocks.push({
      type: 'table',
      id: 'large',
      widths: [600, 300],
      rows: [
        {
          id: 'row',
          cells: [
            { id: 'left', paragraphs },
            {
              id: 'right',
              paragraphs: documentFromText('Right', id).blocks as DocumentParagraph[],
            },
          ],
        },
      ],
    });
    const data = documentToCanvas({
      ...document,
      layout: { ...document.layout, width: 500, margins: [40, 40, 40, 40] },
    });
    const table = data.main.at(-1)!;
    expect(table.colgroup!.map((column) => column.width)).toEqual([280, 140]);
    expect(canvasToDocument(data, document, id)).toEqual(document);
    table.colgroup![0]!.width = 290;
    expect(
      (
        canvasToDocument(data, document, id).blocks.at(
          -1,
        ) as import('../document-model').DocumentTable
      ).widths,
    ).toEqual([(290 * 600) / 280, 300]);
  });
});
