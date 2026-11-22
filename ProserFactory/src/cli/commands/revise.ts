import { randomUUID } from 'node:crypto';
import type { CommandModule } from 'yargs';
import { Prisma } from '@prisma/client';
import { output } from '../utils/output';
import { initDatabase, closeDatabase, getDb } from '../utils/database';
import type { SkillFinding } from '@/lib/skills/types';
import { NotFoundError } from '@/lib/errors';
import { SceneProseService } from '@/services/sceneProseService';
import logger from '@/lib/logger';
import { resolveCliUser } from '../auth';
import { scenesService } from '@/services/scenesService';
import { reviseOwnedOperatorScene } from '@/documents/operatorCommands';
import { compatibilityOperationId } from '@/documents/operationIdentity';
import { documentAuthorityEnabled, documentService } from '@/documents/service';

interface ReviseArgs {
  bookId: number;
  'scene-id'?: number;
  'user-id'?: number;
  'operation-id'?: string;
  instruction?: string;
  json: boolean;
}

export const reviseCommand: CommandModule<object, ReviseArgs> = {
  command: 'revise <bookId>',
  describe: 'Revise scenes based on skill findings or custom instructions',
  builder: (yargs) =>
    yargs
      .positional('bookId', {
        describe: 'Book ID',
        type: 'number',
        demandOption: true,
      })
      .option('user-id', { describe: 'Explicit local operator user ID (defaults to the CLI account)', type: 'number' })
      .option('operation-id', { describe: 'Stable revision UUID (single scene) or batch UUID; recover it before retrying.', type: 'string' })
      .option('scene-id', {
        alias: 's',
        describe: 'Revise specific scene (otherwise revises scenes with issues)',
        type: 'number',
      })
      .option('instruction', {
        alias: 'i',
        describe: 'Custom revision instruction',
        type: 'string',
      })
      .option('json', {
        describe: 'Output result as JSON',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    const batchOperationId = argv['operation-id'] ?? randomUUID();
    try {
      await initDatabase();

      const db = getDb();
      const id = argv.bookId;

      const { id: userId } = await resolveCliUser(db, argv['user-id']);
      const book = await db.book.findFirst({ where: { id, userId } });
      if (!book) {
        throw new NotFoundError(`Book with ID ${id} not found`);
      }

      const proseService = SceneProseService.getInstance();

      let scenesToRevise: Array<{ id: number; label: string; prose: string }> = [];

      if(documentAuthorityEnabled()){
        const manifest=await documentService.manifest(userId,id);
        const findings=argv['scene-id']?undefined:await db.skillRun.findMany({where:{bookId:id,findings:{not:Prisma.DbNull}},select:{sceneId:true}});
        const selected=findings?new Set(findings.flatMap((finding)=>finding.sceneId===null?[]:[finding.sceneId])):new Set([argv['scene-id']!]);
        scenesToRevise=manifest.scenes.filter((scene)=>!scene.deletedAt&&scene.wordCount>0&&selected.has(scene.sceneId)).map((scene)=>({id:scene.sceneId,label:`Scene ${scene.sceneNumber}`,prose:''}));
        if(argv['scene-id']&&!scenesToRevise.length)throw new NotFoundError(`Scene with ID ${argv['scene-id']} not found or has no prose`);
      } else if (argv['scene-id']) {
        const sceneId = argv['scene-id'];
        const scene = await db.scene.findFirst({ where: { id: sceneId, chapter: { act: { bookId: id } } } });

        if (!scene || !scene.prose) {
          throw new NotFoundError(`Scene with ID ${sceneId} not found or has no prose`);
        }

        scenesToRevise = [{ id: scene.id, label: `Scene ${scene.sceneNumber}`, prose: scene.prose }];
      } else {
        // Get scenes with skill findings (SkillRun has no scene relation, query separately)
        const skillRuns = await db.skillRun.findMany({
          where: { bookId: id, findings: { not: Prisma.DbNull } },
        });

        const sceneIds = [...new Set(
          skillRuns
            .filter((r: { sceneId: number | null }) => r.sceneId != null)
            .map((r: { sceneId: number | null }) => r.sceneId as number)
        )];

        if (sceneIds.length > 0) {
          const scenes = await db.scene.findMany({ where: { id: { in: sceneIds }, chapter: { act: { bookId: id } } } });
          for (const scene of scenes) {
            if (scene.prose) {
              scenesToRevise.push({ id: scene.id, label: `Scene ${scene.sceneNumber}`, prose: scene.prose });
            }
          }
        }
      }

      if (scenesToRevise.length === 0) {
        if (!argv.json) {
          output.warning('No scenes to revise. Run review first or specify a scene ID.');
        } else {
          output.json({ success: true, message: 'No scenes to revise', scenesRevised: 0 });
        }
        return;
      }

      if (!argv.json) {
        output.section('Revising Scenes');
        output.data('Book', book.title ?? 'Untitled');
        output.data('Scenes to Revise', scenesToRevise.length);
        if (argv.instruction) output.data('Custom Instruction', argv.instruction);
        output.newline();
      }

      const results = [];
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < scenesToRevise.length; i++) {
        const scene = scenesToRevise[i];

        if (!argv.json) {
          output.startSpinner(`[${i + 1}/${scenesToRevise.length}] Revising: ${scene.label}`);
        }

        const operationId = argv['scene-id'] ? batchOperationId : compatibilityOperationId('proser.cli-revise-batch.v1', { batchOperationId, sceneId: scene.id });
        try {
          if (documentAuthorityEnabled()) {
            if (!argv.json) output.data('Operation', operationId);
            const saved = await reviseOwnedOperatorScene(userId, { bookId: id, sceneId: scene.id, operationId, instruction: argv.instruction });
            if (!argv.json) output.succeedSpinner(`Revised: ${scene.label}`);
            results.push({ sceneId: scene.id, label: scene.label, success: true, operationId, documentRevision: saved.documentRevision });
            successCount++; continue;
          }
          const skillRun = await db.skillRun.findFirst({
            where: { sceneId: scene.id, findings: { not: Prisma.DbNull } },
            orderBy: { createdAt: 'desc' },
          });

          const findings = (skillRun?.findings as SkillFinding[] | undefined) || [];
          const instruction = argv.instruction || 'Revise based on quality findings';

          const result = await proseService.reviseFromFindings(scene.prose, findings, { instruction });

          const saved = await scenesService.updateSceneProse(userId, scene.id, { prose: result.revised });

          if (!argv.json) output.succeedSpinner(`Revised: ${scene.label}`);
          results.push({ sceneId: scene.id, label: scene.label, success: true, documentRevision: saved.documentRevision });
          successCount++;
        } catch (error) {
          if (!argv.json) {
            output.failSpinner(`Failed: ${scene.label}`);
            logger.error({ error, sceneId: scene.id }, 'Scene revision failed');
          }
          results.push({ sceneId: scene.id, label: scene.label, success: false, operationId, error: error instanceof Error ? error.message : 'Unknown error' });
          failCount++;
        }
      }

      if (!argv.json) {
        output.newline();
        output.section('Revision Complete');
        output.success(`Successfully revised: ${successCount} scenes`);
        if (failCount > 0) output.error(`Failed: ${failCount} scenes`);
        output.newline();
        output.success('Next steps:');
        output.info(`  1. Review again: proser-cli review ${book.id}`);
        output.info(`  2. Export manuscript: proser-cli export ${book.id}`);
      } else {
        output.json({ success: true, scenesRevised: successCount, scenesFailed: failCount, results });
      }
    } catch (error) {
      if (!argv.json) {
        output.failSpinner();
        if (error instanceof NotFoundError) {
          output.error(error.message);
        } else {
          output.error(`Failed to revise: ${error instanceof Error ? error.message : 'Unknown error'}`);
          logger.error({ error }, 'Revise command failed');
        }
      } else {
        output.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  },
};
