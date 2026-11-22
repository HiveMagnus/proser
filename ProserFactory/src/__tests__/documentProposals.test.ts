import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { canonicalDocument, documentFromText, projectDocument } from '@/documents/model';
import { createDocumentDiscussion, requestDocumentProposal, readDocumentProposal, revalidateDocumentProposal, applyDocumentProposal, cancelDocumentProposal } from '@/documents/proposals';
import { SceneProseService } from '@/services/sceneProseService';
import type { DocumentDiscussionInput, DocumentDiscussionSnapshot } from '@/documents/proposal-model';
import { InferenceTerminalError } from '@/lib/ai/terminalReason';
import { passageOperationRunSource } from '@/documents/passageOperationSources';
import { deriveDiscussionDraft } from '@/documents/proposalDraft';
import { readPassageOwnedContext } from '@/documents/passageSource';

describe('owned frozen document proposals', () => {
  const previousAuthority = process.env.DOCUMENT_AUTHORITY_ENABLED;
  const previousCapacity = process.env.DOCUMENT_AI_CONTEXT_TOKENS;
  let userId: number; let bookId: number; let sceneId: number; let githubId: string;
  const db = () => databaseService.client;
  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true'; process.env.DOCUMENT_AI_CONTEXT_TOKENS = '32768';
    githubId = `proposal-fixture-${randomUUID()}`; userId = (await db().user.create({ data: { githubId, username: 'Proposal author' } })).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, title: 'Disposable proposal fixture', acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: { sceneNumber: 1, prose: 'Repeated phrase.\n\nRepeated phrase.' } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
    bookId = book.id; sceneId = book.acts[0].chapters[0].scenes[0].id;
    await documentService.initialize(userId, bookId);
    const source = await documentService.read(userId, bookId, sceneId);
    for (const block of source.document.blocks) if (block.type === 'paragraph') block.runs[0].style = { bold: true, font: 'Georgia' };
    const paragraph = documentFromText('Protected table 😀 é.', randomUUID).blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    source.document.blocks.push({ type: 'table', id: randomUUID(), widths: [120], rows: [{ id: randomUUID(), cells: [{ id: randomUUID(), paragraphs: [paragraph] }] }] });
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db().documentProposalValidation.deleteMany({ where: { bookId } }); await db().documentProposal.deleteMany({ where: { bookId } }); await db().documentDiscussion.deleteMany({ where: { bookId } });
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } }); await db().documentOperation.deleteMany({ where: { bookId } }); await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } }); await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => {
    if (previousAuthority === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = previousAuthority;
    if (previousCapacity === undefined) delete process.env.DOCUMENT_AI_CONTEXT_TOKENS; else process.env.DOCUMENT_AI_CONTEXT_TOKENS = previousCapacity;
    await db().user.delete({ where: { id: userId } });
  });
  const auth = (value: request.Test) => value.set('x-user-id', String(userId)).set('x-github-id', githubId).set('x-username', 'Proposal author');
  const context = async (index = 1): Promise<DocumentDiscussionInput> => {
    const source = await documentService.read(userId, bookId, sceneId); const paragraph = source.document.blocks[index]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    const text = paragraph.runs.map((run) => run.text).join('');
    return { schemaVersion: 1, operationId: randomUUID(), sessionId: randomUUID(), sceneId, expectedRevisionId: source.bookRevisionId, expectedSceneRevisionId: source.revisionId, expectedContentHash: source.contentHash, projection: 'final', targets: [{ blockId: paragraph.id, from: 0, to: text.length, sourceText: text }] };
  };
  const model = (replacement = 'Repeated wording.') => jest.spyOn(SceneProseService.prototype, 'proposeDocumentEdits').mockImplementation(async (snapshot) => ({ raw: JSON.stringify({ reply: 'A precise edit.', edits: [{ targetId: snapshot.targets[0].targetId, sourceText: snapshot.targets[0].sourceText, replacement }] }), provenance: { providerId: 'fixture', params: {}, recipe: 'document-proposal', recipeVersion: snapshot.templateVersion } }));
  const prepare = async () => {
    const discussion = await createDocumentDiscussion(userId, bookId, await context());
    const input = { operationId: randomUUID(), instruction: 'Revise exactly the selected passage.' };
    const proposal = await requestDocumentProposal(userId, bookId, discussion.id, input);
    return { discussion, input, proposal, snapshot: discussion.snapshot as unknown as DocumentDiscussionSnapshot };
  };
  const revalidate = async (proposalId: string) => {
    const source = await documentService.read(userId, bookId, sceneId);
    return revalidateDocumentProposal(userId, bookId, proposalId, { operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, expectedSceneRevisionId: source.revisionId });
  };
  test('moving an unchanged chapter to another act invalidates the qualified parent while scene and layout references stay unchanged',async()=>{
    const inference=model();const prepared=await prepare();const source=await documentService.read(userId,bookId,sceneId);const manifest=await documentService.manifest(userId,bookId);await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:manifest.revisionId,expectedScopes:{structure:manifest.scopes!.structure.revisionId},payload:{fixture:'move-chapter-act'}},async(tx)=>{const act=await tx.act.create({data:{bookId,actNumber:2,title:'Different act context'}});return {result:await tx.chapter.update({where:{id:source.chapterId},data:{actId:act.id}})};});
    const current=await documentService.read(userId,bookId,sceneId);expect(current.chapterId).toBe(source.chapterId);expect(current.revisionId).toBe(source.revisionId);expect(current.contentHash).toBe(source.contentHash);expect((await documentService.manifest(userId,bookId)).scopes!.layout).toEqual(manifest.scopes!.layout);await expect(revalidate(prepared.proposal.id)).rejects.toMatchObject({code:'DOCUMENT_TARGET_STALE',status:409});expect(inference).toHaveBeenCalledTimes(1);
  });
  test('moving an unchanged scene to a different owned chapter layout rejects revalidation and application without inference replay',async()=>{
    const source=await documentService.read(userId,bookId,sceneId);const layout=await documentService.scope(userId,bookId,'layout');const structure=await documentService.scope(userId,bookId,'structure');const actId=structure.content.chapters.find((chapter)=>chapter.id===source.chapterId)!.actId;
    const setup=await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:layout.bookRevisionId,expectedScopes:{layout:layout.revisionId,structure:structure.revisionId},payload:{fixture:'two-owned-layouts'}},async(tx)=>{const chapter=await tx.chapter.create({data:{actId,chapterNumber:2,title:'Different parent'}});const contents=structuredClone(layout.content);contents.chapters[String(source.chapterId)]={...contents.book,fontSize:16};contents.chapters[String(chapter.id)]={...contents.book,fontSize:28};return {result:{chapterId:chapter.id},layout:contents};});
    const inference=model();const prepared=await prepare();const before=await documentService.read(userId,bookId,sceneId);const validated=await revalidate(prepared.proposal.id);const oldManifest=await documentService.manifest(userId,bookId);
    await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:oldManifest.revisionId,expectedScopes:{structure:oldManifest.scopes!.structure.revisionId},payload:{fixture:'move-scene'}},async(tx)=>({result:await tx.scene.update({where:{id:sceneId},data:{chapterId:setup.result.chapterId,sceneNumber:1}})}));
    const current=await documentService.read(userId,bookId,sceneId);const head=await documentService.manifest(userId,bookId);expect(current.revisionId).toBe(before.revisionId);expect(current.contentHash).toBe(before.contentHash);expect(head.scopes!.layout).toEqual(oldManifest.scopes!.layout);expect(current.chapterId).not.toBe(before.chapterId);
    await expect(revalidate(prepared.proposal.id)).rejects.toMatchObject({code:'DOCUMENT_TARGET_STALE',status:409});const operationId=randomUUID();await expect(applyDocumentProposal(userId,bookId,prepared.proposal.id,{operationId,expectedRevisionId:current.bookRevisionId,expectedSceneRevisionId:current.revisionId,validationId:validated.id,targetIds:[prepared.snapshot.targets[0].targetId]})).rejects.toMatchObject({status:412});expect(await db().documentOperation.findUnique({where:{id:operationId}})).toBeNull();
    // Prior releases could have persisted an incorrect explicit validation after
    // the move. Application must recheck immutable parent evidence independently.
    const historicalId=randomUUID();await db().documentProposalValidation.create({data:{id:historicalId,proposalId:prepared.proposal.id,bookId,userId,bookRevisionId:current.bookRevisionId,sceneRevisionId:current.revisionId,contentHash:current.contentHash,targets:JSON.parse(JSON.stringify(prepared.snapshot.targets))}});const guardedId=randomUUID();await expect(applyDocumentProposal(userId,bookId,prepared.proposal.id,{operationId:guardedId,expectedRevisionId:current.bookRevisionId,expectedSceneRevisionId:current.revisionId,validationId:historicalId,targetIds:[prepared.snapshot.targets[0].targetId]})).rejects.toMatchObject({code:'DOCUMENT_TARGET_STALE',status:409});expect(await db().documentOperation.findUnique({where:{id:guardedId}})).toBeNull();expect(inference).toHaveBeenCalledTimes(1);expect((await documentService.read(userId,bookId,sceneId)).document).toEqual(before.document);
  });
  test('legacy command names require disclosed owned targets and recover typed proposals without replay', async () => {
    const inference = model(); const source = await documentService.read(userId, bookId, sceneId);
    const path = '/api/generate/prose/command-revise';
    const old = await auth(request(app).post(path)).send({ bookId, sceneId, originalText: 'Arbitrary prose.', instruction: 'Revise.', scope: 'paragraph' });
    expect(old.status).toBe(428); expect(inference).not.toHaveBeenCalled();
    const discussion = await createDocumentDiscussion(userId, bookId, await context());
    const body = { bookId, sceneId, instruction: 'Revise.', scope: 'paragraph', documentPreview: { discussionId: discussion.id, operationId: randomUUID() } };
    const forged = await auth(request(app).post(path)).send({ ...body, originalText: 'A different quotation.' });
    expect(forged.status).toBe(409); expect(inference).not.toHaveBeenCalled();
    const foreign = await auth(request(app).post(path)).send({ ...body, sceneId: sceneId + 1000000 });
    expect(foreign.status).toBe(409); expect(inference).not.toHaveBeenCalled();
    const result = await auth(request(app).post(path)).send(body);
    expect(result.status).toBe(200); expect(result.body.data).toMatchObject({ schemaVersion: 1, proposalId: body.documentPreview.operationId, source: { sceneRevisionId: source.revisionId }, proposal: { status: 'ready' } });
    expect(result.body.data.revised).toBeUndefined();
    const retry = await auth(request(app).post(path)).send(body);
    expect(retry.status).toBe(200); expect(inference).toHaveBeenCalledTimes(1);
    expect((await documentService.read(userId, bookId, sceneId)).revisionId).toBe(source.revisionId);
  });
  test('findings revisions use typed proposal inference and reject stale disclosed context', async () => {
    const inference = model(); const legacy = jest.spyOn(SceneProseService.prototype, 'reviseFromFindings');
    const discussion = await createDocumentDiscussion(userId, bookId, await context());
    const body = { bookId, sceneId, findings: [{ type: 'style', severity: 'suggestion', message: 'Improve the selected passage.', confidence: 0.9 }], documentPreview: { discussionId: discussion.id, operationId: randomUUID() } };
    const response = await auth(request(app).post('/api/generate/prose/revise')).send(body);
    expect(response.status).toBe(200); expect(response.body.data.proposal.status).toBe('ready'); expect(legacy).not.toHaveBeenCalled();
    const source = await documentService.read(userId, bookId, sceneId);
    const layout = await documentService.scope(userId, bookId, 'layout');
    layout.content.book.margins[0] += 1;
    await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, expectedScopes: { layout: layout.revisionId }, payload: { layout: layout.content } }, async () => ({ result: null, layout: layout.content }));
    const stale = await auth(request(app).post('/api/generate/prose/revise')).send({ ...body, documentPreview: { ...body.documentPreview, operationId: randomUUID() } });
    expect(stale.status).toBe(412); expect(inference).toHaveBeenCalledTimes(1);
  });
  test('API context preview discloses complete selected blocks before any inference and preserves originals', async () => {
    const inference = model(); const input = await context(); const source = await documentService.read(userId, bookId, sceneId);
    const missing = await auth(request(app).post(`/api/books/${bookId}/document-discussions`)).send({}); expect(missing.status).toBe(428);
    const response = await auth(request(app).post(`/api/books/${bookId}/document-discussions`)).send(input);
    expect(response.status).toBe(200); expect(inference).not.toHaveBeenCalled();
    expect(response.body.data.snapshot).toMatchObject({ unsaved: false, sourceContentHash: source.contentHash, blocks: [{ id: input.targets[0].blockId }] });
    expect(response.body.data.snapshot.omitted.blockIds).toContain(source.document.blocks[0].id);
    expect((await createDocumentDiscussion(userId, bookId, input)).id).toBe(response.body.data.id);
    expect((await documentService.read(userId, bookId, sceneId)).revisionId).toBe(source.revisionId);
    await expect(createDocumentDiscussion(userId + 100000, bookId, input)).rejects.toMatchObject({ status: 404 });
  });
  test('a leading protected image does not shift an exact repeated-text proposal target', async () => {
    const source = await documentService.read(userId, bookId, sceneId);
    const asset = await db().imageAsset.create({ data: { bookId, userId, name: 'Protected inline fixture', url: '/images/fixture.png', configJson: JSON.stringify({ sha256: 'a'.repeat(64) }) } });
    const paragraph = source.document.blocks[1]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    paragraph.runs = [{ id: randomUUID(), text: '', style: {}, inlineImage: { assetId: asset.id, sha256: 'a'.repeat(64), alt: 'Protected image', width: 100, height: 80 } }, { id: randomUUID(), text: 'aaaa', style: { bold: true } }];
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    const saved = await documentService.read(userId, bookId, sceneId);
    const discussion = await createDocumentDiscussion(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), sessionId: randomUUID(), sceneId, expectedRevisionId: saved.bookRevisionId, expectedSceneRevisionId: saved.revisionId, expectedContentHash: saved.contentHash, projection: 'final', targets: [{ blockId: paragraph.id, from: 1, to: 2, sourceText: 'a' }] });
    model('A');
    const proposal = await requestDocumentProposal(userId, bookId, discussion.id, { operationId: randomUUID(), instruction: 'Change only the first supplied letter.' });
    const validation = await revalidate(proposal.id);
    await applyDocumentProposal(userId, bookId, proposal.id, { operationId: randomUUID(), expectedRevisionId: validation.bookRevisionId, expectedSceneRevisionId: validation.sceneRevisionId, validationId: validation.id, targetIds: [(discussion.snapshot as unknown as DocumentDiscussionSnapshot).targets[0].targetId] });
    const current = await documentService.read(userId, bookId, sceneId);
    expect(current.projection.text).toContain('\uFFFCAaaa');
    expect(projectDocument(current.document, 'original').text).toBe(saved.projection.text);
    const unchangedImage = (current.document.blocks[1] as typeof paragraph).runs.find((run) => run.inlineImage);
    expect(unchangedImage).toEqual(paragraph.runs[0]);
  });
  test('tracked application uses stable identities for repeated quotations and leaves formatting/table objects intact', async () => {
    const inference = model(); const source = await documentService.read(userId, bookId, sceneId);
    const { discussion, proposal, snapshot, input } = await prepare();
    expect(proposal.status).toBe('ready');
    expect((await requestDocumentProposal(userId, bookId, discussion.id, input)).id).toBe(proposal.id); expect(inference).toHaveBeenCalledTimes(1);
    const validation = await revalidate(proposal.id);
    const application = { operationId: randomUUID(), expectedRevisionId: validation.bookRevisionId, expectedSceneRevisionId: validation.sceneRevisionId, validationId: validation.id, targetIds: [snapshot.targets[0].targetId] };
    const committed = await applyDocumentProposal(userId, bookId, proposal.id, application);
    expect(Object.hasOwn(committed, 'scenes')).toBe(false); expect(committed.sceneReferences).toHaveLength(1);
    expect(await applyDocumentProposal(userId, bookId, proposal.id, application)).toEqual(committed);
    const current = await documentService.read(userId, bookId, sceneId);
    expect(projectDocument(current.document).text).toBe('Repeated phrase.\n\nRepeated wording.\n\nProtected table 😀 é.');
    expect(projectDocument(current.document, 'original').text).toBe(source.projection.text);
    expect(current.document.blocks[0]).toEqual(source.document.blocks[0]); expect(current.document.blocks[2]).toEqual(source.document.blocks[2]);
    const paragraph = current.document.blocks[1]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    expect(paragraph.runs.every((run) => run.style.bold && run.style.font === 'Georgia')).toBe(true);
    expect(current.document.changes.every((change) => change.status === 'pending' && change.origin === 'ai' && change.authorId === userId && change.authorName === 'Proposal author')).toBe(true);
    expect((await readDocumentProposal(userId, bookId, proposal.id)).application).toEqual(JSON.parse(JSON.stringify(committed)));
  });
  test('unrelated edits require explicit revalidation while changed target formatting cannot apply', async () => {
    model(); const { proposal, snapshot } = await prepare();
    const unrelated = await documentService.read(userId, bookId, sceneId); const first = unrelated.document.blocks[0]; if (first.type !== 'paragraph') throw new Error('fixture'); first.runs[0].text = 'Unrelated newer text.';
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: unrelated.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: unrelated.revisionId, document: unrelated.document }] });
    const validation = await revalidate(proposal.id); expect(validation.sceneRevisionId).not.toBe(snapshot.sourceSceneRevisionId);
    const changed = await documentService.read(userId, bookId, sceneId); const target = changed.document.blocks[1]; if (target.type !== 'paragraph') throw new Error('fixture'); target.runs[0].style.italic = true;
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: changed.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: changed.revisionId, document: changed.document }] });
    await expect(revalidate(proposal.id)).rejects.toMatchObject({ code: 'DOCUMENT_TARGET_STALE' });
    await expect(applyDocumentProposal(userId, bookId, proposal.id, { operationId: randomUUID(), expectedRevisionId: validation.bookRevisionId, expectedSceneRevisionId: validation.sceneRevisionId, validationId: validation.id, targetIds: [snapshot.targets[0].targetId] })).rejects.toMatchObject({ status: 412 });
    expect((await readDocumentProposal(userId, bookId, proposal.id)).status).toBe('ready');
  });
  test('unsaved context is identified and must be flushed without changing the frozen target before application', async () => {
    model('Edited local draft.'); const input = await context(); const source = await documentService.read(userId, bookId, sceneId);
    const local = structuredClone(source.document); const target = local.blocks[1]; if (target.type !== 'paragraph') throw new Error('fixture'); target.runs[0].text = 'Local draft.';
    input.localDocument = local; input.targets[0] = { blockId: target.id, from: 0, to: 12, sourceText: 'Local draft.' };
    const discussion = await createDocumentDiscussion(userId, bookId, input); expect((discussion.snapshot as unknown as DocumentDiscussionSnapshot).unsaved).toBe(true);
    const proposal = await requestDocumentProposal(userId, bookId, discussion.id, { operationId: randomUUID(), instruction: 'Edit this local target.' }); expect(proposal.status).toBe('ready');
    await expect(revalidate(proposal.id)).rejects.toMatchObject({ code: 'DOCUMENT_TARGET_STALE' });
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: local }] });
    expect((await revalidate(proposal.id)).proposalId).toBe(proposal.id);
  });
  test('bounded unsaved intents derive owned complete blocks and revalidate only after the same exact operation is flushed', async () => {
    const inference = model('Reviewed local draft.'); const input = await context();
    const source = await documentService.read(userId, bookId, sceneId);
    const paragraph = source.document.blocks[1]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    input.localOperations = { operationId: randomUUID(), operations: [{ id: randomUUID(), kind: 'text', target: passageOperationRunSource(source.document, paragraph.id, paragraph.runs[0].id), expectedText: 'Repeated phrase.', replacement: 'Local draft.' }] };
    input.targets = [{ blockId: paragraph.id, from: 0, to: 12, sourceText: 'Local draft.' }];
    const discussion = await createDocumentDiscussion(userId, bookId, input);
    const snapshot = discussion.snapshot as unknown as DocumentDiscussionSnapshot;
    expect(snapshot).toMatchObject({ unsaved: true, draftOperationId: input.localOperations.operationId });
    expect(snapshot.blocks[0].runs.map((run) => run.text).join('')).toBe('Local draft.');
    expect((discussion.request as unknown as DocumentDiscussionInput).localDocument).toBeUndefined();
    expect(JSON.stringify(discussion.request).length).toBeLessThan(2048);
    const proposal = await requestDocumentProposal(userId, bookId, discussion.id, { operationId: randomUUID(), instruction: 'Revise the disclosed local draft.' });
    expect(proposal.status).toBe('ready'); await expect(revalidate(proposal.id)).rejects.toMatchObject({ code: 'DOCUMENT_TARGET_STALE' });
    const immutable = (await db().bookDocumentRevision.findUniqueOrThrow({ where: { id: source.bookRevisionId } })).manifest as unknown as import('@/documents/model').DocumentManifest;
    const ownedContext = await readPassageOwnedContext(db(), bookId, source.bookRevisionId, immutable, immutable.scenes.find((item) => item.sceneId === sceneId)!);
    const draft = deriveDiscussionDraft(source.document, input.localOperations, ownedContext, userId);
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: input.localOperations.operationId, expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: draft }] });
    const validation = await revalidate(proposal.id);
    await applyDocumentProposal(userId, bookId, proposal.id, { operationId: randomUUID(), expectedRevisionId: validation.bookRevisionId, expectedSceneRevisionId: validation.sceneRevisionId, validationId: validation.id, targetIds: [snapshot.targets[0].targetId] });
    const current = await documentService.read(userId, bookId, sceneId);
    expect(current.projection.text).toContain('Reviewed local draft.');
    expect(projectDocument(current.document, 'original').text).toContain('Local draft.');
    expect(current.document.blocks[2]).toEqual(source.document.blocks[2]); expect(inference).toHaveBeenCalledTimes(1);
  });
  test('bounded unsaved derivative rejects forged source evidence, structural operations and mixed representations before inference', async () => {
    const inference = model(); const input = await context(); const source = await documentService.read(userId, bookId, sceneId);
    const paragraph = source.document.blocks[1]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    const target = passageOperationRunSource(source.document, paragraph.id, paragraph.runs[0].id);
    input.localOperations = { operationId: randomUUID(), operations: [{ id: randomUUID(), kind: 'text', target: { ...target, sourceHash: 'f'.repeat(64) }, expectedText: 'Repeated phrase.', replacement: 'Forged.' }] };
    await expect(createDocumentDiscussion(userId, bookId, input)).rejects.toMatchObject({ code: 'DOCUMENT_SOURCE_STALE' });
    input.localOperations.operations = [{ id: randomUUID(), kind: 'paragraph-split', target: { ...target, from: 0, to: 0 }, expectedText: '' }];
    await expect(createDocumentDiscussion(userId, bookId, input)).rejects.toMatchObject({ code: 'DOCUMENT_DRAFT_REQUIRES_SAVE' });
    input.localDocument = source.document; await expect(createDocumentDiscussion(userId, bookId, input)).rejects.toThrow();
    expect(inference).not.toHaveBeenCalled(); expect((await documentService.read(userId, bookId, sceneId)).revisionId).toBe(source.revisionId);
  });
  test('a giant complete target block is rejected before provider dispatch even for a tiny bounded unsaved edit', async () => {
    const inference = model(); const source = await documentService.read(userId, bookId, sceneId);
    const giant = documentFromText('word '.repeat(20000), randomUUID);
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: giant }] });
    const saved = await documentService.read(userId, bookId, sceneId); const paragraph = saved.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    const input: DocumentDiscussionInput = { schemaVersion: 1, operationId: randomUUID(), sessionId: randomUUID(), sceneId, expectedRevisionId: saved.bookRevisionId, expectedSceneRevisionId: saved.revisionId, expectedContentHash: saved.contentHash, projection: 'final', targets: [{ blockId: paragraph.id, from: 0, to: 4, sourceText: 'Word' }], localOperations: { operationId: randomUUID(), operations: [{ id: randomUUID(), kind: 'text', target: passageOperationRunSource(saved.document, paragraph.id, paragraph.runs[0].id, 0, 4), expectedText: 'word', replacement: 'Word' }] } };
    await expect(createDocumentDiscussion(userId, bookId, input)).rejects.toMatchObject({ code: 'DOCUMENT_CONTEXT_TOO_LARGE', status: 413 });
    expect(inference).not.toHaveBeenCalled(); expect(await db().documentDiscussion.findUnique({ where: { id: input.operationId } })).toBeNull();
  });
  test('legacy unsaved snapshots cannot introduce unowned paragraph identities or alter saved layout', async () => {
    const inference = model(); const input = await context(); const source = await documentService.read(userId, bookId, sceneId);
    input.localDocument = structuredClone(source.document); const paragraph = input.localDocument.blocks[1]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    paragraph.id = randomUUID(); input.targets[0].blockId = paragraph.id;
    await expect(createDocumentDiscussion(userId, bookId, input)).rejects.toMatchObject({ code: 'DOCUMENT_DRAFT_REQUIRES_SAVE', status: 409 });
    input.localDocument = structuredClone(source.document); input.localDocument.layout.fontSize += 1;
    await expect(createDocumentDiscussion(userId, bookId, input)).rejects.toMatchObject({ code: 'DOCUMENT_DRAFT_REQUIRES_SAVE', status: 409 });
    expect(inference).not.toHaveBeenCalled();
  });
  test('unknown provider effects remain unknown and cancellation suppresses late output without losing it', async () => {
    const discussion = await createDocumentDiscussion(userId, bookId, await context());
    const inference = jest.spyOn(SceneProseService.prototype, 'proposeDocumentEdits').mockRejectedValue(new Error('Lost provider acknowledgement'));
    const input = { operationId: randomUUID(), instruction: 'Discuss.' };
    expect((await requestDocumentProposal(userId, bookId, discussion.id, input)).status).toBe('unknown');
    expect((await requestDocumentProposal(userId, bookId, discussion.id, input)).status).toBe('unknown'); expect(inference).toHaveBeenCalledTimes(1);
    const cancelled = { operationId: randomUUID(), instruction: 'A cancelled request.' };
    inference.mockImplementation(async (_snapshot, _instruction, options) => {
      await cancelDocumentProposal(userId, bookId, cancelled.operationId); expect(options?.signal?.aborted).toBe(true);
      return { raw: JSON.stringify({ reply: 'Late reply.', edits: [] }), provenance: { providerId: 'fixture', params: {}, recipe: 'document-proposal', recipeVersion: '1.0.0' } };
    });
    const late = await requestDocumentProposal(userId, bookId, discussion.id, cancelled);
    expect(late.status).toBe('cancelled'); expect(late.result).toMatchObject({ output: { reply: 'Late reply.' } }); expect(late.application).toBeNull();
    await expect(revalidate(late.id)).rejects.toMatchObject({ status: 409 });
  });
  test('forged model targets/authority and oversized context fail before any manuscript mutation', async () => {
    const inference = model(); const input = await context(); const source = await documentService.read(userId, bookId, sceneId);
    const discussion = await createDocumentDiscussion(userId, bookId, input);
    inference.mockResolvedValue({ raw: JSON.stringify({ reply: 'Forged', edits: [{ targetId: randomUUID(), sourceText: 'Repeated phrase.', replacement: 'Injected', authorId: 999 }] }), provenance: { providerId: 'fixture', params: {}, recipe: 'document-proposal', recipeVersion: '1.0.0' } });
    const forged = await requestDocumentProposal(userId, bookId, discussion.id, { operationId: randomUUID(), instruction: 'Edit.' });
    expect(forged.status).toBe('failed'); expect(forged.result).toMatchObject({ raw: expect.stringContaining('authorId') });
    expect(canonicalDocument((await documentService.read(userId, bookId, sceneId)).document)).toBe(canonicalDocument(source.document));
    const local = structuredClone(source.document); const block = local.blocks[1]; if (block.type !== 'paragraph') throw new Error('fixture'); block.runs[0].text = 'x'.repeat(20000);
    await expect(createDocumentDiscussion(userId, bookId, { ...input, operationId: randomUUID(), localDocument: local, targets: [{ blockId: block.id, from: 0, to: 20000, sourceText: block.runs[0].text }] })).rejects.toMatchObject({ status: 413 });
    expect(inference).toHaveBeenCalledTimes(1);
  });
  test('follow-up context includes complete prior replies and durable history stays owned', async () => {
    model(); const { discussion, proposal } = await prepare();
    const followup = await createDocumentDiscussion(userId, bookId, { ...await context(), parentDiscussionId: discussion.id });
    const snapshot = followup.snapshot as unknown as DocumentDiscussionSnapshot;
    expect(snapshot.conversation).toEqual([{ proposalId: proposal.id, instruction: 'Revise exactly the selected passage.', reply: 'A precise edit.', sourceSceneRevisionId: (discussion.snapshot as unknown as DocumentDiscussionSnapshot).sourceSceneRevisionId }]);
    const history = await auth(request(app).get(`/api/books/${bookId}/document-discussions?sceneId=${sceneId}`));
    expect(history.status).toBe(200); expect(history.body.data.map((row: { id: string }) => row.id)).toContain(followup.id);
    expect(history.body.data.every((row: Record<string, unknown>) => !('request' in row))).toBe(true);
    const proposals = await auth(request(app).get(`/api/books/${bookId}/document-discussions/${discussion.id}/proposals`));
    expect(proposals.status).toBe(200); expect(proposals.body.data[0].id).toBe(proposal.id);
    const foreign = await request(app).get(`/api/books/${bookId}/document-proposals/${proposal.id}`).set('x-user-id', String(userId + 100000)).set('x-github-id', 'proposal-other-actor');
    expect(foreign.status).toBe(404);
  });
  test('known truncated provider output is preserved as failed and is never repeated', async () => {
    const discussion = await createDocumentDiscussion(userId, bookId, await context());
    const inference = jest.spyOn(SceneProseService.prototype, 'proposeDocumentEdits').mockRejectedValue(new InferenceTerminalError('INFERENCE_TRUNCATED', 'length', 'structured', '{"reply":"partial'));
    const input = { operationId: randomUUID(), instruction: 'Discuss.' };
    const row = await requestDocumentProposal(userId, bookId, discussion.id, input);
    expect(row.status).toBe('failed'); expect(row.providerOutcome).toBe('completed');
    expect(row.result).toMatchObject({ raw: '{"reply":"partial', finishReason: 'length', retainedPartialOutput: true });
    expect((await requestDocumentProposal(userId, bookId, discussion.id, input)).status).toBe('failed'); expect(inference).toHaveBeenCalledTimes(1);
  });
});
