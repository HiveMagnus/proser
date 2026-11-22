import { randomUUID } from 'node:crypto';
import { resolveCliUser } from '../auth';
import { documentAuthorityEnabled, documentService } from '@/documents/service';
import { commitOutline, type OutlineTree } from '@/documents/structureCommands';
import type { DocumentMutationPreconditions } from '@/documents/scope-model';
import type { CommandModule } from 'yargs';
import { output } from '../utils/output';
import { initDatabase, closeDatabase, getDb } from '../utils/database';
import { generateOwnedOperatorBookText } from '@/documents/operatorCommands';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { VllmService } from '@/lib/ai/vllm';
import logger from '@/lib/logger';
import { cleanTitle } from '@/lib/content/validators';

interface OutlineArgs {
  bookId: number;
  acts: number;
  'chapters-per-act': number;
  'scenes-per-chapter': number;
  json: boolean;
  'user-id'?: number;
  'operation-id'?: string;
}

/** Shape returned by AI for a single scene in the outline */
interface AiScene {
  title?: string;
  outline?: string;
  summary?: string;
}

/** Shape returned by AI for a single chapter in the outline */
interface AiChapter {
  title?: string;
  summary?: string;
  scenes?: AiScene[];
}

/** Shape returned by AI for a single act in the outline */
interface AiAct {
  title?: string;
  summary?: string;
  chapters?: AiChapter[];
}

/** Top-level shape returned by AI */
interface AiOutline {
  acts?: AiAct[];
}

/**
 * Attempt to extract a JSON object from an AI response that may contain
 * markdown fences, leading prose, or other noise around the JSON.
 */
function extractJson(text: string): string | null {
  // Try to find a fenced JSON block first
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  // Otherwise find the first { ... } or [ ... ] block
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const bracket = text[start];
  const close = bracket === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === bracket) depth++;
    else if (text[i] === close) depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Parse the AI response into an AiOutline. Returns null on failure.
 */
