jest.mock('@/cli/utils/output',()=>({output:{json:jest.fn(),error:jest.fn(),warning:jest.fn(),failSpinner:jest.fn()}}));
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { readCanonicalBookProjection, readCanonicalScenes } from '@/documents/readProjection';
import { booksService } from '@/services/booksService';
import { scenesService } from '@/services/scenesService';
import {listCommand} from '@/cli/commands/list';
import {output} from '@/cli/utils/output';
import * as cliDatabase from '@/cli/utils/database';
import {revisionStyleFingerprints} from '@/services/editorial/revisionStyleFingerprints';

describe('immutable compatibility projections and bounded metadata reads', () => {
  const db = () => databaseService.client;
  const previousAuthority = process.env.DOCUMENT_AUTHORITY_ENABLED;
  let userId: number; let githubId: string; let bookId: number; let sceneIds: number[]; let chapterIds: number[];
  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true';
    githubId = `read-projection-${randomUUID()}`;
    userId = (await db().user.create({ data: { githubId, username: 'Projection owner' } })).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, title: 'Saved source title', acts: { create: { actNumber: 1, chapters: { create: [
      { chapterNumber: 1, title: 'First', scenes: { create: { sceneNumber: 1, prose: '  Café 👩🏽‍🚀\n\nExact whitespace.  ' } } },
      { chapterNumber: 2, title: 'Second', scenes: { create: { sceneNumber: 1, prose: 'Other chapter body.' } } },
    ] } } } }, include: { acts: { include: { chapters: { orderBy: { chapterNumber: 'asc' }, include: { scenes: true } } } } } });
    bookId = book.id; chapterIds = book.acts[0].chapters.map((chapter) => chapter.id); sceneIds = book.acts[0].chapters.map((chapter) => chapter.scenes[0].id);
    await documentService.initialize(userId, bookId);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db().documentOperation.deleteMany({ where: { bookId } });
    await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } });
    await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => {
    if (previousAuthority === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = previousAuthority;
    await db().user.delete({ where: { id: userId } });
  });
  const auth = (test: request.Test) => test.set('x-user-id', String(userId)).set('x-github-id', githubId).set('x-username', 'Projection owner');

  test('default book, structure and list reads never select scene bodies and bind counts to their manifest', async () => {
    const source = await documentService.manifest(userId, bookId);
    const bodies = jest.spyOn(db().sceneDocumentRevision, 'findFirst');
    const response = await auth(request(app).get(`/api/books/${bookId}`));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ proseIncluded: false, projection: 'final', sourceBookRevisionId: source.revisionId, contentHash: source.contentHash, wordCount: source.totals.wordCount });
    expect(response.body.data.acts[0].chapters[0].scenes[0]).toMatchObject({ sourceSceneRevisionId: source.scenes[0].revisionId, wordCount: source.scenes[0].wordCount, projection: 'final' });
    expect(response.body.data.acts[0].chapters[0].scenes[0]).not.toHaveProperty('prose');
    const structure = await auth(request(app).get(`/api/books/${bookId}/structure`));
    expect(structure.status).toBe(200); expect(structure.body.data.sourceBookRevisionId).toBe(source.revisionId);
    expect(structure.body.data.acts[0].chapters[0].scenes[0]).not.toHaveProperty('prose');
    const list = await booksService.listBooks(userId, { ids: [bookId] });
    expect(list.books[0]).toMatchObject({ wordCount: source.totals.wordCount, sourceBookRevisionId: source.revisionId });
    expect(bodies).not.toHaveBeenCalled();
  });

  test('explicit compatibility prose preserves exact Unicode and whitespace, with scene and book source refs', async () => {
    const expected = (await documentService.read(userId, bookId, sceneIds[0])).projection;
    const response = await auth(request(app).get(`/api/books/${bookId}?includeProse=1`));
    expect(response.status).toBe(200);
    const scene = response.body.data.acts[0].chapters[0].scenes[0];
    expect(scene.prose).toBe(expected.text); expect(scene.wordCount).toBe(expected.wordCount);
    expect(scene.sourceBookRevisionId).toBe(response.body.data.sourceBookRevisionId);
    expect(scene.sourceSceneRevisionId).toBeDefined(); expect(scene.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await auth(request(app).get(`/api/books/${bookId}?includeProse=truncate`))).status).toBe(422);
  });

  test('a concurrent committed edit cannot mix newer mutable metadata into a captured older manifest', async () => {
    const originalManifest = documentService.manifest.bind(documentService);
    const before = await documentService.read(userId, bookId, sceneIds[0]);
    const oldText = before.projection.text;
    const paragraph = before.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); paragraph.runs[0].text = 'Newer text.';
    let frozenRevision = '';
    jest.spyOn(documentService, 'manifest').mockImplementationOnce(async (actor, book) => {
      const frozen = await originalManifest(actor, book); frozenRevision = frozen.revisionId;
      await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: frozen.revisionId, scenes: [{ sceneId: sceneIds[0], expectedRevisionId: before.revisionId, document: before.document }] });
      const current = await originalManifest(userId, bookId);
      await booksService.updateBook(userId, bookId, { title: 'Newer title' }, { operationId: randomUUID(), expectedRevisionId: current.revisionId, expectedScopes: { structure: current.scopes!.structure.revisionId } });
      return frozen;
    });
    const projected = await readCanonicalBookProjection(userId, bookId, { includeProse: true });
    expect(projected.sourceBookRevisionId).toBe(frozenRevision); expect(projected.title).toBe('Saved source title');
    expect(projected.acts[0].chapters[0].scenes[0].prose).toBe(oldText);
    expect((await readCanonicalBookProjection(userId, bookId, { includeProse: true })).title).toBe('Newer title');
  });

  test('chapter and single-scene compatibility reads decode only their requested immutable bodies', async () => {
    const bodies = jest.spyOn(db().sceneDocumentRevision, 'findFirst');
    const chapter = await readCanonicalScenes(userId, bookId, { chapterId: chapterIds[0], includeProse: true });
    expect(chapter.scenes).toHaveLength(1); expect(bodies).toHaveBeenCalledTimes(1);
    expect(bodies.mock.calls[0][0]?.where?.sceneId).toBe(sceneIds[0]); bodies.mockClear();
    const scene = await auth(request(app).get(`/api/books/${bookId}/scenes/${sceneIds[1]}`));
    expect(scene.status).toBe(200); expect(scene.body.data.scene.prose).toBe('Other chapter body.'); expect(bodies).toHaveBeenCalledTimes(1);
    bodies.mockClear();
    const metadata = await auth(request(app).get(`/api/books/${bookId}/scenes?includeProse=0`));
    expect(metadata.status).toBe(200); expect(metadata.body.data.scenes[0]).not.toHaveProperty('prose'); expect(bodies).not.toHaveBeenCalled();
  });

  test('tombstones retain stable revision identity and no longer contribute to visible counts', async () => {
    const source = await documentService.manifest(userId, bookId);
    const deleted = source.scenes[0];
    await scenesService.deleteScene(userId, bookId, deleted.sceneId, { operationId: randomUUID(), expectedRevisionId: source.revisionId, expectedSceneRevisionId: deleted.revisionId, expectedScopes: { structure: source.scopes!.structure.revisionId } });
    const current = await readCanonicalBookProjection(userId, bookId);
    expect(current.acts[0].chapters[0].scenes).toHaveLength(0);
    expect(current.tombstones.scenes).toEqual(expect.arrayContaining([expect.objectContaining({ sourceSceneRevisionId: deleted.revisionId, contentHash: deleted.contentHash, deletedAt: expect.any(String) })]));
    expect(current.wordCount).toBe(source.scenes[1].wordCount);
    expect((await auth(request(app).get(`/api/books/${bookId}/scenes/${deleted.sceneId}`))).status).toBe(404);
  });

  test('foreign owners cannot read bodies, metadata or counts', async () => {
    const foreign = await db().user.create({ data: { githubId: `projection-foreign-${randomUUID()}`, username: 'Foreign reader' } });
    try {
      await expect(readCanonicalBookProjection(foreign.id, bookId, { includeProse: true })).rejects.toMatchObject({ name: 'NotFoundError' });
    } finally { await db().user.delete({ where: { id: foreign.id } }); }
  });
  test('editorial result metrics remain bound to their immutable result after newer typing', async () => {
    const before = await documentService.read(userId, bookId, sceneIds[1]);
    const paragraph = before.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); paragraph.runs[0].text = 'Many newer words replace the scene while the previous review finishes.';
    await documentService.commit(userId, bookId, {schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: before.bookRevisionId, scenes: [{sceneId: sceneIds[1], expectedRevisionId: before.revisionId, document: before.document}]});
    const old = await revisionStyleFingerprints(bookId, before.bookRevisionId, [sceneIds[1]]);
    expect(old[0].fingerprint.wordCount).toBe(3);
    const current = await documentService.manifest(userId, bookId);
    expect((await revisionStyleFingerprints(bookId, current.revisionId, [sceneIds[1]]))[0].fingerprint.wordCount).toBeGreaterThan(3);
    await expect(revisionStyleFingerprints(bookId, before.bookRevisionId, [99999999])).rejects.toThrow('EDITORIAL_RESULT_SCOPE_INVALID');
  });

  test('CLI listing uses revision-bound progress/counts without reading manuscript bodies', async () => {
    jest.spyOn(cliDatabase,'closeDatabase').mockResolvedValue(undefined);
    const report=jest.spyOn(output,'json').mockImplementation(()=>undefined);
    const bodies=jest.spyOn(db().sceneDocumentRevision,'findFirst');
    const source=await documentService.manifest(userId,bookId);
    const handler=listCommand.handler;if(typeof handler!=='function')throw new Error('fixture');
    await handler({_:['list'],$0:'proser','user-id':userId,json:true});
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({success:true,userId,books:expect.arrayContaining([expect.objectContaining({id:bookId,progress:100,wordCount:source.totals.wordCount,projection:'final',sourceBookRevisionId:source.revisionId})])}));
    expect(bodies).not.toHaveBeenCalled();
  });

  test('structure-save receipts and retries retain metadata/source counts without serializing the manuscript', async () => {
    const source=await readCanonicalBookProjection(userId,bookId);const manifest=await documentService.manifest(userId,bookId);
    const input={acts:source.acts.map((act)=>({id:act.id,title:act.title??undefined,chapters:act.chapters.map((chapter)=>({id:chapter.id,title:chapter.title??undefined}))})),documentPreconditions:{operationId:randomUUID(),expectedRevisionId:manifest.revisionId,expectedScopes:{structure:manifest.scopes!.structure.revisionId}}};
    const bodies=jest.spyOn(db().sceneDocumentRevision,'findFirst');
    const result=await auth(request(app).post(`/api/books/${bookId}/structure`)).send(input);expect(result.status).toBe(201);
    const scene=result.body.data.acts[0].chapters[0].scenes[0];expect(scene).not.toHaveProperty('prose');expect(scene).toMatchObject({wordCount:manifest.scenes[0].wordCount,sourceBookRevisionId:result.body.data.documentReceipt.revisionId,sourceSceneRevisionId:manifest.scenes[0].revisionId});
    expect(result.body.data.documentReceipt.result[0].chapters[0].scenes[0]).not.toHaveProperty('prose');expect(bodies).not.toHaveBeenCalled();
    expect((await auth(request(app).post(`/api/books/${bookId}/structure`)).send(input)).body.data).toEqual(result.body.data);
  });

});
