import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SemanticDocument } from '../components/semantic-document';
import { documentFromText, projectDocument, type DocumentParagraph } from '../document-model';
import { documentToCanvas, canvasToDocument } from '../canvas-adapter';
import { paragraphSelection } from '../document-selection';
let sequence = 0;
const id = () => `inline-${++sequence}`;
describe('protected inline images', () => {
  it('retains paragraph/run order, asset digest, dimensions and Unicode offsets across Canvas and semantic modes', () => {
    const document = documentFromText('Before', id);
    const paragraph = document.blocks[0] as DocumentParagraph;
    paragraph.runs.push(
      {
        id: 'inline-image',
        text: '',
        style: {},
        inlineImage: {
          assetId: 42,
          sha256: 'a'.repeat(64),
          alt: 'Image <safe>',
          width: 80,
          height: 40,
        },
      },
      { id: 'after', text: '😀 After', style: { italic: true } },
    );
    const data = documentToCanvas(document);
    expect(data.main[1]).toMatchObject({
      type: 'image',
      id: 'inline-image',
      value: '/api/images/42/content',
      width: 80,
      height: 40,
    });
    expect(canvasToDocument(data, document, id)).toEqual(document);
    expect(projectDocument(document).text).toBe('Before\ufffc😀 After');
    const html = renderToStaticMarkup(<SemanticDocument document={document} />);
    expect(html).toContain('src="/api/images/42/content"');
    expect(html).toContain('alt="Image &lt;safe&gt;"');
    expect(html.indexOf('Before')).toBeLessThan(html.indexOf('inline-image'));
    expect(html.indexOf('inline-image')).toBeLessThan(html.indexOf('😀 After'));
    expect(() => paragraphSelection(document, paragraph.id, 5, 9, 'Before\ufffc😀 After')).toThrow(
      'protected inline image',
    );
    expect(
      paragraphSelection(document, paragraph.id, 7, 9, 'Before\ufffc😀 After')?.targets[0]
        ?.sourceText,
    ).toBe('😀');
  });
});
