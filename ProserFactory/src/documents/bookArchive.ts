import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { databaseService } from '@/lib/database';
import { inspectImageMetadata } from '@/lib/imageMetadata';
import { resolveInside } from '@/lib/safePath';
import { createZipBuffer, readZipBuffer, ZipReadError, type ZipEntry } from '@/lib/zipArchive';
import { documentAuthorityEnabled, documentService } from './service';
import { DocumentError } from './errors';
import { canonicalDocument, documentFromText, imagesOf, paragraphsOf, projectDocument, visibleParagraph, visibleRun, paragraphBoundaryVisible, type DocumentParagraph, type ProserDocument } from './model';
import { validateDocument } from './validation';
import { parseCommentCandidateDocument } from './commentAnchors';
import { stampDocumentReview } from './reviewAttribution';
import { readScope } from './scopes';
import { validateBookLayout } from './scopeValidation';
import type { BookLayoutSnapshot } from './scope-model';

/** Portable book archive, format version 1.
 *
 * A ZIP holding `proser-archive.json` (format, version, source revision and a
 * SHA-256 for every other entry), `book.json` (metadata, structure, codex,
 * notes, plot threads, goal, AI switch, layout and image map), one exact head
 * document per scene under `scenes/`, and the image bytes under `images/`.
 * Import always creates a new book and never touches an existing one. */
export const BOOK_ARCHIVE_FORMAT = 'proser-book-archive';
export const BOOK_ARCHIVE_VERSION = 1;
export const BOOK_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const MAX_SCENES = 1000;
const MAX_IMAGES = 500;
const IMAGE_ROOT = () => path.resolve('public/images');

const db = () => databaseService.client;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const text = (max: number) => z.string().max(max).nullable();
const extensionFor = (mediaType: string) => mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';

