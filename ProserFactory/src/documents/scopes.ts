import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { canonicalDocument, defaultLayout, type ProserDocument } from './model';
import { DocumentError } from './errors';
import type { BookScopeContents, CanonSnapshot, DocumentScopeKind, DocumentScopeReferences, StructureSnapshot } from './scope-model';
import { captureSelectedAssets, validateSelectedAssets } from './selectedAssets';
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const scopeHash = (value: unknown) => createHash('sha256').update(canonicalDocument(value)).digest('hex');
const bookFields = { title: true, summary: true, genre: true, targetAudience: true, draftStatus: true, tagline: true, storyOutline: true, storyArchetypeKey: true, selectedImageId: true, deletedAt: true } as const;
const entityMetadata = { id: true, title: true, summary: true, selectedImageId: true, deletedAt: true, createdAt: true } as const;
/** Capture scope catalogs separately from scene bodies. Scope revisions are
 * immutable and ordinary scene commits keep their lightweight references. */
export async function captureBookScopes(tx: Prisma.TransactionClient, bookId: number): Promise<BookScopeContents> {
  const [book, acts, chapters, scenes, entries, usages, nulls] = await Promise.all([
    tx.book.findUniqueOrThrow({ where: { id: bookId, deletedAt: {} }, select: bookFields }),
    tx.act.findMany({ where: { bookId }, orderBy: { id: 'asc' }, select: { ...entityMetadata, actNumber: true } }),
    tx.chapter.findMany({ where: { act: { bookId } }, orderBy: { id: 'asc' }, select: { ...entityMetadata, actId: true, chapterNumber: true } }),
    tx.scene.findMany({ where: { deletedAt: {}, chapter: { act: { bookId } } }, orderBy: { id: 'asc' }, select: { id: true, chapterId: true, sceneNumber: true, summary: true, outline: true, beatsMeta: true, selectedImageId: true, deletedAt: true, createdAt: true } }),
    tx.codexEntry.findMany({ where: { bookId, deletedAt: {} }, orderBy: { id: 'asc' }, select: { id: true, entryType: true, entryName: true, entryDescription: true, attributes: true, deletedAt: true, createdAt: true } }),
    tx.sceneCodexUsage.findMany({ where: { scene: { chapter: { act: { bookId } } } }, orderBy: { id: 'asc' }, select: { id: true, sceneId: true, codexId: true, usedAt: true, rationale: true, deletedAt: true } }),
    tx.$queryRaw<Array<{ id: number; isNull: boolean }>>`SELECT s.id, (s.beats_meta IS NULL) AS "isNull" FROM scenes s JOIN chapters c ON c.id = s.chapter_id JOIN acts a ON a.id = c.act_id WHERE a.book_id = ${bookId}`,
  ]);
  const sqlNull = new Map(nulls.map((row) => [row.id, row.isNull]));
  const serialized = JSON.parse(JSON.stringify({
    structure: { schemaVersion: 1, book, acts, chapters, scenes: scenes.map((scene) => ({ ...scene, beatsMetaIsSqlNull: sqlNull.get(scene.id) === true })) },
    canon: { schemaVersion: 1, entries, usages },
    layout: { schemaVersion: 1, book: defaultLayout(), chapters: {}, frontMatter: [], backMatter: [], styles: { text: {}, paragraph: {} } },
  })) as BookScopeContents;
  await captureSelectedAssets(tx, bookId, serialized.structure);
  return serialized;
}
/** Restored canonical membership excludes resources introduced by later
 * revisions; their physical tombstones remain available in history. */
