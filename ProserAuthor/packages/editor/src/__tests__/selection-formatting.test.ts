import { describe, expect, it } from 'vitest';
import { documentFromText, type DocumentParagraph } from '../document-model';
import { paragraphSelection } from '../document-selection';
import { formatDocumentSelection } from '../semantic-operations';
import { refreshFormattingSelection, selectionTextStyle } from '../selection-formatting';
let sequence = 0;
const id = () => `selection-format-${++sequence}`;
describe('formatting selection state', () => {
  it('refreshes IDs after partial run formatting so consecutive toggles retain the exact range', () => {
    const document = documentFromText('First repeated First', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    const selected = paragraphSelection(document, paragraph.id, 15, 20, paragraph.runs[0]!.text)!;
    const bold = formatDocumentSelection(document, selected, { bold: true, color: '#123456' }, id);
    const refreshed = refreshFormattingSelection(bold, selected)!;
    expect(refreshed.targets).toEqual(selected.targets);
    expect(refreshed.runs[0]!.runId).not.toBe(selected.runs[0]!.runId);
    expect(selectionTextStyle(bold, refreshed)).toMatchObject({ bold: true, color: '#123456' });
    const italic = formatDocumentSelection(bold, refreshed, { italic: true }, id);
    expect(
      (italic.blocks[0] as DocumentParagraph).runs.map((run) => [run.text, run.style]),
    ).toEqual([
      ['First repeated ', {}],
      ['First', { bold: true, color: '#123456', italic: true }],
    ]);
  });
  it('reflects implicit heading typography while preserving explicit overrides', () => {
    const document = documentFromText('Heading', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    paragraph.style.heading = 2;
    const selected = paragraphSelection(document, paragraph.id, 0, 7, 'Heading')!;
    expect(selectionTextStyle(document, selected)).toMatchObject({
      bold: true,
      size: document.layout.fontSize * 1.5,
    });
    paragraph.runs[0]!.style = { bold: false, size: 20 };
    expect(selectionTextStyle(document, selected)).toMatchObject({ bold: false, size: 20 });
  });
  it('refuses changed source text instead of finding a repeated quotation elsewhere', () => {
    const document = documentFromText('First repeated First', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    const selected = paragraphSelection(document, paragraph.id, 15, 20, paragraph.runs[0]!.text)!;
    paragraph.runs[0]!.text = 'First changed! Gone!';
    expect(() => refreshFormattingSelection(document, selected)).toThrow('selection changed');
  });
  it('computes mixed emphasis from every selected run and resolves inherited fonts', () => {
    const document = documentFromText('Bold plain', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    paragraph.style.name = 'Normal';
    paragraph.runs = [
      { id: id(), text: 'Bold', style: { bold: true } },
      { id: id(), text: ' plain', style: {} },
    ];
    const selected = paragraphSelection(document, paragraph.id, 0, 10, 'Bold plain')!;
    expect(
      selectionTextStyle(document, selected, {
        paragraph: {},
        text: { Normal: { font: 'Liberation Serif', size: 18 } },
      }),
    ).toMatchObject({ bold: false, font: 'Liberation Serif', size: 18 });
  });
});
