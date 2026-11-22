import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SemanticDocument } from '../components/semantic-document';
import { documentFromText, regenerateDocumentText } from '../document-model';

describe('semantic document rendering', () => {
  it('retains table topology, stable cell identities, headings, lists and authenticated image paths', () => {
    let sequence = 0;
    const id = () => `semantic-${++sequence}`;
    const document = documentFromText('Heading\n\nFirst\n\nSecond', id);
    const heading = document.blocks[0];
    const first = document.blocks[1];
    const second = document.blocks[2];
    if (
      heading?.type !== 'paragraph' ||
      first?.type !== 'paragraph' ||
      second?.type !== 'paragraph'
    )
      throw new Error('fixture');
    heading.style.heading = 2;
    heading.runs[0]!.style.bold = true;
    first.style.list = 'number';
    second.style.list = 'number';
    const cell = documentFromText('Cell 😀 e\u0301', id).blocks[0];
    if (cell?.type !== 'paragraph') throw new Error('fixture');
    document.blocks.push({
      type: 'table',
      id: id(),
      widths: [100],
      rows: [{ id: id(), cells: [{ id: 'owned-cell', paragraphs: [cell] }] }],
    });
    document.blocks.push({
      type: 'image',
      id: id(),
      assetId: 42,
      sha256: 'a'.repeat(64),
      alt: 'Protected image',
      width: 100,
      height: 50,
    });
    const html = renderToStaticMarkup(<SemanticDocument document={document} />);
    expect(html).toContain('<h2');
    expect(html).toContain('font-weight:bold');
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain('<table');
    expect(html).toContain('data-cell-id="owned-cell"');
    expect(html).toContain('Cell 😀 e\u0301');
    expect(html).toContain('src="/api/images/42/content"');
    expect(html).toContain('alt="Protected image"');
  });
  it('escapes text and refuses active hyperlinks while rendering supported review projections', () => {
    let sequence = 0;
    const id = () => `review-${++sequence}`;
    const document = regenerateDocumentText(
      documentFromText('Before <script>alert(1)</script>', id),
      'After',
      id,
      {
        authorId: 1,
        authorName: 'Author',
        createdAt: '2026-10-05T12:00:00Z',
        origin: 'ai',
        status: 'pending',
      },
    );
    const before = document.blocks[0];
    if (before?.type !== 'paragraph') throw new Error('fixture');
    before.runs[0]!.style.hyperlink = 'javascript:alert(1)';
    const final = renderToStaticMarkup(<SemanticDocument document={document} />);
    const original = renderToStaticMarkup(<SemanticDocument document={document} view="original" />);
    const markup = renderToStaticMarkup(<SemanticDocument document={document} view="markup" />);
    expect(final).toContain('After');
    expect(final).not.toContain('Before');
    expect(original).toContain('&lt;script&gt;');
    expect(original).not.toContain('href=');
    expect(original).not.toContain('After');
    expect(markup).toContain('<del');
    expect(markup).toContain('<ins');
  });
});
