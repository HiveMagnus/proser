/**
 * Export service — generates manuscript output in various formats.
 *
 * Extracted from the CLI export command to be reusable by both CLI and API.
 * @module services/exportService
 */

/** A loaded book with full act → chapter → scene tree (loosely typed for flexibility). */
export interface BookTree {
  title: string | null;
  summary?: string | null;
  genre?: string | null;
  acts: Array<{
    actNumber: number;
    title?: string | null;
    summary?: string | null;
    chapters: Array<{
      chapterNumber: number;
      title?: string | null;
      summary?: string | null;
      scenes: Array<{
        sceneNumber: number;
        outline?: string | null;
        summary?: string | null;
        prose?: string | null;
      }>;
    }>;
  }>;
}

/** Sanitise a string for use as a filename. */
export function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').toLowerCase();
}

/** Generate a Markdown manuscript. */
export function generateMarkdown(book: BookTree): string {
  const bookTitle = book.title ?? 'Untitled';
  let md = `# ${bookTitle}\n\n`;
  if (book.summary) md += `${book.summary}\n\n`;
  md += `---\n\n`;

  for (const act of book.acts) {
    md += `# Act ${act.actNumber}: ${act.title || 'Untitled'}\n\n`;
    if (act.summary) md += `${act.summary}\n\n`;

    for (const chapter of act.chapters) {
      md += `## Chapter ${chapter.chapterNumber}: ${chapter.title || 'Untitled'}\n\n`;
      if (chapter.summary) md += `*${chapter.summary}*\n\n`;

      for (const scene of chapter.scenes) {
        if (scene.prose) md += `${scene.prose}\n\n`;
      }
    }
  }
  return md;
}

/** Generate a plain-text manuscript. */
export function generatePlainText(book: BookTree): string {
  const bookTitle = book.title ?? 'Untitled';
  let txt = `${bookTitle}\n${'='.repeat(bookTitle.length)}\n\n`;
  if (book.summary) txt += `${book.summary}\n\n`;

  for (const act of book.acts) {
    txt += `\n\nACT ${act.actNumber}: ${act.title || 'Untitled'}\n${'-'.repeat(40)}\n\n`;

    for (const chapter of act.chapters) {
      txt += `\nChapter ${chapter.chapterNumber}: ${chapter.title || 'Untitled'}\n\n`;

      for (const scene of chapter.scenes) {
        if (scene.prose) txt += `${scene.prose}\n\n`;
      }
    }
  }
  return txt;
}

/** Generate an HTML manuscript (for EPUB and web preview). */
export function generateHtml(book: BookTree): string {
  const bookTitle = book.title ?? 'Untitled';
  const parts: string[] = [];

  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en"><head>');
  parts.push(`<meta charset="UTF-8"><title>${escapeHtml(bookTitle)}</title>`);
  parts.push('<style>');
  parts.push('body { font-family: Georgia, serif; max-width: 42em; margin: 2em auto; line-height: 1.7; color: #222; }');
  parts.push('h1 { text-align: center; margin-top: 2em; }');
  parts.push('h2 { border-bottom: 1px solid #ccc; padding-bottom: 0.3em; margin-top: 2em; }');
  parts.push('.summary { font-style: italic; color: #555; margin-bottom: 1em; }');
  parts.push('p { text-indent: 1.5em; margin: 0.5em 0; }');
  parts.push('</style></head><body>');

  parts.push(`<h1>${escapeHtml(bookTitle)}</h1>`);
  if (book.summary) parts.push(`<div class="summary">${escapeHtml(book.summary)}</div>`);
  parts.push('<hr>');

  for (const act of book.acts) {
    parts.push(`<h1>Act ${act.actNumber}: ${escapeHtml(act.title || 'Untitled')}</h1>`);
    if (act.summary) parts.push(`<div class="summary">${escapeHtml(act.summary)}</div>`);

    for (const chapter of act.chapters) {
      parts.push(`<h2>Chapter ${chapter.chapterNumber}: ${escapeHtml(chapter.title || 'Untitled')}</h2>`);
      if (chapter.summary) parts.push(`<div class="summary">${escapeHtml(chapter.summary)}</div>`);

      for (const scene of chapter.scenes) {
        if (scene.prose) {
          // Convert prose paragraphs to <p> tags
          const paragraphs = scene.prose.split(/\n{2,}/);
          for (const para of paragraphs) {
            const trimmed = para.trim();
            if (trimmed) parts.push(`<p>${escapeHtml(trimmed)}</p>`);
          }
        }
      }
    }
  }

  parts.push('</body></html>');
  return parts.join('\n');
}

/** Generate a structured JSON export. */
export function generateJsonExport(book: BookTree): string {
  return JSON.stringify(
    {
      title: book.title ?? 'Untitled',
      summary: book.summary,
      genre: book.genre,
      acts: book.acts.map((act) => ({
        number: act.actNumber,
        title: act.title,
        summary: act.summary,
        chapters: act.chapters.map((ch) => ({
          number: ch.chapterNumber,
          title: ch.title,
          summary: ch.summary,
          scenes: ch.scenes.map((s) => ({
            number: s.sceneNumber,
            outline: s.outline,
            summary: s.summary,
            prose: s.prose,
          })),
        })),
      })),
    },
    null,
    2,
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
