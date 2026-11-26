jest.mock('@/cli/utils/output', () => ({ output: { json: jest.fn(), warning: jest.fn(), error: jest.fn(), failSpinner: jest.fn() } }));
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { scenesService, type SceneWritePreconditions } from '@/services/scenesService';
import { reviseCommand } from '@/cli/commands/revise';
import * as cliDatabase from '@/cli/utils/database';
import { output } from '@/cli/utils/output';
import { SceneProseService } from '@/services/sceneProseService';
import { actsService } from '@/services/actsService';
import { chaptersService } from '@/services/chaptersService';
import { booksService } from '@/services/booksService';
import { codexService } from '@/services/codexService';
import { manuscriptRevisionService } from '@/services/manuscriptRevisionService';
import { withDocumentMutationContext } from '@/services/documentMutationContext';
import { generateOwnedScene, readSceneGeneration, recoverSceneGeneration, cancelSceneGeneration } from '@/documents/generation';
import { projectDocument, documentFromText } from '@/documents/model';
import { commitOutline } from '@/documents/structureCommands';
import { workflowService } from '@/services/workflowService';

describe('revision guarded scene compatibility writers', () => {
  const previousAuthority = process.env.DOCUMENT_AUTHORITY_ENABLED;
  let userId: number; let githubId: string; let bookId: number; let chapterId: number; let sceneId: number;
  const db = () => databaseService.client;
  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true'; githubId = `writer-fixture-${randomUUID()}`;
    userId = (await db().user.create({ data: { githubId, username: 'Writer fixture' } })).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, title: 'Disposable writer fixture', acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: { sceneNumber: 1, prose: 'A preserved phrase.', summary: 'Before' } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
    bookId = book.id; chapterId = book.acts[0].chapters[0].id; sceneId = book.acts[0].chapters[0].scenes[0].id;
    await documentService.initialize(userId, bookId);
    const source = await documentService.read(userId, bookId, sceneId); const paragraph = source.document.blocks[0];
    if (paragraph.type !== 'paragraph') throw new Error('Fixture paragraph');
    paragraph.runs[0].style = { bold: true, font: 'Georgia', size: 18 };
    const body = await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    const scope = await documentService.scope(userId, bookId, 'layout'); const layout = structuredClone(scope.content);
    const header = documentFromText('Protected header', randomUUID); const headerParagraph = header.blocks[0]; if (headerParagraph.type !== 'paragraph') throw new Error('Fixture'); headerParagraph.runs[0].style.italic = true;
    layout.headerFooterStories = [{ id: randomUUID(), owner: 'book', kind: 'header', document: header }];
    await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: body.revisionId, expectedScopes: { layout: scope.revisionId }, payload: { command: 'fixture-owned-header' } }, async () => ({ result: {}, layout }));
  });
  afterEach(async () => {
    await db().documentOperatorEffect.deleteMany({ where: { bookId } });
    await db().documentInferenceOperation.deleteMany({ where: { bookId } });
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } });
    await db().documentOperation.deleteMany({ where: { bookId } }); await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentRevision.deleteMany({ where: { bookId } }); await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => {
    if (previousAuthority === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = previousAuthority;
    await db().user.delete({ where: { id: userId } });
  });
  const conditions = async (): Promise<SceneWritePreconditions> => {
    const head = await documentService.manifest(userId, bookId); const scene = await documentService.read(userId, bookId, sceneId);
    return { operationId: randomUUID(), expectedRevisionId: head.revisionId, expectedScopes: { structure: head.scopes!.structure.revisionId }, expectedSceneRevisionId: scene.revisionId };
  };
  const auth = (value: request.Test) => value.set('x-user-id', String(userId)).set('x-github-id', githubId).set('x-username', 'Writer fixture');

  test('untracked structure, projection-count and canon writes fail before an authority commit can acknowledge them', async () => {
    const source = await documentService.read(userId, bookId, sceneId);
    const expected = await conditions();
    const document = structuredClone(source.document); const paragraph = document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); paragraph.runs[0].text = 'A new preserved phrase.';
    const request = { schemaVersion: 1 as const, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document }] };
    await db().scene.update({ where: { id: sceneId }, data: { sceneNumber: 77 } });
    await expect(documentService.commit(userId, bookId, request)).rejects.toMatchObject({ status: 409 });
    await db().scene.update({ where: { id: sceneId }, data: { sceneNumber: 1, wordCount: 999 } });
    await expect(documentService.commit(userId, bookId, request)).rejects.toMatchObject({ code: 'DOCUMENT_AUTHORITY_DRIFT', status: 409 });
    await db().scene.update({ where: { id: sceneId }, data: { wordCount: source.projection.wordCount } });
    await db().codexEntry.create({ data: { bookId, entryType: 'character', entryName: 'Untracked canon' } });
    const action = jest.fn(async () => ({ result: { changed: true } }));
    await expect(documentService.mutateCatalog(userId, bookId, { ...expected, payload: { command: 'must-not-run' } }, action)).rejects.toMatchObject({ code: 'DOCUMENT_AUTHORITY_DRIFT', status: 409 });
    expect(action).not.toHaveBeenCalled();
    expect((await documentService.manifest(userId, bookId)).revisionId).toBe(source.bookRevisionId);
    expect(await db().documentOperation.findUnique({ where: { id: request.operationId } })).toBeNull();
    expect((await db().scene.findUniqueOrThrow({ where: { id: sceneId } })).prose).toBe(source.projection.text);
  });

  test('mobile quick draft appends missing hierarchy and its structured body atomically and recovers without duplicates', async () => {
    const source = await documentService.manifest(userId, bookId);
    const original = await documentService.read(userId, bookId, sceneId);
    const input = { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.revisionId, expectedScopes: { structure: source.scopes!.structure.revisionId }, summary: 'Quick draft', outline: 'Preserve this exact premise. 😀' };
    expect((await auth(request(app).post(`/api/books/${bookId}/document-quick-drafts`)).send({ schemaVersion: 1 })).status).toBe(428);
    const response = await auth(request(app).post(`/api/books/${bookId}/document-quick-drafts`)).send(input);
    expect(response.status).toBe(201);
    const receipt = response.body.data;
    expect(receipt.result.command).toBe('quick-draft');
    expect(receipt.result.actId).toBe((await db().chapter.findUniqueOrThrow({ where: { id: chapterId } })).actId);
    expect(receipt.result.chapterId).not.toBe(chapterId);
    const draft = await documentService.read(userId, bookId, receipt.result.sceneId);
    expect(draft.projection.text).toBe(''); expect(draft.bookRevisionId).toBe(receipt.revisionId);
    expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(original.document);
    const replay = await auth(request(app).post(`/api/books/${bookId}/document-quick-drafts`)).send(input);
    expect(replay.status).toBe(201); expect(replay.body.data).toEqual(receipt);
    const recovered = await auth(request(app).get(`/api/books/${bookId}/document-operations/${input.operationId}`));
    expect(recovered.status).toBe(200); expect(recovered.body.data).toEqual(receipt);
    expect(await db().scene.count({ where: { chapter: { act: { bookId } } } })).toBe(2);
    const incompatible = await auth(request(app).post(`/api/books/${bookId}/document-quick-drafts`)).send({ ...input, summary: 'Changed intent' });
    expect(incompatible.status).toBe(409);
    const stale = await auth(request(app).post(`/api/books/${bookId}/document-quick-drafts`)).send({ ...input, operationId: randomUUID() });
    expect(stale.status).toBe(412);
    expect(await db().chapter.count({ where: { act: { bookId } } })).toBe(2);
    const current = await documentService.manifest(userId, bookId);
    const second = await auth(request(app).post(`/api/books/${bookId}/document-quick-drafts`)).send({ ...input, operationId: randomUUID(), expectedRevisionId: current.revisionId, expectedScopes: { structure: current.scopes!.structure.revisionId } });
    expect(second.status).toBe(201); expect(second.body.data.result.chapterId).toBe(receipt.result.chapterId);
    expect(await db().chapter.count({ where: { act: { bookId } } })).toBe(2);
  });
  test('book creation can be recovered before its ID is known and remains private to the creator', async () => {
    const operationId = randomUUID();
    const created = await auth(request(app).post('/api/books')).send({ operationId, title: 'Recovered creation' });
    expect(created.status).toBe(201);
    const createdId = Number(created.body.data.id);
    const foreign = await db().user.create({ data: { githubId: `quick-foreign-${randomUUID()}`, username: 'Foreign author' } });
    try {
      const capabilities = await auth(request(app).get('/api/books/document-capabilities'));
      expect(capabilities.status).toBe(200); expect(capabilities.body.data).toMatchObject({ enabled: true, schemaVersion: 1, actorId: userId, revisionPreview: 'disclosed-proposal-v1', revisionSource: 'immutable-manifest-v1', projection: 'final' });
      const ownedCapabilities = await auth(request(app).get(`/api/books/${createdId}/document-capabilities`));
      expect(ownedCapabilities.status).toBe(200); expect(ownedCapabilities.body.data).toMatchObject({ enabled: true, schemaVersion: 1, actorId: userId, revisionPreview: 'disclosed-proposal-v1', revisionSource: 'immutable-manifest-v1', projection: 'final' });
      const recovered = await auth(request(app).get(`/api/books/document-creation-operations/${operationId}`));
      expect(recovered.status).toBe(200); expect(recovered.body.data).toMatchObject({ operationId, bookId: createdId, title: 'Recovered creation', status: 'completed' });
      const hidden = await request(app).get(`/api/books/document-creation-operations/${operationId}`).set('x-user-id', String(foreign.id)).set('x-github-id', foreign.githubId).set('x-username', 'Foreign author');
      expect(hidden.status).toBe(404); expect(JSON.stringify(hidden.body)).not.toContain('Recovered creation');
      const manifest = await documentService.manifest(userId, createdId);
      const draft = await auth(request(app).post(`/api/books/${createdId}/document-quick-drafts`)).send({ schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: manifest.revisionId, expectedScopes: { structure: manifest.scopes!.structure.revisionId }, summary: 'First draft', outline: 'Owned premise' });
      expect(draft.status).toBe(201); expect(draft.body.data.manifest.scenes).toHaveLength(1);
      expect(await db().act.count({ where: { bookId: createdId } })).toBe(1); expect(await db().chapter.count({ where: { act: { bookId: createdId } } })).toBe(1);
      expect((await auth(request(app).get(`/api/books/document-creation-operations/${draft.body.data.operationId}`))).status).toBe(404);
    } finally {
      await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId: createdId } }); await db().documentOperation.deleteMany({ where: { bookId: createdId } }); await db().bookDocumentHead.deleteMany({ where: { bookId: createdId } }); await db().bookDocumentRevision.deleteMany({ where: { bookId: createdId } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId: createdId } }); await db().sceneDocumentRevision.deleteMany({ where: { bookId: createdId } }); await db().book.delete({ where: { id: createdId } }); await db().user.delete({ where: { id: foreign.id } });
    }
  });

  test('body and metadata commit atomically, preserve formatting and recover the same receipt after acknowledgement loss', async () => {
    const expected = await conditions(); const source = await documentService.read(userId, bookId, sceneId);
    const patch = { prose: 'A preserved sentence.', summary: 'After' };
    const saved = await scenesService.updateSceneProse(userId, sceneId, patch, expected);
    const count = await db().sceneDocumentRevision.count({ where: { bookId } });
    expect(await scenesService.updateSceneProse(userId, sceneId, patch, expected)).toEqual(saved);
    expect(await db().sceneDocumentRevision.count({ where: { bookId } })).toBe(count);
    const current = await documentService.read(userId, bookId, sceneId); const paragraph = current.document.blocks[0];
    if (paragraph.type !== 'paragraph') throw new Error('Fixture paragraph');
    expect(paragraph.id).toBe(source.document.blocks[0].id);
    expect(paragraph.runs.every((run) => run.style.bold && run.style.font === 'Georgia' && run.style.size === 18)).toBe(true);
    expect((await documentService.scope(userId, bookId, 'layout')).content.headerFooterStories?.[0].document.blocks[0]).toMatchObject({ runs: [{ text: 'Protected header', style: { italic: true } }] });
    expect(current.projection.text).toBe(patch.prose); expect(saved.summary).toBe(patch.summary);
    expect(saved.documentRevision).toMatchObject({ operationId: expected.operationId, bookRevisionId: current.bookRevisionId, sceneRevisionId: current.revisionId });
    expect(await db().auditLog.count({ where: { userId, entityId: bookId, metadata: { path: ['operationId'], equals: expected.operationId } } })).toBe(1);
    await expect(scenesService.updateSceneProse(userId, sceneId, { prose: 'Stale overwrite', summary: 'Stale' }, { ...expected, operationId: randomUUID() })).rejects.toMatchObject({ status: 412 });
    expect((await db().scene.findUniqueOrThrow({ where: { id: sceneId } })).summary).toBe('After');
  });
  test('missing scope preconditions and ambiguous formatting fail without partial metadata or body writes', async () => {
    await expect(scenesService.updateSceneProse(userId, sceneId, { summary: 'Unconditional' })).rejects.toMatchObject({ status: 428 });
    const expected = await conditions();
    await expect(scenesService.updateSceneProse(userId, sceneId, { prose: 'A preserved sentence.', summary: 'Missing scope' }, { ...expected, expectedScopes: {} })).rejects.toMatchObject({ status: 428 });
    expect(await db().documentOperation.findUnique({ where: { id: expected.operationId } })).toBeNull();
    const source = await documentService.read(userId, bookId, sceneId); const paragraph = source.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('Fixture');
    paragraph.runs = [{ ...paragraph.runs[0], text: 'A preserved ' }, { id: randomUUID(), text: 'phrase.', style: { italic: true } }];
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    await expect(scenesService.updateSceneProse(userId, sceneId, { prose: 'An incompatible rewrite.', summary: 'Must roll back' }, await conditions())).rejects.toMatchObject({ status: 409 });
    expect((await db().scene.findUniqueOrThrow({ where: { id: sceneId } })).summary).toBe('Before');
    expect((await documentService.read(userId, bookId, sceneId)).projection.text).toBe('A preserved phrase.');
  });
  test('create, reorder and tombstone operations retain stable identities and immutable bodies', async () => {
    const expected = await conditions(); const sceneInputs = [{ prose: 'Second scene.', outline: 'Second' }, { prose: 'Third scene.' }];
    const created = await scenesService.batchCreateScenesForChapter({ userId, chapterId, scenes: sceneInputs, preconditions: expected });
    expect(await scenesService.batchCreateScenesForChapter({ userId, chapterId, scenes: sceneInputs, preconditions: expected })).toEqual(created);
    const source = await documentService.read(userId, bookId, created[0].id);
    const ids = [created[1].id, sceneId, created[0].id];
    await scenesService.reorderScenes(userId, bookId, chapterId, ids, await conditions());
    expect((await documentService.manifest(userId, bookId)).scenes.map((reference) => reference.sceneId)).toEqual(ids);
    expect((await documentService.read(userId, bookId, created[0].id)).revisionId).toBe(source.revisionId);
    await expect(scenesService.reorderScenes(userId, bookId, chapterId, [sceneId, sceneId, created[0].id], await conditions())).rejects.toMatchObject({ status: 409 });
    await scenesService.deleteScene(userId, bookId, created[0].id, await conditions());
    expect((await db().scene.findFirstOrThrow({ where: { id: created[0].id, deletedAt: {} } })).deletedAt).not.toBeNull();
    expect((await db().sceneDocumentRevision.findUniqueOrThrow({ where: { id: source.revisionId } })).document).toEqual(source.document);
    expect((await documentService.manifest(userId, bookId)).scenes.find((reference) => reference.sceneId === created[0].id)?.deletedAt).toBeTruthy();
    expect((await scenesService.createSceneForChapter({ userId, chapterId, prose: 'Another scene.', preconditions: await conditions() })).sceneNumber).toBeGreaterThan(0);
  });
  test('the compatibility API returns revision metadata and refuses a different route book even for the same owner', async () => {
    const expected = await conditions();
    const response = await auth(request(app).put(`/api/books/${bookId}/scenes/${sceneId}`)).send({ prose: 'A preserved sentence.', documentPreconditions: expected });
    expect(response.status).toBe(200); expect(response.body.data.scene.documentRevision.operationId).toBe(expected.operationId);
    const missing = await auth(request(app).put(`/api/books/${bookId}/scenes/${sceneId}`)).send({ prose: 'No preconditions' }); expect(missing.status).toBe(428);
    const otherBook = await db().book.create({ data: { userId, title: 'Other owned book' } });
    try {
      const wrongScope = await auth(request(app).put(`/api/books/${otherBook.id}/scenes/${sceneId}`)).send({ summary: 'Wrong book', documentPreconditions: await conditions() });
      expect(wrongScope.status).toBe(404);
    } finally { await db().book.delete({ where: { id: otherBook.id } }); }
  });
  test('CLI revision uses the owned document source captured before inference and refuses a formatting race', async () => {
    const close = jest.spyOn(cliDatabase, 'closeDatabase').mockResolvedValue(undefined);
    const report = jest.spyOn(output, 'json').mockImplementation(() => undefined);
    const inference = jest.spyOn(SceneProseService.prototype, 'reviseFromFindings').mockResolvedValue({ revised: 'A preserved sentence.', findingsAddressed: 0 });
    const handler = reviseCommand.handler; if (typeof handler !== 'function') throw new Error('CLI handler');
    try {
      await handler({ _: ['revise'], $0: 'proser', bookId, 'scene-id': sceneId, 'user-id': userId, json: true });
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ scenesRevised: 1, scenesFailed: 0 }));
      const saved = await documentService.read(userId, bookId, sceneId);
      expect(saved.document.changes.every((change) => change.authorId === userId && change.origin === 'ai' && change.status === 'pending')).toBe(true);
      expect(saved.document.changes.length).toBeGreaterThan(0);
      const paragraph = saved.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('Fixture');
      inference.mockImplementation(async () => {
        const current = await documentService.manifest(userId, bookId); const scope = await documentService.scope(userId, bookId, 'layout'); const layout = structuredClone(scope.content); layout.book.fontSize = 24;
        await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: current.revisionId, expectedScopes: { layout: scope.revisionId }, payload: { command: 'fixture-newer-layout' } }, async () => ({ result: {}, layout }));
        return { revised: 'Stale inference result.', findingsAddressed: 0 };
      });
      await handler({ _: ['revise'], $0: 'proser', bookId, 'scene-id': sceneId, 'user-id': userId, json: true });
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ scenesRevised: 0, scenesFailed: 1, results: [expect.objectContaining({ operationId: expect.any(String), success: false })] }));
      const current = await documentService.read(userId, bookId, sceneId);
      expect(current.projection.text).toBe('A preserved sentence.'); expect((await documentService.scope(userId, bookId, 'layout')).content.book.fontSize).toBe(24);
    } finally { close.mockRestore(); report.mockRestore(); inference.mockRestore(); }
  });
  test('structure, act and chapter writers preserve identities, reject stale saves and recover tombstone receipts', async () => {
    const source = await documentService.read(userId, bookId, sceneId); const initial = await documentService.manifest(userId, bookId);
    const originalAct = (await db().chapter.findUniqueOrThrow({ where: { id: chapterId } })).actId;
    const expected = await conditions();
    const response = await auth(request(app).post(`/api/books/${bookId}/structure`)).send({ acts: [{ id: originalAct, title: 'Retained act', chapters: [{ id: chapterId, title: 'Retained chapter' }, { title: 'Explicitly new chapter' }] }, { title: 'Explicitly new act', chapters: [] }], documentPreconditions: expected });
    expect(response.status).toBe(201); const acts = response.body.data.acts as Array<{ id: number; chapters: Array<{ id: number; title: string }> }>;
    expect(acts).toHaveLength(2); expect(acts[0].id).toBe(originalAct); expect(acts[0].chapters[0].id).toBe(chapterId);
    expect((await documentService.read(userId, bookId, sceneId)).revisionId).toBe(source.revisionId);
    const stale = await auth(request(app).post(`/api/books/${bookId}/structure`)).send({ acts: [{ id: originalAct, title: 'Stale title', chapters: [] }], documentPreconditions: { ...expected, operationId: randomUUID() } }); expect(stale.status).toBe(412);
    const extraAct = await actsService.createAct(userId, bookId, { title: 'Third act', summary: 'Keep this summary' }, await conditions());
    await actsService.updateAct(userId, bookId, extraAct.id, { title: 'Third act renamed' }, await conditions());
    expect((await db().act.findUniqueOrThrow({ where: { id: extraAct.id } })).summary).toBe('Keep this summary');
    const extraChapter = await chaptersService.createChapter(userId, bookId, extraAct.id, { title: 'New chapter' }, await conditions());
    const extraScene = await scenesService.createSceneForChapter({ userId, chapterId: extraChapter.id, prose: 'Preserved new scene.', preconditions: await conditions() });
    const deleteChapter = await conditions(); const chapterReceipt = await chaptersService.deleteChapter(userId, bookId, extraChapter.id, deleteChapter);
    expect(await chaptersService.deleteChapter(userId, bookId, extraChapter.id, deleteChapter)).toEqual(chapterReceipt);
    expect((await db().scene.findFirstOrThrow({ where: { id: extraScene.id, deletedAt: {} } })).deletedAt).not.toBeNull();
    const deleteAct = await conditions(); const actReceipt = await actsService.deleteAct(userId, bookId, originalAct, deleteAct);
    expect(await actsService.deleteAct(userId, bookId, originalAct, deleteAct)).toEqual(actReceipt);
    expect((await db().chapter.findUniqueOrThrow({ where: { id: chapterId } })).deletedAt).not.toBeNull();
    expect((await db().scene.findFirstOrThrow({ where: { id: sceneId, deletedAt: {} } })).deletedAt).not.toBeNull();
    const current = await documentService.manifest(userId, bookId);
    await documentService.restore(userId, bookId, initial.revisionId, current.revisionId, randomUUID());
    expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(source.document);
    expect((await db().act.findUniqueOrThrow({ where: { id: originalAct } })).deletedAt).toBeNull();
    expect((await db().chapter.findUniqueOrThrow({ where: { id: chapterId } })).deletedAt).toBeNull();
  });
  test('book creation is atomic and idempotent, with initialized scopes and an authenticated operation receipt', async () => {
    await expect(booksService.createBook(userId, { title: 'Missing operation' })).rejects.toMatchObject({ status: 428 });
    const operationId = randomUUID(); const data = { title: 'Atomic book creation', summary: 'Exact é and 😀' };
    const created = await booksService.createBook(userId, data, operationId);
    try {
      const recovered = await booksService.createBook(userId, data, operationId); expect(recovered.id).toBe(created.id);
      const manifest = await documentService.manifest(userId, created.id);
      expect(manifest.scenes).toEqual([]); expect(manifest.totals.wordCount).toBe(0);
      expect(Object.keys(manifest.scopes!).sort()).toEqual(['canon', 'layout', 'structure']);
      expect(await db().bookDocumentRevision.count({ where: { bookId: created.id } })).toBe(1);
      await expect(booksService.createBook(userId, { title: 'Different content' }, operationId)).rejects.toMatchObject({ status: 409 });
      expect((await documentService.operation(userId, created.id, operationId)).revisionId).toBe(manifest.revisionId);
      expect(await db().auditLog.count({ where: { userId, entityId: created.id } })).toBe(1);
    } finally {
      await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId: created.id } });
      await db().documentOperation.deleteMany({ where: { bookId: created.id } }); await db().bookDocumentHead.deleteMany({ where: { bookId: created.id } });
      await db().bookDocumentRevision.deleteMany({ where: { bookId: created.id } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId: created.id } });
      await db().book.delete({ where: { id: created.id } });
    }
  });
  test('book metadata and canon writers use scoped revisions, preserve body authority and recover their exact receipts', async () => {
    const source = await documentService.read(userId, bookId, sceneId);
    const expected = await conditions();
    await booksService.updateBook(userId, bookId, { title: 'Renamed book' }, expected);
    const metadata = await db().book.findUniqueOrThrow({ where: { id: bookId } }); expect(metadata.title).toBe('Renamed book');
    const canonConditions = async () => { const head = await documentService.manifest(userId, bookId); return { operationId: randomUUID(), expectedRevisionId: head.revisionId, expectedScopes: { canon: head.scopes!.canon.revisionId } }; };
    const create = await canonConditions(); const data = { entryType: 'character', entryName: 'Stable character', attributes: '{"aliases":["é"]}' };
    const entry = await codexService.createEntry(userId, bookId, data, create);
    expect((await codexService.createEntry(userId, bookId, data, create)).id).toBe(entry.id);
    await expect(codexService.updateEntry(userId, entry.id, { entryName: 'Stale character' }, { ...create, operationId: randomUUID() })).rejects.toMatchObject({ status: 412 });
    await codexService.updateEntry(userId, entry.id, { entryDescription: 'New description' }, await canonConditions());
    expect((await documentService.scope(userId, bookId, 'canon')).content.entries.find((item) => item.id === entry.id)).toMatchObject({ entryName: 'Stable character', entryDescription: 'New description', attributes: data.attributes });
    const remove = await canonConditions(); const removed = await codexService.deleteEntry(userId, entry.id, remove);
    expect(await codexService.deleteEntry(userId, entry.id, remove)).toEqual(removed);
    expect((await documentService.scope(userId, bookId, 'canon')).content.entries.find((item) => item.id === entry.id)?.deletedAt).toBeTruthy();
    expect((await documentService.read(userId, bookId, sceneId)).revisionId).toBe(source.revisionId);
  });
  test('lists a deleted book in the trash with the revision that restores it', async () => {
    const before = await documentService.manifest(userId, bookId);
    expect((await auth(request(app).get('/api/books/trash'))).body.data.books.some((book: { id: number }) => book.id === bookId)).toBe(false);
    const deleted = await booksService.deleteBook(userId, bookId, await conditions());
    if (!deleted) throw new Error('Missing lifecycle receipt');
    const trash = await auth(request(app).get('/api/books/trash'));
    expect(trash.status).toBe(200);
    const entry = trash.body.data.books.find((book: { id: number }) => book.id === bookId);
    expect(entry).toMatchObject({ title: 'Disposable writer fixture', revisionId: deleted.revisionId, restoreRevisionId: before.revisionId });
    const restored = await auth(request(app).post(`/api/books/${bookId}/document-revisions/${entry.restoreRevisionId}/restore`)).send({ operationId: randomUUID(), expectedRevisionId: entry.revisionId });
    expect(restored.status).toBe(200);
    expect((await auth(request(app).get('/api/books/trash'))).body.data.books.some((book: { id: number }) => book.id === bookId)).toBe(false);
    const otherUser = await db().user.create({ data: { githubId: `trash-other-${randomUUID()}`, username: 'Other writer' } });
    try {
      await booksService.deleteBook(userId, bookId, await conditions());
      const foreign = await request(app).get('/api/books/trash').set('x-user-id', String(otherUser.id)).set('x-github-id', otherUser.githubId).set('x-username', 'Other writer');
      expect(foreign.body.data.books).toEqual([]);
    } finally {
      await db().user.delete({ where: { id: otherUser.id } });
    }
  });
  test('book deletion records a restorable lifecycle revision and permits exact receipt recovery for its owner', async () => {
    const source = await documentService.read(userId, bookId, sceneId); const initial = await documentService.manifest(userId, bookId);
    const expected = await conditions(); const deleted = await booksService.deleteBook(userId, bookId, expected);
    if (!deleted) throw new Error('Missing lifecycle receipt');
    expect(await booksService.deleteBook(userId, bookId, expected)).toEqual(deleted);
    expect(await documentService.operation(userId, bookId, expected.operationId)).toEqual(deleted);
    await expect(documentService.operation(userId + 1000000, bookId, expected.operationId)).rejects.toThrow('Book not found');
    await expect(documentService.manifest(userId, bookId)).rejects.toThrow('Book not found');
    const restored = await auth(request(app).post(`/api/books/${bookId}/document-revisions/${initial.revisionId}/restore`)).send({ operationId: randomUUID(), expectedRevisionId: deleted.revisionId });
    expect(restored.status).toBe(200);
    expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(source.document);
    expect((await db().book.findFirstOrThrow({ where: { id: bookId } })).deletedAt).toBeNull();
  });
  test('native workflow revision IDs reference immutable manifests without rewriting preserved legacy evidence', async () => {
    const source = await documentService.read(userId, bookId, sceneId); const beforeCount = await db().manuscriptRevision.count({ where: { bookId } });
    expect(await manuscriptRevisionService.current(bookId)).toBe(source.bookRevisionId);
    expect(await db().manuscriptRevision.count({ where: { bookId } })).toBe(beforeCount);
    const bridge = await db().manuscriptRevision.findUniqueOrThrow({ where: { id: source.bookRevisionId } });
    expect(bridge.snapshot).toEqual({ schemaVersion: 1, documentRevisionId: source.bookRevisionId, projection: 'final' });
    const legacyId = randomUUID(); const oldSnapshot = { scenes: [{ id: sceneId, prose: 'Historical evidence' }], codex: [] };
    await db().manuscriptRevision.create({ data: { id: legacyId, bookId, contentHash: 'preserved-historical-hash', wordCount: 2, changedScopes: [], snapshot: oldSnapshot } });
    const legacy = await db().manuscriptRevision.findUniqueOrThrow({ where: { id: legacyId } });
    await scenesService.updateSceneProse(userId, sceneId, { prose: 'A preserved sentence.' }, await conditions());
    expect(await db().manuscriptRevision.findUniqueOrThrow({ where: { id: legacyId } })).toEqual(legacy);
    expect((await manuscriptRevisionService.snapshotRevision(bookId, source.bookRevisionId)).scenes[0].prose).toBe('A preserved phrase.');
    await expect(manuscriptRevisionService.snapshotRevision(bookId, legacyId)).rejects.toMatchObject({ code: 'DOCUMENT_LEGACY_MAPPING_REQUIRED' });
    expect((await manuscriptRevisionService.currentAncestry(bookId)).current).toBe((await documentService.manifest(userId, bookId)).revisionId);
  });
  test('workflow admission reads its native source without an implicit mutation under an admitted resource claim', async () => {
    const source = await documentService.manifest(userId, bookId); const count = await db().manuscriptRevision.count({ where: { bookId } });
    const current = await withDocumentMutationContext({ userId, sharedResourceOperationId: 'admission-is-not-execution', signal: () => undefined }, () => manuscriptRevisionService.current(bookId));
    expect(current).toBe(source.revisionId); expect(await db().manuscriptRevision.count({ where: { bookId } })).toBe(count);
  });
  test('a repeated backfill verifies body and catalog drift instead of activating stale authority', async () => {
    const source = await documentService.read(userId, bookId, sceneId);
    await db().scene.update({ where: { id: sceneId }, data: { prose: 'Legacy write after initial backfill' } });
    await expect(documentService.initialize(userId, bookId)).rejects.toMatchObject({ code: 'DOCUMENT_AUTHORITY_DRIFT' });
    await db().scene.update({ where: { id: sceneId }, data: { prose: source.projection.text, summary: 'Legacy metadata after initial backfill' } });
    await expect(documentService.initialize(userId, bookId)).rejects.toMatchObject({ code: 'DOCUMENT_AUTHORITY_DRIFT' });
    await db().scene.update({ where: { id: sceneId }, data: { summary: 'Before' } });
    expect(await documentService.initialize(userId, bookId)).toBe(source.bookRevisionId);
  });
  test('editorial patch compatibility tracks exact source edits, recovers the original result and fences complete restoration', async () => {
    const source = await documentService.read(userId, bookId, sceneId); const operationId = randomUUID();
    const input = { userId, bookId, expectedRevisionId: source.bookRevisionId, operationId, patches: [{ sceneId, expectedProse: source.projection.text, revisedProse: 'A preserved sentence.' }] };
    const result = await manuscriptRevisionService.applyScenePatches(input);
    expect(await manuscriptRevisionService.applyScenePatches(input)).toBe(result);
    const saved = await documentService.read(userId, bookId, sceneId);
    expect(saved.bookRevisionId).toBe(result); expect(saved.document.changes.length).toBeGreaterThan(0);
    expect(saved.document.changes.every((change) => change.origin === 'ai' && change.status === 'pending' && change.authorId === userId)).toBe(true);
    await expect(manuscriptRevisionService.restore(bookId, source.bookRevisionId)).rejects.toMatchObject({ status: 428 });
    await scenesService.updateSceneProse(userId, sceneId, { summary: 'Later metadata' }, await conditions());
    await expect(manuscriptRevisionService.restore(bookId, source.bookRevisionId, undefined, { userId, expectedRevisionId: result, operationId: randomUUID() })).rejects.toMatchObject({ status: 412 });
    const current = await documentService.manifest(userId, bookId);
    await manuscriptRevisionService.restore(bookId, source.bookRevisionId, undefined, { userId, expectedRevisionId: current.revisionId, operationId: randomUUID() });
    expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(source.document);
    expect((await db().scene.findUniqueOrThrow({ where: { id: sceneId } })).summary).toBe('Before');
  });
  test('authenticated request identity and cancellation are enforced before durable acknowledgement', async () => {
    const expected = await conditions(); const controller = new AbortController(); const source = await documentService.read(userId, bookId, sceneId);
    await expect(withDocumentMutationContext({ userId: userId + 1000000, signal: () => undefined }, () => documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] }))).rejects.toThrow('Book not found');
    await expect(withDocumentMutationContext({ userId, actorGithubId: githubId, signal: () => controller.signal }, () => documentService.mutateCatalog(userId, bookId, { ...expected, payload: { cancelled: true } }, async (tx) => {
      await tx.scene.update({ where: { id: sceneId }, data: { summary: 'Must roll back cancellation' } }); controller.abort(); return { result: null };
    }))).rejects.toMatchObject({ name: 'AbortError' });
    expect((await db().scene.findUniqueOrThrow({ where: { id: sceneId } })).summary).toBe('Before');
    expect((await documentService.manifest(userId, bookId)).revisionId).toBe(source.bookRevisionId);
    expect(await db().documentOperation.findUnique({ where: { id: expected.operationId } })).toBeNull();
  });
  test('a superseded shared resource fence cannot commit structured content', async () => {
    const operationId = `fixture-fence-${randomUUID()}`; const resourceKey = `provider:proser:${bookId}`;
    const claim = { leaseId: 'fixture_lease_123456789', version: 1, resources: [{ resourceKey, fenceGeneration: '1' }], missionRootId: 'document-fixture', missionRevision: 1, taskId: 'document-fixture', operationId, requestSha256: 'a'.repeat(64), actionClass: 'reversible_change', deadline: Math.floor(Date.now() / 1000) + 300, caller: { kind: 'direct' }, ownerActor: githubId, evidenceDomain: 'nova.provider-result.v1' };
    await db().sharedResourceOperation.create({ data: { operationId, leaseId: claim.leaseId, claimJson: JSON.stringify(claim), claimSha256: 'b'.repeat(64), requestSha256: claim.requestSha256, evidenceDomain: claim.evidenceDomain, method: 'POST', route: `/api/books/${bookId}/document-commits`, bodySha256: 'c'.repeat(64), state: 'running' } });
    await db().sharedResourceFence.create({ data: { resourceKey, highestGeneration: 1n, operationId } });
      const expected = await conditions();
      await withDocumentMutationContext({ userId, actorGithubId: githubId, sharedResourceOperationId: operationId, signal: () => undefined }, () => scenesService.updateSceneProse(userId, sceneId, { summary: 'Fenced edit' }, expected));
      expect((await db().scene.findUniqueOrThrow({ where: { id: sceneId } })).summary).toBe('Fenced edit');
      const successorId = `newer-${randomUUID()}`;
      await db().sharedResourceOperation.create({ data: { operationId: successorId, leaseId: claim.leaseId, claimJson: JSON.stringify({ ...claim, operationId: successorId, resources: [{ resourceKey, fenceGeneration: '2' }] }), claimSha256: 'd'.repeat(64), requestSha256: claim.requestSha256, evidenceDomain: claim.evidenceDomain, method: 'POST', route: `/api/books/${bookId}/document-commits`, bodySha256: 'e'.repeat(64), state: 'running' } });
      await db().sharedResourceFence.update({ where: { resourceKey }, data: { highestGeneration: 2n, operationId: successorId } });
      const stale = await conditions();
      await expect(withDocumentMutationContext({ userId, sharedResourceOperationId: operationId, signal: () => undefined }, () => scenesService.updateSceneProse(userId, sceneId, { summary: 'Superseded edit' }, stale))).rejects.toMatchObject({ code: 'SHARED_RESOURCE_FENCE_LOST' });
      expect((await db().scene.findUniqueOrThrow({ where: { id: sceneId } })).summary).toBe('Fenced edit');
      expect(await db().documentOperation.findUnique({ where: { id: stale.operationId } })).toBeNull();
    // Retain fixture operation/fence history: database enforcement deliberately
    // forbids deleting it. The entire acceptance database is disposable.
  });
  test('generation freezes its source, persists its result, tracks paragraph replacement and recovers without another provider call', async () => {
    const source = await documentService.read(userId, bookId, sceneId); const expected = await conditions();
    const inference = jest.spyOn(SceneProseService.prototype, 'generateProse').mockResolvedValue({ prose: 'Generated first.\n\nGenerated second.', wordCount: 4 });
    const input = { bookId, sceneId, expected, context: { bookId, sceneId, title: '', useCodexRAG: true } };
    try {
      const saved = await generateOwnedScene(userId, input);
      const replay = await generateOwnedScene(userId, input);
      expect(replay).toEqual(saved); expect(inference).toHaveBeenCalledTimes(1);
      expect(inference.mock.calls[0][1]).toMatchObject({ noTransportReplay: true, frozenContext: true });
      const document = (await documentService.read(userId, bookId, sceneId)).document;
      expect(projectDocument(document).text).toBe('Generated first.\n\nGenerated second.'); expect(projectDocument(document, 'original').text).toBe(source.projection.text);
      expect((await documentService.scope(userId, bookId, 'layout')).content.headerFooterStories?.[0].document.blocks[0]).toMatchObject({ runs: [{ text: 'Protected header', style: { italic: true } }] });
      expect(document.changes.map((change) => change.kind)).toEqual(['paragraphDeletion', 'paragraphInsertion']);
      expect((await readSceneGeneration(userId, bookId, expected.operationId)).status).toBe('completed');
      await scenesService.updateSceneProse(userId, sceneId, { summary: 'Newer metadata' }, await conditions());
      expect(await recoverSceneGeneration(userId, bookId, sceneId, expected.operationId, true)).toEqual(saved);
      expect(await cancelSceneGeneration(userId, bookId, expected.operationId)).toMatchObject({ status: 'completed', application: 'committed' });
      expect(inference).toHaveBeenCalledTimes(1);
      await expect(recoverSceneGeneration(userId, bookId, sceneId, expected.operationId, false)).rejects.toMatchObject({ status: 409 });
      await expect(generateOwnedScene(userId, { ...input, context: { ...input.context, title: 'Different request' } })).rejects.toMatchObject({ status: 409 });
      await expect(readSceneGeneration(userId + 1000000, bookId, expected.operationId)).rejects.toMatchObject({ status: 404 });
    } finally { inference.mockRestore(); }
  });
  test('a provider outcome remains unknown and a stale completed result cannot overwrite a newer revision', async () => {
    const inference = jest.spyOn(SceneProseService.prototype, 'generateProse').mockRejectedValue(new Error('Lost provider acknowledgement'));
    const expected = await conditions(); const input = { bookId, sceneId, expected, context: { bookId, sceneId, title: '' } };
    try {
      await expect(generateOwnedScene(userId, input)).rejects.toMatchObject({ code: 'DOCUMENT_INFERENCE_UNKNOWN' });
      await expect(generateOwnedScene(userId, input)).rejects.toMatchObject({ code: 'DOCUMENT_INFERENCE_UNKNOWN' });
      expect(inference).toHaveBeenCalledTimes(1); expect((await readSceneGeneration(userId, bookId, expected.operationId)).status).toBe('unknown');
      const next = { ...input, expected: await conditions() };
      inference.mockImplementation(async () => { await scenesService.updateSceneProse(userId, sceneId, { summary: 'Newer human work' }, await conditions()); return { prose: 'Late generated text.', wordCount: 3 }; });
      await expect(generateOwnedScene(userId, next)).rejects.toMatchObject({ status: 412 });
      expect((await readSceneGeneration(userId, bookId, next.expected.operationId)).result).toMatchObject({ prose: 'Late generated text.' });
      expect((await db().scene.findUniqueOrThrow({ where: { id: sceneId } })).summary).toBe('Newer human work');
      expect((await documentService.read(userId, bookId, sceneId)).projection.text).toBe('A preserved phrase.');
    } finally { inference.mockRestore(); }
  });
  test('outline append is atomic and preserves existing identities and body revisions', async () => {
    const source = await documentService.read(userId, bookId, sceneId); const expected = await conditions();
    const tree = { acts: [{ title: 'Appended act', chapters: [{ title: 'Appended chapter', scenes: [{ outline: 'An exact outline' }] }] }] };
    const result = await commitOutline(userId, bookId, tree, expected);
    expect(await commitOutline(userId, bookId, tree, expected)).toEqual(result);
    expect((await documentService.read(userId, bookId, sceneId)).revisionId).toBe(source.revisionId);
    const createdId = result.result.acts[0].chapters[0].sceneIds[0];
    expect((await documentService.read(userId, bookId, createdId)).projection.text).toBe('');
    await expect(commitOutline(userId, bookId, tree, { ...expected, operationId: randomUUID() })).rejects.toMatchObject({ status: 412 });
    expect((await documentService.manifest(userId, bookId)).scenes.map((reference) => reference.sceneId)).toContain(sceneId);
  });
  test('character canon batches commit atomically and reject a newer source without duplicating entries', async () => {
    const source = await documentService.read(userId, bookId, sceneId);
    const head = await documentService.manifest(userId, bookId);
    const expected = { operationId: randomUUID(), expectedRevisionId: head.revisionId, expectedScopes: { canon: head.scopes!.canon.revisionId } };
    const entries = [{ entryType: 'character', entryName: 'First', entryDescription: 'One' }, { entryType: 'character', entryName: 'Second', entryDescription: 'Two' }];
    const saved = await codexService.createEntries(userId, bookId, entries, expected);
    expect(JSON.parse(JSON.stringify(await codexService.createEntries(userId, bookId, entries, expected)))).toEqual(JSON.parse(JSON.stringify(saved)));
    expect(saved.entries).toHaveLength(2);
    expect(await db().codexEntry.count({ where: { bookId } })).toBe(2);
    await expect(codexService.createEntries(userId, bookId, entries, { ...expected, operationId: randomUUID() })).rejects.toMatchObject({ status: 412 });
    await expect(codexService.createEntries(userId, bookId, [...entries, { entryType: 'character', entryName: '' }], { ...expected, operationId: randomUUID() })).rejects.toThrow();
    expect((await documentService.read(userId, bookId, sceneId)).revisionId).toBe(source.revisionId);
  });
  test('cancellation aborts inference, retains late output and cannot be replayed or applied', async () => {
    const source = await documentService.read(userId, bookId, sceneId); const expected = await conditions();
    const input = { bookId, sceneId, expected, context: { bookId, sceneId, title: '' } };
    const inference = jest.spyOn(SceneProseService.prototype, 'generateProse').mockImplementation(async (_context, options) => {
      await expect(cancelSceneGeneration(userId + 1000000, bookId, expected.operationId)).rejects.toMatchObject({ name: 'NotFoundError' });
      const cancelled = await auth(request(app).post(`/api/books/${bookId}/document-inference-operations/${expected.operationId}/cancel`)).send({});
      expect(cancelled.status).toBe(200); expect(cancelled.body.data.status).toBe('cancelled');
      expect(options?.signal?.aborted).toBe(true);
      return { prose: 'Late cancelled result.', wordCount: 3 };
    });
    try {
      await expect(generateOwnedScene(userId, input)).rejects.toMatchObject({ code: 'DOCUMENT_INFERENCE_CANCELLED' });
      const retained = await readSceneGeneration(userId, bookId, expected.operationId);
      expect(retained).toMatchObject({ status: 'cancelled', result: { prose: 'Late cancelled result.' }, application: { status: 'unapplied' } });
      await expect(generateOwnedScene(userId, input)).rejects.toMatchObject({ code: 'DOCUMENT_INFERENCE_CANCELLED' });
      await expect(scenesService.updateSceneProse(userId, sceneId, { prose: 'Late cancelled result.' }, { ...expected, origin: 'ai', regeneration: true })).rejects.toMatchObject({ code: 'DOCUMENT_INFERENCE_CANCELLED' });
      expect(inference).toHaveBeenCalledTimes(1);
      expect((await documentService.read(userId, bookId, sceneId)).revisionId).toBe(source.revisionId);
    } finally { inference.mockRestore(); }
  });
  test('scene generation APIs require source revisions and recover creation plus generation without duplicate effects', async () => {
    const inference = jest.spyOn(SceneProseService.prototype, 'generateProse').mockResolvedValue({ prose: 'API generated prose.', wordCount: 3 });
    try {
      const missing = await auth(request(app).post(`/api/books/${bookId}/scenes/${sceneId}/regenerate`)).send({});
      expect(missing.status).toBe(428); expect(inference).not.toHaveBeenCalled();
      const documentPreconditions = await conditions();
      const body = { generate: true, outline: 'New scene', documentPreconditions };
      const url = `/api/books/${bookId}/chapters/${chapterId}/scenes/generate`;
      const created = await auth(request(app).post(url)).send(body);
      expect(created.status).toBe(201);
      const replay = await auth(request(app).post(url)).send(body);
      expect(replay.status).toBe(201); expect(replay.body).toEqual(created.body);
      expect(inference).toHaveBeenCalledTimes(1);
      expect(await db().scene.count({ where: { chapterId } })).toBe(2);
      const recovery = await auth(request(app).get(`/api/books/${bookId}/document-inference-operations/${created.body.data.scene.documentRevision.operationId}`));
      expect(recovery.status).toBe(200); expect(recovery.body.data.application.status).toBe('committed');
    } finally { inference.mockRestore(); }
  });
  test('saved batch generation advances only its own head and replays its retained receipts', async () => {
    const created = await scenesService.createSceneForChapter({ userId, chapterId, outline: 'Second', preconditions: await conditions() });
    const first = await conditions(); const second = await documentService.read(userId, bookId, created.id);
    const input = { bookId, saveToScene: true, items: [
      { sceneId, documentPreconditions: first },
      { sceneId: created.id, documentPreconditions: { ...first, operationId: randomUUID(), expectedSceneRevisionId: second.revisionId } },
    ] };
    const inference = jest.spyOn(SceneProseService.prototype, 'generateProse').mockResolvedValue({ prose: 'Batch prose.', wordCount: 2 });
    try {
      const result = await auth(request(app).post('/api/generate/prose/batch')).send(input);
      expect(result.status).toBe(200);
      expect(result.body.data.results.map((item: { status: string }) => item.status)).toEqual(['completed', 'completed']);
      const replay = await auth(request(app).post('/api/generate/prose/batch')).send(input);
      expect(replay.status).toBe(200); expect(replay.body.data.results).toEqual(result.body.data.results);
      expect(inference).toHaveBeenCalledTimes(2);
      expect((await documentService.read(userId, bookId, sceneId)).projection.text).toBe('Batch prose.');
      expect((await documentService.read(userId, bookId, created.id)).projection.text).toBe('Batch prose.');
    } finally { inference.mockRestore(); }
  });
  test('an authorized guided workflow applies through native authority and preserves styles and workflow provenance', async () => {
    const source = await documentService.read(userId, bookId, sceneId); const paragraph = source.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    paragraph.runs[0].text = Array.from({ length: 180 }, (_, index) => `word${index}`).join(' ');
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    const run = await workflowService.start(userId, 'guided_improve', { bookId, scope: { type: 'scene', id: sceneId }, instruction: 'Replace exactly "word90" with "changed90".' }, undefined, false, undefined, `fixture-${randomUUID()}`);
    await workflowService.process(run.runId);
    const current = await documentService.read(userId, bookId, sceneId); const body = current.document.blocks[0]; if (body.type !== 'paragraph') throw new Error('fixture');
    expect(current.projection.text).toContain('changed90'); expect(body.runs.every((run) => run.style.bold && run.style.font === 'Georgia')).toBe(true);
    expect(current.document.changes.every((change) => change.origin === 'workflow' && change.authorId === userId)).toBe(true);
    expect((await db().manuscriptRevision.findUniqueOrThrow({ where: { id: current.bookRevisionId } })).workflowRunId).toBe(run.runId);
    expect((await db().workflowRun.findUniqueOrThrow({ where: { id: run.runId } })).status).toBe('completed');
  });
});
