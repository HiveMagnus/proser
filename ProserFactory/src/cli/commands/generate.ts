import { randomUUID } from 'node:crypto';
import { resolveCliUser } from '../auth';
import { documentAuthorityEnabled, documentService } from '@/documents/service';
import { generateOwnedScene, recoverSceneGeneration } from '@/documents/generation';
import type { CommandModule } from 'yargs';
import { output } from '../utils/output';
import { initDatabase, closeDatabase, getDb } from '../utils/database';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { SceneProseService } from '@/services/sceneProseService';
import logger from '@/lib/logger';

interface GenerateArgs {
  bookId: number;
  'scene-id'?: number;
  'user-id'?: number;
  'operation-id'?: string;
  'use-rag': boolean;
  json: boolean;
}

export const generateCommand: CommandModule<object, GenerateArgs> = {
  command: 'generate <bookId>',
  describe: 'Generate prose for scenes',
  builder: (yargs) =>
    yargs
      .positional('bookId', {
        describe: 'Book ID',
        type: 'number',
        demandOption: true,
      })
      .option('scene-id', {
        alias: 's',
        describe: 'Generate specific scene (otherwise generates all)',
        type: 'number',
      })
      .option('use-rag', {
        describe: 'Use RAG for context-aware generation',
        type: 'boolean',
        default: true,
      })
      .option('user-id', { describe: 'Explicit local operator user ID', type: 'number' })
      .option('operation-id', { describe: 'Recoverable generation UUID (requires --scene-id)', type: 'string' })
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

      const { id: userId } = await resolveCliUser(db, argv['user-id']);
      const book = await db.book.findFirst({
        where: { id, userId },
        include: {
          acts: {
            include: {
              chapters: {
                include: { scenes: true },
              },
            },
          },
        },
      });

      if (!book) {
        throw new NotFoundError(`Book with ID ${id} not found`);
      }

      if (argv['operation-id'] && !argv['scene-id']) throw new ValidationError('--operation-id requires --scene-id');
      const proseService = SceneProseService.getInstance();

      let scenesToGenerate: Array<{
        id: number;
        label: string;
        actNumber: number;
        chapterNumber: number;
        sceneNumber: number;
      }> = [];

      if (argv['scene-id']) {
        const sceneId = argv['scene-id'];
        const scene = await db.scene.findFirst({
          where: { id: sceneId, chapter: { act: { bookId: id } } },
          include: {
            chapter: { include: { act: true } },
          },
        });

        if (!scene) {
          throw new NotFoundError(`Scene with ID ${sceneId} not found`);
        }

        scenesToGenerate = [
          {
            id: scene.id,
            label: `Scene ${scene.sceneNumber}`,
            actNumber: scene.chapter.act.actNumber,
            chapterNumber: scene.chapter.chapterNumber,
            sceneNumber: scene.sceneNumber,
          },
        ];
      } else {
        for (const act of book.acts) {
          for (const chapter of act.chapters) {
            for (const scene of chapter.scenes) {
              if (!scene.prose || scene.prose.trim().length === 0) {
                scenesToGenerate.push({
                  id: scene.id,
                  label: `Scene ${scene.sceneNumber}`,
                  actNumber: act.actNumber,
                  chapterNumber: chapter.chapterNumber,
                  sceneNumber: scene.sceneNumber,
                });
              }
            }
          }
        }
      }

      if (scenesToGenerate.length === 0) {
        if (!argv.json) {
          output.warning('All scenes already have prose.');
          output.info('Use --scene-id to regenerate a specific scene.');
        } else {
          output.json({ success: true, message: 'All scenes already have prose', scenesGenerated: 0 });
        }
        return;
      }

      if (!argv.json) {
        output.section('Generating Prose');
        output.data('Book', book.title ?? 'Untitled');
        output.data('Scenes to Generate', String(scenesToGenerate.length));
        output.data('RAG Enabled', String(argv['use-rag']));
        output.newline();
      }

      const results = [];
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < scenesToGenerate.length; i++) {
        const scene = scenesToGenerate[i];

        if (!argv.json) {
          output.startSpinner(
            `[${i + 1}/${scenesToGenerate.length}] Generating Act ${scene.actNumber}, Ch ${scene.chapterNumber}, Scene ${scene.sceneNumber}`
          );
        }

        const operationId = argv['operation-id'] ?? randomUUID();
        if (!argv.json && documentAuthorityEnabled()) output.data('Operation', operationId);
        try {
          if (documentAuthorityEnabled()) {
            const retained = argv['operation-id'] && await db.documentInferenceOperation.findFirst({ where: { id: operationId, bookId: id, userId }, select: { id: true } });
            const source = await documentService.read(userId, id, scene.id);
            const saved = retained ? await recoverSceneGeneration(userId, id, scene.id, operationId, argv['use-rag']) : await generateOwnedScene(userId, { bookId: id, sceneId: scene.id, expected: { operationId, expectedRevisionId: source.bookRevisionId, expectedSceneRevisionId: source.revisionId, expectedScopes: {} }, context: { bookId: id, sceneId: scene.id, title: book.title ?? 'Untitled', useCodexRAG: argv['use-rag'] } });
            results.push({ sceneId: scene.id, label: scene.label, wordCount: saved.generation.wordCount, operationId: saved.operationId, documentRevision: saved.scene.documentRevision, success: true }); successCount++;
            if (!argv.json) output.succeedSpinner(`Generated ${saved.generation.wordCount} words for ${scene.label}`);
            continue;
          }
          const result = await proseService.generateProse({
            bookId: id,
            sceneId: scene.id,
            title: book.title ?? 'Untitled',
            useCodexRAG: argv['use-rag'],
          });

          if (!argv.json) {
            output.succeedSpinner(`Generated ${result.wordCount} words for ${scene.label}`);
          }

          results.push({ sceneId: scene.id, label: scene.label, wordCount: result.wordCount, success: true });
          successCount++;
        } catch (error) {
          if (!argv.json) {
            output.failSpinner(`Failed: ${scene.label}`);
            logger.error({ error, sceneId: scene.id }, 'Scene generation failed');
          }
          results.push({ sceneId: scene.id, label: scene.label, success: false, operationId, error: error instanceof Error ? error.message : 'Unknown error' });
          failCount++;
        }
      }

      if (!argv.json) {
        output.newline();
        output.section('Generation Complete');
        output.success(`Successfully generated: ${successCount} scenes`);
        if (failCount > 0) output.error(`Failed: ${failCount} scenes`);
        output.newline();
        output.success('Next steps:');
        output.info(`  1. Review quality: proser-cli review ${book.id}`);
        output.info(`  2. Check status: proser-cli status ${book.id}`);
        output.info(`  3. Export manuscript: proser-cli export ${book.id}`);
      } else {
        output.json({ success: true, scenesGenerated: successCount, scenesFailed: failCount, results });
      }
    } catch (error) {
      if (!argv.json) {
        output.failSpinner();
        if (error instanceof NotFoundError) {
          output.error(error.message);
        } else {
          output.error(`Failed to generate prose: ${error instanceof Error ? error.message : 'Unknown error'}`);
          logger.error({ error }, 'Generate command failed');
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
