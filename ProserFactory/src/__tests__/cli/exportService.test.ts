/// <reference types="jest" />

import {
  generateMarkdown,
  generatePlainText,
  generateJsonExport,
  generateHtml,
  sanitizeFilename,
} from '../../services/exportService';
import { generateEpub } from '../../services/epubService';

const sampleBook = {
  title: 'The <Great> Escape',
  summary: 'A short summary.',
  genre: 'thriller',
  acts: [
    {
      actNumber: 1,
      title: 'Beginning',
      chapters: [
        {
          chapterNumber: 1,
          title: 'Arrival',
          scenes: [{ sceneNumber: 1, prose: 'First paragraph.\n\nSecond paragraph.' }],
        },
      ],
    },
  ],
};

describe('exportService', () => {
  it('sanitizes filename', () => {
    expect(sanitizeFilename('My Book: A Test!')).toBe('my_book_a_test_');
  });

  it('generates markdown/plain/json/html outputs', () => {
    const md = generateMarkdown(sampleBook as any);
    const txt = generatePlainText(sampleBook as any);
    const json = generateJsonExport(sampleBook as any);
    const html = generateHtml(sampleBook as any);

    expect(md).toContain('# The <Great> Escape');
    expect(txt).toContain('ACT 1: Beginning');
    expect(JSON.parse(json).acts[0].chapters[0].title).toBe('Arrival');
    expect(html).toContain('&lt;Great&gt; Escape');
    expect(html).toContain('<p>First paragraph.</p>');
  });

  it('generates an epub buffer', async () => {
    const buffer = await generateEpub(sampleBook as any, { title: 'The Great Escape', uuid: 'test-uuid' });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.byteLength).toBeGreaterThan(100);
  });
});
