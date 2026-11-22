import type { CommandModule } from 'yargs';
import { output } from '../utils/output';
import { initDatabase, closeDatabase, getDb } from '../utils/database';
import { NotFoundError } from '@/lib/errors';
import logger from '@/lib/logger';
import { randomUUID } from 'node:crypto';
import { resolveCliUser } from '../auth';
import { documentAuthorityEnabled } from '@/documents/capabilities';
import { ValidationError } from '@/lib/errors';

/* ------------------------------------------------------------------ */
/*  codex:list                                                         */
/* ------------------------------------------------------------------ */

interface CodexListArgs {
  bookId: number;
  'user-id'?: number;
  type: string | undefined;
  json: boolean;
}

export const codexListCommand: CommandModule<object, CodexListArgs> = {
  command: 'codex:list <bookId>',
  describe: 'List codex entries for a book',
  builder: (yargs) =>
    yargs
      .positional('bookId', {
        describe: 'Book ID',
        type: 'number',
        demandOption: true,
      })
      .option('type', {
        describe: 'Filter by entry type (e.g. character, location, item)',
        type: 'string',
      })
      .option('user-id', { describe: 'Explicit local operator user ID', type: 'number' })
      .option('json', {
        describe: 'Output result as JSON',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    try {
      await initDatabase();

      const db = getDb();
      const { id: userId } = await resolveCliUser(db, argv['user-id']);
      if (!await db.book.findFirst({ where: { id: argv.bookId, userId } })) throw new NotFoundError('Book not found');

      const where: Record<string, unknown> = { bookId: argv.bookId };
      if (argv.type) {
        where.entryType = argv.type;
      }

      const entries = await db.codexEntry.findMany({ where });

      if (!argv.json) {
        if (entries.length === 0) {
          output.info('No codex entries found.');
        } else {
          output.section(`Codex Entries (${entries.length})`);
          for (const entry of entries) {
            output.data(
              `[${entry.entryType}] ${entry.entryName}`,
              entry.entryDescription
                ? entry.entryDescription.substring(0, 80) + (entry.entryDescription.length > 80 ? '…' : '')
                : '(no description)'
            );
          }
        }
      } else {
        output.json({
          success: true,
          entries: entries.map((e) => ({
            id: e.id,
            entryType: e.entryType,
            entryName: e.entryName,
            entryDescription: e.entryDescription,
          })),
        });
      }
    } catch (error) {
      if (!argv.json) {
        output.error(`Failed to list codex entries: ${error instanceof Error ? error.message : 'Unknown error'}`);
        logger.error({ error }, 'Codex list command failed');
      } else {
        output.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      process.exit(1);
    } finally {
      await closeDatabase();
    }
  },
};

/* ------------------------------------------------------------------ */
/*  codex:add                                                          */
/* ------------------------------------------------------------------ */

interface CodexAddArgs {
  bookId: number;
  'user-id'?: number;
  'operation-id'?: string;
  'expected-revision'?: string;
  'expected-canon'?: string;
  name: string;
  description: string;
  type: string;
  json: boolean;
}

export const codexAddCommand: CommandModule<object, CodexAddArgs> = {
  command: 'codex:add <bookId> <name> <description>',
  describe: 'Add a codex entry to a book',
  builder: (yargs) =>
    yargs
      .positional('bookId', {
        describe: 'Book ID',
        type: 'number',
        demandOption: true,
      })
      .positional('name', {
        describe: 'Entry name',
        type: 'string',
        demandOption: true,
      })
      .positional('description', {
        describe: 'Entry description',
        type: 'string',
        demandOption: true,
      })
      .option('type', {
        describe: 'Entry type (character, location, item, etc.)',
        type: 'string',
        default: 'character',
      })
      .option('user-id', { describe: 'Explicit local operator user ID', type: 'number' })
      .option('operation-id', { describe: 'Recoverable save UUID; retain its exact revision preconditions', type: 'string' })
      .option('expected-revision', { describe: 'Expected book revision UUID', type: 'string' })
      .option('expected-canon', { describe: 'Expected canon revision UUID', type: 'string' })
      .option('json', {
        describe: 'Output result as JSON',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    try {
      await initDatabase();

      const db = getDb();

      // Verify book exists
      const { id: userId } = await resolveCliUser(db, argv['user-id']);
      const book = await db.book.findFirst({ where: { id: argv.bookId, userId } });
      if (!book) {
        throw new NotFoundError(`Book with ID ${argv.bookId} not found`);
      }

      const data = { entryType: argv.type, entryName: argv.name, entryDescription: argv.description };
      let expected;
      if (documentAuthorityEnabled()) {
        if (argv['operation-id'] && (!argv['expected-revision'] || !argv['expected-canon'])) throw new ValidationError('Recovering an operation requires --expected-revision and --expected-canon from its original command.');
        const { documentService } = await import('@/documents/service');
        const head = await documentService.manifest(userId, argv.bookId);
        expected = { operationId: argv['operation-id'] ?? randomUUID(), expectedRevisionId: argv['expected-revision'] ?? head.revisionId, expectedScopes: { canon: argv['expected-canon'] ?? head.scopes!.canon.revisionId } };
        if (!argv.json) output.data('Save preconditions', JSON.stringify(expected));
      }
      const entry = expected ? await (await import('@/services/codexService')).codexService.createEntry(userId, argv.bookId, data, expected) : await db.codexEntry.create({
        data: {
          bookId: argv.bookId,
          entryType: argv.type,
          entryName: argv.name,
          entryDescription: argv.description,
        },
      });

      if (!argv.json) {
        output.success(`Codex entry created: [${entry.entryType}] ${entry.entryName} (ID: ${entry.id})`);
      } else {
        output.json({
          success: true,
          documentPreconditions: expected,
          entry: {
            id: entry.id,
            entryType: entry.entryType,
            entryName: entry.entryName,
            entryDescription: entry.entryDescription,
          },
        });
      }
    } catch (error) {
      if (!argv.json) {
        if (error instanceof NotFoundError) {
          output.error(error.message);
        } else {
          output.error(`Failed to add codex entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
          logger.error({ error }, 'Codex add command failed');
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
