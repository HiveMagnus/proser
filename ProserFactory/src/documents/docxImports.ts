import { CODEC_VERSION } from '@hivemagnus/canvas-word-codec';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { databaseService } from '@/lib/database';
import { documentService } from './service';
import { readImportOriginal, preserveImportOriginal } from './imports';
import { convertDocx, type DocxIncomingAsset } from './docxImport';
import { extractDocumentLayoutStories } from './layoutStories';
import { imagesOf, paragraphsOf, type ProserDocument, canonicalDocument, projectDocument } from './model';
import { validateDocument } from './validation';
import { appendHierarchy, outlineTreeSchema } from './structureCommands';
import {
  importPreviewSchema,
  docxImportCommitSchema,
  requireDocxImportCommitPreconditions,
} from './importValidation';
import { readScope } from './scopes';
import type { DocumentManifest } from './model';
import { DocumentError } from './errors';
const db = () => databaseService.client;
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalDocument(value)).digest('hex');
const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
interface StoredConversion {
  kind: 'docx';
  schemaVersion: 1;
  documents: Array<{ document: ProserDocument }>;
  headerFooterStories?: Array<{documentIndex:number;kind:'header'|'footer';document:ProserDocument}>;
  styles?:import('./style-model').DocumentStyleDefinitions;
  chapterTitles: string[];
  assets: DocxIncomingAsset[];
}
export async function preserveDocxOriginal(
  userId: number,
  bookId: number,
  id: string,
  bytes: Uint8Array,
) {
  return preserveImportOriginal(userId, bookId, id, 'docx', bytes);
}
export async function prepareDocxImport(userId: number, bookId: number, raw: unknown) {
  const input = importPreviewSchema.parse(raw);
  const original = await readImportOriginal(userId, bookId, input.originalId);
  if (original.format !== 'docx')
    throw new DocumentError(
      'DOCUMENT_IMPORT_FORMAT_INVALID',
      'Original is not a DOCX upload.',
      422,
    );
  const requestHash = digest({
    userId,
    bookId,
    input,
    originalSha256: original.sha256,
    codecVersion: CODEC_VERSION,
  });
  const previous = await db().documentImportPreview.findUnique({
    where: { id: input.operationId },
  });
  if (previous) {
    if (
      previous.userId !== userId ||
      previous.bookId !== bookId ||
      previous.requestHash !== requestHash
    )
      throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Preview ID was reused.', 409);
    return readDocxImportPreview(userId, bookId, previous.id);
  }
  const head = await documentService.manifest(userId, bookId);
  if (head.revisionId !== input.expectedRevisionId)
    throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Book changed before conversion.', 412);
  const converted = await convertDocx(Buffer.from(original.bytes));
  const conversion: StoredConversion = {
    kind: 'docx',
    schemaVersion: 1,
    documents: converted.documents.map((document) => ({ document })),
    headerFooterStories: converted.headerFooterStories,
    styles:converted.styles,
    chapterTitles: converted.chapterTitles,
    assets: converted.assets,
  };
  const report = {
    schemaVersion: 1,
    format: 'docx',
    codecVersion: CODEC_VERSION,
    originalId: original.id,
    originalSha256: original.sha256,
    convertedSha256: digest(conversion),
    strategy: 'append-heading-mapped-chapters',
    chapterCount: conversion.documents.length,
    wordCount: conversion.documents.reduce(
      (count, item) => count + projectDocument(item.document).wordCount,
      0,
    ),
    detected: converted.detected,
    losses: converted.losses,
    externalResourcesFetched: false,
    nativeParagraphRevisionAcceptance: 'unverified',
    mapping: conversion.chapterTitles.map((title, index) => ({
      chapterIndex: index,
      title,
      sceneCount: 1,
    })),
  };
  const reportHash = digest(report);
  if (
    Buffer.byteLength(canonicalDocument(conversion)) > 256 * 1024 * 1024 ||
    Buffer.byteLength(canonicalDocument(report)) > 8 * 1024 * 1024
  )
    throw new DocumentError(
      'DOCUMENT_IMPORT_TOO_LARGE',
      'Conversion exceeds retained limits.',
      413,
    );
  await documentService.sideRecord(userId, bookId, async (tx) => {
    const current = await tx.bookDocumentHead.findUniqueOrThrow({ where: { bookId } });
    if (current.revisionId !== input.expectedRevisionId)
      throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Book changed during conversion.', 412);
    const prior = await tx.documentImportPreview.findUnique({ where: { id: input.operationId } });
    if (prior) {
      if (prior.requestHash !== requestHash || prior.userId !== userId)
        throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Preview ID reused.', 409);
      return;
    }
    await tx.documentImportPreview.create({
      data: {
        id: input.operationId,
        originalId: original.id,
        bookId,
        userId,
        sourceBookRevision: head.revisionId,
        requestHash,
        conversion: json(conversion),
        report: json(report),
        reportHash,
      },
    });
  });
  return readDocxImportPreview(userId, bookId, input.operationId);
}
export async function readDocxImportPreview(userId: number, bookId: number, id: string) {
  const row = await db().documentImportPreview.findFirst({ where: { id, bookId, userId } });
  if (!row) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Import preview not found.', 404);
  await readImportOriginal(userId, bookId, row.originalId);
  if (
    digest(row.report) !== row.reportHash ||
    digest(row.conversion) !== (row.report as { convertedSha256: string }).convertedSha256
  )
    throw new DocumentError(
      'DOCUMENT_IMPORT_PREVIEW_INVALID',
      'Conversion/report checksum changed.',
      503,
    );
  const conversion = row.conversion as unknown as StoredConversion;
  if (conversion.kind !== 'docx')
    throw new DocumentError('DOCUMENT_IMPORT_FORMAT_INVALID', 'Preview is not DOCX.', 422);
  return {
    id: row.id,
    originalId: row.originalId,
    sourceBookRevisionId: row.sourceBookRevision,
    reportHash: row.reportHash,
    report: row.report,
    mapping: conversion.chapterTitles.map((title, index) => ({
      chapterIndex: index,
      title,
      sceneCount: 1,
    })),
    documents: conversion.documents.map((item) => item.document),
    headerFooterStories: conversion.headerFooterStories ?? [],
    styles:conversion.styles,
  };
}
export async function commitDocxImport(
  userId: number,
  bookId: number,
  previewId: string,
  raw: unknown,
) {
  requireDocxImportCommitPreconditions(raw);
  const input = docxImportCommitSchema.parse(raw);
  const preview = await readDocxImportPreview(userId, bookId, previewId);
  const original = await readImportOriginal(userId, bookId, preview.originalId);
  if (input.consentReportHash !== preview.reportHash)
    throw new DocumentError(
      'DOCUMENT_IMPORT_CONSENT_REQUIRED',
      'Explicit consent to this exact fidelity report is required.',
      409,
    );
  const row = await db().documentImportPreview.findFirstOrThrow({
    where: { id: previewId, bookId, userId },
  });
  const conversion = row.conversion as unknown as StoredConversion;
  // Content-addressed bytes are written exclusively, before DB references commit.
  // A failed transaction can leave an unreferenced immutable blob, never a visible asset.
  const root = path.resolve('public/images');
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const asset of conversion.assets) {
    const bytes = Buffer.from(asset.bytesBase64, 'base64');
    if (bytesHash(bytes) !== asset.sha256)
      throw new DocumentError(
        'DOCUMENT_IMPORT_PREVIEW_INVALID',
        'Retained image checksum changed.',
        503,
      );
    const filename = `import-${asset.sha256}.${asset.mediaType === 'image/png' ? 'png' : 'jpg'}`;
    try {
      await writeFile(path.join(root, filename), bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
        throw error;
      if (bytesHash(await readFile(path.join(root, filename))) !== asset.sha256)
        throw new DocumentError(
          'DOCUMENT_IMPORT_ASSET_INVALID',
          'Existing content-addressed image bytes changed.',
          503,
        );
    }
  }
  return documentService.mutateCatalog(
    userId,
    bookId,
    {
      operationId: input.operationId,
      expectedRevisionId: input.expectedRevisionId,
      expectedScopes: input.expectedScopes,
      payload: { command: 'commit-docx-import', previewId, input },
    },
    async (tx) => {
      if (preview.sourceBookRevisionId !== input.expectedRevisionId)
        throw new DocumentError(
          'DOCUMENT_SOURCE_STALE',
          'Preview belongs to another saved revision.',
          412,
        );
      const stored = await tx.documentImportPreview.findFirstOrThrow({
        where: { id: previewId, bookId, userId },
      });
      if (
        digest(stored.report) !== input.consentReportHash ||
        digest(stored.conversion) !== (stored.report as { convertedSha256: string }).convertedSha256
      )
        throw new DocumentError(
          'DOCUMENT_IMPORT_PREVIEW_INVALID',
          'Retained preview changed.',
          503,
        );
      const assetIds = new Map<number, number>();
      for (const asset of conversion.assets) {
        const filename = `import-${asset.sha256}.${asset.mediaType === 'image/png' ? 'png' : 'jpg'}`;
        const image = await tx.imageAsset.create({
          data: {
            userId,
            bookId,
            name: filename,
            url: `/images/${filename}`,
            source: 'document-import',
            configJson: JSON.stringify({
              sha256: asset.sha256,
              mediaType: asset.mediaType,
              originalId: original.id,
              previewId,
              width: asset.width,
              height: asset.height,
            }),
          },
        });
        assetIds.set(asset.placeholderId, image.id);
      }
      const tree = outlineTreeSchema.parse({
        acts: [
          {
            title: 'Imported manuscript',
            chapters: conversion.chapterTitles.map((title) => ({ title, scenes: [{}] })),
          },
        ],
      });
      const hierarchy = await appendHierarchy(tx, bookId, tree);
      const sceneIds = hierarchy.acts.flatMap((act) =>
        act.chapters.flatMap((chapter) => chapter.sceneIds),
      );
      const chapters = hierarchy.acts.flatMap((act) => act.chapters);
      const importedStories: import('./scope-model').HeaderFooterStory[] = [];
      const importStoryMappings: Array<{documentIndex:number;sceneId:number;kind:'header'|'footer';storyId:string}> = [];
      const remapAssets = (document:ProserDocument) => {
        for (const image of imagesOf(document)) {
          const assetId = assetIds.get(image.assetId); if (!assetId) throw new DocumentError('DOCUMENT_IMPORT_ASSET_MISSING', 'Converted image has no retained owned asset.', 422);
          const block = document.blocks.find((block) => block.type === 'image' && block.id === image.id);
          if (block?.type === 'image') block.assetId = assetId;
          else for (const paragraph of paragraphsOf(document, true)) for (const run of paragraph.runs) if (run.id === image.id && run.inlineImage) run.inlineImage.assetId = assetId;
        }
        return validateDocument(document);
      };
      const documents = conversion.documents.map((item,documentIndex) => {
        const extracted = extractDocumentLayoutStories(item.document, chapters[documentIndex].id);
        for (const retained of conversion.headerFooterStories ?? []) if(retained.documentIndex===documentIndex) {
          const existing=extracted.stories.find((story)=>story.kind===retained.kind);
          if(existing) existing.document=structuredClone(retained.document);
          else extracted.stories.push({id:randomUUID(),owner:'chapter',chapterId:chapters[documentIndex].id,kind:retained.kind,document:structuredClone(retained.document)});
        }
        for (const story of extracted.stories) {story.document=remapAssets(story.document);importedStories.push(story);importStoryMappings.push({documentIndex,sceneId:sceneIds[documentIndex],kind:story.kind,storyId:story.id});}
        return remapAssets(extracted.document);
      });
      await tx.auditLog.create({
        data: {
          userId,
          entityType: 'book',
          entityId: bookId,
          action: 'update',
          metadata: json({
            action: 'docx-import-conversion-consent',
            previewId,
            originalId: original.id,
            originalSha256: original.sha256,
            reportHash: input.consentReportHash,
            operationId: input.operationId,
          }),
        },
      });
      const manifest = (await tx.bookDocumentHead.findUniqueOrThrow({ where: { bookId } }))
        .manifest as unknown as DocumentManifest;
      if (!manifest.scopes)
        throw new DocumentError(
          'DOCUMENT_SCOPE_BACKFILL_REQUIRED',
          'Layout authority unavailable.',
          409,
        );
      const layout = await readScope(tx, bookId, 'layout', manifest.scopes.layout);
      for (const [index, chapter] of hierarchy.acts[0].chapters.entries())
        layout.chapters[String(chapter.id)] = structuredClone(documents[index].layout);
      if(conversion.styles)layout.styles={text:{...layout.styles.text,...conversion.styles.text},paragraph:{...layout.styles.paragraph,...conversion.styles.paragraph},labels:{...layout.styles.labels,...conversion.styles.labels}};
      layout.headerFooterStories = [...(layout.headerFooterStories ?? []), ...importedStories];
      return {
        importStoryMappings,
        layout,
        result: {
          previewId,
          originalId: original.id,
          reportHash: input.consentReportHash,
          hierarchy,
        },
        newDocuments: sceneIds.map((sceneId, index) => ({ sceneId, document: documents[index] })),
        importSource: {
          originalId: original.id,
          originalSha256: original.sha256,
          previewId,
          reportHash: input.consentReportHash,
        },
      };
    },
    'import',
  );
}
