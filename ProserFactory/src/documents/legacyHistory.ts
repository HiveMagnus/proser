import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { documentService, type DocumentManifest } from './service';
import { DocumentError } from './errors';
import { canonicalDocument, defaultLayout, documentFromText, projectDocument } from './model';
import { compatibilityOperationId } from './operationIdentity';
import { readScope, writeScopeRevision, validateScopeMembership } from './scopes';
import { orderedSceneReferences } from './scope-model';
import { validateDocument } from './validation';
import { convertSupportedLegacyHtml } from './legacyHtml';

const sceneSchema = z.object({ id: z.number().int().positive(), chapterId: z.number().int().positive(), sceneNumber: z.number().int().positive(), prose: z.string().nullable(), summary: z.string().nullable(), outline: z.string().nullable() }).strict();
const entrySchema = z.object({ id: z.number().int().positive(), entryType: z.string(), entryName: z.string(), entryDescription: z.string().nullable(), attributes: z.string().nullable() }).strict();
const snapshotSchema = z.object({ scenes: z.array(sceneSchema), codex: z.array(entrySchema) }).strict();
const hash = (value: unknown) => createHash('sha256').update(canonicalDocument(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** Old revisions never recorded whole-document history. Preserve that evidence,
 * convert only what exists, and disclose retained scaffolding without pretending
 * that missing formatting, review or book metadata was recovered. */
async function prepare(tx: Prisma.TransactionClient, bookId: number, legacyRevisionId: string) {
  const legacy = await tx.manuscriptRevision.findFirst({ where: { id: legacyRevisionId, bookId } });
  const head = await tx.bookDocumentHead.findUnique({ where: { bookId } });
  if (!legacy || !head) throw new DocumentError('DOCUMENT_LEGACY_HISTORY_MISSING', 'Owned legacy revision and a verified document head are required.', 404);
  const parsed = snapshotSchema.safeParse(legacy.snapshot);
  if (!parsed.success) throw new DocumentError('DOCUMENT_LEGACY_HISTORY_UNSUPPORTED', 'This preserved snapshot needs a separately reviewed converter; no evidence was changed.', 409);
  const snapshot = parsed.data;
  if (new Set(snapshot.scenes.map((scene) => scene.id)).size !== snapshot.scenes.length || new Set(snapshot.codex.map((entry) => entry.id)).size !== snapshot.codex.length) throw new DocumentError('DOCUMENT_LEGACY_HISTORY_INVALID', 'Historical snapshot contains duplicate identities.', 409);
  const manifest = head.manifest as unknown as DocumentManifest;
  if (!manifest.scopes) throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED', 'Complete current scope backfill before historical conversion.', 409);
  const structure = structuredClone(await readScope(tx, bookId, 'structure', manifest.scopes.structure));
  const canon = structuredClone(await readScope(tx, bookId, 'canon', manifest.scopes.canon));
  const currentScene = new Map(structure.scenes.map((scene) => [scene.id, scene]));
  const currentEntry = new Map(canon.entries.map((entry) => [entry.id, entry]));
  const chapterIds = new Set(snapshot.scenes.map((scene) => scene.chapterId));
  const chapters = structure.chapters.filter((chapter) => chapterIds.has(chapter.id));
  if (chapters.length !== chapterIds.size || snapshot.scenes.some((scene) => !currentScene.has(scene.id)) || snapshot.codex.some((entry) => !currentEntry.has(entry.id))) throw new DocumentError('DOCUMENT_LEGACY_HISTORY_IDENTITIES_MISSING', 'Historical identities cannot be reconstructed from retained owned resources; explicit reconciliation is required.', 409);
  const actIds = new Set(chapters.map((chapter) => chapter.actId));
  structure.acts = structure.acts.filter((act) => actIds.has(act.id)).map((act) => ({ ...act, deletedAt: null }));
  structure.chapters = chapters.map((chapter) => ({ ...chapter, deletedAt: null }));
  structure.scenes = snapshot.scenes.map((scene) => ({ ...currentScene.get(scene.id)!, chapterId: scene.chapterId, sceneNumber: scene.sceneNumber, summary: scene.summary, outline: scene.outline, deletedAt: null }));
  canon.entries = snapshot.codex.map((entry) => ({ ...currentEntry.get(entry.id)!, ...entry, deletedAt: null }));
  // Usage relationships were not saved by the old snapshots. Retaining present
  // usage would manufacture historical evidence.
  canon.usages = [];
  const layout = { schemaVersion: 1 as const, book: defaultLayout(), chapters: {}, frontMatter: [], backMatter: [], styles: { text: {}, paragraph: {} } };
  validateScopeMembership({ structure, canon, layout });
  const documents = snapshot.scenes.map((scene) => {
    let sequence = 0;
    const html = /<\/?(?:p|div|span|h[1-6]|table|img|script|style)\b/i.test(scene.prose ?? '') ? convertSupportedLegacyHtml(scene.prose ?? '', `${legacyRevisionId}:${scene.id}`) : undefined;
    const document = html?.document ?? validateDocument(documentFromText(scene.prose ?? '', () => compatibilityOperationId('proser.legacy-history.identity.v1', { legacyRevisionId, sceneId: scene.id, sequence: sequence++ })));
    return { scene, document, htmlFidelity: html?.fidelity, revisionId: compatibilityOperationId('proser.legacy-history.scene.v1', { legacyRevisionId, sceneId: scene.id }), contentHash: hash(document) };
  });
  const report = {
    schemaVersion: 1, kind: 'preserved-legacy-snapshot', legacyRevisionId, legacyContentHash: legacy.contentHash,
    sourceSnapshotHash: hash(legacy.snapshot), sourceParentLegacyRevisionId: legacy.parentRevisionId, scaffoldBookRevisionId: head.revisionId,
    completeDocument: false, restoration: 'blocked', sceneCount: snapshot.scenes.length, codexCount: snapshot.codex.length,
    preservedFields: ['scene identities/chapter membership/order/prose/summary/outline', 'codex identities/type/name/description/attributes'],
    unrecordedFields: ['book/act/chapter metadata and ordering history', 'scene beats/images/creation timestamps', 'layout/styles/assets/review/comments', 'canon usage relationships', 'original null versus empty where old snapshot normalized prose'],
    retainedScaffold: ['owned act/chapter identities and retained metadata', 'scene/codex metadata outside original snapshot'],
    sceneNullEvidence: snapshot.scenes.map((scene) => ({ sceneId: scene.id, storedProseWasNull: scene.prose === null, originalNullDistinctionKnown: scene.prose === null || scene.prose.length > 0 })),
    htmlConversions: documents.filter((item) => item.htmlFidelity).map((item) => ({ sceneId: item.scene.id, fidelity: item.htmlFidelity })),
    convertedDocuments: documents.map((item) => ({ sceneId: item.scene.id, contentHash: item.contentHash })),
  };
  return { legacy, report, reportHash: hash(report), structure, canon, layout, documents };
}
export async function previewLegacyHistory(userId: number, bookId: number, legacyRevisionId: string) {
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const mapping = await tx.documentLegacyRevisionMapping.findUnique({ where: { legacyRevisionId } });
    if (mapping) {
      if (mapping.bookId !== bookId) throw new DocumentError('DOCUMENT_LEGACY_HISTORY_MISSING', 'Historical revision not found.', 404);
      return { status: 'converted' as const, documentRevisionId: mapping.documentRevisionId, fidelity: mapping.fidelity };
    }
    const result = await prepare(tx, bookId, legacyRevisionId);
    return { status: 'preview' as const, report: result.report, reportHash: result.reportHash };
  });
}
export async function convertLegacyHistory(userId: number, bookId: number, legacyRevisionId: string, consentReportHash: string) {
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const existing = await tx.documentLegacyRevisionMapping.findUnique({ where: { legacyRevisionId } });
    if (existing) {
      const fidelity = existing.fidelity as { reportHash?: string; operatorConsent?: { reportHash?: string } };
      if (existing.bookId !== bookId || fidelity.reportHash !== consentReportHash || fidelity.operatorConsent?.reportHash !== consentReportHash) throw new DocumentError('DOCUMENT_LEGACY_CONSENT_CONFLICT', 'Historical conversion has different retained consent.', 409);
      return existing.documentRevisionId;
    }
    const prepared = await prepare(tx, bookId, legacyRevisionId);
    if (prepared.reportHash !== consentReportHash) throw new DocumentError('DOCUMENT_LEGACY_CONSENT_REQUIRED', 'Explicit consent must match the current historical conversion report.', 409, { reportHash: prepared.reportHash });
    const references = [];
    for (const item of prepared.documents) {
      await tx.sceneDocumentRevision.create({ data: { id: item.revisionId, bookId, sceneId: item.scene.id, schemaVersion: 1, contentHash: item.contentHash, document: json(item.document), originalProse: item.scene.prose, actorId: userId, origin: 'legacy-history', createdAt: prepared.legacy.createdAt } });
      references.push({ sceneId: item.scene.id, chapterId: item.scene.chapterId, sceneNumber: item.scene.sceneNumber, revisionId: item.revisionId, contentHash: item.contentHash, wordCount: projectDocument(item.document).wordCount, deletedAt: null });
    }
    const manifest: DocumentManifest = { schemaVersion: 1, scenes: orderedSceneReferences(references, prepared.structure), scopes: {
      structure: await writeScopeRevision(tx, bookId, userId, 'structure', prepared.structure), canon: await writeScopeRevision(tx, bookId, userId, 'canon', prepared.canon), layout: await writeScopeRevision(tx, bookId, userId, 'layout', prepared.layout),
    } };
    const parentMapping = prepared.legacy.parentRevisionId ? await tx.documentLegacyRevisionMapping.findUnique({ where: { legacyRevisionId: prepared.legacy.parentRevisionId } }) : null;
    const revisionId = compatibilityOperationId('proser.legacy-history.book.v1', { legacyRevisionId });
    await tx.bookDocumentRevision.create({ data: { id: revisionId, bookId, parentRevisionId: parentMapping?.bookId === bookId ? parentMapping.documentRevisionId : null, contentHash: hash(manifest), manifest: json(manifest), actorId: userId, operationId: `legacy-history:${legacyRevisionId}`, createdAt: prepared.legacy.createdAt } });
    await tx.documentLegacyRevisionMapping.create({ data: { legacyRevisionId, bookId, documentRevisionId: revisionId, legacyContentHash: prepared.legacy.contentHash, fidelity: json({ ...prepared.report, reportHash: prepared.reportHash, operatorConsent: { userId, reportHash: consentReportHash, convertedAt: new Date().toISOString() } }) } });
    await tx.auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action: 'create', metadata: { command: 'legacy-history-conversion', legacyRevisionId, documentRevisionId: revisionId, reportHash: consentReportHash, completeDocument: false } } });
    return revisionId;
  });
}
