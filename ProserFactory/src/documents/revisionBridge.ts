import type { Prisma, BookDocumentRevision } from '@prisma/client';
import { createHash } from 'node:crypto';
import { canonicalDocument } from './model';
import { DocumentError } from './errors';
import type { DocumentManifest } from './service';

/** Preserve existing revision foreign keys using lightweight, immutable native
 * references. Historical legacy snapshots and hashes are never rewritten. */
export async function writeRevisionBridge(tx: Prisma.TransactionClient, bookId: number, revisionId: string, workflowRunId?: string, leaseOwner?: string, changedScopes: unknown[] = []) {
  const missing = []; const visited = new Set<string>(); let cursor: string | null = revisionId;
  while (cursor) {
    if (visited.has(cursor)) throw new DocumentError('DOCUMENT_REVISION_GRAPH_INVALID', 'Document ancestry contains a cycle.', 503);
    visited.add(cursor);
    const revision: BookDocumentRevision | null = await tx.bookDocumentRevision.findFirst({ where: { id: cursor, bookId } });
    if (!revision) throw new DocumentError('DOCUMENT_REVISION_MISSING', 'Document ancestry is unavailable.', 503);
    const expected = createHash('sha256').update(canonicalDocument(revision.manifest)).digest('hex');
    if (revision.contentHash !== expected) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Document ancestry checksum is invalid.', 503);
    const existing = await tx.manuscriptRevision.findUnique({ where: { id: cursor } });
    if (existing) {
      const mapping = await tx.documentLegacyRevisionMapping.findUnique({ where: { legacyRevisionId: cursor } });
      if (existing.bookId !== bookId || existing.contentHash !== revision.contentHash || mapping?.bookId !== bookId || mapping.documentRevisionId !== cursor) throw new DocumentError('DOCUMENT_REVISION_BRIDGE_CONFLICT', 'Revision identity conflicts with preserved historical evidence.', 409);
      break;
    }
    missing.push(revision); cursor = revision.parentRevisionId;
  }
  for (const revision of missing.reverse()) {
    const manifest = revision.manifest as unknown as DocumentManifest;
    const snapshot = { schemaVersion: 1, documentRevisionId: revision.id, projection: 'final' };
    await tx.manuscriptRevision.create({ data: {
      id: revision.id, bookId, parentRevisionId: revision.parentRevisionId,
      contentHash: revision.contentHash, wordCount: manifest.scenes.filter((scene) => !scene.deletedAt).reduce((sum, scene) => sum + scene.wordCount, 0),
      snapshot, changedScopes: (revision.id === revisionId ? changedScopes : []) as Prisma.InputJsonValue,
      ...(revision.id === revisionId ? { workflowRunId, leaseOwner } : {}),
      createdAt: revision.createdAt,
    } });
    await tx.documentLegacyRevisionMapping.create({ data: {
      legacyRevisionId: revision.id, bookId, documentRevisionId: revision.id, legacyContentHash: revision.contentHash,
      fidelity: { kind: 'native-document-reference', schemaVersion: 1, projection: 'final', completeDocument: true },
    } });
  }
  return revisionId;
}
