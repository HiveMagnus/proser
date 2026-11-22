import type { CommandModule } from 'yargs';
import { output } from '../utils/output';
import { initDatabase, closeDatabase, getDb } from '../utils/database';
import { NotFoundError } from '@/lib/errors';
import { VllmService } from '@/lib/ai/vllm';
import logger from '@/lib/logger';
import { randomUUID } from 'node:crypto';
import { resolveCliUser } from '../auth';
import { documentAuthorityEnabled, documentService } from '@/documents/service';
import { generateOwnedOperatorBookText } from '@/documents/operatorCommands';
import { codexService } from '@/services/codexService';
import { ValidationError } from '@/lib/errors';
import { withRetry } from '@/lib/resilience';
import { DocumentError } from '@/documents/errors';

interface CharactersArgs {
  bookId: number;
  'user-id'?: number;
  'operation-id'?: string;
  json: boolean;
}

/** Shape returned by AI for a single character */
interface AiCharacter {
  name?: string;
  role?: string;
  description?: string;
  traits?: string;
}

/** Top-level shape returned by AI */
interface AiCharacters {
  characters?: AiCharacter[];
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
 * Parse the AI response into a character list. Returns null on failure.
 */
function parseCharacterResponse(raw: string): AiCharacter[] | null {
  try {
    const jsonStr = extractJson(raw);
    if (!jsonStr) return null;
    const parsed = JSON.parse(jsonStr) as AiCharacters | AiCharacter[];

    // Handle both { characters: [...] } and bare [...]
    const list = Array.isArray(parsed) ? parsed : parsed.characters;
    if (!list || !Array.isArray(list) || list.length === 0) return null;

    // Validate each entry has at least a name
    const valid = list.filter((c: AiCharacter) => c.name && typeof c.name === 'string');
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

/** Default fallback characters when AI parsing fails */
const FALLBACK_CHARACTERS: AiCharacter[] = [
  { name: 'Protagonist', role: 'protagonist', description: 'The main character of the story.' },
  { name: 'Antagonist', role: 'antagonist', description: 'The primary opposing force in the story.' },
  { name: 'Supporting Character', role: 'supporting', description: 'A key supporting character who aids the protagonist.' },
];

export const charactersCommand: CommandModule<object, CharactersArgs> = {
  command: 'characters <bookId>',
  describe: 'Generate character profiles and add to codex',
  builder: (yargs) =>
    yargs
      .positional('bookId', {
        describe: 'Book ID',
        type: 'number',
        demandOption: true,
      })
      .option('operation-id', { describe: 'Stable character generation/save UUID for exact recovery.', type: 'string' })
      .option('user-id', { describe: 'Explicit local operator user ID', type: 'number' })
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
      const book = await db.book.findFirst({
        where: { id, userId },
      });

      if (!book) {
        throw new NotFoundError(`Book with ID ${id} not found`);
      }
      const source = documentAuthorityEnabled() ? await documentService.manifest(userId, id) : undefined;
      const structure = source ? await documentService.scope(userId, id, 'structure') : undefined;
      if (structure && structure.bookRevisionId !== source!.revisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Book changed before character generation.', 412);
      const contextBook = structure?.content.book ?? book;
      let expected = source ? { operationId, expectedRevisionId: source.revisionId, expectedScopes: { canon: source.scopes!.canon.revisionId } } : undefined;
      if (expected && !argv.json) output.data('Save preconditions', JSON.stringify(expected));

      if (!argv.json) {
        output.section('Generating Characters');
        output.data('Book', book.title ?? 'Untitled');
        output.newline();
        output.startSpinner('Analyzing story and creating character profiles...');
      }

      const ai = new VllmService();
      const promptForBook = (contextBook: { title: string | null; summary: string | null; genre: string | null }) => `Create character profiles for the following book:

Title: ${contextBook.title ?? 'Untitled'}
Concept: ${contextBook.summary ?? 'No summary available'}
Genre: ${contextBook.genre || 'fiction'}

Create 3-5 main characters. Return ONLY a JSON object with this exact structure (no other text):
{
  "characters": [
    {
      "name": "Character's full name",
      "role": "protagonist | antagonist | supporting | mentor | etc.",
      "description": "2-3 sentence character description including background, personality, and motivation."
    }
  ]
}`;

      const generated = source ? await generateOwnedOperatorBookText(userId, { bookId: id, operationId, kind: 'cli-characters', intent: { recipe: 'character-profiles-v1' }, expectedRevisionId: source.revisionId, makePrompt: promptForBook }) : undefined;
      if (generated) expected = { ...generated.expected, expectedScopes: { canon: generated.expected.expectedScopes.canon! } };
      const aiResponse = generated?.result.raw ?? await withRetry(() => ai.generateText({ prompt: promptForBook(contextBook) }), 1);
      const parsed = parseCharacterResponse(aiResponse);
      if (source && !parsed) throw new ValidationError('Character output was invalid. No canonical entries were created.');

      const characters = parsed ?? FALLBACK_CHARACTERS;
      const usedAi = parsed !== null;

      if (!argv.json) {
        if (usedAi) {
          output.updateSpinner(`Creating ${characters.length} character entries from AI response...`);
        } else {
          output.updateSpinner('AI response could not be parsed as JSON — creating placeholder character entries...');
          logger.warn('Failed to parse AI character response, falling back to placeholders');
        }
      }

      const frozenBookTitle = generated ? generated.request.bookMetadata.title : book.title;
      const data = characters.map((char) => ({ entryName: char.name!, entryType: 'character', entryDescription: char.description || `Character profile for ${char.name} (${char.role || 'unknown role'}) in ${frozenBookTitle ?? 'Untitled'}.` }));
      const createdEntries = expected ? (await codexService.createEntries(userId, id, data, expected, 'ai', generated?.result)).entries : [];
      if (!expected) {
      for (const char of characters) {
        const entry = await db.codexEntry.create({
          data: {
            bookId: id,
            entryName: char.name!,
            entryType: 'character',
            entryDescription: char.description || `Character profile for ${char.name} (${char.role || 'unknown role'}) in ${book.title ?? 'Untitled'}.`,
          },
        });
        createdEntries.push(entry);
      }
      }

      if (!argv.json) {
        output.succeedSpinner(`${createdEntries.length} characters created${usedAi ? '' : ' (placeholders)'}!`);
      }

      const updatedBook = await db.book.findUnique({
        where: { id },
        include: {
          codexEntries: { where: { entryType: 'character' } },
        },
      });

      if (!updatedBook) {
        throw new NotFoundError('Book not found after character generation');
      }

      if (!argv.json) {
        output.newline();
        output.section('Generated Characters');

        if (updatedBook.codexEntries.length === 0) {
          output.warning('No character entries found.');
        } else {
          updatedBook.codexEntries.forEach((entry) => {
            output.info(`- ${entry.entryName}`);
            if (entry.entryDescription) {
              const preview = entry.entryDescription.substring(0, 100);
              output.data('  Description', preview + (entry.entryDescription.length > 100 ? '...' : ''));
            }
          });
        }

        output.newline();
        output.success('Next steps:');
        output.info(`  1. Generate scenes: proser-cli generate ${book.id}`);
        output.info(`  2. View all codex: proser-cli codex:list ${book.id}`);
      } else {
        output.json({
          success: true, operationId,
          documentPreconditions: expected,
          characters: updatedBook.codexEntries.map((entry) => ({
            name: entry.entryName,
            type: entry.entryType,
            description: entry.entryDescription,
          })),
        });
      }
    } catch (error) {
      if (!argv.json) {
        output.failSpinner();
        if (error instanceof NotFoundError) {
          output.error(error.message);
        } else {
          output.error(`Failed to generate characters: ${error instanceof Error ? error.message : 'Unknown error'}`);
          logger.error({ error }, 'Characters command failed');
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
