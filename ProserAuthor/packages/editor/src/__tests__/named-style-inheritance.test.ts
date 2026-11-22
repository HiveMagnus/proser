import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  documentFromText,
  canonicalDocument,
  type DocumentParagraph,
  type DocumentStyleDefinitions,
} from '../document-model';
import { documentToCanvas, canvasToDocument } from '../canvas-adapter';
import { SemanticDocument } from '../components/semantic-document';
const definitions: DocumentStyleDefinitions = {
  paragraph: { style_1: { name: 'style_1', heading: 2, alignment: 'right', lineSpacing: 1.5 } },
  text: { style_1: { font: 'Liberation Sans', size: 22, bold: true } },
  labels: { style_1: 'Chapter heading 日本語' },
};
let sequence = 0;
const id = () => `named-${++sequence}`;
describe('Factory-defined named-style inheritance', () => {
  it('renders inherited paragraph/run properties while preserving only stored overrides on serialization', () => {
    const document = documentFromText('Named text', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    paragraph.style = { name: 'style_1' };
    paragraph.runs[0]!.style = { color: '#123456' };
    const canvas = documentToCanvas(document, 'final', definitions);
    const first = canvas.main[0]!;
    expect(first).toMatchObject({
      font: 'Liberation Sans',
      size: 22,
      bold: true,
      color: '#123456',
      rowFlex: 'right',
      level: 'second',
    });
    expect(canonicalDocument(canvasToDocument(canvas, document, id))).toBe(
      canonicalDocument(document),
    );
    const changed = structuredClone(canvas);
    changed.main[0]!.size = 30;
    const next = canvasToDocument(changed, document, id);
    expect((next.blocks[0] as DocumentParagraph).runs[0]!.style).toEqual({
      color: '#123456',
      size: 30,
    });
    expect((next.blocks[0] as DocumentParagraph).style).toEqual({ name: 'style_1' });
  });
  it('uses the same inherited styles in semantic rendering and honors explicit overrides', () => {
    const document = documentFromText('Named text', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    paragraph.style = { name: 'style_1', alignment: 'center' };
    paragraph.runs[0]!.style = { bold: false, size: 18 };
    const html = renderToStaticMarkup(
      createElement(SemanticDocument, { document, namedStyles: definitions }),
    );
    expect(html).toContain('<h2');
    expect(html).toContain('text-align:center');
    expect(html).toContain('font-family:Liberation Sans');
    expect(html).toContain('font-size:18px');
  });
  it('retains character style references and chained inherited properties without materializing defaults', () => {
    const document = documentFromText('Character reference', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    const named = {
      ...definitions,
      text: {
        ...definitions.text,
        char_base: { italic: true, font: 'Liberation Serif' },
        char_child: { characterStyleId: 'char_base', bold: true },
      },
    };
    paragraph.runs[0]!.style = { characterStyleId: 'char_child', bold: false };
    const canvas = documentToCanvas(document, 'final', named);
    expect(canvas.main[0]).toMatchObject({ italic: true, font: 'Liberation Serif', bold: false });
    expect(canonicalDocument(canvasToDocument(canvas, document, id))).toBe(
      canonicalDocument(document),
    );
  });
});
