import { randomUUID } from 'node:crypto';
import { documentAuthorityEnabled } from '@/documents/capabilities';
import type { CommandModule } from 'yargs';
import { output } from '../utils/output';
import { initDatabase, closeDatabase, getDb } from '../utils/database';
import { resolveCliUser } from '../auth';
import { ValidationError } from '@/lib/errors';
import logger from '@/lib/logger';

interface CreateArgs {
  prompt: string;
  genre?: string;
  title?: string;
  'user-id'?: number;
  'operation-id'?: string;
  json: boolean;
}

export const createCommand: CommandModule<object, CreateArgs> = {
  command: 'create <prompt>',
  describe: 'Create a new book from an initial prompt',
  builder: (yargs) =>
    yargs
      .positional('prompt', {
        describe: 'Initial story prompt or concept',
        type: 'string',
        demandOption: true,
      })
      .option('genre', {
        alias: 'g',
        describe: 'Story genre (e.g., fantasy, sci-fi, mystery)',
        type: 'string',
      })
      .option('title', {
        alias: 't',
        describe: 'Book title (default: auto-generated)',
        type: 'string',
      })
      .option('user-id', {
        alias: 'u',
        describe: 'User ID to own the book (auto-creates CLI user if omitted)',
        type: 'number',
      })
      .option('operation-id', { describe: 'Stable creation UUID; retain it to recover an interrupted creation', type: 'string' })
      .option('json', {
        describe: 'Output result as JSON',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    const operationId = argv['operation-id'] ?? randomUUID();
    try {
      await initDatabase();

      if (!argv.json) {
        output.section('Creating New Book');
        output.info(`Prompt: ${argv.prompt}`);
        if (argv.genre) output.data('Genre', argv.genre);
        output.newline();
      }

      const db = getDb();

      if (!argv.prompt || argv.prompt.trim().length < 10) {
        throw new ValidationError('Prompt must be at least 10 characters long');
      }

      if (!argv.json) {
        output.startSpinner('Creating book record...');
      }

      // Resolve or create CLI user
      const { id: userId } = await resolveCliUser(db, argv['user-id']);

      if (!argv.json) output.data('Operation', operationId);
      const data = { title: argv.title || `Untitled - ${new Date().toISOString().split('T')[0]}`, summary: argv.prompt, genre: argv.genre || 'fiction' };
      const book = documentAuthorityEnabled() ? await (await import('@/services/booksService')).booksService.createBook(userId, data, operationId) : await db.book.create({
        data: {
          userId,
          title: argv.title || `Untitled - ${new Date().toISOString().split('T')[0]}`,
          summary: argv.prompt,
          genre: argv.genre || 'fiction',
          draftStatus: 'draft',
        },
      });

      if (!argv.json) {
        output.succeedSpinner('Book created successfully!');
        output.newline();
        output.section('Book Details');
        output.data('ID', book.id);
        output.data('Title', book.title ?? 'Untitled');
        output.data('Genre', book.genre || 'N/A');
        output.newline();
        output.success('Next steps:');
        output.info(`  1. Generate outline: proser-cli outline ${book.id}`);
        output.info(`  2. Create characters: proser-cli characters ${book.id}`);
        output.info(`  3. Generate scenes: proser-cli generate ${book.id}`);
      } else {
        output.json({
          success: true,
          operationId,
          book: {
            id: book.id,
            title: book.title,
            genre: book.genre,
          },
        });
      }
    } catch (error) {
      if (!argv.json) {
        output.failSpinner();
        if (error instanceof ValidationError) {
          output.error(error.message);
        } else {
          output.error(`Failed to create book: ${error instanceof Error ? error.message : 'Unknown error'}`);
          logger.error({ error }, 'Create command failed');
        }
      } else {
        output.json({
          success: false,
          operationId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      process.exit(1);
    } finally {
      await closeDatabase();
    }
  },
};
