import { z } from 'zod';
import { documentSchema, validateDocument } from './validation';
import type { BookLayoutSnapshot } from './scope-model';
import { DocumentError } from './errors';
const identity = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const paragraph = documentSchema.shape.blocks.element.options[0];
const story = z.object({ id: identity, name: z.string().min(1).max(200), document: documentSchema }).strict();
export const bookLayoutSchema = z.object({
  schemaVersion: z.literal(1), book: documentSchema.shape.layout,
  chapters: z.record(z.string().regex(/^[1-9][0-9]*$/), documentSchema.shape.layout),
  headerFooterStories: z.array(z.object({id:identity,owner:z.enum(['book','chapter']),chapterId:z.number().int().positive().optional(),kind:z.enum(['header','footer']),document:documentSchema}).strict()).max(1000).optional(),
  frontMatter: z.array(story).max(100), backMatter: z.array(story).max(100),
  styles: z.object({ text: z.record(identity, paragraph.shape.runs.element.shape.style), paragraph: z.record(identity, paragraph.shape.style),labels:z.record(identity,z.string().min(1).max(512)).optional() }).strict(),
}).strict();
export function validateBookLayout(input: unknown, options: {commentCandidates?:boolean} = {}): BookLayoutSnapshot {
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 8 * 1024 * 1024) throw new DocumentError('DOCUMENT_LAYOUT_TOO_LARGE', 'Book layout exceeds 8 MiB.', 413);
  const layout = bookLayoutSchema.parse(input);
  const validateStory = options.commentCandidates ? (raw:unknown) => documentSchema.parse(raw) : validateDocument;
  // Validate each header/footer story with the same canonical constraints.
  for (const settings of [layout.book, ...Object.values(layout.chapters)]) validateDocument({ schemaVersion: 1, blocks: [], comments: [], changes: [], layout: settings });
  const seen = new Set<string>();
  for (const ancillary of [...layout.frontMatter, ...layout.backMatter]) {
    if (seen.has(ancillary.id)) throw new DocumentError('DOCUMENT_STORY_ID_DUPLICATE', 'Ancillary story identities must be unique.', 422);
    seen.add(ancillary.id); validateStory(ancillary.document);
  }
  const slots = new Set<string>();
  for (const owned of layout.headerFooterStories ?? []) {
    if (seen.has(owned.id)) throw new DocumentError('DOCUMENT_STORY_ID_DUPLICATE', 'Story identities must be unique across owned stories.', 422);
    seen.add(owned.id);
    if ((owned.owner === 'book' && owned.chapterId !== undefined) || (owned.owner === 'chapter' && owned.chapterId === undefined)) throw new DocumentError('DOCUMENT_STORY_OWNER_INVALID', 'Story owner and chapter identity disagree.', 422);
    const key = `${owned.owner}:${owned.chapterId ?? 'book'}:${owned.kind}`;
    if (slots.has(key)) throw new DocumentError('DOCUMENT_STORY_SLOT_DUPLICATE', 'An owner may have one canonical header and one canonical footer.', 422);
    slots.add(key);
    const settings = owned.owner === 'book' ? layout.book : layout.chapters[String(owned.chapterId)];
    if (!settings || settings[owned.kind].length) throw new DocumentError('DOCUMENT_STORY_AUTHORITY_CONFLICT', 'Owned stories require empty corresponding compatibility layout fragments.', 422);
    if (owned.document.layout.header.length || owned.document.layout.footer.length || owned.document.blocks.some((block) => block.type === 'pageBreak')) throw new DocumentError('DOCUMENT_STORY_LAYOUT_INVALID', 'Header/footer story documents cannot contain nested stories or page breaks.', 422);
    validateStory(owned.document);
  }
  return layout;
}
