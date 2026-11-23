import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { databaseService } from '../lib/database';
import { NotFoundError, ValidationError } from '../lib/errors';
import { createZipBuffer, type ZipEntry } from '../lib/zipArchive';
import { generateMarkdown } from './exportService';
import { documentAuthorityEnabled, documentService } from '@/documents/service';
import { catalogCommand } from '@/documents/catalogCommands';
import type { Prisma } from '@prisma/client';
import { inspectImageMetadata } from '@/lib/imageMetadata';
import { importedImageQuota } from '@/lib/storageQuota';

export { creativeImageSchema } from '../api/schemas/creativeImports';
import { creativeImageSchema } from '../api/schemas/creativeImports';

export function inspectImportedImage(encoded: string, expectedDigest: string) {
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 6 * 1024 * 1024 || bytes.toString('base64') !== encoded) throw new ValidationError('Invalid bounded base64 image');
  if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) throw new ValidationError('Image digest mismatch');
  const verified = inspectImageMetadata(bytes);
  const extension = verified.mediaType === 'image/png' ? 'png' : verified.mediaType === 'image/jpeg' ? 'jpg' : 'webp';
  return { bytes, extension, ...verified };
}

export async function importCreativeImage(userId: number, raw: unknown, actor: string, requestId: string) {
  const input = creativeImageSchema.parse(raw);
  const { bytes, extension, ...verifiedImageMetadata } = inspectImportedImage(input.bytesBase64, input.sha256);
  const book = await databaseService.client.book.findFirst({ where: { id: input.bookId, userId } });
  if (!book) throw new NotFoundError('Book not found');
  if (documentAuthorityEnabled() && input.setCover) {
    catalogCommand(input.documentPreconditions, { command: 'import-creative-cover' });
    const previous = await databaseService.client.documentOperation.findFirst({ where: { id: input.documentPreconditions!.operationId, userId, bookId: input.bookId }, select: { id: true } });
    if (!previous) await documentService.assertMutationAuthority(userId, input.bookId, input.documentPreconditions!.expectedRevisionId);
  }
  const name = `import-${userId}-${input.bookId}-${input.sha256}.${extension}`;
  // Refuse before any bytes reach disk. An image this account already imported
  // for this book is a replay and stays allowed.
  if (!await databaseService.client.imageAsset.findFirst({ where: { userId, bookId: input.bookId, source: 'nova-import', name }, select: { id: true } })) {
    const quota = importedImageQuota();
    const [bookCount, userCount] = await Promise.all([
      databaseService.client.imageAsset.count({ where: { bookId: input.bookId, source: 'nova-import' } }),
      databaseService.client.imageAsset.count({ where: { userId, source: 'nova-import' } }),
    ]);
    if (bookCount >= quota.bookCount) throw new ValidationError('This book has reached its imported image limit');
    if (userCount >= quota.userCount) throw new ValidationError('This account has reached its imported image limit');
  }
  const sourceKey = createHash('sha256').update(JSON.stringify([input.source, input.sourceId, input.artifactKey])).digest('hex');
  const root = path.resolve('public/images');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, name), bytes, { mode: 0o600, flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
    if (createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex') !== input.sha256) throw new ValidationError('Stored image digest mismatch');
  });
  const { bytesBase64: _bytes, ...metadata } = input;
  void _bytes;
  const apply = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`creative-import:${userId}:${sourceKey}`}, 0))`;
    const rows = await tx.imageAsset.findMany({ where: { userId, source: 'nova-import' }, orderBy: { id: 'desc' } });
    const linked = rows.flatMap((row) => {
      try { const meta = JSON.parse(row.configJson || '{}') as Record<string, unknown>; return meta.sourceKey === sourceKey ? [{ row, meta }] : []; }
      catch { return []; }
    });
    const current = linked.find(({ row, meta }) => row.bookId === input.bookId && meta.superseded !== true);
    if (current?.meta.sha256 === input.sha256 && current.meta.sourceRevision === input.sourceRevision) { if (input.setCover) await tx.book.update({ where: { id: input.bookId }, data: { selectedImageId: current.row.id } }); return { ...current.row, replayed: true }; }
    if (current && current.meta.sha256 !== input.expectedPreviousDigest) throw new ValidationError('Source revision conflict; provide expectedPreviousDigest from the current attachment');
    for (const { row, meta } of linked) {
      await tx.imageAsset.update({ where: { id: row.id }, data: { configJson: JSON.stringify({ ...meta, sourceUpdateAvailable: input.sourceRevision, ...(row.bookId === input.bookId ? { superseded: true } : {}) }) } });
    }
    const asset = await tx.imageAsset.create({ data: { userId, bookId: input.bookId, name, url: `/images/${name}`, source: 'nova-import',
      configJson: JSON.stringify({ ...metadata, ...verifiedImageMetadata, sourceKey, actor, requestId, importedAt: new Date().toISOString() }) } });
    if (input.setCover) await tx.book.update({ where: { id: input.bookId }, data: { selectedImageId: asset.id } });
    return { ...asset, replayed: false };
  };
  if (documentAuthorityEnabled()) {
    if (!input.setCover) return documentService.sideRecord(userId, input.bookId, apply);
    const receipt = await documentService.mutateCatalog(userId, input.bookId, catalogCommand(input.documentPreconditions, { command: 'import-creative-cover', metadata }), async (tx) => ({ result: await apply(tx) }));
    return { ...receipt.result, documentReceipt: { operationId: receipt.operationId, bookRevisionId: receipt.revisionId, contentHash: receipt.contentHash } };
  }
  return databaseService.client.$transaction(apply);
}

export async function exportCreativePackage(userId: number, bookId: number) {
  const book = await databaseService.client.book.findFirst({
    where: { id: bookId, userId },
    include: { acts: { orderBy: { actNumber: 'asc' }, include: {
      chapters: { orderBy: { chapterNumber: 'asc' }, include: {
        scenes: { orderBy: { sceneNumber: 'asc' } },
      } },
    } } },
  });
  if (!book) throw new NotFoundError('Book not found');
  const images = await databaseService.client.imageAsset.findMany({ where: { userId, bookId, source: 'nova-import' }, orderBy: { id: 'asc' }, take: 101 });
  if (images.length > 100) throw new ValidationError('Illustrated package exceeds 100 images');
  const entries: ZipEntry[] = [];
  const manifest: Array<Record<string, unknown>> = [];
  let markdown = generateMarkdown(book);
  let total = Buffer.byteLength(markdown);
  for (const image of images) {
    const metadata = JSON.parse(image.configJson || '{}') as Record<string, unknown>;
    if (metadata.superseded === true) continue;
    const bytes = await fs.readFile(path.resolve('public/images', path.basename(image.name)));
    total += bytes.length;
    if (total > 64 * 1024 * 1024) throw new ValidationError('Illustrated package exceeds 64 MiB');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== metadata.sha256) throw new ValidationError('Imported image integrity mismatch');
    const filename = 'images/' + path.basename(image.name);
    entries.push({ name: filename, content: bytes, store: true });
    const caption = String(metadata.caption || image.name).replace(/[\[\]\\\r\n]/g, ' ');
    markdown += `\n\n![${caption}](${filename})\n`;
    manifest.push({ imageId: image.id, filename, bytes: bytes.length, ...metadata });
  }
  entries.unshift({ name: 'manuscript.md', content: markdown });
  entries.push({ name: 'manifest.json', content: JSON.stringify({ bookId, visibility: 'private', manuscriptSha256: createHash('sha256').update(markdown).digest('hex'), images: manifest }, null, 2) });
  return createZipBuffer(entries);
}
