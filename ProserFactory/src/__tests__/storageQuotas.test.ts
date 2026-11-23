import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { preserveImportOriginal } from '@/documents/imports';
import { importCreativeImage } from '@/services/creativeImportService';
import { importOriginalQuota, importedImageQuota } from '@/lib/storageQuota';

describe('upload storage quotas', () => {
  const db = () => databaseService.client;
  const previous = { ...process.env };
  const bookIds: number[] = [];
  const filenames: string[] = [];
  let userId: number;
  const createBook = async () => {
    const id = (await documentService.createBook(userId, { title: 'Quota fixture' }, randomUUID())).result.id;
    bookIds.push(id);
    return id;
  };
  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true';
    userId = (await db().user.create({ data: { githubId: `quota-fixture-${randomUUID()}`, username: 'Quota fixture' } })).id;
  });
  afterEach(async () => {
    for (const key of ['IMPORT_ORIGINALS_BOOK_QUOTA_BYTES', 'IMPORT_ORIGINALS_USER_QUOTA_BYTES', 'IMAGE_IMPORTS_BOOK_LIMIT', 'IMAGE_IMPORTS_USER_LIMIT']) delete process.env[key];
    for (const bookId of bookIds.splice(0)) {
      await db().imageAsset.deleteMany({ where: { bookId } });
      await db().documentImportOriginal.deleteMany({ where: { bookId } });
      await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } });
      await db().documentOperation.deleteMany({ where: { bookId } });
      await db().bookDocumentHead.deleteMany({ where: { bookId } });
      await db().bookDocumentRevision.deleteMany({ where: { bookId } });
      await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } });
      await db().book.delete({ where: { id: bookId } });
    }
    for (const filename of filenames.splice(0)) await unlink(path.resolve('public/images', filename)).catch(() => undefined);
  });
  afterAll(async () => {
    await db().user.delete({ where: { id: userId } });
    if (previous.DOCUMENT_AUTHORITY_ENABLED === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED;
    else process.env.DOCUMENT_AUTHORITY_ENABLED = previous.DOCUMENT_AUTHORITY_ENABLED;
  });

  it('uses bounded defaults and ignores invalid overrides', () => {
    expect(importOriginalQuota({})).toEqual({ bookBytes: 512 * 1024 * 1024, userBytes: 2048 * 1024 * 1024 });
    expect(importOriginalQuota({ IMPORT_ORIGINALS_BOOK_QUOTA_BYTES: '-1', IMPORT_ORIGINALS_USER_QUOTA_BYTES: '4096' })).toEqual({ bookBytes: 512 * 1024 * 1024, userBytes: 4096 });
    expect(importedImageQuota({ IMAGE_IMPORTS_BOOK_LIMIT: 'many' })).toEqual({ bookCount: 500, userCount: 5000 });
  });

  it('refuses a preserved original that would exceed the book quota but accepts a replay', async () => {
    const bookId = await createBook();
    process.env.IMPORT_ORIGINALS_BOOK_QUOTA_BYTES = '10';
    const id = randomUUID();
    const bytes = Buffer.from('12345678');
    await expect(preserveImportOriginal(userId, bookId, id, 'docx', bytes)).resolves.toMatchObject({ id, byteLength: 8 });
    await expect(preserveImportOriginal(userId, bookId, randomUUID(), 'docx', Buffer.from('abc'))).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_QUOTA_EXCEEDED', status: 413 });
    await expect(preserveImportOriginal(userId, bookId, id, 'docx', bytes)).resolves.toMatchObject({ id });
    await expect(preserveImportOriginal(userId, bookId, randomUUID(), 'docx', Buffer.from('ab'))).resolves.toMatchObject({ byteLength: 2 });
  });

  it('refuses a preserved original that would exceed the account quota across books', async () => {
    const first = await createBook();
    const second = await createBook();
    process.env.IMPORT_ORIGINALS_USER_QUOTA_BYTES = '10';
    await preserveImportOriginal(userId, first, randomUUID(), 'docx', Buffer.from('12345678'));
    await expect(preserveImportOriginal(userId, second, randomUUID(), 'docx', Buffer.from('abc'))).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_QUOTA_EXCEEDED' });
    expect(await db().documentImportOriginal.count({ where: { bookId: second } })).toBe(0);
  });

  it('refuses an imported image beyond the account limit before writing it and accepts a replay', async () => {
    const first = await createBook();
    const second = await createBook();
    process.env.IMAGE_IMPORTS_USER_LIMIT = '1';
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZp0AAAAASUVORK5CYII=', 'base64');
    const input = (bookId: number) => ({ bookId, source: 'nova', sourceId: `quota-${bookId}`, sourceRevision: 'r1', artifactKey: 'art', sha256: createHash('sha256').update(bytes).digest('hex'), bytesBase64: bytes.toString('base64'), visibility: 'private', license: 'Disposable fixture', provenance: { fixture: true } });
    const stored = await importCreativeImage(userId, input(first), 'fixture-actor', 'quota-1');
    filenames.push(stored.name);
    await expect(importCreativeImage(userId, input(second), 'fixture-actor', 'quota-2')).rejects.toThrow('imported image limit');
    expect(await db().imageAsset.count({ where: { bookId: second } })).toBe(0);
    await expect(importCreativeImage(userId, input(first), 'fixture-actor', 'quota-3')).resolves.toMatchObject({ id: stored.id, replayed: true });
  });
});
