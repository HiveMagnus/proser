import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { documentFromText } from '@/documents/model';
import { imageAssetService } from '@/services/imageAssetService';

describe('immutable asset bytes and historical container references', () => {
  const db = () => databaseService.client;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  const sha256 = createHash('sha256').update(png).digest('hex');
  let userId: number; let githubId: string; let bookId: number; let sceneId: number;
  const files: string[] = [];
  beforeAll(async () => { githubId = `asset-preservation-${randomUUID()}`; userId = (await db().user.create({ data: { githubId, username: 'Asset author' } })).id; });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: { sceneNumber: 1, prose: 'Preserve image bytes.' } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
    bookId = book.id; sceneId = book.acts[0].chapters[0].scenes[0].id; await documentService.initialize(userId, bookId);
  });
  afterEach(async () => {
    await db().documentOperation.deleteMany({ where: { bookId } }); await db().bookDocumentHead.deleteMany({ where: { bookId } }); await db().bookDocumentRevision.deleteMany({ where: { bookId } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } }); await db().sceneDocumentRevision.deleteMany({ where: { bookId } }); await db().imageAsset.deleteMany({ where: { bookId } }); await db().book.delete({ where: { id: bookId } });
    await Promise.all(files.splice(0).map((file) => fs.unlink(file).catch(() => undefined)));
  });
  afterAll(async () => { await db().user.delete({ where: { id: userId } }); });
  const auth = (call: request.Test) => call.set('x-user-id', String(userId)).set('x-github-id', githubId);
  const generated = async () => {
    const name = `asset-preservation-${randomUUID()}.png`; const file = path.resolve('public/images', name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, png); files.push(file);
    const [asset] = await imageAssetService.persistAssets({ userId, bookId, urls: [`/images/${name}`], source: 'forge', config: { sha256: 'forged' } }); return { asset, file };
  };
  test.each(['book', 'act', 'chapter', 'scene'] as const)('selected %s artwork retains exact bytes through removal and complete restoration', async (kind) => {
    const { asset, file } = await generated();
    const scene = await db().scene.findUniqueOrThrow({ where: { id: sceneId }, include: { chapter: true } });
    const select = async (selectedImageId: number) => {
      const manifest = await documentService.manifest(userId, bookId);
      return documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: manifest.revisionId, expectedScopes: { structure: manifest.scopes!.structure.revisionId }, payload: { kind, selectedImageId } }, async (tx) => {
        if (kind === 'book') await tx.book.update({ where: { id: bookId }, data: { selectedImageId } });
        if (kind === 'act') await tx.act.update({ where: { id: scene.chapter.actId }, data: { selectedImageId } });
        if (kind === 'chapter') await tx.chapter.update({ where: { id: scene.chapterId }, data: { selectedImageId } });
        if (kind === 'scene') await tx.scene.update({ where: { id: sceneId }, data: { selectedImageId } });
        return { result: null };
      });
    };
    const selected = await select(asset.id); const scope = await documentService.scope(userId, bookId, 'structure');
    const selection = kind === 'book' ? scope.content.book : kind === 'act' ? scope.content.acts[0] : kind === 'chapter' ? scope.content.chapters[0] : scope.content.scenes[0];
    expect(selection).toMatchObject({ selectedImageId: asset.id, selectedImageAsset: { assetId: asset.id, sha256, mediaType: 'image/png', byteLength: png.length, width: 1, height: 1 } });
    const removed = await select(0);
    const deletion = await auth(request(app).delete(`/api/images/${asset.id}`)); expect(deletion.status).toBe(409); expect(deletion.body.error.code).toBe('DOCUMENT_ASSET_REFERENCED');
    await fs.writeFile(file, Buffer.from('tampered selected artwork'));
    await expect(documentService.restore(userId, bookId, selected.revisionId, removed.revisionId, randomUUID())).rejects.toMatchObject({ code: 'DOCUMENT_SELECTED_ASSET_INVALID', status: 409 });
    expect((await documentService.manifest(userId, bookId)).revisionId).toBe(removed.revisionId);
    await fs.writeFile(file, png);
    const restored = await documentService.restore(userId, bookId, selected.revisionId, removed.revisionId, randomUUID());
    expect(restored.revisionId).not.toBe(selected.revisionId);
    expect((await documentService.scope(userId, bookId, 'structure')).content).toEqual(scope.content);
    expect(await fs.readFile(file)).toEqual(png);
    const current = await documentService.manifest(userId, bookId);
    await expect(select(asset.id + 999999)).rejects.toMatchObject({ code: 'DOCUMENT_SELECTED_ASSET_UNVERIFIED', status: 409 });
    expect((await documentService.manifest(userId, bookId)).revisionId).toBe(current.revisionId);
  });
  test.each(['inline', 'table', 'story'] as const)('deactivated authority cannot delete historical %s images', async (container) => {
    const { asset, file } = await generated();
    const image = { assetId: asset.id, sha256, alt: 'Retained image', width: 10, height: 10 };
    const paragraph = documentFromText('', randomUUID).blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); paragraph.runs = [{ id: randomUUID(), text: '', style: {}, inlineImage: image }];
    if (container === 'story') {
      const layout = await documentService.scope(userId, bookId, 'layout'); const manifest = await documentService.manifest(userId, bookId);
      const story = documentFromText('', randomUUID); story.blocks = [paragraph]; layout.content.headerFooterStories = [{ id: randomUUID(), owner: 'book', kind: 'header', document: story }];
      await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: manifest.revisionId, expectedScopes: { layout: layout.revisionId }, payload: { layout: layout.content } }, async () => ({ result: null, layout: layout.content }));
      const next = await documentService.scope(userId, bookId, 'layout'); next.content.headerFooterStories = [];
      await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: (await documentService.manifest(userId, bookId)).revisionId, expectedScopes: { layout: next.revisionId }, payload: { layout: next.content } }, async () => ({ result: null, layout: next.content }));
    } else {
      const source = await documentService.read(userId, bookId, sceneId);
      source.document.blocks.push(container === 'inline' ? paragraph : { type: 'table', id: randomUUID(), widths: [100], rows: [{ id: randomUUID(), cells: [{ id: randomUUID(), paragraphs: [paragraph] }] }] });
      await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
      const next = await documentService.read(userId, bookId, sceneId); next.document.blocks.pop();
      await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: next.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: next.revisionId, document: next.document }] });
    }
    const previous = process.env.DOCUMENT_AUTHORITY_ENABLED; process.env.DOCUMENT_AUTHORITY_ENABLED = 'false';
    try { const response = await auth(request(app).delete(`/api/images/${asset.id}`)); expect(response.status).toBe(409); expect(response.body.error.code).toBe('DOCUMENT_ASSET_REFERENCED'); } finally { if (previous === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = previous; }
    expect(await fs.readFile(file)).toEqual(png); expect(await db().imageAsset.findUnique({ where: { id: asset.id } })).not.toBeNull();
  });
  test('generated registration binds actual bytes, exposes digests, and failed batches retain files without partial rows', async () => {
    const { asset, file } = await generated(); expect(JSON.parse(asset.configJson!)).toMatchObject({ sha256, width: 1, height: 1, mediaType: 'image/png', byteLength: png.length });
    const listing = await auth(request(app).get(`/api/images/list?bookId=${bookId}`)); expect(listing.body.data.items[0]).toMatchObject({ id: asset.id, sha256, width: 1, height: 1 });
    const download = await auth(request(app).get(`/api/images/${asset.id}/content`)); expect(download.status).toBe(200); expect(download.headers['x-content-sha256']).toBe(sha256); expect(download.body).toEqual(png);
    await fs.writeFile(file, Buffer.from('tampered immutable image'));
    const tampered = await auth(request(app).get(`/api/images/${asset.id}/content`)); expect(tampered.status).toBe(503); expect(tampered.body.error.code).toBe('DOCUMENT_ASSET_INTEGRITY'); await fs.writeFile(file, png);
    const count = await db().imageAsset.count({ where: { bookId } });
    await expect(imageAssetService.persistAssets({ userId, bookId, urls: [`/images/${asset.name}`, `/images/missing-${randomUUID()}.png`], source: 'forge' })).rejects.toThrow();
    expect(await db().imageAsset.count({ where: { bookId } })).toBe(count); expect(await fs.readFile(file)).toEqual(png);
    const foreign = await request(app).delete(`/api/images/${asset.id}`).set('x-user-id', String(userId + 99999)).set('x-github-id', 'foreign-assets'); expect(foreign.status).toBeGreaterThanOrEqual(400);
    const deleted = await auth(request(app).delete(`/api/images/${asset.id}`)); expect(deleted.status).toBe(200); expect(await fs.readFile(file)).toEqual(png);
  });
});
