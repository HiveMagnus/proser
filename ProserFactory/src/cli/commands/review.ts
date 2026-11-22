import { createHash } from 'node:crypto';
import { resolveCliUser } from '../auth';
import { documentAuthorityEnabled, documentService, DocumentError } from '@/documents/service';
import type { SkillInput } from '@/lib/skills/types';
import type { CommandModule } from 'yargs';
import { output } from '../utils/output';
import { initDatabase, closeDatabase, getDb } from '../utils/database';
import { NotFoundError } from '@/lib/errors';
import type { SkillFinding } from '@/lib/skills/types';
import { runSkills } from '@/lib/skills';
import logger from '@/lib/logger';
import {readCanonicalBookProjection} from '@/documents/readProjection';

interface ReviewArgs {
  bookId: number;
  'scene-id'?: number;
  'user-id'?: number;
  json: boolean;
}

export const reviewCommand: CommandModule<object, ReviewArgs> = {
  command: 'review <bookId>',
  describe: 'Run quality analysis skills on generated prose',
  builder: (yargs) =>
    yargs
      .positional('bookId', {
        describe: 'Book ID',
        type: 'number',
        demandOption: true,
      })
      .option('user-id', { describe: 'Explicit local operator user ID', type: 'number' })
      .option('scene-id', {
        alias: 's',
        describe: 'Review specific scene (otherwise reviews all)',
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
      const id = argv.bookId;

      const { id: userId } = await resolveCliUser(db, argv['user-id']);
      const book = documentAuthorityEnabled() ? await readCanonicalBookProjection(userId, id, {includeNotes:false}) : await db.book.findFirst({
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

      const sourceManifest = documentAuthorityEnabled() ? await documentService.manifest(userId, id) : undefined;
      if(sourceManifest&&'sourceBookRevisionId' in book&&book.sourceBookRevisionId!==sourceManifest.revisionId)throw new DocumentError('DOCUMENT_SOURCE_STALE','Book changed before review navigation was frozen.',412);
      const sourceStructure = sourceManifest ? await documentService.scope(userId, id, 'structure') : undefined;
      if (sourceStructure && sourceStructure.bookRevisionId !== sourceManifest!.revisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Book changed before review context was frozen.', 412);
      const contextBook = sourceStructure?.content.book ?? book;
      let scenesToReview: Array<{ id: number; label: string; prose: string }> = [];

      if (sourceManifest) {
        const selected = sourceManifest.scenes.filter((scene)=>!scene.deletedAt&&(!argv['scene-id']||scene.sceneId===argv['scene-id']));
        for(const scene of selected)if(scene.wordCount)scenesToReview.push({id:scene.sceneId,label:`Scene ${scene.sceneNumber}`,prose:''});
        if(argv['scene-id']&&!scenesToReview.length)throw new NotFoundError(`Scene with ID ${argv['scene-id']} not found or has no prose`);
      } else if (argv['scene-id']) {
        const sceneId = argv['scene-id'];
        const scene = await db.scene.findFirst({ where: { id: sceneId, chapter: { act: { bookId: id } } } });

        if (!scene || !scene.prose) {
          throw new NotFoundError(`Scene with ID ${sceneId} not found or has no prose`);
        }

        scenesToReview = [{ id: scene.id, label: `Scene ${scene.sceneNumber}`, prose: scene.prose }];
      } else {
        for (const act of book.acts) {
          for (const chapter of act.chapters) {
            for (const scene of chapter.scenes) {
              if (scene.prose && scene.prose.trim().length > 0) {
                scenesToReview.push({ id: scene.id, label: `Scene ${scene.sceneNumber}`, prose: scene.prose });
              }
            }
          }
        }
      }

      if (scenesToReview.length === 0) {
        if (!argv.json) {
          output.warning('No scenes with prose to review.');
        } else {
          output.json({ success: true, message: 'No scenes with prose to review', scenesReviewed: 0 });
        }
        return;
      }

      if (!argv.json) {
        output.section('Running Quality Analysis');
        output.data('Book', book.title ?? 'Untitled');
        output.data('Scenes to Review', scenesToReview.length);
        output.newline();
      }

      const allFindings: Array<{ sceneId: number; sceneLabel: string; findings?: SkillFinding[]; error?: string; documentSource?: SkillInput['documentSource'] }> = [];
      let totalIssues = 0;

      for (let i = 0; i < scenesToReview.length; i++) {
        const scene = scenesToReview[i];

        if (!argv.json) {
          output.startSpinner(`[${i + 1}/${scenesToReview.length}] Analyzing: ${scene.label}`);
        }

        try {
          const source = sourceManifest ? await documentService.read(userId, id, scene.id) : undefined;
          if (source && source.bookRevisionId !== sourceManifest!.revisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Frozen book review source changed; no target was silently rebased.', 412);
          const documentSource: SkillInput['documentSource'] = source ? { bookRevisionId: source.bookRevisionId, sceneRevisionId: source.revisionId, contentHash: source.contentHash, projection: 'final', projectionSha256: createHash('sha256').update(source.projection.text).digest('hex') } : undefined;
          const skillResults = await runSkills({
            documentSource,
            bookId: id,
            sceneId: scene.id,
            prose: source?.projection.text ?? scene.prose,
            title: contextBook.title ?? 'Untitled',
            genre: contextBook.genre || undefined,
          });

          if (skillResults.results.some((result) => result.status !== 'completed')) throw new DocumentError('DOCUMENT_REVIEW_INCOMPLETE', 'One or more critics failed; this review does not establish a clean result.', 409);
          const findings = skillResults.results.flatMap((r) => r.findings || []);
          totalIssues += findings.length;

          if (!argv.json) {
            if (findings.length === 0) {
              output.succeedSpinner(`${scene.label} - No issues found`);
            } else {
              output.succeedSpinner(`${scene.label} - ${findings.length} issue(s) found`);
            }
          }

          allFindings.push({ sceneId: scene.id, sceneLabel: scene.label, findings, documentSource });
        } catch (error) {
          if (!argv.json) {
            output.failSpinner(`Failed to review: ${scene.label}`);
            logger.error({ error, sceneId: scene.id }, 'Scene review failed');
          }
          allFindings.push({ sceneId: scene.id, sceneLabel: scene.label, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      }

      if (!argv.json) {
        output.newline();
        output.section('Review Results');
        output.data('Scenes Reviewed', scenesToReview.length);
        output.data('Total Issues', totalIssues);
        output.newline();

        if (totalIssues > 0) {
          output.section('Issues Found');
          allFindings.forEach((result) => {
            if (result.findings && result.findings.length > 0) {
              output.info(`${result.sceneLabel}:`);
              result.findings.forEach((finding) => {
                output.warning(`  - [${finding.severity}] ${finding.message}`);
              });
            }
          });
          output.newline();
          output.success('Next steps:');
          output.info(`  1. Revise scenes: proser-cli revise ${book.id}`);
        } else {
          output.success('All scenes passed quality checks!');
          output.info(`  Next: proser-cli export ${book.id}`);
        }
      } else {
        output.json({ success: allFindings.every((result) => !result.error), scenesReviewed: scenesToReview.length, scenesFailed: allFindings.filter((result) => result.error).length, totalIssues, findings: allFindings });
      }
    } catch (error) {
      if (!argv.json) {
        output.failSpinner();
        if (error instanceof NotFoundError) {
          output.error(error.message);
        } else {
          output.error(`Failed to review: ${error instanceof Error ? error.message : 'Unknown error'}`);
          logger.error({ error }, 'Review command failed');
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
