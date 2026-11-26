import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { databaseService } from '@/lib/database';
import { decodeLegacyBundle } from '@/lib/importers/legacyBundle';
import { documentFromLegacyMarkdown } from '@/lib/importers/legacyMarkdown';
import { parsePlainManuscript, plainManuscriptFormats, type PlainManuscriptFormat } from '@/lib/importers/plainManuscript';
import { currentDocumentMutationContext } from '@/services/documentMutationContext';
import { documentService } from './service';
import { DocumentError } from './errors';
import { canonicalDocument, documentFromText, projectDocument, type ProserDocument } from './model';
import { validateDocument } from './validation';
import { appendHierarchy, outlineTreeSchema, type OutlineTree } from './structureCommands';
import { importCommitSchema, importPreviewSchema, requireImportCommitPreconditions } from './importValidation';
import { importOriginalQuota } from '@/lib/storageQuota';

const db = () => databaseService.client;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const digest = (value: unknown) => createHash('sha256').update(canonicalDocument(value)).digest('hex');
const byteDigest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
interface Conversion { tree: OutlineTree; documents: ProserDocument[]; codex: Array<{ entryType: string; entryName: string; entryDescription: string; attributes: string }> }
async function owned(userId: number, bookId: number) {
  if (currentDocumentMutationContext()?.userId !== undefined && currentDocumentMutationContext()!.userId !== userId || !await db().book.findFirst({ where: { id: bookId, userId, deletedAt: {} }, select: { id: true } })) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Book not found.', 404);
}
/** Preserve exact bytes before invoking any converter, including on malformed
 * input. Originals never change. An unused one can be deleted with
 * deleteImportOriginal; a committed import's original is kept as evidence. */
export type ImportOriginalFormat = 'legacy-markdown-bundle-v1' | 'docx' | PlainManuscriptFormat;
export const textImportFormats = ['legacy-markdown-bundle-v1', ...plainManuscriptFormats] as const;
export async function preserveImportOriginal(userId: number, bookId: number, id: string, format: ImportOriginalFormat, bytes: Uint8Array) {
  z.string().uuid().parse(id); await owned(userId, bookId);
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024) throw new DocumentError('DOCUMENT_IMPORT_TOO_LARGE', 'Original uploads must contain 1 byte to 32 MiB.', 413);
  const sha256 = byteDigest(bytes);
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const prior = await tx.documentImportOriginal.findUnique({ where: { id } });
    if (prior) { if (prior.bookId !== bookId || prior.userId !== userId || prior.format !== format || prior.sha256 !== sha256 || byteDigest(prior.bytes) !== sha256) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Original ID belongs to another upload.', 409); return { id, sha256, byteLength: prior.byteLength }; }
    const quota = importOriginalQuota();
    const [book, user] = await Promise.all([
      tx.documentImportOriginal.aggregate({ where: { bookId }, _sum: { byteLength: true } }),
      tx.documentImportOriginal.aggregate({ where: { userId }, _sum: { byteLength: true } }),
    ]);
    if ((book._sum.byteLength ?? 0) + bytes.byteLength > quota.bookBytes) throw new DocumentError('DOCUMENT_IMPORT_QUOTA_EXCEEDED', 'This book has reached its preserved import storage limit.', 413);
    if ((user._sum.byteLength ?? 0) + bytes.byteLength > quota.userBytes) throw new DocumentError('DOCUMENT_IMPORT_QUOTA_EXCEEDED', 'This account has reached its preserved import storage limit.', 413);
    await tx.documentImportOriginal.create({ data: { id, userId, bookId, format, sha256, byteLength: bytes.byteLength, bytes: Buffer.from(bytes) } });
    return { id, sha256, byteLength: bytes.byteLength };
  });
}
/** Originals a committed import came from, by the audit record of that commit:
 * legacy bundle commits record originalId, DOCX commits importSource.originalId. */
async function committedOriginalIds(client: Pick<Prisma.TransactionClient, '$queryRaw'>, bookId: number): Promise<Set<string>> {
  const rows = await client.$queryRaw<Array<{ id: string | null }>>`SELECT DISTINCT unnest(ARRAY[metadata->>'originalId', metadata->'importSource'->>'originalId']) AS id FROM audit_log WHERE entity_type = 'book' AND entity_id = ${bookId} AND (metadata ? 'originalId' OR metadata ? 'importSource')`;
  return new Set(rows.flatMap((row) => (row.id ? [row.id] : [])));
}

