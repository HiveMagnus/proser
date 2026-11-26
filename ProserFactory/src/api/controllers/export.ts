import { documentAuthorityEnabled } from '@/documents/capabilities';
import { exportCanonicalBook } from '@/documents/publication';
import { DocumentError } from '@/documents/errors';
import { publicationOptionsSchema } from '@/documents/publicationValidation';
import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { databaseService } from '../../lib/database';
import { NotFoundError, ValidationError } from '../../lib/errors';
import logger from '../../lib/logger';
import { respondSuccess } from '../utils/response';
import { createHash } from 'node:crypto';
function escapeHtml(str: string) { return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)); }

export class ExportController {
  static async exportBook(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const bookId = parseInt(req.params.bookId);
      const signal = req.operationSignal;
      signal?.throwIfAborted();
      const format = (req.query.format as string) || 'markdown';
      const includeCodex = req.query.includeCodex === 'true' || req.query.includeCodex === '1';
      const includeMetadata = req.query.includeMetadata === 'true' || req.query.includeMetadata === '1';
      const includeSummaries = req.query.includeSummaries === 'true' || req.query.includeSummaries === '1';
      const download = req.query.download === 'true' || req.query.download === '1';
      const hasExtras = includeCodex || includeMetadata || includeSummaries;
      if (documentAuthorityEnabled()) {
        if (hasExtras) throw new DocumentError('PUBLICATION_OPTIONS_UNSUPPORTED', 'Legacy codex/metadata/summary injection is not supported by the canonical export. Use saved front/back matter.', 409);
        const options = publicationOptionsSchema.parse({ format: format === 'txt' ? 'text' : format, mode: req.query.mode ?? 'final', preset: req.query.preset ?? 'saved' });
        const result = await exportCanonicalBook(userId, bookId, options.format, { mode: options.mode, preset: options.preset, operationId: typeof req.query.operationId === 'string' ? req.query.operationId : undefined, expectedRevisionId: typeof req.query.expectedRevisionId === 'string' ? req.query.expectedRevisionId : undefined });
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Source-Revision', result.job.sourceRevisionId);
        res.setHeader('X-Publication-Job-Id', result.job.id);
        res.setHeader('X-Content-Sha256', result.artifact.sha256);
        if (download || ['docx', 'epub', 'pdf'].includes(options.format)) {
          res.setHeader('Content-Type', result.artifact.mediaType);
          res.setHeader('Content-Disposition', `attachment; filename="${result.artifact.filename}"`);
          res.send(Buffer.from(result.artifact.bytes));
        } else respondSuccess(res, { format: options.format, content: Buffer.from(result.artifact.bytes).toString('utf8'), jobId: result.job.id, artifactId: result.artifact.id, sourceRevisionId: result.job.sourceRevisionId, fidelity: (result.artifact.provenance as { fidelity?: unknown }).fidelity });
        return;
      }


      // Explicitly reject PDF as an unsupported query option unless later enabled path handles it
  if (format === 'pdf') throw new ValidationError('Unsupported format');
      const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
  if (!book) throw new NotFoundError('Book not found');
      signal?.throwIfAborted();

      const acts = await databaseService.client.act.findMany({ where: { bookId }, orderBy: { actNumber: 'asc' }, include: { chapters: { orderBy: { chapterNumber: 'asc' }, include: { scenes: { where: { deletedAt: null }, orderBy: { sceneNumber: 'asc' } } } } } });

      // Fetch codex entries if requested
      let codexEntries: Array<{ entryType: string; entryName: string; entryDescription: string | null }> = [];
      if (includeCodex) {
        codexEntries = await databaseService.client.codexEntry.findMany({
          where: { bookId, deletedAt: null },
          orderBy: [{ entryType: 'asc' }, { entryName: 'asc' }],
          select: { entryType: true, entryName: true, entryDescription: true },
        });
      }
  let output = '';
      if (format === 'markdown') {
        output += `# ${book.title || 'Untitled Book'}\n\n`;
        if (includeMetadata) {
          if (book.genre) output += `**Genre:** ${book.genre}\n\n`;
          if (book.targetAudience) output += `**Target Audience:** ${book.targetAudience}\n\n`;
          if (book.summary) output += `**Summary:** ${book.summary}\n\n`;
          output += '---\n\n';
        }
        for (const act of acts) {
          output += `## Act ${act.actNumber}${act.title ? ': ' + act.title : ''}\n\n`;
          if (includeSummaries && act.summary) output += `*${act.summary}*\n\n`;
          for (const chapter of act.chapters) {
            output += `### Chapter ${chapter.chapterNumber}${chapter.title ? ': ' + chapter.title : ''}\n\n`;
            if (includeSummaries && chapter.summary) output += `*${chapter.summary}*\n\n`;
            for (const scene of chapter.scenes) {
              output += `#### Scene ${chapter.chapterNumber}.${scene.sceneNumber}\n\n`;
              if (includeSummaries && scene.summary) output += `> ${scene.summary}\n\n`;
              if (scene.prose) output += scene.prose + '\n\n';
            }
          }
        }
        if (includeCodex && codexEntries.length > 0) {
          output += '---\n\n## Codex\n\n';
          let lastType = '';
          for (const entry of codexEntries) {
            if (entry.entryType !== lastType) {
              output += `### ${entry.entryType.charAt(0).toUpperCase() + entry.entryType.slice(1)}s\n\n`;
              lastType = entry.entryType;
            }
            output += `**${entry.entryName}**`;
            if (entry.entryDescription) output += `: ${entry.entryDescription}`;
            output += '\n\n';
          }
        }
  } else if (format === 'html') {
  const safeTitle = book.title || 'Untitled Book';
  output += `<html><head><meta charset=\"utf-8\"/><title>${escapeHtml(safeTitle)}</title></head><body>`;
  output += `<h1>${escapeHtml(safeTitle)}</h1>`;
        if (includeMetadata) {
          output += '<div class="metadata">';
          if (book.genre) output += `<p><strong>Genre:</strong> ${escapeHtml(book.genre)}</p>`;
          if (book.targetAudience) output += `<p><strong>Target Audience:</strong> ${escapeHtml(book.targetAudience)}</p>`;
          if (book.summary) output += `<p><strong>Summary:</strong> ${escapeHtml(book.summary)}</p>`;
          output += '<hr/></div>';
        }
        for (const act of acts) {
          output += `<h2>Act ${act.actNumber}${act.title ? ': ' + escapeHtml(act.title) : ''}</h2>`;
          if (includeSummaries && act.summary) output += `<p><em>${escapeHtml(act.summary)}</em></p>`;
          for (const chapter of act.chapters) {
            output += `<h3>Chapter ${chapter.chapterNumber}${chapter.title ? ': ' + escapeHtml(chapter.title) : ''}</h3>`;
            if (includeSummaries && chapter.summary) output += `<p><em>${escapeHtml(chapter.summary)}</em></p>`;
            for (const scene of chapter.scenes) {
              output += `<h4>Scene ${chapter.chapterNumber}.${scene.sceneNumber}</h4>`;
              if (includeSummaries && scene.summary) output += `<blockquote>${escapeHtml(scene.summary)}</blockquote>`;
              if (scene.prose) output += `<p>${escapeHtml(scene.prose).replace(/\n+/g, '<br/>')}</p>`;
            }
          }
        }
        if (includeCodex && codexEntries.length > 0) {
          output += '<hr/><h2>Codex</h2>';
          let lastType = '';
          for (const entry of codexEntries) {
            if (entry.entryType !== lastType) {
              output += `<h3>${escapeHtml(entry.entryType.charAt(0).toUpperCase() + entry.entryType.slice(1))}s</h3>`;
              lastType = entry.entryType;
            }
            output += `<p><strong>${escapeHtml(entry.entryName)}</strong>`;
            if (entry.entryDescription) output += `: ${escapeHtml(entry.entryDescription)}`;
            output += '</p>';
          }
        }
        output += '</body></html>';
  } else if (format === 'rtf') {
        const esc = (s: string) => s.replace(/[\\{}]/g, m => '\\' + m).replace(/\n/g, '\\par ');
        output += `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}`;
  output += `\\f0\\fs36 ${esc(book.title || 'Untitled Book')}\\par `;
        if (includeMetadata) {
          if (book.genre) output += `\\fs20 Genre: ${esc(book.genre)}\\par `;
          if (book.targetAudience) output += `\\fs20 Target Audience: ${esc(book.targetAudience)}\\par `;
          if (book.summary) output += `\\fs20 Summary: ${esc(book.summary)}\\par `;
        }
        for (const act of acts) {
          output += `\\fs28 Act ${act.actNumber}${act.title ? ': ' + esc(act.title) : ''}\\par `;
          if (includeSummaries && act.summary) output += `\\fs18\\i ${esc(act.summary)}\\i0\\par `;
          for (const chapter of act.chapters) {
            output += `\\fs24 Chapter ${chapter.chapterNumber}${chapter.title ? ': ' + esc(chapter.title) : ''}\\par `;
            if (includeSummaries && chapter.summary) output += `\\fs18\\i ${esc(chapter.summary)}\\i0\\par `;
            for (const scene of chapter.scenes) {
              output += `\\fs20 Scene ${chapter.chapterNumber}.${scene.sceneNumber}\\par `;
              if (includeSummaries && scene.summary) output += `\\fs18\\i ${esc(scene.summary)}\\i0\\par `;
              if (scene.prose) output += esc(scene.prose) + '\\par ';
            }
          }
        }
        output += '}';
  } else {
        throw new ValidationError('Unsupported format');
      }
  // Manuscript text stays out of shared caches; the digest lets a client skip an unchanged body.
  const etag = `"${createHash('sha256').update(output).digest('base64url')}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
  const payload = { format, content: output };
  signal?.throwIfAborted();
  if (download) {
    const mimeTypes: Record<string, string> = { markdown: 'text/markdown', html: 'text/html', rtf: 'application/rtf' };
    const exts: Record<string, string> = { markdown: 'md', html: 'html', rtf: 'rtf' };
    const filename = (book.title || 'book').replace(/[^a-z0-9]+/gi, '_') + '.' + (exts[format] || 'txt');
    res.setHeader('Content-Type', mimeTypes[format] || 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(output);
    return;
  }
  respondSuccess(res, payload);
    } catch (error) {
      logger.error({ error, bookId: req.params.bookId, userId: req.user?.id }, 'Failed to export book');
      throw error;
    }
  }
}
