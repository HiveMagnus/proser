import type { CommandModule } from 'yargs';
import { output } from '../utils/output';
import { initDatabase, closeDatabase, getDb } from '../utils/database';
import { resolveCliUser } from '../auth';
import logger from '@/lib/logger';
import {documentAuthorityEnabled} from '@/documents/service';
import {readCanonicalBookProjection} from '@/documents/readProjection';

interface ListArgs {
  'user-id'?: number;
  json: boolean;
}

export const listCommand: CommandModule<object, ListArgs> = {
  command: 'list',
  describe: 'List books for the CLI user (or a specified user)',
  builder: (yargs) =>
    yargs
      .option('user-id', {
        alias: 'u',
        describe: 'User ID to list books for (defaults to CLI user)',
        type: 'number',
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

      const { id: userId } = await resolveCliUser(db, argv['user-id']);

      const rows: Array<{id:number;title:string;genre:string;status:string;scenes:number;progress:number;wordCount?:number;sourceBookRevisionId?:string;contentHash?:string;projection?:'final'}> = [];
      if (documentAuthorityEnabled()) {
        const identities = await db.book.findMany({where:{userId,deletedAt:null},select:{id:true},orderBy:{updatedAt:'desc'}});
        for (const identity of identities) {
          const book = await readCanonicalBookProjection(userId, identity.id, {includeNotes:false});
          const scenes = book.acts.flatMap((act)=>act.chapters.flatMap((chapter)=>chapter.scenes));
          const written = scenes.filter((scene)=>scene.hasProse).length;
          rows.push({id:book.id,title:book.title??'Untitled',genre:book.genre??'N/A',status:book.draftStatus??'draft',scenes:scenes.length,progress:scenes.length?Number((written/scenes.length*100).toFixed(1)):0,wordCount:book.wordCount,sourceBookRevisionId:book.sourceBookRevisionId,contentHash:book.contentHash,projection:'final'});
        }
      } else {
      const books = await db.book.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        include: {
          acts: {
            include: {
              chapters: {
                include: {
                  scenes: {
                    select: { prose: true },
                  },
                },
              },
            },
          },
        },
      });

      rows.push(...books.map((book) => {
        const totalScenes = book.acts.reduce(
          (sum: number, act) => sum + act.chapters.reduce((chSum: number, ch) => chSum + ch.scenes.length, 0),
          0,
        );
        const scenesWithProse = book.acts.reduce(
          (sum: number, act) =>
            sum +
            act.chapters.reduce(
              (chSum: number, ch) =>
                chSum + ch.scenes.filter((s) => typeof s.prose === 'string' && s.prose.trim().length > 0).length,
              0,
            ),
          0,
        );
        const progress = totalScenes > 0 ? Number(((scenesWithProse / totalScenes) * 100).toFixed(1)) : 0;

        return {
          id: book.id,
          title: book.title ?? 'Untitled',
          genre: book.genre ?? 'N/A',
          status: book.draftStatus ?? 'draft',
          scenes: totalScenes,
          progress,
        };
      }));
      }

      if (argv.json) {
        output.json({
          success: true,
          userId,
          count: rows.length,
          books: rows,
        });
        return;
      }

      output.section(`Books (${rows.length})`);
      if (rows.length === 0) {
        output.info('No books found for this user.');
        return;
      }

      output.table(
        rows.map((row) => ({
          ID: row.id,
          Title: row.title,
          Genre: row.genre,
          Status: row.status,
          Scenes: row.scenes,
          'Progress %': `${row.progress.toFixed(1)}%`,
        })),
      );
    } catch (error) {
      if (!argv.json) {
        output.error(`Failed to list books: ${error instanceof Error ? error.message : 'Unknown error'}`);
        logger.error({ error }, 'List command failed');
      } else {
        output.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      process.exit(1);
    } finally {
      await closeDatabase();
    }
  },
};