/** The owner's preserved originals for one book, with storage use against the quota. */
export async function listImportOriginals(userId: number, bookId: number) {
  await owned(userId, bookId);
  const [rows, previews, committed, bookUse, userUse] = await Promise.all([
    db().documentImportOriginal.findMany({ where: { bookId, userId }, select: { id: true, format: true, sha256: true, byteLength: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
    db().documentImportPreview.groupBy({ by: ['originalId'], where: { bookId }, _count: { _all: true } }),
    committedOriginalIds(db(), bookId),
    db().documentImportOriginal.aggregate({ where: { bookId }, _sum: { byteLength: true } }),
    db().documentImportOriginal.aggregate({ where: { userId }, _sum: { byteLength: true } }),
  ]);
  const previewCounts = new Map(previews.map((row) => [row.originalId, row._count._all]));
  return {
    originals: rows.map((row) => ({ ...row, previewCount: previewCounts.get(row.id) ?? 0, committed: committed.has(row.id), deletable: !committed.has(row.id) })),
    usage: { bookBytes: bookUse._sum.byteLength ?? 0, userBytes: userUse._sum.byteLength ?? 0 },
    quota: importOriginalQuota(),
  };
}

/** Delete an original no committed import used, with its uncommitted previews.
 * A committed import's original and preview stay as its evidence. */
export async function deleteImportOriginal(userId: number, bookId: number, id: string) {
  z.string().uuid().parse(id); await owned(userId, bookId);
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const original = await tx.documentImportOriginal.findFirst({ where: { id, bookId, userId }, select: { id: true, byteLength: true } });
    if (!original) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Original not found.', 404);
    if ((await committedOriginalIds(tx, bookId)).has(id)) throw new DocumentError('DOCUMENT_IMPORT_ORIGINAL_COMMITTED', 'A committed import came from this original, so it is kept as evidence.', 409);
    const previews = await tx.documentImportPreview.deleteMany({ where: { originalId: id, bookId } });
    await tx.documentImportOriginal.delete({ where: { id } });
    return { id, deleted: true, byteLength: original.byteLength, previewsDeleted: previews.count };
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
  const format = original.format as ImportOriginalFormat;
  if (!(textImportFormats as readonly string[]).includes(format)) throw new DocumentError('DOCUMENT_IMPORT_INVALID', 'This original uses another import format. Use its own preview route.', 422, { originalId: original.id, format });
  const plain = format === 'markdown' || format === 'plain-text';
  let parsed: Pick<ReturnType<typeof decodeLegacyBundle>, 'manuscript' | 'codex' | 'sourceFileNames' | 'unconvertedFiles'>;
  let plainDetails: ReturnType<typeof parsePlainManuscript> | null = null;
  try {
    if (plain) { plainDetails = parsePlainManuscript(original.bytes, format, book.title ?? 'Imported manuscript'); parsed = { manuscript: plainDetails, codex: [], sourceFileNames: [], unconvertedFiles: [] }; }
    else parsed = decodeLegacyBundle(original.bytes, book.title ?? 'Imported manuscript');
  }
  catch (error) { if (error instanceof DocumentError) throw error; throw new DocumentError('DOCUMENT_IMPORT_INVALID', plain ? 'The manuscript text could not be read. The original remains preserved.' : 'Original bundle encoding, JSON or metadata is invalid. The original remains preserved.', 422, { originalId: original.id }); }
  const tree = outlineTreeSchema.parse({ acts: parsed.manuscript.acts.map((act) => ({ title: act.title, chapters: act.chapters.map((chapter) => ({ title: chapter.title, summary: chapter.summary, scenes: chapter.scenes.map((scene) => ({ summary: scene.summary, outline: scene.outline })) })) })) });
  // Plain text has no markup, so asterisks and underscores stay as typed.
  const convert = format === 'plain-text' ? (prose: string) => documentFromText(prose, randomUUID) : (prose: string) => documentFromLegacyMarkdown(prose, randomUUID);
  const documents = parsed.manuscript.acts.flatMap((act) => act.chapters.flatMap((chapter) => chapter.scenes.map((scene) => validateDocument(convert(scene.prose)))));
  if (!documents.length) throw new DocumentError('DOCUMENT_IMPORT_EMPTY', 'The conversion contains no scenes.', 422);
  if (Buffer.byteLength(canonicalDocument({ tree, documents, codex: parsed.codex })) > 256 * 1024 * 1024) throw new DocumentError('DOCUMENT_IMPORT_TOO_LARGE', 'Converted content exceeds 256 MiB.', 413);
  const conversion: Conversion = { tree, documents, codex: parsed.codex };
  const counts = { actCount: tree.acts.length, chapterCount: tree.acts.reduce((total, act) => total + act.chapters.length, 0), sceneCount: documents.length, wordCount: documents.reduce((total, document) => total + projectDocument(document).wordCount, 0) };
  const report = plainDetails
    ? { schemaVersion: 1, codec: 'proser-plain-manuscript', codecVersion: '1.0.0', format, originalId: original.id, originalSha256: original.sha256, sourceBookRevisionId: head.revisionId, strategy: 'append-new-identities', convertedSha256: digest(conversion), title: plainDetails.title, byline: plainDetails.byline, ...counts, codexCount: 0, encoding: plainDetails.encoding, paragraphMode: plainDetails.paragraphMode, fileNames: [], losses: plainManuscriptLosses(format as PlainManuscriptFormat, plainDetails) }
    : { schemaVersion: 1, codec: 'proser-legacy-markdown-bundle', codecVersion: '1.1.0', originalId: original.id, originalSha256: original.sha256, sourceBookRevisionId: head.revisionId, strategy: 'append-new-identities', convertedSha256: digest(conversion), title: parsed.manuscript.title, byline: parsed.manuscript.byline, ...counts, codexCount: parsed.codex.length, fileNames: parsed.sourceFileNames, losses: [{ code: 'LEGACY_HEADING_WHITESPACE_MAPPING', message: 'Heading/chapter/scene mapping consumes manuscript headings and trims boundary whitespace; carriage returns and Markdown line breaks are normalized only in converted content. Originals remain exact.' }, { code: 'MARKDOWN_INLINE_STYLE_SUBSET', message: 'Manuscript emphasis, strong emphasis, strikethrough and code spans become native text styles. Links, HTML, image references and tables stay as text. No external resources are fetched.' }, { code: 'CODEX_FRONTMATTER_SUBSET', message: 'Only scalar frontmatter name/type fields guide codex conversion. Raw frontmatter and metadata originals are retained.' }, ...(parsed.unconvertedFiles.length ? [{ code: 'UNCONVERTED_SOURCE_FILES', message: 'These originals are retained without conversion.', fileNames: parsed.unconvertedFiles }] : [])] };
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
/** What a Markdown or plain-text conversion changes, so the writer can consent
 * to the exact mapping. The original file is always kept byte for byte. */
function plainManuscriptLosses(format: PlainManuscriptFormat, details: ReturnType<typeof parsePlainManuscript>) {
  const losses: Array<{ code: string; message: string; count?: number }> = [
    format === 'markdown'
      ? { code: 'PLAIN_HEADING_MAPPING', message: 'Each chapter-level heading starts a new chapter and becomes its title; a lone first top-level heading is the book title, and "Part" headings above chapters start new parts. Text before the first chapter becomes an "Opening" chapter. Underlined (setext) headings are not detected.' }
      : { code: 'PLAIN_HEADING_MAPPING', message: 'Lines such as "Chapter 1", "Chapter Two: The Storm", "Prologue" or "Epilogue" on their own start chapters, and "Part One" lines start parts. Text before the first chapter becomes an "Opening" chapter.' },
    { code: 'PARAGRAPH_WHITESPACE_NORMALIZED', message: details.paragraphMode === 'line' ? 'This file has one paragraph per line, so each line becomes a paragraph. Indentation and blank lines are not kept.' : format === 'markdown' ? 'Blank lines separate paragraphs. Other line breaks inside a paragraph become spaces, except Markdown hard breaks. Indentation is not kept.' : 'Blank lines separate paragraphs. Line breaks inside a paragraph become spaces, and indentation is not kept.' },
    format === 'markdown'
      ? { code: 'MARKDOWN_INLINE_STYLE_SUBSET', message: 'Emphasis, strong emphasis, strikethrough and code spans become native text styles. Links, HTML, image references, lists, block quotes, code blocks and tables stay as text. No external resources are fetched.' }
      : { code: 'PLAIN_TEXT_NO_STYLES', message: 'Plain text has no formatting, so asterisks and underscores stay as typed.' },
  ];
  if (details.sceneBreakCount) losses.push({ code: 'SCENE_BREAK_MARKERS', message: 'Scene-break lines (such as ***, * * * or #) split chapters into scenes and are not kept as text.', count: details.sceneBreakCount });
  if (details.demotedHeadingCount) losses.push({ code: 'SUBHEADINGS_AS_PARAGRAPHS', message: 'Headings below chapter level become ordinary paragraphs.', count: details.demotedHeadingCount });
  if (details.frontmatterRemoved) losses.push({ code: 'FRONTMATTER_NOT_CONVERTED', message: 'The YAML front matter block is not converted. Only its title is shown in this report.' });
  if (details.encoding === 'windows-1252') losses.push({ code: 'LEGACY_TEXT_ENCODING', message: 'This file is not UTF-8, so it was read as Windows-1252 (Western European). Check accented letters and quotation marks in the preview.' });
  return losses;
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
