/**
 * EPUB generation service — produces styled .epub files using the archiver library.
 *
 * An EPUB is a ZIP file with a specific structure:
 *   mimetype (uncompressed)
 *   META-INF/container.xml
 *   OEBPS/content.opf
 *   OEBPS/toc.ncx
 *   OEBPS/style.css
 *   OEBPS/title.xhtml
 *   OEBPS/chapter-*.xhtml
 *
 * @module services/epubService
 */

import { createZipBuffer, type ZipEntry } from '@/lib/zipArchive';
import type { BookTree } from './exportService';

/** Metadata for the EPUB. */
export interface EpubMetadata {
  title: string;
  author?: string;
  language?: string;
  genre?: string;
  description?: string;
  /** UUID for the book identifier. Auto-generated if omitted. */
  uuid?: string;
}

/**
 * Generate a styled EPUB buffer from a book tree.
 *
 * @param book     - The full book structure with acts/chapters/scenes.
 * @param metadata - EPUB metadata (title, author, etc.).
 * @returns A Buffer containing the .epub file.
 */
export async function generateEpub(book: BookTree, metadata: EpubMetadata): Promise<Buffer> {
  const uuid = metadata.uuid ?? crypto.randomUUID();
  const title = metadata.title || book.title || 'Untitled';
  const author = metadata.author ?? 'Proser AI';
  const lang = metadata.language ?? 'en';

  // Collect chapters as flat list for manifest/spine
  const chapters: Array<{
    id: string;
    filename: string;
    label: string;
    html: string;
  }> = [];

  for (const act of book.acts) {
    for (const chapter of act.chapters) {
      const chNum = chapter.chapterNumber;
      const chTitle = chapter.title || `Chapter ${chNum}`;
      const id = `chapter-${chNum}`;
      const filename = `${id}.xhtml`;

      let body = `<h2>${escapeHtml(chTitle)}</h2>\n`;
      if (chapter.summary) {
        body += `<p class="summary">${escapeHtml(chapter.summary)}</p>\n`;
      }
      for (const scene of chapter.scenes) {
        if (scene.prose) {
          for (const para of scene.prose.split(/\n{2,}/)) {
            const t = para.trim();
            if (t) body += `<p>${escapeHtml(t)}</p>\n`;
          }
        }
      }

      chapters.push({
        id,
        filename,
        label: `Chapter ${chNum}: ${chTitle}`,
        html: wrapXhtml(chTitle, body),
      });
    }
  }

  const entries: ZipEntry[] = [];
  // mimetype must be first and uncompressed
  entries.push({ name: 'mimetype', content: 'application/epub+zip', store: true });

  // META-INF/container.xml
  entries.push({ name: 'META-INF/container.xml', content: containerXml() });

  // OEBPS/style.css
  entries.push({ name: 'OEBPS/style.css', content: styleCss() });

  // OEBPS/title.xhtml
  entries.push({
    name: 'OEBPS/title.xhtml',
    content: titlePage(title, author, metadata.genre, book.summary ?? undefined),
  });

  // OEBPS/chapter-*.xhtml
  for (const ch of chapters) {
    entries.push({ name: `OEBPS/${ch.filename}`, content: ch.html });
  }

  // OEBPS/content.opf
  entries.push({
    name: 'OEBPS/content.opf',
    content: contentOpf(uuid, title, author, lang, chapters),
  });

  // OEBPS/toc.ncx
  entries.push({ name: 'OEBPS/toc.ncx', content: tocNcx(uuid, title, chapters) });
  return createZipBuffer(entries);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function contentOpf(
  uuid: string,
  title: string,
  author: string,
  lang: string,
  chapters: Array<{ id: string; filename: string }>,
): string {
  const manifestItems = [
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="style" href="style.css" media-type="text/css"/>',
    '<item id="title-page" href="title.xhtml" media-type="application/xhtml+xml"/>',
    ...chapters.map((c) => `<item id="${c.id}" href="${c.filename}" media-type="application/xhtml+xml"/>`),
  ].join('\n    ');

  const spineItems = [
    '<itemref idref="title-page"/>',
    ...chapters.map((c) => `<itemref idref="${c.id}"/>`),
  ].join('\n    ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="BookId">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeHtml(title)}</dc:title>
    <dc:creator opf:role="aut">${escapeHtml(author)}</dc:creator>
    <dc:language>${lang}</dc:language>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`;
}

function tocNcx(uuid: string, title: string, chapters: Array<{ id: string; filename: string; label: string }>): string {
  const navPoints = chapters
    .map(
      (c, i) => `    <navPoint id="navpoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeHtml(c.label)}</text></navLabel>
      <content src="${c.filename}"/>
    </navPoint>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeHtml(title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`;
}

function styleCss(): string {
  return `/* Proser EPUB Stylesheet */
body {
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.7;
  color: #222;
  margin: 1em;
}
h1 {
  text-align: center;
  font-size: 2em;
  margin-top: 2em;
  margin-bottom: 0.5em;
}
h2 {
  font-size: 1.4em;
  border-bottom: 1px solid #ccc;
  padding-bottom: 0.3em;
  margin-top: 2em;
}
p {
  text-indent: 1.5em;
  margin: 0.5em 0;
}
p.summary {
  font-style: italic;
  color: #555;
  text-indent: 0;
  margin-bottom: 1em;
}
.title-page {
  text-align: center;
  margin-top: 30%;
}
.title-page h1 {
  font-size: 2.5em;
  margin-bottom: 0.5em;
}
.title-page .author {
  font-size: 1.2em;
  color: #555;
}
.title-page .genre {
  font-size: 0.9em;
  color: #888;
  margin-top: 1em;
}
.title-page .synopsis {
  font-style: italic;
  color: #444;
  margin-top: 2em;
  text-align: left;
  max-width: 30em;
  margin-left: auto;
  margin-right: auto;
}`;
}

function titlePage(title: string, author: string, genre?: string, synopsis?: string): string {
  let body = '<div class="title-page">\n';
  body += `<h1>${escapeHtml(title)}</h1>\n`;
  body += `<p class="author">by ${escapeHtml(author)}</p>\n`;
  if (genre) body += `<p class="genre">${escapeHtml(genre)}</p>\n`;
  if (synopsis) body += `<p class="synopsis">${escapeHtml(synopsis)}</p>\n`;
  body += '</div>';
  return wrapXhtml(title, body);
}

function wrapXhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>`;
}
