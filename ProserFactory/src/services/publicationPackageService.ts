import { databaseService } from '@/lib/database';
import { documentAuthorityEnabled } from '@/documents/capabilities';
import { createPublicationJob, runPublicationJob, readPublicationArtifact as readCanonicalPublicationArtifact } from '@/documents/publication';
import { compatibilityOperationId } from '@/documents/operationIdentity';
import { DocumentError } from '@/documents/errors';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createZipBuffer } from '@/lib/zipArchive';
import { generateEpub } from '@/services/epubService';
import { generateHtml, generateMarkdown, sanitizeFilename, type BookTree } from '@/services/exportService';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function zip(entries: Array<{ name: string; content: string | Buffer; store?: boolean }>): Promise<Buffer> {
  return createZipBuffer(entries);
}

function docxParagraph(text: string, style?: string): string {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

async function generateDocx(book: BookTree): Promise<Buffer> {
  const body: string[] = [docxParagraph(book.title ?? 'Untitled', 'Title')];
  if (book.summary) body.push(docxParagraph(book.summary));
  for (const act of book.acts) {
    body.push(docxParagraph(`Act ${act.actNumber}: ${act.title || 'Untitled'}`, 'Heading1'));
    for (const chapter of act.chapters) {
      body.push(docxParagraph(`Chapter ${chapter.chapterNumber}: ${chapter.title || 'Untitled'}`, 'Heading2'));
      for (const scene of chapter.scenes) {
        for (const paragraph of (scene.prose ?? '').split(/\n{2,}/).map((value) => value.trim()).filter(Boolean)) body.push(docxParagraph(paragraph));
      }
    }
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr/></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style></w:styles>`;
  return zip([
    { name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>` },
    { name: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', content: document },
    { name: 'word/styles.xml', content: styles },
    { name: 'word/_rels/document.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
  ]);
}

export interface PublicationArtifact {
  filename: string;
  format: 'markdown' | 'epub' | 'docx' | 'html' | 'pdf' | 'text' | 'json' | 'metadata' | 'cover-spec' | 'front-matter' | 'back-matter';
  mediaType: string;
  bytes: number;
  sha256: string;
}

export async function createPublicationPackage(runId: string, revisionId: string, book: BookTree, metadata: { author?: string; audience?: string; pov?: string; tense?: string }) {
  if (documentAuthorityEnabled()) {
    const run = await databaseService.client.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new DocumentError('PUBLICATION_NOT_FOUND', 'Workflow publication authority is unavailable.', 404);
    const owner = await databaseService.client.book.findUnique({ where: { id: run.bookId }, select: { userId: true } });
    if (!owner) throw new DocumentError('PUBLICATION_NOT_FOUND', 'Publication book is unavailable.', 404);
    const artifacts: PublicationArtifact[] = [];
    for (const format of ['docx', 'epub', 'pdf', 'html', 'markdown', 'text', 'json'] as const) {
      const operationId = compatibilityOperationId('proser.workflow-publication.v1', { runId, revisionId, format });
      const job = await createPublicationJob(owner.userId, run.bookId, { operationId, expectedRevisionId: revisionId, options: { format, mode: 'final', preset: 'saved' } });
      const result = job.status === 'completed' ? job : await runPublicationJob(owner.userId, run.bookId, job.id);
      if (result.status !== 'completed' || !result.artifactId) throw new DocumentError('WORKFLOW_PUBLICATION_FAILED', `Publication ${format} job ${job.id} failed: ${result.errorMessage ?? result.status}`, 409);
      const artifact = await readCanonicalPublicationArtifact(owner.userId, run.bookId, result.artifactId);
      artifacts.push({ filename: `${artifact.id}.${format}`, format, mediaType: artifact.mediaType, bytes: artifact.byteLength, sha256: artifact.sha256 });
    }
    return { root: 'document-authority', directory: `document-publications:${owner.userId}:${run.bookId}`, manifest: { revisionId, artifacts }, validation: { pass: true, checks: artifacts.map((artifact) => ({ check: `canonical_${artifact.format}`, pass: true })) } };
  }
  const root = path.resolve(process.env.PUBLICATION_DIR ?? path.join(process.cwd(), 'data', 'publications'));
  const directory = path.join(root, runId);
  await mkdir(directory, { recursive: true });
  const base = sanitizeFilename(book.title ?? 'untitled') || 'untitled';
  const markdown = generateMarkdown(book);
  const html = generateHtml(book);
  const epub = await generateEpub(book, { title: book.title ?? 'Untitled', author: metadata.author, genre: book.genre ?? undefined, description: book.summary ?? undefined });
  const docx = await generateDocx(book);
  const metadataDocument = JSON.stringify({ title: book.title ?? 'Untitled', author: metadata.author ?? 'Proser Author', genre: book.genre, audience: metadata.audience, pov: metadata.pov, tense: metadata.tense, description: book.summary, language: 'en', revisionId }, null, 2);
  const coverSpec = `# Cover specification\n\nTitle: ${book.title ?? 'Untitled'}\n\nGenre: ${book.genre ?? 'Fiction'}\n\nAudience: ${metadata.audience ?? 'Adult'}\n\nCreative direction: A market-appropriate cover that communicates the central premise without depicting a generic manuscript or quill. Preserve clear thumbnail readability and reserve space for author credit.\n`;
  const frontMatter = `# ${book.title ?? 'Untitled'}\n\n${metadata.author ?? 'Proser Author'}\n\n---\n\nCopyright © ${new Date().getUTCFullYear()} ${metadata.author ?? 'Proser Author'}. All rights reserved.\n\n## Contents\n\n${book.acts.flatMap((act) => act.chapters.map((chapter) => `- Chapter ${chapter.chapterNumber}: ${chapter.title || 'Untitled'}`)).join('\n')}\n`;
  const backMatter = `# About this edition\n\nGenre: ${book.genre ?? 'Fiction'}\n\n${book.summary ?? ''}\n\n## Acknowledgments\n\nAuthor acknowledgments to be supplied before distribution.\n\n## About the author\n\nAuthor biography to be supplied before distribution.\n`;
  const outputs: Array<{ filename: string; format: PublicationArtifact['format']; mediaType: string; content: string | Buffer }> = [
    { filename: `${base}.md`, format: 'markdown', mediaType: 'text/markdown', content: markdown },
    { filename: `${base}.epub`, format: 'epub', mediaType: 'application/epub+zip', content: epub },
    { filename: `${base}.docx`, format: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: docx },
    { filename: `${base}.html`, format: 'html', mediaType: 'text/html', content: html },
    { filename: `${base}-metadata.json`, format: 'metadata', mediaType: 'application/json', content: metadataDocument },
    { filename: `${base}-cover-spec.md`, format: 'cover-spec', mediaType: 'text/markdown', content: coverSpec },
    { filename: `${base}-front-matter.md`, format: 'front-matter', mediaType: 'text/markdown', content: frontMatter },
    { filename: `${base}-back-matter.md`, format: 'back-matter', mediaType: 'text/markdown', content: backMatter },
  ];
  const artifacts: PublicationArtifact[] = [];
  for (const output of outputs) {
    const content = Buffer.isBuffer(output.content) ? output.content : Buffer.from(output.content, 'utf8');
    await writeFile(path.join(directory, output.filename), content);
    artifacts.push({ filename: output.filename, format: output.format, mediaType: output.mediaType, bytes: content.byteLength, sha256: hash(content) });
  }
  const expectedChapters = book.acts.reduce((sum, act) => sum + act.chapters.length, 0);
  const checks = [
    { check: 'markdown_chapters', pass: (markdown.match(/^## Chapter /gm) ?? []).length === expectedChapters },
    { check: 'epub_signature', pass: epub.subarray(0, 2).toString() === 'PK' && epub.includes(Buffer.from('application/epub+zip')) },
    { check: 'docx_signature', pass: docx.subarray(0, 2).toString() === 'PK' && docx.includes(Buffer.from('word/document.xml')) },
    { check: 'metadata_parse', pass: Boolean(JSON.parse(metadataDocument).title) },
    { check: 'all_nonempty', pass: artifacts.every((artifact) => artifact.bytes > 100) },
  ];
  return { root, directory, manifest: { revisionId, artifacts }, validation: { pass: checks.every((check) => check.pass), checks } };
}

export async function readPublicationArtifact(directory: string, filename: string): Promise<Buffer> {
  if (directory.startsWith('document-publications:')) {
    const match = /^document-publications:(\d+):(\d+)$/.exec(directory);
    const artifactId = filename.slice(0, filename.lastIndexOf('.'));
    if (!match || !/^[a-f0-9-]{36}$/.test(artifactId)) throw new DocumentError('PUBLICATION_NOT_FOUND', 'Invalid canonical artifact reference.', 404);
    return Buffer.from((await readCanonicalPublicationArtifact(Number(match[1]), Number(match[2]), artifactId)).bytes);
  }
  if (path.basename(filename) !== filename) throw new Error('Invalid publication filename');
  return readFile(path.join(directory, filename));
}