function parseOutlineResponse(raw: string): AiOutline | null {
  try {
    const jsonStr = extractJson(raw);
    if (!jsonStr) return null;
    const parsed = JSON.parse(jsonStr) as AiOutline;
    if (!parsed.acts || !Array.isArray(parsed.acts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const outlineCommand: CommandModule<object, OutlineArgs> = {
  command: 'outline <bookId>',
  describe: 'Generate story outline (acts, chapters, scenes)',
  builder: (yargs) =>
    yargs
      .positional('bookId', {
        describe: 'Book ID',
        type: 'number',
        demandOption: true,
      })
      .option('acts', {
        alias: 'a',
        describe: 'Number of acts',
        type: 'number',
        default: 3,
      })
      .option('chapters-per-act', {
        alias: 'c',
        describe: 'Chapters per act',
        type: 'number',
        default: 5,
      })
      .option('scenes-per-chapter', {
        alias: 's',
        describe: 'Scenes per chapter',
        type: 'number',
        default: 4,
      })
      .option('user-id', { describe: 'Explicit local operator user ID', type: 'number' })
      .option('operation-id', { describe: 'Stable outline commit UUID', type: 'string' })
      .option('json', {
        describe: 'Output result as JSON',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    const operationId = argv['operation-id'] ?? randomUUID();
    try {
      await initDatabase();

      const db = getDb();
      const id = argv.bookId;

      const { id: userId } = await resolveCliUser(db, argv['user-id']);
      const book = await db.book.findFirst({ where: { id, userId } });
      if (!book) {
        throw new NotFoundError(`Book with ID ${id} not found`);
      }

      const numActs = argv.acts;
      const chaptersPerAct = argv['chapters-per-act'];
      const scenesPerChapter = argv['scenes-per-chapter'];

      if (!argv.json) {
        output.section('Generating Outline');
        output.data('Book', book.title ?? 'Untitled');
        output.data('Acts', numActs);
        output.data('Chapters per Act', chaptersPerAct);
        output.data('Scenes per Chapter', scenesPerChapter);
        output.newline();
        output.startSpinner('Generating story structure...');
      }

      let expected: DocumentMutationPreconditions | undefined;
      if (documentAuthorityEnabled()) {
        const source = await documentService.manifest(userId, id);
        expected = { operationId, expectedRevisionId: source.revisionId, expectedScopes: { structure: source.scopes!.structure.revisionId } };
      }
      const ai = new VllmService();
      const promptForBook = (promptBook: { title: string | null; summary: string | null; genre: string | null }) => `Create a detailed ${numActs}-act story outline for the following book concept.

Title: ${promptBook.title ?? 'Untitled'}
Concept: ${promptBook.summary ?? 'No summary available'}
Genre: ${promptBook.genre || 'fiction'}

Requirements:
- Exactly ${numActs} acts
- Exactly ${chaptersPerAct} chapters per act
- Exactly ${scenesPerChapter} scenes per chapter

Return ONLY a JSON object with this exact structure (no other text):
{
  "acts": [
    {
      "title": "Act title",
      "summary": "Brief act summary",
      "chapters": [
        {
          "title": "Chapter title",
          "summary": "Brief chapter summary",
          "scenes": [
            {
              "title": "Scene title",
              "outline": "2-3 sentence scene outline describing what happens"
            }
          ]
        }
      ]
    }
  ]
}`;

      const generated = expected ? await generateOwnedOperatorBookText(userId, { bookId: id, operationId, kind: 'cli-outline', intent: { acts: numActs, chaptersPerAct, scenesPerChapter }, expectedRevisionId: expected.expectedRevisionId, makePrompt: promptForBook }) : undefined;
      if (generated) expected = generated.expected;
      const aiResponse = generated?.result.raw ?? await ai.generateText({ prompt: promptForBook(book) });
      const parsed = parseOutlineResponse(aiResponse);

      if (parsed && !argv.json) {
        output.updateSpinner('Creating book structure from AI outline...');
      } else if (!parsed && !argv.json) {
        output.updateSpinner('AI response could not be parsed as JSON — creating structure with placeholder names...');
        logger.warn('Failed to parse AI outline response, falling back to placeholders');
      }

      if (documentAuthorityEnabled()) {
        if (!parsed) throw new ValidationError('Outline output was invalid. Its exact provider response was retained; no hierarchy was invented.');
        const frozenBookTitle = generated ? generated.request.bookMetadata.title : book.title;
        const tree: OutlineTree = { acts: Array.from({ length: numActs }, (_, index) => {
          const act = parsed?.acts?.[index]; const number = index + 1;
          return { title: cleanTitle(act?.title || `Act ${number}`), summary: act?.summary || `Act ${number} of ${frozenBookTitle ?? 'Untitled'}`, chapters: Array.from({ length: chaptersPerAct }, (_, chapterIndex) => {
            const chapter = act?.chapters?.[chapterIndex]; const chapterNumber = chapterIndex + 1;
            return { title: cleanTitle(chapter?.title || `Chapter ${chapterNumber}`), summary: chapter?.summary || `Chapter ${chapterNumber} of Act ${number}`, scenes: Array.from({ length: scenesPerChapter }, (_, sceneIndex) => ({ outline: chapter?.scenes?.[sceneIndex]?.outline || chapter?.scenes?.[sceneIndex]?.summary || `Scene ${sceneIndex + 1} outline` })) };
          }) };
        }) };
        await commitOutline(userId, id, tree, expected, generated?.result);
      } else {
      // Create the structure in the database, using AI data when available
      for (let actNum = 1; actNum <= numActs; actNum++) {
        const aiAct = parsed?.acts?.[actNum - 1];
        const act = await db.act.create({
          data: {
            bookId: id,
            actNumber: actNum,
            title: cleanTitle(aiAct?.title || `Act ${actNum}`),
            summary: aiAct?.summary || `Act ${actNum} of ${book.title ?? 'Untitled'}`,
          },
        });

        for (let chNum = 1; chNum <= chaptersPerAct; chNum++) {
          const aiChapter = aiAct?.chapters?.[chNum - 1];
          const chapter = await db.chapter.create({
            data: {
              actId: act.id,
              chapterNumber: chNum,
              title: cleanTitle(aiChapter?.title || `Chapter ${chNum}`),
              summary: aiChapter?.summary || `Chapter ${chNum} of Act ${actNum}`,
            },
          });

          for (let sceneNum = 1; sceneNum <= scenesPerChapter; sceneNum++) {
            const aiScene = aiChapter?.scenes?.[sceneNum - 1];
            await db.scene.create({
              data: {
                chapterId: chapter.id,
                sceneNumber: sceneNum,
                outline: aiScene?.outline || aiScene?.summary || `Scene ${sceneNum} outline`,
              },
            });
          }
        }
      }

      }

      if (!argv.json) {
        output.succeedSpinner('Outline generated successfully!');
      }

      const updatedBook = await db.book.findUnique({
        where: { id },
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

      if (!updatedBook) {
        throw new NotFoundError('Book not found after outline generation');
      }

      if (!argv.json) {
        output.newline();
        output.section('Generated Structure');
        output.data('Title', updatedBook.title ?? 'Untitled');
        output.data('Acts', updatedBook.acts.length);
        output.newline();

        updatedBook.acts.forEach((act) => {
          output.info(`Act ${act.actNumber}: ${act.title || `Act ${act.actNumber}`}`);
          act.chapters.forEach((chapter) => {
            output.info(`  Chapter ${chapter.chapterNumber}: ${chapter.title || `Chapter ${chapter.chapterNumber}`} (${chapter.scenes.length} scenes)`);
          });
        });

        output.newline();
        output.success('Next steps:');
        output.info(`  1. Create characters: proser-cli characters ${book.id}`);
        output.info(`  2. Generate scenes: proser-cli generate ${book.id}`);
      } else {
        output.json({
          success: true, operationId,
          book: {
            id: updatedBook.id,
            title: updatedBook.title,
            acts: updatedBook.acts.map((act) => ({
              number: act.actNumber,
              title: act.title,
              chapters: act.chapters.map((ch) => ({
                number: ch.chapterNumber,
                title: ch.title,
                scenes: ch.scenes.length,
              })),
            })),
          },
        });
      }
    } catch (error) {
      if (!argv.json) {
        output.failSpinner();
        if (error instanceof NotFoundError) {
          output.error(error.message);
        } else {
          output.error(`Failed to generate outline: ${error instanceof Error ? error.message : 'Unknown error'}`);
          logger.error({ error }, 'Outline command failed');
        }
      } else {
        output.json({
          success: false, operationId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  },
};
