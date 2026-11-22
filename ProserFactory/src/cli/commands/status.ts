import type { CommandModule } from 'yargs';
import { output } from '../utils/output';
import { initDatabase, closeDatabase, getDb } from '../utils/database';
import { NotFoundError } from '@/lib/errors';
import logger from '@/lib/logger';

interface StatusArgs {
  bookId: number;
  json: boolean;
}

export const statusCommand: CommandModule<object, StatusArgs> = {
  command: 'status <bookId>',
  describe: 'Show book status and generation progress',
  builder: (yargs) =>
    yargs
      .positional('bookId', {
        describe: 'Book ID',
        type: 'number',
        demandOption: true,
      })
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

      const book = await db.book.findUnique({
        where: { id },
        include: {
          acts: {
            include: {
              chapters: {
                include: { scenes: true },
              },
            },
          },
          codexEntries: true,
        },
      });

      if (!book) {
        throw new NotFoundError(`Book with ID ${id} not found`);
      }

      const totalScenes = book.acts.reduce(
        (sum: number, act) =>
          sum + act.chapters.reduce((chSum: number, ch) => chSum + ch.scenes.length, 0),
        0
      );

      const scenesWithProse = book.acts.reduce(
        (sum: number, act) =>
          sum +
          act.chapters.reduce(
            (chSum: number, ch) =>
              chSum + ch.scenes.filter((s) => s.prose && s.prose.trim().length > 0).length,
            0
          ),
        0
      );

      const progress = totalScenes > 0 ? (scenesWithProse / totalScenes) * 100 : 0;

      if (!argv.json) {
        output.section('Book Status');
        output.data('ID', book.id);
        output.data('Title', book.title ?? 'Untitled');
        output.data('Genre', book.genre || 'N/A');
        output.data('Status', book.draftStatus ?? 'draft');
        output.newline();

        output.section('Structure');
        output.data('Acts', book.acts.length);
        output.data('Chapters', book.acts.reduce((sum: number, act) => sum + act.chapters.length, 0));
        output.data('Scenes', totalScenes);
        output.newline();

        output.section('Progress');
        output.data('Scenes Generated', `${scenesWithProse} / ${totalScenes}`);
        output.data('Completion', `${progress.toFixed(1)}%`);
        output.newline();

        output.section('Knowledge Base');
        output.data('Codex Entries', book.codexEntries.length);
      } else {
        output.json({
          success: true,
          book: {
            id: book.id,
            title: book.title ?? 'Untitled',
            genre: book.genre,
            draftStatus: book.draftStatus,
            structure: {
              acts: book.acts.length,
              chapters: book.acts.reduce((sum: number, act) => sum + act.chapters.length, 0),
              scenes: totalScenes,
            },
            progress: {
              scenesGenerated: scenesWithProse,
              totalScenes,
              percentage: progress,
            },
            codexEntries: book.codexEntries.length,
          },
        });
      }
    } catch (error) {
      if (!argv.json) {
        if (error instanceof NotFoundError) {
          output.error(error.message);
        } else {
          output.error(`Failed to get status: ${error instanceof Error ? error.message : 'Unknown error'}`);
          logger.error({ error }, 'Status command failed');
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
