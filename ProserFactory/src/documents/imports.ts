import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { databaseService } from '@/lib/database';
import { decodeLegacyBundle } from '@/lib/importers/legacyBundle';
import { currentDocumentMutationContext } from '@/services/documentMutationContext';
import { documentService } from './service';
import { DocumentError } from './errors';
import { canonicalDocument, documentFromText, projectDocument, type ProserDocument } from './model';
import { validateDocument } from './validation';
import { appendHierarchy, outlineTreeSchema, type OutlineTree } from './structureCommands';
import { importCommitSchema, importPreviewSchema, requireImportCommitPreconditions } from './importValidation';

const db = () => databaseService.client;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const digest = (value: unknown) => createHash('sha256').update(canonicalDocument(value)).digest('hex');
const byteDigest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
interface Conversion { tree: OutlineTree; documents: ProserDocument[]; codex: Array<{ entryType: string; entryName: string; entryDescription: string; attributes: string }> }
async function owned(userId: number, bookId: number) {
  if (currentDocumentMutationContext()?.userId !== undefined && currentDocumentMutationContext()!.userId !== userId || !await db().book.findFirst({ where: { id: bookId, userId, deletedAt: {} }, select: { id: true } })) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Book not found.', 404);
}
/** Preserve exact bytes before invoking any converter, including on malformed
 * input. Originals are append-only and have no delete/update API. */
