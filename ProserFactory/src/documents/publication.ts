import { CODEC_VERSION } from '@hivemagnus/canvas-word-codec';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { chromium } from 'playwright';
import { databaseService } from '@/lib/database';
import {assertPublicationReleaseAdmission,bindReleaseAdmission,runAdmittedBackground} from '@/operations/releaseAdmission';
import { inspectImageMetadata } from '@/lib/imageMetadata';
import {
  currentDocumentMutationContext,
  withDocumentMutationContext,
} from '@/services/documentMutationContext';
import { documentService } from './service';
import { DocumentError } from './errors';
import { detachedHistoricalBoundaryIds } from './wordExchange';
import { verifyPublicationFonts } from './runtimeReadiness';
import { imagesOf, paragraphsOf,
  canonicalDocument,
  projectDocument,
  type DocumentManifest,
  type DocumentLayout,
} from './model';
import { readScope } from './scopes';
import { layoutStory } from './layoutStories';
import { validateDocument } from './validation';
import type { DocumentPublicationJob, DocumentPublicationCapabilities } from './publication-model';
import { publicationJobSchema, publicationOptionsSchema } from './publicationValidation';
import { publicationDocxDetailed } from './publicationDocx';
import type {PublicationImageDerivation} from './publicationImages';
import {
  publicationDocuments,
  publicationJson,
  publicationEpub,
  publicationPdf,
  publicationHtml,
  publicationMarkdown,
  publicationText,
  reviewSidecar,
  bytesSha256,
  type PublicationInput,
  type PublicationFormat,
} from './publicationRender';
import { type ExportMode, type DocxAsset } from './docxExport';
import { validateDocxPackage, readDocumentPackage, parseDocumentXml } from './packageValidation';
const db = () => databaseService.client;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalDocument(value)).digest('hex');
interface JobManifest {
  schemaVersion: 1;
  requestHash: string;
  sourceManifest: DocumentManifest;
  sourceHash: string;
  lease?: { token: string; until: string };
  artifactId?: string;
  errorMessage?: string;
  fidelity?: import('./publication-model').DocumentPublicationFidelity;
}
const formats: Record<PublicationFormat, { mediaType: string; extension: string }> = {
  docx: {
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  },
  epub: { mediaType: 'application/epub+zip', extension: 'epub' },
  pdf: { mediaType: 'application/pdf', extension: 'pdf' },
  html: { mediaType: 'text/html; charset=utf-8', extension: 'html' },
  markdown: { mediaType: 'text/markdown; charset=utf-8', extension: 'md' },
  text: { mediaType: 'text/plain; charset=utf-8', extension: 'txt' },
  json: { mediaType: 'application/json', extension: 'json' },
};
async function owned(userId: number, bookId: number) {
  const context = currentDocumentMutationContext();
  if (
    (context && context.userId !== userId) ||
    !(await db().book.findFirst({
      where: { id: bookId, userId, deletedAt: {} },
      select: { id: true },
    }))
  )
    throw new DocumentError('PUBLICATION_NOT_FOUND', 'Book not found.', 404);
}
export async function publicationCapabilities(
  userId: number,
  bookId: number,
): Promise<DocumentPublicationCapabilities> {
  await owned(userId, bookId);
  let pdf = false;
  try {
    await access(chromium.executablePath());
    await verifyPublicationFonts();
    pdf = true;
  } catch {
    /* Failed renderers are disclosed before requesting jobs. */
  }
  return {
    schemaVersion: 1,
    modes: ['retain-review', 'final', 'original'],
    presets: ['saved', 'submission-manuscript', 'print-book'],
    formats: Object.entries(formats).map(([format, info]) => ({
      format,
      ...info,
      available: format !== 'pdf' || pdf,
      reason:
        format === 'pdf' && !pdf
          ? 'Pinned Chromium or verified licensed fonts are unavailable.'
          : null,
      review:
        format === 'docx'
          ? 'native'
          : format === 'epub'
            ? 'sidecar'
            : format === 'markdown'
              ? 'sidecar-download'
              : format === 'html' || format === 'pdf'
                ? 'visual-markup'
                : 'projection',
    })),
    nativeCommentRanges:{maximum:32767,contiguousOnly:true,headerFooterSupported:false,scope:'body-and-table-cell-paragraphs'},
    codecVersion: CODEC_VERSION,
    rendererVersion: chromium.executablePath(),
    wordAcceptance: 'unverified',
  };
}
export async function createPublicationJob(userId: number, bookId: number, raw: unknown) {
  const input = publicationJobSchema.parse(raw);
  await owned(userId,bookId);const requestHash=hash({userId,bookId,input});const recovered=await db().documentPublication.findFirst({where:{id:input.operationId,userId,bookId}});
  if(recovered){if((recovered.manifest as unknown as JobManifest).requestHash!==requestHash)throw new DocumentError('DOCUMENT_OPERATION_CONFLICT','Publication operation ID was reused.',409);return publicationSummary(recovered);}
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const prior = await tx.documentPublication.findUnique({ where: { id: input.operationId } });
    const requestHash = hash({ userId, bookId, input });
    if (prior) {
      if (
        prior.bookId !== bookId ||
        prior.userId !== userId ||
        (prior.manifest as unknown as JobManifest).requestHash !== requestHash
      )
        throw new DocumentError(
          'DOCUMENT_OPERATION_CONFLICT',
          'Publication operation ID was reused.',
          409,
        );
      return publicationSummary(prior);
    }
    await assertPublicationReleaseAdmission(tx,userId,bookId);
    const head = await tx.bookDocumentHead.findUnique({ where: { bookId } });
    if (!head)
      throw new DocumentError('DOCUMENT_NOT_MIGRATED', 'Document authority is unavailable.', 409);
    if (head.revisionId !== input.expectedRevisionId)
      throw new DocumentError(
        'DOCUMENT_SOURCE_STALE',
        'Book changed before publication admission.',
        412,
      );
    const revision = await tx.bookDocumentRevision.findUnique({ where: { id: head.revisionId } });
    if (!revision || revision.bookId !== bookId || hash(head.manifest) !== revision.contentHash)
      throw new DocumentError(
        'DOCUMENT_MANIFEST_INVALID',
        'Publication source checksum is invalid.',
        503,
      );
    const manifest: JobManifest = {
      schemaVersion: 1,
      requestHash,
      sourceManifest: head.manifest as unknown as DocumentManifest,
      sourceHash: revision.contentHash,
    };
    const row = await tx.documentPublication.create({
      data: {
        id: input.operationId,
        bookId,
        userId,
        revisionId: head.revisionId,
        status: 'pending',
        options: json(input.options),
        manifest: json(manifest),
      },
    });
    await bindReleaseAdmission(tx,'publication',row.id,{bookId,revisionId:row.revisionId,hash:manifest.sourceHash});
    await tx.auditLog.create({
      data: {
        userId,
        entityType: 'book',
        entityId: bookId,
        action: 'create',
        metadata: json({
          type: 'document-publication-admission',
          operationId: row.id,
          sourceRevisionId: row.revisionId,
          options: input.options,
        }),
      },
    });
    return publicationSummary(row);
  });
}
function publicationSummary(row: {
  id: string;
  revisionId: string;
  status: string;
  options: Prisma.JsonValue;
  manifest: Prisma.JsonValue;
  errorCode: string | null;
  createdAt: Date;
  bookId: number;
}): DocumentPublicationJob {
  const manifest = row.manifest as unknown as JobManifest;
  return {
    id: row.id,
    sourceRevisionId: row.revisionId,
    sourceHash: manifest.sourceHash,
    status: row.status,
    options: publicationOptionsSchema.parse(row.options),
    errorCode: row.errorCode,
    errorMessage: manifest.errorMessage ?? null,
    createdAt: row.createdAt.toISOString(),
    artifactId: manifest.artifactId ?? null,
    ...(manifest.fidelity ? { fidelity: manifest.fidelity } : {}),
    downloadPath: manifest.artifactId
      ? `/api/books/${row.bookId}/document-publication-artifacts/${manifest.artifactId}/download`
      : null,
    reviewSidecarPath: manifest.artifactId
      ? `/api/books/${row.bookId}/document-publication-artifacts/${manifest.artifactId}/review`
      : null,
  };
}
export async function readPublicationJob(userId: number, bookId: number, id: string) {
  await owned(userId, bookId);
  const row = await db().documentPublication.findFirst({ where: { id, bookId, userId } });
  if (!row) throw new DocumentError('PUBLICATION_NOT_FOUND', 'Publication job not found.', 404);
  return publicationSummary(row);
}
function preset(layout: DocumentLayout, name: string): DocumentLayout {
  if (name === 'saved') return structuredClone(layout);
  return {
    ...structuredClone(layout),
    preset: name === 'print-book' ? 'book' : 'manuscript',
    width: name === 'print-book' ? 576 : 816,
    height: name === 'print-book' ? 864 : 1056,
    margins: name === 'print-book' ? [72, 60, 72, 84] : [96, 96, 96, 96],
    font: name === 'print-book' ? 'Liberation Serif' : 'Liberation Mono',
    fontSize: 16,
    pageNumbers: true,
  };
}
async function materialize(
  userId: number,
  bookId: number,
  revisionId: string,
  expected: JobManifest,
  presetName: string,
): Promise<PublicationInput> {
  await owned(userId, bookId);
  const row = await db().bookDocumentRevision.findFirst({ where: { id: revisionId, bookId } });
  if (
    !row ||
    row.contentHash !== expected.sourceHash ||
    hash(row.manifest) !== expected.sourceHash ||
    hash(expected.sourceManifest) !== expected.sourceHash
  )
    throw new DocumentError(
      'DOCUMENT_MANIFEST_INVALID',
      'Immutable publication source is invalid.',
      503,
    );
  const manifest = expected.sourceManifest;
  if (!manifest.scopes)
    throw new DocumentError(
      'DOCUMENT_SCOPE_BACKFILL_REQUIRED',
      'Complete layout and structure are required.',
      409,
    );
  const structure = await readScope(db(), bookId, 'structure', manifest.scopes.structure);
  const layout = await readScope(db(), bookId, 'layout', manifest.scopes.layout);
  const author = await db().user.findUnique({ where: { id: userId }, select: { username: true } });
  const sections: PublicationInput['sections'] = [];
  let canonicalBytes = 0;
  for (const story of layout.frontMatter)
    sections.push({
      id: story.id,
      title: story.name,
      document: validateDocument({
        ...story.document,
        layout: preset(story.document.layout, presetName),
      }),
    });
  for (const reference of manifest.scenes.filter((scene) => !scene.deletedAt)) {
    const source = await db().sceneDocumentRevision.findFirst({
      where: { id: reference.revisionId, bookId, sceneId: reference.sceneId },
    });
    if (
      !source ||
      source.contentHash !== reference.contentHash ||
      hash(source.document) !== reference.contentHash
    )
      throw new DocumentError(
        'DOCUMENT_REVISION_INVALID',
        'Immutable scene checksum is invalid.',
        503,
      );
    const chapter = structure.chapters.find((chapter) => chapter.id === reference.chapterId);
    canonicalBytes += Buffer.byteLength(canonicalDocument(source.document));
    if (canonicalBytes > 256 * 1024 * 1024)
      throw new DocumentError(
        'PUBLICATION_SOURCE_TOO_LARGE',
        'Canonical publication source exceeds 256 MiB.',
        413,
      );
    const document = validateDocument(source.document);
    document.layout = preset(
      layout.chapters[String(reference.chapterId)] ?? layout.book,
      presetName,
    );
    const header=layoutStory(layout,'header',reference.chapterId); const footer=layoutStory(layout,'footer',reference.chapterId);
    sections.push({
      ...(header?{headerStory:{id:header.id,document:validateDocument(header.document)}}:{}),
      ...(footer?{footerStory:{id:footer.id,document:validateDocument(footer.document)}}:{}),
      id: `scene:${reference.sceneId}`,
      title: chapter?.title ?? `Chapter ${chapter?.chapterNumber ?? 1}`,
      document,
      sceneId: reference.sceneId,
      sceneNumber: reference.sceneNumber,
      chapterId: reference.chapterId,
      chapterNumber: chapter?.chapterNumber ?? 1,
      startsChapter: sections.at(-1)?.chapterId !== reference.chapterId,
      actNumber: structure.acts.find((act) => act.id === chapter?.actId)?.actNumber ?? 1,
    });
  }
  for (const story of layout.backMatter)
    sections.push({
      id: story.id,
      title: story.name,
      document: validateDocument({
        ...story.document,
        layout: preset(story.document.layout, presetName),
      }),
    });
  const assets = new Map<number, DocxAsset>();
  let assetBytes = 0;
  const imageRoot = await realpath(path.resolve('public/images')).catch(() =>
    path.resolve('public/images'),
  );
  const cover = structure.book.selectedImageAsset;
  const references = [...sections.flatMap((section) => publicationDocuments(section).flatMap(imagesOf)), ...(cover && presetName !== 'submission-manuscript' ? [cover] : [])];
  for (const image of references)
      if (!assets.has(image.assetId)) {
        const asset = await db().imageAsset.findFirst({
          where: { id: image.assetId, userId, bookId },
        });
        if (!asset || !/^\/images\/[a-zA-Z0-9_.-]+$/.test(asset.url))
          throw new DocumentError(
            'EXPORT_ASSET_UNAVAILABLE',
            'Publication requires an owned local immutable asset.',
            409,
          );
        const filename = await realpath(path.join(imageRoot, path.basename(asset.url))).catch(
          () => null,
        );
        if (!filename || !filename.startsWith(imageRoot + path.sep))
          throw new DocumentError(
            'EXPORT_ASSET_UNAVAILABLE',
            'Asset file is unavailable or escapes storage.',
            409,
          );
        const info = await stat(filename);
        assetBytes += info.size;
        if (info.size > 32 * 1024 * 1024 || assetBytes > 256 * 1024 * 1024)
          throw new DocumentError(
            'EXPORT_ASSET_LIMIT',
            'Publication asset bytes exceed supported limits.',
            413,
          );
        const bytes = await readFile(filename);
        if (bytes.length > 32 * 1024 * 1024 || bytesSha256(bytes) !== image.sha256)
          throw new DocumentError('EXPORT_ASSET_UNAVAILABLE', 'Asset checksum is invalid.', 409);
        let metadata: ReturnType<typeof inspectImageMetadata>;
        try { metadata = inspectImageMetadata(bytes); }
        catch { throw new DocumentError('EXPORT_ASSET_UNAVAILABLE', 'Publication image has invalid or unsupported bounded headers.', 409); }
        if ('byteLength' in image && (image.byteLength !== metadata.byteLength || image.mediaType !== metadata.mediaType || image.width !== undefined && image.width !== metadata.width || image.height !== undefined && image.height !== metadata.height))
          throw new DocumentError('EXPORT_ASSET_UNAVAILABLE', 'Selected image metadata disagrees with immutable bytes.', 409);
        const mediaType = metadata.mediaType;
        assets.set(asset.id, { bytes, mediaType });
      } else {
        const metadata = inspectImageMetadata(assets.get(image.assetId)!.bytes);
        if (metadata.sha256 !== image.sha256 || 'byteLength' in image && (image.byteLength !== metadata.byteLength || image.mediaType !== metadata.mediaType || image.width !== undefined && image.width !== metadata.width || image.height !== undefined && image.height !== metadata.height))
          throw new DocumentError('EXPORT_ASSET_UNAVAILABLE','Repeated asset references disagree with immutable bytes or intrinsic metadata.',409);
      }
  if (cover && presetName !== 'submission-manuscript') {
    const metadata = inspectImageMetadata(assets.get(cover.assetId)!.bytes);
    const coverLayout = preset(layout.book, presetName);
    coverLayout.header = []; coverLayout.footer = []; coverLayout.pageNumbers = false;
    const availableWidth = coverLayout.width - coverLayout.margins[1] - coverLayout.margins[3];
    const availableHeight = coverLayout.height - coverLayout.margins[0] - coverLayout.margins[2];
    const scale = Math.min(availableWidth / metadata.width, availableHeight / metadata.height, 1);
    sections.unshift({id:'book-cover',title:'Cover',startsChapter:true,isCover:true,document:validateDocument({schemaVersion:1,blocks:[{type:'image',id:'book-cover-image',assetId:cover.assetId,sha256:cover.sha256,alt:cover.alt,width:metadata.width*scale,height:metadata.height*scale}],changes:[],comments:[],layout:coverLayout})});
  }
  if (!sections.length)
    sections.push({
      id: 'empty',
      title: structure.book.title ?? 'Untitled Book',
      document: validateDocument({
        schemaVersion: 1,
        blocks: [],
        changes: [],
        comments: [],
        layout: preset(layout.book, presetName),
      }),
    });
  return {
    title: structure.book.title ?? 'Untitled Book',
    author: author?.username ?? 'Proser Author',
    revisionId,
    styles:layout.styles,
    sections,
    coverAssetId: cover && presetName !== 'submission-manuscript' ? cover.assetId : undefined,
    coverOmitted: Boolean(cover && presetName === 'submission-manuscript'),
    assets,
  };
}
let rendering = 0;
const renderWaiters: Array<() => void> = [];
async function acquireRenderSlot() {
  if (rendering >= 2) await new Promise<void>((resolve) => renderWaiters.push(resolve));
  else rendering++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = renderWaiters.shift();
    if (next) next();
    else rendering--;
  };
}
export async function runPublicationJob(userId:number,bookId:number,id:string){
  await owned(userId,bookId);const row=await db().documentPublication.findFirst({where:{id,bookId,userId}});if(!row)throw new DocumentError('PUBLICATION_NOT_FOUND','Publication job not found.',404);
  if(row.status==='completed'||row.status==='cancelled')return publicationSummary(row);
  const manifest=row.manifest as unknown as JobManifest;if(row.status==='running'&&manifest.lease&&Date.parse(manifest.lease.until)>Date.now())throw new DocumentError('PUBLICATION_RUNNING','Publication is already rendering; recover its job status.',409);
  return runAdmittedBackground('publication-render',id,userId,()=>executePublicationJob(userId,bookId,id),{bookId,revisionId:row.revisionId,hash:manifest.sourceHash});
}
async function executePublicationJob(userId: number, bookId: number, id: string) {
  await owned(userId, bookId);
  const token = randomUUID();
  const leaseMs = 10 * 60 * 1000;
  const admitted = await documentService.sideRecord(userId, bookId, async (tx) => {
    const row = await tx.documentPublication.findFirst({ where: { id, bookId, userId } });
    if (!row) throw new DocumentError('PUBLICATION_NOT_FOUND', 'Publication job not found.', 404);
    if (row.status === 'completed' || row.status === 'cancelled') return null;
    const manifest = row.manifest as unknown as JobManifest;
    if (row.status === 'running' && manifest.lease && Date.parse(manifest.lease.until) > Date.now())
      throw new DocumentError(
        'PUBLICATION_RUNNING',
        'Publication is already rendering; recover its job status.',
        409,
      );
    manifest.lease = { token, until: new Date(Date.now() + leaseMs).toISOString() };
    await tx.documentPublication.update({
      where: { id },
      data: { status: 'running', errorCode: null, manifest: json(manifest) },
    });
    return { ...row, manifest };
  });
  if (!admitted) return readPublicationJob(userId, bookId, id);
  const releaseRender = await acquireRenderSlot();
  try {
    const options = admitted.options as {
      format: PublicationFormat;
      mode: ExportMode;
      preset: string;
    };
    const input = await materialize(
      userId,
      bookId,
      admitted.revisionId,
      admitted.manifest,
      options.preset,
    );
    let bytes: Buffer;
    let rendererVersion: string | null = null;
    let rendererFonts: unknown = null;
    let rendererFontUsage: unknown = null;
    let fontSubstitutions: Array<{ requested: string; actual: string }> = [];
    let imageDerivations:PublicationImageDerivation[]=[];
    if (options.format === 'docx') {const rendered=await publicationDocxDetailed(input,options.mode);bytes=rendered.bytes;imageDerivations=rendered.derivations;rendererVersion=rendered.rendererVersion;}
    else if (options.format === 'epub') bytes = await publicationEpub(input, options.mode);
    else if (options.format === 'pdf') {
      const rendered = await publicationPdf(input, options.mode);
      bytes = rendered.bytes;
      rendererVersion = rendered.version;
      rendererFonts = rendered.fonts;
      rendererFontUsage = rendered.fontUsage;
      fontSubstitutions = rendered.substitutions;
    } else if (options.format === 'html') bytes = Buffer.from(publicationHtml(input, options.mode));
    else if (options.format === 'markdown')
      bytes = Buffer.from(publicationMarkdown(input, options.mode));
    else if (options.format === 'text') bytes = Buffer.from(publicationText(input, options.mode));
    else bytes = Buffer.from(publicationJson(input,options.mode,admitted.manifest.sourceManifest));
    if (bytes.length > 256 * 1024 * 1024)
      throw new DocumentError('PUBLICATION_TOO_LARGE', 'Rendered artifact exceeds 256 MiB.', 413);
    const validation: Record<string, unknown> = { bytes: true, sha256: bytesSha256(bytes) };
    if (options.format === 'docx') {
      const files = await validateDocxPackage(bytes, true);
      validation.packageEntries = files.size;
      validation.xmlRelationships = true;
    }
    if (options.format === 'epub') {
      const files = await readDocumentPackage(bytes, true);
      for (const [name, content] of files)
        if (/\.(xml|opf|xhtml)$/.test(name)) parseDocumentXml(content);
      validation.packageEntries = files.size;
      validation.xhtml = true;
    }
    if (options.format === 'pdf')
      validation.pdfSignature = bytes.subarray(0, 5).toString() === '%PDF-';
    const fidelity = {
      schemaVersion: 1,
      format: options.format,
      mode: options.mode,
      nativeReview: options.format === 'docx',
      losses:
        options.format === 'markdown'
          ? [
              'Paragraph layout, font, size, color, underline and native table structure use reduced formatting. Images use authenticated asset references.',
            ]
          : options.format === 'epub'
            ? ['Print pagination, margins and header/footer stories are not EPUB layout semantics.', 'Fonts are referenced by name; EPUB readers may substitute fonts that are unavailable.']
            : options.format === 'html' ? ['Fonts are referenced by name; HTML viewers may substitute fonts that are unavailable.']
            : options.format === 'text'
              ? ['Text projection omits formatting and objects.']
              : [],
      reviewSidecar: options.mode === 'retain-review' ? reviewSidecar(input) : null,
      wordAcceptance: 'unverified',
    };
    for(const derivative of imageDerivations)fidelity.losses.push(`Static WebP asset ${derivative.assetId} is represented by a verified ${derivative.width}×${derivative.height} PNG derivative for Word compatibility; original bytes and source digest remain unchanged.`);
    if (input.coverOmitted) fidelity.losses.push('The submission-manuscript preset omits the selected book cover; its immutable source reference remains preserved.');
    const detached = input.sections.flatMap((section) => publicationDocuments(section).flatMap((document)=>document.comments)).filter((comment) => comment.anchorStates?.length);
    if (detached.length) fidelity.losses.push(`${detached.length} detached comments retain original anchor/source evidence in the review sidecar. Native ranges are omitted; markup shows explicit detached notes.`);
    if(options.format==='docx'&&options.mode!=='retain-review'){const ranges=input.sections.reduce((count,section)=>count+section.document.comments.filter((comment)=>!comment.resolved&&!comment.anchorStates?.length).length,0);if(ranges>32767)fidelity.losses.push(`Source review contains ${ranges} comments, exceeding Word's 32767 native-range limit. This ${options.mode} export omits native review without accepting manuscript changes.`);}
    if (options.format === 'docx' && options.mode === 'retain-review') {
      const historicalBoundaries = input.sections.flatMap((section) => publicationDocuments(section)).reduce((count, document) => count + detachedHistoricalBoundaryIds(document).length, 0);
      if (historicalBoundaries) fidelity.losses.push(`${historicalBoundaries} resolved historical paragraph boundaries retain exact source proofs, attribution and resolution history in the review sidecar; detached old marks are omitted from current native Word revisions.`);
      const storyComments=input.sections.filter((section)=>section.startsChapter!==false).flatMap((section)=>[section.headerStory,section.footerStory].flatMap((story)=>story?story.document.comments:[])).filter((comment)=>!comment.resolved).length;
      if(storyComments) fidelity.losses.push(`${storyComments} header/footer comments remain in the review sidecar. Word ignores native comment anchors in these stories; native body and table-cell comments remain supported.`);
      const resolved = input.sections.flatMap((section) => publicationDocuments(section).flatMap((document)=>document.comments)).filter((comment) => comment.resolved && !comment.anchorStates?.length).length;
      if (resolved) fidelity.losses.push(`${resolved} resolved comments retain resolution history in the review sidecar and are omitted from classic native comment ranges.`);
    }
    if (options.format === 'pdf' && input.sections.some((section) => section.document.layout.header.length || section.document.layout.footer.length || section.headerStory || section.footerStory)) fidelity.losses.push('Rich margin stories render as 300 DPI graphics with preserved styles/images; their text is retained in source documents but is not selectable PDF text.');
    if (options.format === 'docx') {
      const sizes = new Set([...Object.values(input.styles?.text??{}).flatMap((style)=>style.size===undefined?[]:[style.size]),...input.sections.flatMap((section) => publicationDocuments(section)).flatMap((document) => [document.layout.fontSize, ...paragraphsOf(document, true).flatMap((paragraph) => paragraph.runs.flatMap((run) => run.style.size === undefined ? [] : [run.style.size])), ...document.changes.flatMap((change) => [change.beforeStyle?.size, change.afterStyle?.size].filter((size): size is number => size !== undefined))])]);
      for (const size of sizes) { const actual = Math.round(size * 1.5) / 1.5; if (Math.abs(size - actual) > 1e-9) fidelity.losses.push(`Font size ${size}px is represented as ${actual}px at Word half-point precision.`); }
    }
    let markdownOffset = 0;
    const markdownIndex = input.sections.map((section, index) => {
      const content = publicationMarkdown({ ...input, sections: [section] }, options.mode);
      const start = markdownOffset;
      markdownOffset += content.length + (index < input.sections.length - 1 ? 2 : 0);
      return {
        id: section.id,
        title: section.title,
        sceneId: section.sceneId,
        sceneNumber: section.sceneNumber,
        chapterId: section.chapterId,
        chapterNumber: section.chapterNumber,
        actNumber: section.actNumber,
        start,
        end: start + content.length,
        wordCount: projectDocument(
          section.document,
          options.mode === 'retain-review' ? 'markup' : options.mode,
        ).wordCount,
      };
    });
    const provenance = {
      title: input.title,
      markdownIndex,
      sourceManifest: admitted.manifest.sourceManifest,
      sourceHash: admitted.manifest.sourceHash,
      sourceRevisionId: admitted.revisionId,
      options,
      codecVersion: CODEC_VERSION,
      rendererVersion,
      imageDerivations,
      rendererFonts,
      rendererFontUsage,
      fontSubstitutions,
      nodeVersion: process.version,
      fonts: Array.from(new Set(input.sections.map((section) => section.document.layout.font))),
      validation,
      fidelity,
      createdBy: userId,
      createdAt: new Date().toISOString(),
    };
    await documentService.sideRecord(userId, bookId, async (tx) => {
      const row = await tx.documentPublication.findFirstOrThrow({ where: { id, bookId, userId } });
      const manifest = row.manifest as unknown as JobManifest;
      if (row.status !== 'running' || manifest.lease?.token !== token)
        throw new DocumentError(
          'PUBLICATION_LEASE_LOST',
          'Publication was cancelled or superseded.',
          409,
        );
      const artifactId = randomUUID();
      await tx.documentPublicationArtifact.create({
        data: {
          id: artifactId,
          publicationId: id,
          bookId,
          userId,
          sha256: bytesSha256(bytes),
          byteLength: bytes.length,
          mediaType: formats[options.format].mediaType,
          filename: `${input.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'book'}.${formats[options.format].extension}`,
          bytes: Uint8Array.from(bytes),
          provenance: json(provenance),
        },
      });
      manifest.artifactId = artifactId;
      manifest.fidelity = { losses: fidelity.losses, fontSubstitutions, wordAcceptance: fidelity.wordAcceptance };
      delete manifest.lease;
      await tx.documentPublication.update({
        where: { id },
        data: { status: 'completed', manifest: json(manifest) },
      });
      await tx.auditLog.create({
        data: {
          userId,
          entityType: 'book',
          entityId: bookId,
          action: 'create',
          metadata: json({
            type: 'document-publication-completed',
            operationId: id,
            artifactId,
            sha256: bytesSha256(bytes),
            sourceRevisionId: admitted.revisionId,
          }),
        },
      });
    });
  } catch (error) {
    try {
      await documentService.sideRecord(userId, bookId, async (tx) => {
        const row = await tx.documentPublication.findFirst({ where: { id, bookId, userId } });
        if (!row) return;
        const manifest = row.manifest as unknown as JobManifest;
        if (row.status !== 'running' || manifest.lease?.token !== token) return;
        delete manifest.lease;
        manifest.errorMessage = error instanceof Error ? error.message : 'Publication failed.';
        await tx.documentPublication.update({
          where: { id },
          data: {
            status: 'failed',
            errorCode: error instanceof DocumentError ? error.code : 'PUBLICATION_FAILED',
            manifest: json(manifest),
          },
        });
      });
    } finally {
      releaseRender();
    }
  }
  releaseRender();
  return readPublicationJob(userId, bookId, id);
}
export async function dispatchPublicationJob(userId: number, bookId: number, id: string) {
  const context = currentDocumentMutationContext();
  if (context?.sharedResourceOperationId) return runPublicationJob(userId, bookId, id);
  withDocumentMutationContext(
    { userId, actorGithubId: context?.actorGithubId, signal: () => undefined },
    () => {
      void runPublicationJob(userId, bookId, id).catch(() => undefined);
    },
  );
  return readPublicationJob(userId, bookId, id);
}
export async function cancelPublicationJob(userId: number, bookId: number, id: string) {
  await documentService.sideRecord(userId, bookId, async (tx) => {
    const row = await tx.documentPublication.findFirst({ where: { id, bookId, userId } });
    if (!row) throw new DocumentError('PUBLICATION_NOT_FOUND', 'Publication job not found.', 404);
    if (row.status === 'completed') return;
    const manifest = row.manifest as unknown as JobManifest;
    delete manifest.lease;
    await tx.documentPublication.update({
      where: { id },
      data: { status: 'cancelled', errorCode: 'CANCELLED_BY_OWNER', manifest: json(manifest) },
    });
  });
  return readPublicationJob(userId, bookId, id);
}
export async function readPublicationArtifact(userId: number, bookId: number, id: string) {
  await owned(userId, bookId);
  const row = await db().documentPublicationArtifact.findFirst({ where: { id, bookId, userId } });
  if (!row) throw new DocumentError('PUBLICATION_NOT_FOUND', 'Artifact not found.', 404);
  if (row.bytes.length !== row.byteLength || bytesSha256(row.bytes) !== row.sha256)
    throw new DocumentError(
      'PUBLICATION_ARTIFACT_INVALID',
      'Stored immutable artifact checksum is invalid.',
      503,
    );
  return row;
}
/** Compatibility callers still read a revision-bound canonical export; they do
 * not rebuild formatting from Scene.prose or invent a second renderer. */
