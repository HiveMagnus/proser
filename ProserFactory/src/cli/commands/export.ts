import { resolveCliUser } from '../auth';
import { documentAuthorityEnabled } from '@/documents/capabilities';
import { exportCanonicalBook } from '@/documents/publication';
import type { CommandModule } from 'yargs';
import { output } from '../utils/output';
import { initDatabase, closeDatabase, getDb } from '../utils/database';
import { NotFoundError } from '@/lib/errors';
import {
  generateMarkdown,
  generatePlainText,
  generateHtml,
  generateJsonExport,
  sanitizeFilename,
} from '@/services/exportService';
import { generateEpub } from '@/services/epubService';
import * as fs from 'fs/promises';
import * as path from 'path';
import logger from '@/lib/logger';

type ExportFormat = 'markdown' | 'txt' | 'html' | 'epub' | 'json' | 'docx' | 'pdf';

interface ExportArgs {
  bookId: number;
  'output-dir': string;
  format: ExportFormat;
  json: boolean;
  mode:'final'|'original'|'retain-review';
  preset:'saved'|'submission-manuscript'|'print-book';
  'user-id'?: number;
  'operation-id'?: string;
  'expected-revision'?: string;
}

export const exportCommand: CommandModule<object, ExportArgs> = {
  command: 'export <bookId>',
  describe: 'Export book manuscript to file',
  builder: (yargs) =>
    yargs
      .positional('bookId', {
        describe: 'Book ID',
        type: 'number',
        demandOption: true,
      })
      .option('output-dir', {
        alias: 'o',
        describe: 'Output directory',
        type: 'string',
        default: './output',
      })
      .option('format', {
        alias: 'f',
        describe: 'Export format',
        type: 'string',
        choices: ['markdown', 'txt', 'html', 'epub', 'json', 'docx', 'pdf'] as const,
        default: 'markdown' as ExportFormat,
      })
      .option('mode',{type:'string',choices:['final','original','retain-review'] as const,default:'final' as const,describe:'Review projection; does not accept manuscript changes'})
      .option('preset',{type:'string',choices:['saved','submission-manuscript','print-book'] as const,default:'saved' as const,describe:'Publication layout preset'})
      .option('user-id', { type: 'number', describe: 'Authenticated local operator user ID' })
      .option('operation-id', { type: 'string', describe: 'Recover the exact publication operation UUID' })
      .option('expected-revision', { type: 'string', describe: 'Export this expected saved book revision' })
      .option('json', {
        describe: 'Output result as JSON',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    try {
      await initDatabase();

      const db = getDb();
      const id = argv.bookId;

      if (documentAuthorityEnabled()) {
        const user = await resolveCliUser(db, argv['user-id']);
        const result = await exportCanonicalBook(user.id, id, argv.format === 'txt' ? 'text' : argv.format, { operationId: argv['operation-id'], expectedRevisionId: argv['expected-revision'],mode:argv.mode,preset:argv.preset });
        const directory = path.resolve(argv['output-dir']);
        await fs.mkdir(directory, { recursive: true });
        const outputPath = path.join(directory, result.artifact.filename);
        await fs.writeFile(outputPath, result.artifact.bytes);
        const provenance=result.artifact.provenance as {fidelity?:{reviewSidecar?:unknown}};const sidecar=provenance.fidelity?.reviewSidecar;const reviewPath=sidecar?outputPath+'.review.json':undefined;if(reviewPath)await fs.writeFile(reviewPath,JSON.stringify(sidecar,null,2));
        if (argv.json) output.json({ success: true, file: outputPath, format: argv.format, size: result.artifact.byteLength, operationId: result.job.id, artifactId: result.artifact.id, sourceRevisionId: result.job.sourceRevisionId, sha256: result.artifact.sha256, mode:argv.mode,preset:argv.preset,fidelity:result.job.fidelity,reviewPath });
        else {output.success(`Exported ${outputPath} from revision ${result.job.sourceRevisionId} (job ${result.job.id})`);for(const loss of result.job.fidelity?.losses??[])output.warning(loss);for(const font of result.job.fidelity?.fontSubstitutions??[])output.warning(`Font ${font.requested} rendered as ${font.actual}.`);if(reviewPath)output.data('Review sidecar',reviewPath);}
        return;
      }
      const book = await db.book.findUnique({
        where: { id },
        include: {
          acts: {
            orderBy: { actNumber: 'asc' },
            include: {
              chapters: {
                orderBy: { chapterNumber: 'asc' },
                include: {
                  scenes: { orderBy: { sceneNumber: 'asc' } },
                },
              },
            },
          },
        },
      });

      if (!book) {
        throw new NotFoundError(`Book with ID ${id} not found`);
      }

      const bookTitle = book.title ?? 'Untitled';

      if (!argv.json) {
        output.section('Exporting Manuscript');
        output.data('Book', bookTitle);
        output.data('Format', argv.format);
        output.data('Output Directory', argv['output-dir']);
        output.newline();
        output.startSpinner('Generating export file...');
      }

      const outputDir = path.resolve(argv['output-dir']);
      await fs.mkdir(outputDir, { recursive: true });

      const bookTree = {
        title: book.title,
        summary: book.summary,
        genre: book.genre,
        acts: book.acts,
      };

      let content: string | Buffer = '';
      let filename = '';
      const format = argv.format;

      switch (format) {
        case 'markdown':
          content = generateMarkdown(bookTree);
          filename = `${sanitizeFilename(bookTitle)}.md`;
          break;
        case 'txt':
          content = generatePlainText(bookTree);
          filename = `${sanitizeFilename(bookTitle)}.txt`;
          break;
        case 'html':
          content = generateHtml(bookTree);
          filename = `${sanitizeFilename(bookTitle)}.html`;
          break;
        case 'epub':
          content = await generateEpub(bookTree, {
            title: bookTitle,
            genre: book.genre ?? undefined,
            description: book.summary ?? undefined,
          });
          filename = `${sanitizeFilename(bookTitle)}.epub`;
          break;
        case 'json':
          content = generateJsonExport(bookTree);
          filename = `${sanitizeFilename(bookTitle)}.json`;
          break;
      }

      const outputPath = path.join(outputDir, filename);
      await fs.writeFile(outputPath, content, typeof content === 'string' ? 'utf-8' : undefined);

      const sizeBytes = typeof content === 'string' ? content.length : content.length;

      if (!argv.json) {
        output.succeedSpinner('Export complete!');
        output.newline();
        output.section('Export Details');
        output.data('File', outputPath);
        output.data('Size', `${(sizeBytes / 1024).toFixed(2)} KB`);
        output.newline();
        output.success('Manuscript exported successfully!');
      } else {
        output.json({ success: true, file: outputPath, format, size: sizeBytes });
      }
    } catch (error) {
      if (!argv.json) {
        output.failSpinner();
        if (error instanceof NotFoundError) {
          output.error(error.message);
        } else {
          output.error(`Failed to export: ${error instanceof Error ? error.message : 'Unknown error'}`);
          logger.error({ error }, 'Export command failed');
        }
      } else {
        output.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      process.exit(1);
    } finally {
      await closeDatabase();
    }
  },
};