export async function preserveImportOriginal(userId: number, bookId: number, id: string, format: 'legacy-markdown-bundle-v1' | 'docx', bytes: Uint8Array) {
  z.string().uuid().parse(id); await owned(userId, bookId);
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024) throw new DocumentError('DOCUMENT_IMPORT_TOO_LARGE', 'Original uploads must contain 1 byte to 32 MiB.', 413);
  const sha256 = byteDigest(bytes);
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const prior = await tx.documentImportOriginal.findUnique({ where: { id } });
    if (prior) { if (prior.bookId !== bookId || prior.userId !== userId || prior.format !== format || prior.sha256 !== sha256 || byteDigest(prior.bytes) !== sha256) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Original ID belongs to another upload.', 409); return { id, sha256, byteLength: prior.byteLength }; }
    await tx.documentImportOriginal.create({ data: { id, userId, bookId, format, sha256, byteLength: bytes.byteLength, bytes: Buffer.from(bytes) } });
    return { id, sha256, byteLength: bytes.byteLength };
  });
}
export async function readImportOriginal(userId: number, bookId: number, id: string) {
  await owned(userId, bookId);
  const row = await db().documentImportOriginal.findFirst({ where: { id, userId, bookId } });
  if (!row) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Original not found.', 404);
  if (row.byteLength !== row.bytes.byteLength || byteDigest(row.bytes) !== row.sha256) throw new DocumentError('DOCUMENT_ORIGINAL_INVALID', 'Preserved original checksum is invalid.', 503);
  return row;
}
export async function prepareLegacyBundleImport(userId: number, bookId: number, input: { operationId: string; originalId: string; expectedRevisionId: string }) {
  importPreviewSchema.parse(input);
  const original = await readImportOriginal(userId, bookId, input.originalId);
  const requestHash = digest({ userId, bookId, input, originalSha256: original.sha256 });
  const previous = await db().documentImportPreview.findUnique({ where: { id: input.operationId } });
  if (previous) { if (previous.userId !== userId || previous.bookId !== bookId || previous.requestHash !== requestHash) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Preview operation belongs to another conversion.', 409); return readImportPreview(userId, bookId, previous.id); }
  const head = await documentService.manifest(userId, bookId);
  if (head.revisionId !== input.expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Book changed before import preview.', 412, { currentRevisionId: head.revisionId });
  const book = await db().book.findUniqueOrThrow({ where: { id: bookId }, select: { title: true } });
  let parsed: ReturnType<typeof decodeLegacyBundle>;
  try { parsed = decodeLegacyBundle(original.bytes, book.title ?? 'Imported manuscript'); }
  catch (error) { if (error instanceof DocumentError) throw error; throw new DocumentError('DOCUMENT_IMPORT_INVALID', 'Original bundle encoding, JSON or metadata is invalid. The original remains preserved.', 422, { originalId: original.id }); }
  const tree = outlineTreeSchema.parse({ acts: parsed.manuscript.acts.map((act) => ({ title: act.title, chapters: act.chapters.map((chapter) => ({ title: chapter.title, summary: chapter.summary, scenes: chapter.scenes.map((scene) => ({ summary: scene.summary, outline: scene.outline })) })) })) });
  const documents = parsed.manuscript.acts.flatMap((act) => act.chapters.flatMap((chapter) => chapter.scenes.map((scene) => validateDocument(documentFromText(scene.prose, randomUUID)))));
  if (!documents.length) throw new DocumentError('DOCUMENT_IMPORT_EMPTY', 'The conversion contains no scenes.', 422);
  if (Buffer.byteLength(canonicalDocument({ tree, documents, codex: parsed.codex })) > 256 * 1024 * 1024) throw new DocumentError('DOCUMENT_IMPORT_TOO_LARGE', 'Converted content exceeds 256 MiB.', 413);
  const conversion: Conversion = { tree, documents, codex: parsed.codex };
  const report = { schemaVersion: 1, codec: 'proser-legacy-markdown-bundle', codecVersion: '1.0.0', originalId: original.id, originalSha256: original.sha256, sourceBookRevisionId: head.revisionId, strategy: 'append-new-identities', convertedSha256: digest(conversion), title: parsed.manuscript.title, byline: parsed.manuscript.byline, actCount: tree.acts.length, chapterCount: tree.acts.reduce((total, act) => total + act.chapters.length, 0), sceneCount: documents.length, wordCount: documents.reduce((total, document) => total + projectDocument(document).wordCount, 0), codexCount: parsed.codex.length, fileNames: parsed.sourceFileNames, losses: [{ code: 'LEGACY_HEADING_WHITESPACE_MAPPING', message: 'Heading/chapter/scene mapping consumes manuscript headings and trims boundary whitespace; carriage returns are normalized only in converted content. Originals remain exact.' }, { code: 'MARKDOWN_FORMATTING_LITERAL', message: 'Inline Markdown, HTML, image references and tables remain literal text; they do not become native formatted objects. No external resources are fetched.' }, { code: 'CODEX_FRONTMATTER_SUBSET', message: 'Only scalar frontmatter name/type fields guide codex conversion. Raw frontmatter and metadata originals are retained.' }, ...(parsed.unconvertedFiles.length ? [{ code: 'UNCONVERTED_SOURCE_FILES', message: 'These originals are retained without conversion.', fileNames: parsed.unconvertedFiles }] : [])] };
  const reportHash = digest(report);
  if (Buffer.byteLength(canonicalDocument({ report, mapping: tree })) > 8 * 1024 * 1024) throw new DocumentError('DOCUMENT_IMPORT_REPORT_TOO_LARGE', 'The complete report and mapping exceed the supported preview size. Originals remain preserved.', 413);
  await documentService.sideRecord(userId, bookId, async (tx) => {
    const current = await tx.bookDocumentHead.findUniqueOrThrow({ where: { bookId } });
    if (current.revisionId !== input.expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Book changed during conversion.', 412);
    const prior = await tx.documentImportPreview.findUnique({ where: { id: input.operationId } });
    if (prior) { if (prior.requestHash !== requestHash || prior.userId !== userId) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Preview ID was reused.', 409); return; }
    await tx.documentImportPreview.create({ data: { id: input.operationId, originalId: original.id, bookId, userId, sourceBookRevision: head.revisionId, requestHash, conversion: json(conversion), report: json(report), reportHash } });
  });
  return readImportPreview(userId, bookId, input.operationId);
}
export async function readImportPreview(userId: number, bookId: number, id: string) {
  await owned(userId, bookId);
  const row = await db().documentImportPreview.findFirst({ where: { id, bookId, userId } });
  if (!row) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Import preview not found.', 404);
  if (digest(row.report) !== row.reportHash || digest(row.conversion) !== (row.report as { convertedSha256?: string }).convertedSha256) throw new DocumentError('DOCUMENT_IMPORT_PREVIEW_INVALID', 'Conversion/report checksum changed.', 503);
  const conversion = row.conversion as unknown as Conversion;
  return { id: row.id, originalId: row.originalId, sourceBookRevisionId: row.sourceBookRevision, reportHash: row.reportHash, report: row.report, mapping: conversion.tree };
}
export async function commitLegacyBundleImport(userId: number, bookId: number, previewId: string, raw: unknown) {
  requireImportCommitPreconditions(raw);
  const input = importCommitSchema.parse(raw);
  const preview = await readImportPreview(userId, bookId, previewId);
  const original = await readImportOriginal(userId, bookId, preview.originalId);
  if (input.consentReportHash !== preview.reportHash) throw new DocumentError('DOCUMENT_IMPORT_CONSENT_REQUIRED', 'Explicit consent to this exact conversion report is required.', 409);
  return documentService.mutateCatalog(userId, bookId, { operationId: input.operationId, expectedRevisionId: input.expectedRevisionId, expectedScopes: input.expectedScopes, payload: { command: 'commit-legacy-import', previewId, input } }, async (tx) => {
    if (preview.sourceBookRevisionId !== input.expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Preview belongs to another book revision. Prepare a new preview.', 412);
    const row = await tx.documentImportPreview.findFirstOrThrow({ where: { id: previewId, bookId, userId } });
    if (digest(row.report) !== input.consentReportHash || digest(row.conversion) !== (row.report as { convertedSha256?: string }).convertedSha256 || (row.report as { originalSha256?: string }).originalSha256 !== original.sha256) throw new DocumentError('DOCUMENT_IMPORT_PREVIEW_INVALID', 'Import evidence changed.', 503);
    const conversion = row.conversion as unknown as Conversion;
    const hierarchy = await appendHierarchy(tx, bookId, outlineTreeSchema.parse(conversion.tree));
    const sceneIds = hierarchy.acts.flatMap((act) => act.chapters.flatMap((chapter) => chapter.sceneIds));
    if (sceneIds.length !== conversion.documents.length) throw new DocumentError('DOCUMENT_IMPORT_PREVIEW_INVALID', 'Scene mapping disagrees with conversion.', 503);
    for (const entry of conversion.codex) await tx.codexEntry.create({ data: { bookId, ...entry } });
    await tx.auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action: 'update', metadata: json({ action: 'import-conversion-consent', previewId, originalId: original.id, originalSha256: original.sha256, reportHash: input.consentReportHash, operationId: input.operationId }) } });
    return { result: { previewId, originalId: original.id, reportHash: input.consentReportHash, hierarchy }, newDocuments: sceneIds.map((sceneId, index) => ({ sceneId, document: validateDocument(conversion.documents[index]) })) };
  });
}