export async function captureManifestScopes(tx: Prisma.TransactionClient, bookId: number, base: BookScopeContents, before: BookScopeContents): Promise<BookScopeContents> {
  const contents = await captureBookScopes(tx, bookId);
  const retain = <Row extends { id: number; deletedAt: string | null }>(rows: Row[], canonical: Row[], previous: Row[]): Row[] => {
    const known = new Set(canonical.map((row) => row.id)); const existed = new Set(previous.map((row) => row.id));
    return rows.filter((row) => known.has(row.id) || !row.deletedAt || !existed.has(row.id));
  };
  contents.structure.acts = retain(contents.structure.acts, base.structure.acts, before.structure.acts);
  contents.structure.chapters = retain(contents.structure.chapters, base.structure.chapters, before.structure.chapters);
  contents.structure.scenes = retain(contents.structure.scenes, base.structure.scenes, before.structure.scenes);
  contents.canon.entries = retain(contents.canon.entries, base.canon.entries, before.canon.entries);
  contents.canon.usages = retain(contents.canon.usages, base.canon.usages, before.canon.usages);
  contents.layout = base.layout;
  return contents;
}
export async function writeScopeRevision<K extends DocumentScopeKind>(tx: Prisma.TransactionClient, bookId: number, actorId: number, kind: K, content: BookScopeContents[K], parentRevisionId?: string) {
  const contentHash = scopeHash(content); const revisionId = randomUUID();
  await tx.bookDocumentScopeRevision.create({ data: { id: revisionId, bookId, actorId, kind, contentHash, content: toJson(content), parentRevisionId } });
  return { revisionId, contentHash };
}
export async function initializeScopeReferences(tx: Prisma.TransactionClient, bookId: number, actorId: number): Promise<DocumentScopeReferences> {
  const contents = await captureBookScopes(tx, bookId);
  validateScopeMembership(contents);
  await validateSelectedAssets(tx, bookId, contents.structure);
  return { structure: await writeScopeRevision(tx, bookId, actorId, 'structure', contents.structure), canon: await writeScopeRevision(tx, bookId, actorId, 'canon', contents.canon), layout: await writeScopeRevision(tx, bookId, actorId, 'layout', contents.layout) };
}
export function validateScopeMembership(contents: BookScopeContents) {
  const { structure, canon } = contents;
  const acts = new Map(structure.acts.map((act) => [act.id, act]));
  const chapters = new Map(structure.chapters.map((chapter) => [chapter.id, chapter]));
  const scenes = new Map(structure.scenes.map((scene) => [scene.id, scene]));
  const entries = new Map(canon.entries.map((entry) => [entry.id, entry]));
  for (const act of structure.acts) if (!act.deletedAt && act.actNumber < 1) throw new DocumentError('DOCUMENT_SCOPE_ORDER_INVALID', 'Active acts need positive order values.', 409);
  for (const chapter of structure.chapters) {
    const parent = acts.get(chapter.actId);
    if (!parent || (!chapter.deletedAt && (parent.deletedAt || chapter.chapterNumber < 1))) throw new DocumentError('DOCUMENT_SCOPE_PARENT_INVALID', 'Active chapters need an active owned parent and positive order.', 409);
  }
  for (const scene of structure.scenes) {
    const parent = chapters.get(scene.chapterId);
    if (!parent || (!scene.deletedAt && (parent.deletedAt || scene.sceneNumber < 1))) throw new DocumentError('DOCUMENT_SCOPE_PARENT_INVALID', 'Active scenes need an active owned parent and positive order.', 409);
  }
  for (const story of contents.layout.headerFooterStories ?? []) if (story.owner === 'chapter' && !chapters.has(story.chapterId!)) throw new DocumentError('DOCUMENT_STORY_OWNERSHIP_INVALID', 'Layout story chapter is not owned by this manifested book.', 409);
  for (const usage of canon.usages) if (!scenes.has(usage.sceneId) || !entries.has(usage.codexId)) throw new DocumentError('DOCUMENT_SCOPE_USAGE_INVALID', 'Codex usage must reference owned scene and canon identities.', 409);
}
export async function readScope<K extends DocumentScopeKind>(tx: Prisma.TransactionClient, bookId: number, kind: K, reference: DocumentScopeReferences[K]): Promise<BookScopeContents[K]> {
  const revision = await tx.bookDocumentScopeRevision.findFirst({ where: { id: reference.revisionId, bookId, kind } });
  if (!revision || revision.contentHash !== reference.contentHash || scopeHash(revision.content) !== reference.contentHash) throw new DocumentError('DOCUMENT_SCOPE_REVISION_INVALID', 'The immutable book scope is unavailable or corrupt.', 503);
  return revision.content as unknown as BookScopeContents[K];
}
async function ownedIds(tx: Prisma.TransactionClient, bookId: number, structure: StructureSnapshot, canon: CanonSnapshot) {
  for (const act of structure.acts) {
    const found = await tx.act.findUnique({ where: { id: act.id }, select: { bookId: true } });
    if (found && found.bookId !== bookId) throw new DocumentError('DOCUMENT_SCOPE_OWNERSHIP_INVALID', 'A restored act belongs to another book.', 409);
  }
  for (const chapter of structure.chapters) {
    const found = await tx.chapter.findUnique({ where: { id: chapter.id }, select: { act: { select: { bookId: true } } } });
    if (found && found.act.bookId !== bookId) throw new DocumentError('DOCUMENT_SCOPE_OWNERSHIP_INVALID', 'A restored chapter belongs to another book.', 409);
    if (!structure.acts.some((act) => act.id === chapter.actId)) throw new DocumentError('DOCUMENT_SCOPE_PARENT_INVALID', 'Chapter parent is missing from the restored structure.', 409);
  }
  for (const scene of structure.scenes) {
    const found = await tx.scene.findFirst({ where: { id: scene.id, deletedAt: {} }, select: { chapter: { select: { act: { select: { bookId: true } } } } } });
    if (found && found.chapter.act.bookId !== bookId) throw new DocumentError('DOCUMENT_SCOPE_OWNERSHIP_INVALID', 'A restored scene belongs to another book.', 409);
    if (!structure.chapters.some((chapter) => chapter.id === scene.chapterId)) throw new DocumentError('DOCUMENT_SCOPE_PARENT_INVALID', 'Scene parent is missing from the restored structure.', 409);
  }
  for (const entry of canon.entries) {
    const found = await tx.codexEntry.findFirst({ where: { id: entry.id, deletedAt: {} }, select: { bookId: true } });
    if (found && found.bookId !== bookId) throw new DocumentError('DOCUMENT_SCOPE_OWNERSHIP_INVALID', 'A restored codex entry belongs to another book.', 409);
  }
  for (const usage of canon.usages) {
    if (!structure.scenes.some((scene) => scene.id === usage.sceneId) || !canon.entries.some((entry) => entry.id === usage.codexId)) throw new DocumentError('DOCUMENT_SCOPE_USAGE_INVALID', 'Restored codex usage has an invalid parent.', 409);
    const found = await tx.sceneCodexUsage.findUnique({ where: { id: usage.id }, select: { scene: { select: { chapter: { select: { act: { select: { bookId: true } } } } } } } });
    if (found && found.scene.chapter.act.bookId !== bookId) throw new DocumentError('DOCUMENT_SCOPE_OWNERSHIP_INVALID', 'A restored codex usage belongs to another book.', 409);
  }
}
/** Restore identities and membership by tombstoning newer resources. Two-pass
 * ordering avoids uniqueness collisions; no act/chapter/scene is deleted. */
