import { createHash } from 'node:crypto';
import { databaseService } from '@/lib/database';
import { canonicalDocument, type DocumentManifest, type ProserDocument } from './model';
import { validateDocument } from './validation';
import { readScope } from './scopes';
import { DocumentError } from './errors';
const hash = (value: unknown) => createHash('sha256').update(canonicalDocument(value)).digest('hex');

/** Release approval sees the exact reviewed immutable manifest. A final-text
 * export neither resolves records nor authorizes publication of pending review. */
export async function reviewStateAtRevision(userId: number, bookId: number, revisionId: string) {
  const db = databaseService.client;
  const book = await db.book.findFirst({ where: { id: bookId, userId }, select: { id: true } });
  if (!book) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Book not found.', 404);
  const mapping = await db.documentLegacyRevisionMapping.findFirst({ where: { bookId, legacyRevisionId: revisionId } });
  if (!mapping || (mapping.fidelity as { completeDocument?: boolean }).completeDocument !== true) throw new DocumentError('DOCUMENT_REVIEW_SOURCE_INCOMPLETE', 'Complete immutable document evidence is required for publication approval.', 409);
  const revision = await db.bookDocumentRevision.findFirst({ where: { bookId, id: mapping.documentRevisionId } });
  if (!revision || hash(revision.manifest) !== revision.contentHash) throw new DocumentError('DOCUMENT_MANIFEST_INVALID', 'Publication review source checksum is invalid.', 503);
  const manifest = revision.manifest as unknown as DocumentManifest;
  if (!manifest.scopes) throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED', 'Publication review requires complete canonical scopes.', 409);
  const structure = await readScope(db, bookId, 'structure', manifest.scopes.structure);
  const layout = await readScope(db, bookId, 'layout', manifest.scopes.layout);
  const activeActs = new Set(structure.acts.filter((act) => !act.deletedAt).map((act) => act.id));
  const activeChapters = new Set(structure.chapters.filter((chapter) => !chapter.deletedAt && activeActs.has(chapter.actId)).map((chapter) => chapter.id));
  const pending = new Set<string>(); const unresolved = new Set<string>();
  const count = (document: ProserDocument) => { for (const change of document.changes) if (change.status === 'pending') pending.add(change.id); for (const comment of document.comments) if (!comment.resolved) unresolved.add(comment.id); };
  const activeStories = [...layout.frontMatter, ...layout.backMatter, ...(layout.headerFooterStories ?? []).filter((story) => story.owner === 'book' || activeChapters.has(story.chapterId!))];
  for (const story of activeStories) count(validateDocument(story.document));
  for (const reference of manifest.scenes.filter((scene) => !scene.deletedAt && activeChapters.has(scene.chapterId))) {
    const source = await db.sceneDocumentRevision.findFirst({ where: { id: reference.revisionId, sceneId: reference.sceneId, bookId } });
    if (!source || source.contentHash !== reference.contentHash || hash(source.document) !== reference.contentHash) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Publication review body checksum is invalid.', 503);
    count(validateDocument(source.document));
  }
  return { sourceBookRevisionId: revision.id, sourceContentHash: revision.contentHash, pendingChanges: pending.size, unresolvedComments: unresolved.size };
}