export async function exportCanonicalBook(
  userId: number,
  bookId: number,
  format: PublicationFormat,
  options: {
    operationId?: string;
    expectedRevisionId?: string;
    mode?: ExportMode;
    preset?: 'saved' | 'submission-manuscript' | 'print-book';
  } = {},
) {
  const head = await documentService.manifest(userId, bookId);
  const job = await createPublicationJob(userId, bookId, {
    operationId: options.operationId ?? randomUUID(),
    expectedRevisionId: options.expectedRevisionId ?? head.revisionId,
    options: { format, mode: options.mode ?? 'final', preset: options.preset ?? 'saved' },
  });
  const result = job.status === 'completed' ? job : await runPublicationJob(userId, bookId, job.id);
  if (result.status !== 'completed' || !result.artifactId)
    throw new DocumentError(
      'PUBLICATION_FAILED',
      `Export job ${result.id}: ${result.errorMessage ?? result.status}`,
      409,
      { jobId: result.id },
    );
  const artifact = await readPublicationArtifact(userId, bookId, result.artifactId);
  return { job: result, artifact };
}
export async function listPublicationJobs(userId: number, bookId: number, cursor?: string) {
  await owned(userId, bookId);
  const rows = await db().documentPublication.findMany({
    where: { bookId, userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 51,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  return {
    jobs: rows.slice(0, 50).map(publicationSummary),
    nextCursor: rows.length > 50 ? rows[49].id : null,
  };
}