const sceneSchema = z.object({
  sourceId: z.number().int().positive(), summary: text(20000), outline: text(20000),
  beatsMeta: z.unknown().optional(), selectedImageId: z.number().int().nonnegative(),
  document: z.string().regex(/^scenes\/[0-9]{4}\.json$/),
}).strict();
const chapterSchema = z.object({
  sourceId: z.number().int().positive(), title: text(500), summary: text(20000), selectedImageId: z.number().int().nonnegative(),
  scenes: z.array(sceneSchema).max(200),
}).strict();
const actSchema = z.object({
  sourceId: z.number().int().positive(), title: text(500), summary: text(20000), selectedImageId: z.number().int().nonnegative(),
  chapters: z.array(chapterSchema).max(200),
}).strict();
const imageSchema = z.object({
  sourceId: z.number().int().positive(), path: z.string().regex(/^images\/[a-f0-9]{64}\.(png|jpg|webp)$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  byteLength: z.number().int().positive(), name: z.string().min(1).max(500), source: z.string().max(100).nullable(),
}).strict();
const bookJsonSchema = z.object({
  book: z.object({
    title: text(255), summary: text(20000), genre: text(100), targetAudience: text(100), draftStatus: text(50),
    tagline: text(1000), storyOutline: text(200000), storyArchetypeKey: text(100), selectedImageId: z.number().int().nonnegative(),
  }).strict(),
  writingGoal: z.object({ targetWords: z.number().int().positive().nullable(), deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), dailyWords: z.number().int().positive().nullable() }).strict().nullable(),
  aiDisabled: z.boolean(),
  acts: z.array(actSchema).max(50),
  codex: z.array(z.object({ sourceId: z.number().int().positive(), entryType: z.string().min(1).max(100), entryName: z.string().min(1).max(500), entryDescription: text(100000), attributes: text(100000) }).strict()).max(5000),
  codexUsages: z.array(z.object({ sceneId: z.number().int().positive(), codexId: z.number().int().positive(), rationale: text(10000) }).strict()).max(50000),
  notes: z.array(z.object({ title: z.string().max(500), content: z.string().max(1_000_000) }).strict()).max(5000),
  plotThreads: z.array(z.object({
    threadKey: z.string().min(1).max(200), question: text(10000), authorManaged: z.boolean(), status: z.string().max(50),
    description: text(100000), firstSceneId: z.number().int().positive().nullable(), lastSceneId: z.number().int().positive().nullable(),
    dueHorizon: text(200), actors: z.unknown().optional(), notes: text(100000), confidence: z.number().min(0).max(1), archived: z.boolean(),
  }).strict()).max(5000),
  layout: z.unknown(),
  images: z.array(imageSchema).max(MAX_IMAGES),
}).strict();
const manifestSchema = z.object({
  format: z.literal(BOOK_ARCHIVE_FORMAT), formatVersion: z.literal(BOOK_ARCHIVE_VERSION),
  exportedAt: z.string().max(40), source: z.object({ bookRevisionId: z.string().max(64), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  counts: z.object({ scenes: z.number().int().nonnegative(), images: z.number().int().nonnegative(), wordCount: z.number().int().nonnegative() }).strict(),
  files: z.array(z.object({ path: z.string().max(200), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative() }).strict()).max(MAX_SCENES + MAX_IMAGES + 1),
}).strict();
type BookJson = z.infer<typeof bookJsonSchema>;
export type BookArchiveManifest = z.infer<typeof manifestSchema>;

async function readOwnedImage(asset: { id: number; name: string; url: string }) {
  const filename = resolveInside(IMAGE_ROOT(), path.basename(asset.name));
  const info = await fs.lstat(filename).catch(() => undefined);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) return undefined;
  const bytes = await fs.readFile(filename);
  try { return { bytes, ...inspectImageMetadata(bytes) }; } catch { return undefined; }
}

/** Export the book's current head as one archive. Every scene document, the
 * layout and the codex come from the same immutable revision. */
export async function exportBookArchive(userId: number, bookId: number): Promise<{ archive: Buffer; sha256: string; filename: string; manifest: BookArchiveManifest }> {
  if (!documentAuthorityEnabled()) throw new DocumentError('DOCUMENT_AUTHORITY_INACTIVE', 'Book archives need structured manuscript authority.', 503);
  const manifest = await documentService.manifest(userId, bookId);
  if (!manifest.scopes) throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED', 'Book scopes need explicit backfill.', 409);
  const [structure, canon, layout] = await Promise.all([
    readScope(db(), bookId, 'structure', manifest.scopes.structure),
    readScope(db(), bookId, 'canon', manifest.scopes.canon),
    readScope(db(), bookId, 'layout', manifest.scopes.layout),
  ]);
  const live = new Map(manifest.scenes.filter((scene) => !scene.deletedAt).map((scene) => [scene.sceneId, scene]));
  if (live.size > MAX_SCENES) throw new DocumentError('DOCUMENT_ARCHIVE_TOO_LARGE', `Book archives support up to ${MAX_SCENES} scenes.`, 413);
  const revisions = await db().sceneDocumentRevision.findMany({ where: { bookId, id: { in: [...live.values()].map((scene) => scene.revisionId) } } });
  const byRevision = new Map(revisions.map((row) => [row.id, row]));
  const entries: ZipEntry[] = [];
  const files: BookArchiveManifest['files'] = [];
  let total = 0;
  const add = (name: string, content: Buffer, store = false) => {
    total += content.length;
    if (total > BOOK_ARCHIVE_MAX_BYTES) throw new DocumentError('DOCUMENT_ARCHIVE_TOO_LARGE', 'The book archive would exceed 128 MiB.', 413);
    entries.push({ name, content, store }); files.push({ path: name, sha256: sha256(content), byteLength: content.length });
  };
  const documents: ProserDocument[] = [];
  let sceneIndex = 0;
  const acts: BookJson['acts'] = structure.acts.filter((act) => !act.deletedAt).sort((a, b) => a.actNumber - b.actNumber).map((act) => ({
    sourceId: act.id, title: act.title, summary: act.summary, selectedImageId: act.selectedImageId,
    chapters: structure.chapters.filter((chapter) => chapter.actId === act.id && !chapter.deletedAt).sort((a, b) => a.chapterNumber - b.chapterNumber).map((chapter) => ({
      sourceId: chapter.id, title: chapter.title, summary: chapter.summary, selectedImageId: chapter.selectedImageId,
      scenes: structure.scenes.filter((scene) => scene.chapterId === chapter.id && !scene.deletedAt && live.has(scene.id)).sort((a, b) => a.sceneNumber - b.sceneNumber).map((scene) => {
        const reference = live.get(scene.id)!;
        const row = byRevision.get(reference.revisionId);
        if (!row || row.contentHash !== reference.contentHash || sha256(canonicalDocument(row.document)) !== reference.contentHash) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Document checksum does not match its immutable manifest.', 503);
        const document = validateDocument(row.document); documents.push(document);
        const file = `scenes/${String(++sceneIndex).padStart(4, '0')}.json`;
        add(file, Buffer.from(JSON.stringify(document)));
        return { sourceId: scene.id, summary: scene.summary, outline: scene.outline, ...(scene.beatsMetaIsSqlNull ? {} : { beatsMeta: scene.beatsMeta }), selectedImageId: scene.selectedImageId, document: file };
      }),
    })),
  }));
  const liveSceneIds = new Set(acts.flatMap((act) => act.chapters.flatMap((chapter) => chapter.scenes.map((scene) => scene.sourceId))));
  // Images: every image the manuscript, layout or a selection uses must be
  // exported intact; other images of the book are included when readable.
  const required = new Set<number>([structure.book.selectedImageId, ...acts.flatMap((act) => [act.selectedImageId, ...act.chapters.flatMap((chapter) => [chapter.selectedImageId, ...chapter.scenes.map((scene) => scene.selectedImageId)])])]);
  for (const document of [...documents, ...[...layout.frontMatter, ...layout.backMatter, ...(layout.headerFooterStories ?? [])].map((story) => story.document)]) for (const image of imagesOf(document)) required.add(image.assetId);
  required.delete(0);
  const assets = await db().imageAsset.findMany({ where: { bookId, userId }, orderBy: { id: 'asc' }, take: MAX_IMAGES + 1 });
  if (assets.length > MAX_IMAGES) throw new DocumentError('DOCUMENT_ARCHIVE_TOO_LARGE', `Book archives support up to ${MAX_IMAGES} images.`, 413);
  const images: BookJson['images'] = []; const written = new Set<string>(); const omittedImageIds: number[] = [];
  for (const asset of assets) {
    const image = await readOwnedImage(asset);
    if (!image) { if (required.has(asset.id)) throw new DocumentError('DOCUMENT_ASSET_INTEGRITY', 'An image the book uses is missing or unreadable.', 503, { assetId: asset.id }); omittedImageIds.push(asset.id); continue; }
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(asset.configJson ?? '{}') as Record<string, unknown>; } catch { /* Unverified metadata stays unverified. */ }
    if (typeof metadata.sha256 === 'string' && metadata.sha256 !== image.sha256) { if (required.has(asset.id)) throw new DocumentError('DOCUMENT_ASSET_INTEGRITY', 'Stored image checksum differs from its immutable reference.', 503, { assetId: asset.id }); omittedImageIds.push(asset.id); continue; }
    const file = `images/${image.sha256}.${extensionFor(image.mediaType)}`;
    if (!written.has(file)) { add(file, image.bytes, true); written.add(file); }
    images.push({ sourceId: asset.id, path: file, sha256: image.sha256, mediaType: image.mediaType, byteLength: image.bytes.length, name: asset.name.slice(0, 500), source: asset.source });
  }
  for (const id of required) if (!images.some((image) => image.sourceId === id)) throw new DocumentError('DOCUMENT_ASSET_INTEGRITY', 'An image the book uses is not registered to it.', 503, { assetId: id });
  const [notes, threads, goal, policy] = await Promise.all([
    db().note.findMany({ where: { bookId }, orderBy: { id: 'asc' }, select: { title: true, content: true } }),
    db().plotThread.findMany({ where: { bookId }, orderBy: { id: 'asc' } }),
    db().bookWritingGoal.findUnique({ where: { bookId } }),
    db().bookAiPolicy.findUnique({ where: { bookId } }),
  ]);
  const liveCodex = canon.entries.filter((entry) => !entry.deletedAt);
  const liveCodexIds = new Set(liveCodex.map((entry) => entry.id));
  const book: BookJson = {
    book: { title: structure.book.title, summary: structure.book.summary, genre: structure.book.genre, targetAudience: structure.book.targetAudience, draftStatus: structure.book.draftStatus, tagline: structure.book.tagline, storyOutline: structure.book.storyOutline, storyArchetypeKey: structure.book.storyArchetypeKey, selectedImageId: structure.book.selectedImageId },
    writingGoal: goal ? { targetWords: goal.targetWords, deadline: goal.deadline ? goal.deadline.toISOString().slice(0, 10) : null, dailyWords: goal.dailyWords } : null,
    aiDisabled: policy?.aiDisabled ?? false,
    acts,
    codex: liveCodex.map((entry) => ({ sourceId: entry.id, entryType: entry.entryType, entryName: entry.entryName, entryDescription: entry.entryDescription, attributes: entry.attributes })),
    codexUsages: canon.usages.filter((usage) => !usage.deletedAt && liveCodexIds.has(usage.codexId) && liveSceneIds.has(usage.sceneId)).map((usage) => ({ sceneId: usage.sceneId, codexId: usage.codexId, rationale: usage.rationale })),
    notes,
    plotThreads: threads.map((thread) => ({ threadKey: thread.threadKey, question: thread.question, authorManaged: thread.authorManaged, status: thread.status, description: thread.description, firstSceneId: thread.firstSceneId && liveSceneIds.has(thread.firstSceneId) ? thread.firstSceneId : null, lastSceneId: thread.lastSceneId && liveSceneIds.has(thread.lastSceneId) ? thread.lastSceneId : null, dueHorizon: thread.dueHorizon, ...(thread.actors === null ? {} : { actors: thread.actors }), notes: thread.notes, confidence: thread.confidence, archived: thread.archivedAt !== null })),
    layout,
    images,
  };
  add('book.json', Buffer.from(JSON.stringify(book)));
  const archiveManifest: BookArchiveManifest = {
    format: BOOK_ARCHIVE_FORMAT, formatVersion: BOOK_ARCHIVE_VERSION, exportedAt: new Date().toISOString(),
    source: { bookRevisionId: manifest.revisionId, contentHash: manifest.contentHash },
    counts: { scenes: sceneIndex, images: images.length, wordCount: documents.reduce((sum, document) => sum + projectDocument(document).wordCount, 0) },
    files,
  };
  void omittedImageIds;
  const archive = await createZipBuffer([{ name: 'proser-archive.json', content: JSON.stringify(archiveManifest, null, 2) }, ...entries]);
  return { archive, sha256: sha256(archive), filename: `book-${bookId}-archive.proser.zip`, manifest: archiveManifest };
}