export async function restoreBookScopes(tx: Prisma.TransactionClient, bookId: number, references: DocumentScopeReferences) {
  const structure = await readScope(tx, bookId, 'structure', references.structure);
  const canon = await readScope(tx, bookId, 'canon', references.canon);
  const layout = await readScope(tx, bookId, 'layout', references.layout);
  await validateSelectedAssets(tx, bookId, structure);
  await ownedIds(tx, bookId, structure, canon);
  const now = new Date();
  const [acts, chapters, scenes] = await Promise.all([
    tx.act.findMany({ where: { bookId }, select: { id: true } }),
    tx.chapter.findMany({ where: { act: { bookId } }, select: { id: true } }),
    tx.scene.findMany({ where: { deletedAt: {}, chapter: { act: { bookId } } }, select: { id: true } }),
  ]);
  for (const scene of scenes) await tx.scene.update({ where: { id: scene.id }, data: { sceneNumber: -scene.id, deletedAt: now } });
  for (const chapter of chapters) await tx.chapter.update({ where: { id: chapter.id }, data: { chapterNumber: -chapter.id, deletedAt: now } });
  for (const act of acts) await tx.act.update({ where: { id: act.id }, data: { actNumber: -act.id, deletedAt: now } });
  const { deletedAt: bookDeletedAt, selectedImageAsset: _bookAsset, ...bookMetadata } = structure.book;
  await tx.book.update({ where: { id: bookId }, data: { ...bookMetadata, deletedAt: bookDeletedAt ? new Date(bookDeletedAt) : null } });
  for (const { id, createdAt, deletedAt, selectedImageAsset: _actAsset, ...metadata } of structure.acts) {
    const data = { ...metadata, bookId, createdAt: createdAt ? new Date(createdAt) : null, deletedAt: deletedAt ? new Date(deletedAt) : null };
    await tx.act.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  for (const { id, createdAt, deletedAt, selectedImageAsset: _chapterAsset, ...metadata } of structure.chapters) {
    const data = { ...metadata, createdAt: createdAt ? new Date(createdAt) : null, deletedAt: deletedAt ? new Date(deletedAt) : null };
    await tx.chapter.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  for (const { id, createdAt, deletedAt, beatsMetaIsSqlNull, beatsMeta, chapterId, sceneNumber, summary, outline, selectedImageId } of structure.scenes) {
    const data = { chapterId, sceneNumber, summary, outline, selectedImageId, createdAt: createdAt ? new Date(createdAt) : null, deletedAt: deletedAt ? new Date(deletedAt) : null, beatsMeta: beatsMeta === null ? beatsMetaIsSqlNull ? Prisma.DbNull : Prisma.JsonNull : beatsMeta as Prisma.InputJsonValue };
    await tx.scene.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  await tx.codexEntry.updateMany({ where: { bookId }, data: { deletedAt: now } });
  for (const { id, createdAt, deletedAt, ...metadata } of canon.entries) {
    const data = { ...metadata, bookId, createdAt: createdAt ? new Date(createdAt) : null, deletedAt: deletedAt ? new Date(deletedAt) : null };
    await tx.codexEntry.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  await tx.sceneCodexUsage.updateMany({ where: { scene: { chapter: { act: { bookId } } } }, data: { deletedAt: now } });
  for (const { id, usedAt, deletedAt, ...usage } of canon.usages) {
    const data = { ...usage, usedAt: usedAt ? new Date(usedAt) : null, deletedAt: deletedAt ? new Date(deletedAt) : null };
    await tx.sceneCodexUsage.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  return { structure, canon, layout };
}
export function scopeDocuments(contents: Pick<BookScopeContents, 'layout'>): ProserDocument[] {
  return [...contents.layout.frontMatter, ...contents.layout.backMatter, ...(contents.layout.headerFooterStories ?? [])].map((story) => story.document)
    .concat([contents.layout.book, ...Object.values(contents.layout.chapters)].map((layout) => ({ schemaVersion: 1, blocks: [], changes: [], comments: [], layout })));
}