export interface ArchiveImportLosses {
  /** Scenes whose resolved tracked changes were folded into the text. */
  resolvedReviewFolded: number;
  /** Resolved comments, and comments whose anchors no longer attach. */
  commentsDropped: number;
  /** Scenes or stories that could only be imported as plain text. */
  plainTextFallbacks: number;
}

/** Fold resolved tracked changes into the text, keep pending changes and open
 * comments as new review items, and drop server-owned history that only the
 * source installation can verify. */
export function importableDocument(source: ProserDocument, losses: ArchiveImportLosses): ProserDocument {
  const attempt = (keepComments: boolean) => {
    const document = structuredClone(source);
    const resolved = new Set(document.changes.filter((change) => change.status !== 'pending').map((change) => change.id));
    if (resolved.size) losses.resolvedReviewFolded++;
    const fold = (paragraphs: DocumentParagraph[]): DocumentParagraph[] => {
      const kept = paragraphs.filter((paragraph) => !(paragraph.changeId && resolved.has(paragraph.changeId)) || visibleParagraph(paragraph, document.changes, 'final'));
      const merged: DocumentParagraph[] = [];
      for (const paragraph of kept) {
        paragraph.runs = paragraph.runs.filter((run) => !(run.changeId && resolved.has(run.changeId)) || visibleRun(run, document.changes, 'final'));
        for (const run of paragraph.runs) if (run.changeId && resolved.has(run.changeId)) delete run.changeId;
        if (paragraph.changeId && resolved.has(paragraph.changeId)) delete paragraph.changeId;
        const previous = merged.at(-1);
        if (previous?.boundaryChangeId && resolved.has(previous.boundaryChangeId)) {
          const hidden = !paragraphBoundaryVisible(previous, paragraph, document.changes, 'final');
          delete previous.boundaryChangeId;
          if (hidden) { previous.runs.push(...paragraph.runs); if (paragraph.boundaryChangeId) previous.boundaryChangeId = paragraph.boundaryChangeId; continue; }
        }
        merged.push(paragraph);
      }
      const last = merged.at(-1);
      if (last?.boundaryChangeId && resolved.has(last.boundaryChangeId)) delete last.boundaryChangeId;
      for (const paragraph of merged) if (!paragraph.runs.length) paragraph.runs.push({ id: randomUUID(), text: '', style: {} });
      return merged;
    };
    document.layout.header = fold(document.layout.header);
    document.layout.footer = fold(document.layout.footer);
    // Fold each run of consecutive body paragraphs once, so a hidden boundary
    // between two of them is still known when the second one is reached.
    const blocks: ProserDocument['blocks'] = [];
    let group: DocumentParagraph[] = [];
    const flush = () => { if (group.length) blocks.push(...fold(group)); group = []; };
    for (const block of document.blocks) {
      if (block.type === 'paragraph') { group.push(block); continue; }
      flush();
      if (block.type === 'table') for (const row of block.rows) for (const cell of row.cells) cell.paragraphs = fold(cell.paragraphs);
      blocks.push(block);
    }
    flush();
    document.blocks = blocks;
    const runIds = new Set(paragraphsOf(document, true).flatMap((paragraph) => paragraph.runs.map((run) => run.id)));
    const blockIds = new Set(paragraphsOf(document, true).map((paragraph) => paragraph.id));
    document.changes = document.changes.filter((change) => change.status === 'pending').flatMap((change) => {
      const { resolutionHistory: _history, historicalBoundarySource: _boundary, importedAuthor: _author, ...rest } = change;
      void _history; void _boundary; void _author;
      const targetRunIds = rest.targetRunIds.filter((id) => runIds.has(id));
      const targetBlockIds = rest.targetBlockIds?.filter((id) => blockIds.has(id));
      if (!targetRunIds.length && !targetBlockIds?.length) return [];
      return [{ ...rest, targetRunIds, ...(targetBlockIds ? { targetBlockIds } : {}) }];
    });
    const pending = new Set(document.changes.map((change) => change.id));
    for (const paragraph of paragraphsOf(document, true)) {
      if (paragraph.changeId && !pending.has(paragraph.changeId)) delete paragraph.changeId;
      if (paragraph.boundaryChangeId && !pending.has(paragraph.boundaryChangeId)) delete paragraph.boundaryChangeId;
      for (const run of paragraph.runs) if (run.changeId && !pending.has(run.changeId)) delete run.changeId;
    }
    const runs = new Map(paragraphsOf(document, true).flatMap((paragraph) => paragraph.runs.map((run) => [run.id, { paragraph, run }] as const)));
    const before = document.comments.length;
    document.comments = keepComments ? document.comments.filter((comment) => !comment.resolved).flatMap((comment) => {
      const { anchorStates: _states, resolutionHistory: _history, importedAuthor: _author, ...rest } = comment;
      void _states; void _history; void _author;
      const anchors = rest.anchors.filter((anchor) => { const found = runs.get(anchor.runId); return found?.paragraph.id === anchor.blockId && found.run.text.slice(anchor.start, anchor.end) === anchor.sourceText; });
      return anchors.length ? [{ ...rest, anchors }] : [];
    }) : [];
    const dropped = before - document.comments.length;
    const checked = parseCommentCandidateDocument(document);
    validateDocument(checked);
    stampDocumentReview(structuredClone(checked), undefined, { id: 0, name: 'archive-check' }, 'manual');
    return { document: checked, dropped };
  };
  for (const keepComments of [true, false]) {
    const folded = losses.resolvedReviewFolded;
    try { const { document, dropped } = attempt(keepComments); losses.commentsDropped += dropped; return document; }
    catch { losses.resolvedReviewFolded = folded; }
  }
  losses.plainTextFallbacks++;
  losses.commentsDropped += source.comments.length;
  return validateDocument({ ...documentFromText(projectDocument(source).text.replace(/[￼\f]/g, ''), randomUUID), layout: source.layout });
}

function remapImages(document: ProserDocument, assetIds: Map<number, number>): ProserDocument {
  for (const block of document.blocks) if (block.type === 'image') block.assetId = mappedId(assetIds, block.assetId);
  for (const paragraph of paragraphsOf(document, true)) for (const run of paragraph.runs) if (run.inlineImage) run.inlineImage.assetId = mappedId(assetIds, run.inlineImage.assetId);
  return document;
}
function mappedId(map: Map<number, number>, id: number) {
  if (!id) return 0;
  const mapped = map.get(id);
  if (!mapped) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', 'The archive refers to an image it does not contain.', 422, { sourceId: id });
  return mapped;
}

export interface ParsedBookArchive { manifest: BookArchiveManifest; book: BookJson; documents: Map<string, ProserDocument>; images: Map<string, Buffer>; sha256: string }

/** Verify the archive completely before anything is written. */
export async function parseBookArchive(bytes: Buffer): Promise<ParsedBookArchive> {
  if (Array.isArray(bytes) || !(bytes instanceof Buffer)) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', 'Upload the book archive bytes.', 422);
  if (!bytes.length || bytes.length > BOOK_ARCHIVE_MAX_BYTES) throw new DocumentError('DOCUMENT_ARCHIVE_TOO_LARGE', 'Book archives must contain 1 byte to 128 MiB.', 413);
  let files: Map<string, Buffer>;
  try { files = await readZipBuffer(bytes, { maxEntries: MAX_SCENES + MAX_IMAGES + 2, maxEntryBytes: 32 * 1024 * 1024, maxTotalBytes: 2 * BOOK_ARCHIVE_MAX_BYTES }); }
  catch (error) { if (error instanceof ZipReadError) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', `The file is not a valid book archive: ${error.message}`, 422); throw error; }
  const parseJson = (name: string) => { const raw = files.get(name); if (!raw) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', `The archive has no ${name}.`, 422); try { return JSON.parse(raw.toString('utf8')) as unknown; } catch { throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', `${name} is not valid JSON.`, 422); } };
  const rawManifest = parseJson('proser-archive.json') as { format?: unknown; formatVersion?: unknown };
  if (rawManifest?.format !== BOOK_ARCHIVE_FORMAT) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', 'The file is not a Proser book archive.', 422);
  if (rawManifest.formatVersion !== BOOK_ARCHIVE_VERSION) throw new DocumentError('DOCUMENT_ARCHIVE_VERSION_UNSUPPORTED', `This Proser reads book archive version ${BOOK_ARCHIVE_VERSION}; the file is version ${String(rawManifest.formatVersion)}.`, 422);
  const parsedManifest = manifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', 'The archive manifest is invalid.', 422);
  const manifest = parsedManifest.data;
  const listed = new Set(manifest.files.map((file) => file.path));
  if (listed.size !== manifest.files.length || listed.has('proser-archive.json')) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', 'The archive manifest lists a file twice.', 422);
  for (const name of files.keys()) if (name !== 'proser-archive.json' && !listed.has(name)) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', `The archive contains an unlisted file: ${name}.`, 422);
  for (const file of manifest.files) {
    const content = files.get(file.path);
    if (!content || content.length !== file.byteLength || sha256(content) !== file.sha256) throw new DocumentError('DOCUMENT_ARCHIVE_DIGEST_MISMATCH', `The archive file ${file.path} is missing or does not match its digest.`, 422);
  }
  const parsedBook = bookJsonSchema.safeParse(parseJson('book.json'));
  if (!parsedBook.success) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', 'book.json is invalid.', 422, { issues: parsedBook.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`) });
  const book = parsedBook.data;
  const scenes = book.acts.flatMap((act) => act.chapters.flatMap((chapter) => chapter.scenes));
  if (scenes.length > MAX_SCENES) throw new DocumentError('DOCUMENT_ARCHIVE_TOO_LARGE', `Book archives support up to ${MAX_SCENES} scenes.`, 413);
  const documents = new Map<string, ProserDocument>();
  for (const scene of scenes) {
    if (documents.has(scene.document)) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', 'Two scenes share one document.', 422);
    try { documents.set(scene.document, parseCommentCandidateDocument(parseJson(scene.document))); }
    catch (error) { if (error instanceof DocumentError && error.code === 'DOCUMENT_ARCHIVE_INVALID') throw error; throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', `${scene.document} is not a valid manuscript document.`, 422); }
  }
  try { validateBookLayout(book.layout, { commentCandidates: true }); } catch { throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', 'The archive layout is invalid.', 422); }
  const images = new Map<string, Buffer>();
  for (const image of book.images) {
    const bytesOf = files.get(image.path);
    if (!bytesOf) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', `The archive has no ${image.path}.`, 422);
    let inspected: ReturnType<typeof inspectImageMetadata>;
    try { inspected = inspectImageMetadata(bytesOf); } catch { throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', `${image.path} is not a supported image.`, 422); }
    if (inspected.sha256 !== image.sha256 || inspected.mediaType !== image.mediaType || bytesOf.length !== image.byteLength || !image.path.startsWith(`images/${image.sha256}.`)) throw new DocumentError('DOCUMENT_ARCHIVE_DIGEST_MISMATCH', `${image.path} does not match its image record.`, 422);
    images.set(image.path, bytesOf);
  }
  return { manifest, book, documents, images, sha256: sha256(bytes) };
}

export interface BookArchiveImportReceipt {
  operationId: string; bookId: number; title: string | null; revisionId: string; status: 'completed';
  counts: { acts: number; chapters: number; scenes: number; codex: number; notes: number; plotThreads: number; images: number; wordCount: number };
  losses: ArchiveImportLosses;
  source: BookArchiveManifest['source'] & { archiveSha256: string };
}

/** The catalog operation is derived from the creation operation, so a retry
 * of the same import replays both receipts instead of importing twice. */
function contentOperationId(operationId: string) {
  const hex = sha256(`book-archive-content:${operationId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Import a verified archive as a new book owned by the caller. */
export async function importBookArchive(userId: number, bytes: Buffer, operationId: string): Promise<BookArchiveImportReceipt> {
  if (!documentAuthorityEnabled()) throw new DocumentError('DOCUMENT_AUTHORITY_INACTIVE', 'Book archives need structured manuscript authority.', 503);
  z.string().uuid().parse(operationId);
  const archive = await parseBookArchive(bytes);
  const { book } = archive;
  const created = await documentService.createBook(userId, { title: book.book.title, genre: book.book.genre, targetAudience: book.book.targetAudience, summary: book.book.summary }, operationId);
  const bookId = created.result.id;
  // Image bytes are content addressed and written before the transaction; a
  // failed import leaves at most unreferenced files for the orphan sweep.
  const root = IMAGE_ROOT();
  await fs.mkdir(root, { recursive: true });
  const fileNames = new Map<string, string>();
  for (const image of book.images) {
    const name = `archive-${userId}-${image.sha256}.${extensionFor(image.mediaType)}`;
    if (!fileNames.has(image.path)) {
      await fs.writeFile(resolveInside(root, name), archive.images.get(image.path)!, { mode: 0o600, flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        if (sha256(await fs.readFile(resolveInside(root, name))) !== image.sha256) throw new DocumentError('DOCUMENT_ASSET_INTEGRITY', 'A stored image with the same name has different bytes.', 503);
      });
      fileNames.set(image.path, name);
    }
  }
  const losses: ArchiveImportLosses = { resolvedReviewFolded: 0, commentsDropped: 0, plainTextFallbacks: 0 };
  const scopes = created.manifest.scopes!;
  const receipt = await documentService.mutateCatalog(userId, bookId, {
    operationId: contentOperationId(operationId), expectedRevisionId: created.revisionId,
    expectedScopes: { structure: scopes.structure.revisionId, canon: scopes.canon.revisionId, layout: scopes.layout.revisionId },
    payload: { command: 'import-book-archive', archiveSha256: archive.sha256 },
  }, async (tx) => {
    const assetIds = new Map<number, number>();
    for (const image of book.images) {
      const inspected = inspectImageMetadata(archive.images.get(image.path)!);
      const name = fileNames.get(image.path)!;
      const asset = await tx.imageAsset.create({ data: { userId, bookId, name, url: `/images/${name}`, source: 'archive-import', configJson: JSON.stringify({ sha256: image.sha256, mediaType: image.mediaType, byteLength: image.byteLength, width: inspected.width, height: inspected.height, originalName: image.name, originalSource: image.source, importedAt: new Date().toISOString() }) } });
      assetIds.set(image.sourceId, asset.id);
    }
    await tx.book.update({ where: { id: bookId }, data: { draftStatus: book.book.draftStatus ?? 'draft', tagline: book.book.tagline, storyOutline: book.book.storyOutline, storyArchetypeKey: book.book.storyArchetypeKey, selectedImageId: mappedId(assetIds, book.book.selectedImageId) } });
    const sceneIds = new Map<number, number>(); const chapterIds = new Map<number, number>();
    const newDocuments: Array<{ sceneId: number; document: ProserDocument }> = [];
    for (const [actIndex, act] of book.acts.entries()) {
      const createdAct = await tx.act.create({ data: { bookId, actNumber: actIndex + 1, title: act.title, summary: act.summary, selectedImageId: mappedId(assetIds, act.selectedImageId) } });
      for (const [chapterIndex, chapter] of act.chapters.entries()) {
        const createdChapter = await tx.chapter.create({ data: { actId: createdAct.id, chapterNumber: chapterIndex + 1, title: chapter.title, summary: chapter.summary, selectedImageId: mappedId(assetIds, chapter.selectedImageId) } });
        chapterIds.set(chapter.sourceId, createdChapter.id);
        for (const [sceneIndex, scene] of chapter.scenes.entries()) {
          const createdScene = await tx.scene.create({ data: { chapterId: createdChapter.id, sceneNumber: sceneIndex + 1, summary: scene.summary, outline: scene.outline, beatsMeta: scene.beatsMeta === undefined ? undefined : json(scene.beatsMeta), selectedImageId: mappedId(assetIds, scene.selectedImageId) } });
          if (sceneIds.has(scene.sourceId)) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', 'Two scenes share one identity.', 422);
          sceneIds.set(scene.sourceId, createdScene.id);
          newDocuments.push({ sceneId: createdScene.id, document: remapImages(importableDocument(archive.documents.get(scene.document)!, losses), assetIds) });
        }
      }
    }
    const codexIds = new Map<number, number>();
    for (const entry of book.codex) {
      const createdEntry = await tx.codexEntry.create({ data: { bookId, entryType: entry.entryType, entryName: entry.entryName, entryDescription: entry.entryDescription, attributes: entry.attributes } });
      codexIds.set(entry.sourceId, createdEntry.id);
    }
    const usages = new Set<string>();
    for (const usage of book.codexUsages) {
      const sceneId = sceneIds.get(usage.sceneId); const codexId = codexIds.get(usage.codexId);
      if (!sceneId || !codexId || usages.has(`${sceneId}:${codexId}`)) continue;
      usages.add(`${sceneId}:${codexId}`);
      await tx.sceneCodexUsage.create({ data: { sceneId, codexId, rationale: usage.rationale } });
    }
    for (const note of book.notes) await tx.note.create({ data: { bookId, title: note.title, content: note.content } });
    for (const thread of book.plotThreads) {
      await tx.plotThread.create({ data: { bookId, threadKey: thread.threadKey, question: thread.question, authorManaged: thread.authorManaged, status: thread.status, description: thread.description, firstSceneId: thread.firstSceneId ? sceneIds.get(thread.firstSceneId) ?? null : null, lastSceneId: thread.lastSceneId ? sceneIds.get(thread.lastSceneId) ?? null : null, dueHorizon: thread.dueHorizon, ...(thread.actors === undefined ? {} : { actors: json(thread.actors) }), notes: thread.notes, confidence: thread.confidence, archivedAt: thread.archived ? new Date() : null } });
    }
    if (book.writingGoal) await tx.bookWritingGoal.create({ data: { bookId, targetWords: book.writingGoal.targetWords, deadline: book.writingGoal.deadline ? new Date(`${book.writingGoal.deadline}T00:00:00.000Z`) : null, dailyWords: book.writingGoal.dailyWords } });
    // A book kept away from AI stays away from AI on the new installation.
    if (book.aiDisabled) await tx.bookAiPolicy.create({ data: { bookId, aiDisabled: true } });
    const sourceLayout = validateBookLayout(book.layout, { commentCandidates: true });
    const layout: BookLayoutSnapshot = {
      ...sourceLayout,
      chapters: Object.fromEntries(Object.entries(sourceLayout.chapters).flatMap(([id, settings]) => { const mapped = chapterIds.get(Number(id)); return mapped ? [[String(mapped), settings]] : []; })),
      frontMatter: sourceLayout.frontMatter.map((story) => ({ ...story, document: remapImages(importableDocument(story.document, losses), assetIds) })),
      backMatter: sourceLayout.backMatter.map((story) => ({ ...story, document: remapImages(importableDocument(story.document, losses), assetIds) })),
      ...(sourceLayout.headerFooterStories ? { headerFooterStories: sourceLayout.headerFooterStories.flatMap((story) => {
        if (story.owner === 'book') return [{ ...story, document: remapImages(importableDocument(story.document, losses), assetIds) }];
        const chapterId = chapterIds.get(story.chapterId!);
        return chapterId ? [{ ...story, chapterId, document: remapImages(importableDocument(story.document, losses), assetIds) }] : [];
      }) } : {}),
    };
    const counts = { acts: book.acts.length, chapters: chapterIds.size, scenes: sceneIds.size, codex: codexIds.size, notes: book.notes.length, plotThreads: book.plotThreads.length, images: assetIds.size, wordCount: newDocuments.reduce((sum, item) => sum + projectDocument(item.document).wordCount, 0) };
    await tx.auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action: 'update', metadata: json({ action: 'import-book-archive', operationId, archiveSha256: archive.sha256, source: archive.manifest.source, counts, losses }) } });
    return { result: { counts, losses: { ...losses } }, newDocuments, layout, receiptProjection: 'references' };
  });
  return { operationId, bookId, title: created.result.title, revisionId: receipt.revisionId, status: 'completed', counts: receipt.result.counts, losses: receipt.result.losses, source: { ...archive.manifest.source, archiveSha256: archive.sha256 } };
}
