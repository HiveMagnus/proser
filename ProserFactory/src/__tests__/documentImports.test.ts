import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { preserveImportOriginal, prepareLegacyBundleImport, readImportOriginal, readImportPreview, commitLegacyBundleImport, listImportOriginals, deleteImportOriginal } from '@/documents/imports';
import { documentFromText, projectDocument } from '@/documents/model';
import { documentFromLegacyMarkdown } from '@/lib/importers/legacyMarkdown';

describe('original-preserving append imports', () => {
  const prior = process.env.DOCUMENT_AUTHORITY_ENABLED;
  const db = () => databaseService.client;
  let userId: number; let bookId: number; let sceneId: number; let githubId: string;
  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true';
    githubId = `import-fixture-${randomUUID()}`;
    userId = (await db().user.create({ data: { githubId, username: 'Import author' } })).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, title: 'Preserved existing book', acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: { sceneNumber: 1, prose: 'Original manuscript 😀 é.' } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
    bookId = book.id; sceneId = book.acts[0].chapters[0].scenes[0].id;
    await documentService.initialize(userId, bookId);
  });
  afterEach(async () => {
    await db().documentImportPreview.deleteMany({ where: { bookId } }); await db().documentImportOriginal.deleteMany({ where: { bookId } });
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } }); await db().documentOperation.deleteMany({ where: { bookId } }); await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } }); await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => { if (prior === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = prior; await db().user.delete({ where: { id: userId } }); });
  const sourceText = '# Imported title\r\nby Fixture\r\n\r\n## Imported act\r\n### Chapter 1: New chapter\r\n\r\n  First **bold** paragraph 😀 é.  \r\n\r\n* * *\r\n\r\nSecond paragraph.\r\n';
  const file = (name: string, content: string) => ({ name, bytesBase64: Buffer.from(content).toString('base64') });
  const bundle = (files = [file('novel.md', sourceText), file('characters/person/entry.md', '---\nname: Person\ntype: character\n---\nAn exact description.'), file('characters/person/metadata.json','{"id":"legacy-person","attributes":{"name":"Person"},"links":{"keep":"value"}}')]) => Buffer.from(JSON.stringify({ schemaVersion: 1, files }));
  const preview = async (bytes = bundle()) => {
    const original = await preserveImportOriginal(userId, bookId, randomUUID(), 'legacy-markdown-bundle-v1', bytes);
    const source = await documentService.manifest(userId, bookId);
    const input = { operationId: randomUUID(), originalId: original.id, expectedRevisionId: source.revisionId };
    return { original, input, record: await prepareLegacyBundleImport(userId, bookId, input) };
  };
  const conditions = async (reportHash: string) => {
    const source = await documentService.manifest(userId, bookId);
    return { operationId: randomUUID(), expectedRevisionId: source.revisionId, expectedScopes: { structure: source.scopes!.structure.revisionId, canon: source.scopes!.canon.revisionId }, consentReportHash: reportHash };
  };
  const auth = (value: request.Test) => value.set('x-user-id', String(userId)).set('x-github-id', githubId).set('x-username','Import author');
  test('lists originals and deletes only those no committed import used', async () => {
    const unused = await preview();
    const used = await preview();
    await commitLegacyBundleImport(userId, bookId, used.record.id, await conditions(used.record.reportHash));
    const listed = await listImportOriginals(userId, bookId);
    expect(listed.originals.find((row) => row.id === unused.original.id)).toMatchObject({ previewCount: 1, committed: false, deletable: true });
    expect(listed.originals.find((row) => row.id === used.original.id)).toMatchObject({ previewCount: 1, committed: true, deletable: false });
    expect(listed.usage.bookBytes).toBe(unused.original.byteLength + used.original.byteLength);

    await expect(deleteImportOriginal(userId, bookId, used.original.id)).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_ORIGINAL_COMMITTED', status: 409 });
    const stranger = await db().user.create({ data: { githubId: `import-stranger-${randomUUID()}`, username: 'Stranger' } });
    try {
      await expect(deleteImportOriginal(stranger.id, bookId, unused.original.id)).rejects.toMatchObject({ status: 404 });
    } finally {
      await db().user.delete({ where: { id: stranger.id } });
    }

    await expect(deleteImportOriginal(userId, bookId, unused.original.id)).resolves.toMatchObject({ id: unused.original.id, deleted: true, previewsDeleted: 1 });
    expect(await db().documentImportOriginal.count({ where: { id: unused.original.id } })).toBe(0);
    expect(await db().documentImportPreview.count({ where: { originalId: unused.original.id } })).toBe(0);
    await expect(readImportOriginal(userId, bookId, unused.original.id)).rejects.toMatchObject({ status: 404 });
    expect((await listImportOriginals(userId, bookId)).usage.bookBytes).toBe(used.original.byteLength);
    expect(await readImportOriginal(userId, bookId, used.original.id)).toMatchObject({ id: used.original.id });

    // A deleted ID is free for a new upload.
    await expect(preserveImportOriginal(userId, bookId, unused.original.id, 'legacy-markdown-bundle-v1', bundle())).resolves.toMatchObject({ id: unused.original.id });
    const listedOverHttp = await auth(request(app).get(`/api/books/${bookId}/import-originals`));
    expect(listedOverHttp.status).toBe(200);
    expect(listedOverHttp.headers['cache-control']).toBe('private, no-store');
    expect(listedOverHttp.body.data.originals).toHaveLength(2);
    expect((await auth(request(app).delete(`/api/books/${bookId}/import-originals/${unused.original.id}`))).status).toBe(200);
    expect((await auth(request(app).delete(`/api/books/${bookId}/import-originals/${unused.original.id}`))).status).toBe(404);
    expect((await auth(request(app).delete(`/api/books/${bookId}/import-originals/${used.original.id}`))).status).toBe(409);
  });
  test('converts nested inline marks while retaining unsupported markup as text', () => {
    const literal = '<span>plain</span> ![Cover](cover.png) [Notes](notes.md)';
    const document = documentFromLegacyMarkdown(`***Both*** ~~old~~ \`code\`\n\n${literal}`, randomUUID);
    expect(projectDocument(document).text).toBe(`Both old code\n\n${literal}`);
    expect(document.blocks[0]).toMatchObject({ runs: [
      { text: 'Both', style: { bold: true, italic: true } },
      { text: ' ', style: {} },
      { text: 'old', style: { strikeout: true } },
      { text: ' ', style: {} },
      { text: 'code', style: { font: 'monospace' } },
    ] });
  });
  test('preview preserves exact CR/Unicode bytes, exposes hierarchy/losses, and creates no hierarchy identities', async () => {
    const before = await documentService.manifest(userId, bookId); const bytes = bundle(); const prepared = await preview(bytes);
    const original = await readImportOriginal(userId, bookId, prepared.original.id); expect(Buffer.from(original.bytes)).toEqual(bytes);
    expect(prepared.record.mapping.acts[0].chapters[0].scenes).toHaveLength(2);
    expect(prepared.record.report).toMatchObject({ strategy: 'append-new-identities', sceneCount: 2, codexCount: 1, losses: [{ code: 'LEGACY_HEADING_WHITESPACE_MAPPING' }, { code: 'MARKDOWN_INLINE_STYLE_SUBSET' }, { code: 'CODEX_FRONTMATTER_SUBSET' }] });
    expect(await documentService.manifest(userId, bookId)).toEqual(before); expect(await db().scene.count({ where: { chapter: { act: { bookId } } } })).toBe(1);
    expect(await prepareLegacyBundleImport(userId, bookId, prepared.input)).toEqual(prepared.record);
    expect(await db().documentImportPreview.count({ where: { bookId } })).toBe(1);
  });
  test('commit requires exact explicit loss consent, appends new IDs and preserves old prose/styles/history', async () => {
    const body = await documentService.read(userId, bookId, sceneId); const paragraph = body.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); paragraph.runs[0].style = { bold: true, font: 'Georgia' };
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: body.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: body.revisionId, document: body.document }] });
    const old = await documentService.read(userId, bookId, sceneId); const prepared = await preview(); const input = await conditions(prepared.record.reportHash);
    await expect(commitLegacyBundleImport(userId, bookId, prepared.record.id, { ...input, consentReportHash: undefined })).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_CONSENT_REQUIRED' });
    await expect(commitLegacyBundleImport(userId, bookId, prepared.record.id, { ...input, consentReportHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_CONSENT_REQUIRED' });
    const receipt = await commitLegacyBundleImport(userId, bookId, prepared.record.id, input);
    expect(receipt.manifest.scenes).toHaveLength(3); expect(receipt.result.hierarchy.acts[0].id).not.toBe((await documentService.scope(userId, bookId, 'structure')).content.acts[0].id);
    expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(old.document);
    expect((await documentService.read(userId, bookId, sceneId)).revisionId).toBe(old.revisionId);
    const first = receipt.result.hierarchy.acts[0].chapters[0].sceneIds[0];
    const imported = await documentService.read(userId, bookId, first);
    expect(imported.projection.text).toBe('First bold paragraph 😀 é.');
    expect(imported.document.blocks[0]).toMatchObject({ runs: [{ text: 'First ', style: {} }, { text: 'bold', style: { bold: true } }, { text: ' paragraph 😀 é.', style: {} }] });
    expect((await readImportOriginal(userId, bookId, prepared.original.id)).sha256).toBe(prepared.original.sha256);
    expect(await db().auditLog.count({ where: { userId, entityId: bookId, metadata: { path: ['action'], equals: 'import-conversion-consent' } } })).toBe(1);
    // Lost acknowledgement recovery remains exact after a later edit.
    const current = await documentService.read(userId, bookId, sceneId);
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: current.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: current.revisionId, document: current.document }] });
    expect(await commitLegacyBundleImport(userId, bookId, prepared.record.id, input)).toEqual(receipt);
    expect(await db().scene.count({ where: { chapter: { act: { bookId } } } })).toBe(3);
  });
  test('stale preview cannot overwrite new work; changed report/conversion cannot commit', async () => {
    const prepared = await preview(); const input = await conditions(prepared.record.reportHash); const current = await documentService.read(userId, bookId, sceneId);
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: current.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: current.revisionId, document: documentFromText('Newer work.', randomUUID) }] });
    await expect(commitLegacyBundleImport(userId, bookId, prepared.record.id, input)).rejects.toMatchObject({ status: 412 });
    expect((await documentService.read(userId, bookId, sceneId)).projection.text).toBe('Newer work.');
    await db().documentImportPreview.update({ where: { id: prepared.record.id }, data: { conversion: {} } });
    await expect(readImportPreview(userId, bookId, prepared.record.id)).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_PREVIEW_INVALID' });
  });
  test('malformed/path/duplicate originals remain preserved while conversion rejects them', async () => {
    for (const bytes of [Buffer.from('{malformed'), bundle([file('../novel.md','unsafe')]), bundle([file('novel.md',sourceText),file('novel.md','duplicate')])]) {
      const original = await preserveImportOriginal(userId, bookId, randomUUID(), 'legacy-markdown-bundle-v1', bytes); const source = await documentService.manifest(userId, bookId);
      await expect(prepareLegacyBundleImport(userId, bookId, { operationId: randomUUID(), originalId: original.id, expectedRevisionId: source.revisionId })).rejects.toThrow();
      expect(Buffer.from((await readImportOriginal(userId, bookId, original.id)).bytes)).toEqual(bytes);
    }
    expect(await db().documentImportPreview.count({ where: { bookId } })).toBe(0);
    const malformedId = randomUUID();
    expect((await auth(request(app).post(`/api/books/${bookId}/import-originals/${malformedId}`).set('Content-Type','application/octet-stream').send(Buffer.from('malformed')))).status).toBe(201);
    const head = await documentService.manifest(userId, bookId);
    const invalid = await auth(request(app).post(`/api/books/${bookId}/import-previews`).send({ operationId: randomUUID(), originalId: malformedId, expectedRevisionId: head.revisionId }));
    expect(invalid.status).toBe(422); expect(invalid.body.error.code).toBe('DOCUMENT_IMPORT_INVALID');
  });
  test('cross-user original/preview access and reused upload IDs fail closed', async () => {
    const prepared = await preview();
    await expect(readImportOriginal(userId + 100000, bookId, prepared.original.id)).rejects.toMatchObject({ status: 404 });
    await expect(readImportPreview(userId + 100000, bookId, prepared.record.id)).rejects.toMatchObject({ status: 404 });
    await expect(preserveImportOriginal(userId, bookId, prepared.original.id, 'legacy-markdown-bundle-v1', bundle([file('novel.md','Changed')]))).rejects.toMatchObject({ code: 'DOCUMENT_OPERATION_CONFLICT' });
    const bytes = bundle(); expect((await preserveImportOriginal(userId, bookId, prepared.original.id, 'legacy-markdown-bundle-v1', bytes)).id).toBe(prepared.original.id);
  });
  test('HTTP original upload/download and preview are owned, bounded and gated', async () => {
    const originalId = randomUUID(); const bytes = bundle();
    const upload = await auth(request(app).post(`/api/books/${bookId}/import-originals/${originalId}`).set('Content-Type','application/octet-stream').send(bytes)); expect(upload.status).toBe(201);
    const download = await auth(request(app).get(`/api/books/${bookId}/import-originals/${originalId}/content`)); expect(download.status).toBe(200); expect(download.headers['x-content-sha256']).toBe(upload.body.data.sha256); expect(download.headers['cache-control']).toBe('private, no-store');
    const head = await documentService.manifest(userId, bookId);
    const previewId = randomUUID(); const response = await auth(request(app).post(`/api/books/${bookId}/import-previews`).send({ operationId: previewId, originalId, expectedRevisionId: head.revisionId })); expect(response.status).toBe(200);
    expect(response.body.data.mapping.acts).toHaveLength(1);
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'false';
    const inactive = await auth(request(app).get(`/api/books/${bookId}/import-previews/${previewId}`)); expect(inactive.status).toBe(503);
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true';
  });
  test('Markdown and plain-text files are preserved exactly, previewed with their own report and appended on consent', async () => {
    const markdown = Buffer.from('# Novel\r\n\r\n## Chapter 1\r\n\r\nA **bold** start.\r\n\r\n***\r\n\r\nNext scene.\r\n\r\n## Chapter 2\r\n\r\nThe end.\r\n');
    const markdownId = randomUUID();
    const upload = await auth(request(app).post(`/api/books/${bookId}/import-originals/${markdownId}?format=markdown`).set('Content-Type','application/octet-stream').send(markdown));
    expect(upload.status).toBe(201);
    const download = await auth(request(app).get(`/api/books/${bookId}/import-originals/${markdownId}/content`));
    expect(download.headers['content-type']).toMatch(/^text\/markdown/); expect(download.headers['content-disposition']).toContain(`original-${markdownId}.md`);
    expect(download.text).toBe(markdown.toString()); expect(download.headers['x-content-sha256']).toBe(upload.body.data.sha256);
    const head = await documentService.manifest(userId, bookId);
    const previewed = await auth(request(app).post(`/api/books/${bookId}/import-previews`).send({ operationId: randomUUID(), originalId: markdownId, expectedRevisionId: head.revisionId }));
    expect(previewed.status).toBe(200);
    expect(previewed.body.data.report).toMatchObject({ codec: 'proser-plain-manuscript', format: 'markdown', title: 'Novel', chapterCount: 2, sceneCount: 3, codexCount: 0, encoding: 'utf-8' });
    expect(previewed.body.data.report.losses.map((loss: { code: string }) => loss.code)).toEqual(['PLAIN_HEADING_MAPPING', 'PARAGRAPH_WHITESPACE_NORMALIZED', 'MARKDOWN_INLINE_STYLE_SUBSET', 'SCENE_BREAK_MARKERS']);
    expect(previewed.body.data.mapping.acts[0].chapters.map((chapter: { title: string }) => chapter.title)).toEqual(['Chapter 1', 'Chapter 2']);
    expect(await db().scene.count({ where: { chapter: { act: { bookId } } } })).toBe(1);
    const committed = await auth(request(app).post(`/api/books/${bookId}/import-previews/${previewed.body.data.id}/commit`).send(await conditions(previewed.body.data.reportHash)));
    expect(committed.status).toBe(200);
    const first = committed.body.data.result.hierarchy.acts[0].chapters[0].sceneIds[0];
    const imported = await documentService.read(userId, bookId, first);
    expect(imported.projection.text).toBe('A bold start.');
    expect(imported.document.blocks[0]).toMatchObject({ runs: [{ text: 'A ' }, { text: 'bold', style: { bold: true } }, { text: ' start.' }] });
    expect((await listImportOriginals(userId, bookId)).originals.find((row) => row.id === markdownId)).toMatchObject({ format: 'markdown', committed: true });

    // Plain text keeps asterisks literally; a DOCX or unknown format cannot use this route.
    const text = await preserveImportOriginal(userId, bookId, randomUUID(), 'plain-text', Buffer.from('Chapter 1\n\nA *literal* line.\n'));
    const source = await documentService.manifest(userId, bookId);
    const plain = await prepareLegacyBundleImport(userId, bookId, { operationId: randomUUID(), originalId: text.id, expectedRevisionId: source.revisionId });
    expect(plain.report).toMatchObject({ format: 'plain-text', chapterCount: 1 });
    const plainCommit = await commitLegacyBundleImport(userId, bookId, plain.id, await conditions(plain.reportHash));
    expect((await documentService.read(userId, bookId, plainCommit.result.hierarchy.acts[0].chapters[0].sceneIds[0])).projection.text).toBe('A *literal* line.');
    const docx = await preserveImportOriginal(userId, bookId, randomUUID(), 'docx', Buffer.from('PK not a manuscript'));
    const latest = await documentService.manifest(userId, bookId);
    await expect(prepareLegacyBundleImport(userId, bookId, { operationId: randomUUID(), originalId: docx.id, expectedRevisionId: latest.revisionId })).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_INVALID', status: 422 });
    expect((await auth(request(app).post(`/api/books/${bookId}/import-originals/${randomUUID()}?format=rtf`).set('Content-Type','application/octet-stream').send(Buffer.from('x')))).status).toBe(422);
  });
  test('legacy projection methods refuse activation bypass; backfill verifies existing projection counts', async () => {
    await expect(documentService.legacyWriteScene(userId, bookId, sceneId, { prose: 'Bypass' })).rejects.toMatchObject({ status: 428 });
    await db().scene.update({ where: { id: sceneId }, data: { wordCount: 999 } });
    await expect(documentService.initialize(userId, bookId)).rejects.toMatchObject({ code: 'DOCUMENT_AUTHORITY_DRIFT' });
    const row = await db().scene.findUniqueOrThrow({ where: { id: sceneId } }); expect(row.wordCount).toBe(999); expect(row.prose).toBe('Original manuscript 😀 é.');
    const revision = await documentService.manifest(userId, bookId); expect(revision.scenes).toHaveLength(1);
    // Tests alone deliberately repair their invalid fixture projection.
    const immutable = await db().sceneDocumentRevision.findUniqueOrThrow({ where: { id: revision.scenes[0].revisionId } });
    const words = projectDocument(immutable.document as unknown as ReturnType<typeof documentFromText>).wordCount;
    await db().scene.update({ where: { id: sceneId }, data: { wordCount: words } });
    expect(await documentService.initialize(userId, bookId)).toBe(revision.revisionId);
  });
  test('binary uploads reject empty/oversized bodies with explicit size errors before preserving bytes', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(32 * 1024 * 1024 + 1)]) {
      const response = await auth(request(app).post(`/api/books/${bookId}/import-originals/${randomUUID()}`).set('Content-Type','application/octet-stream').send(bytes));
      expect(response.status).toBe(413); expect(response.body.error.code).toBe('DOCUMENT_IMPORT_TOO_LARGE');
    }
    expect(await db().documentImportOriginal.count({ where: { bookId } })).toBe(0);
  });
  test('bulk import retains long codex descriptions beyond the interactive form ceiling', async () => {
    const description = 'Long retained description. '.repeat(400);
    const prepared = await preview(bundle([file('novel.md',sourceText),file('lore/long/entry.md',`---\nname: Long lore\ntype: lore\n---\n${description}`),file('lore/long/metadata.json','{"id":"long-original"}')]));
    await commitLegacyBundleImport(userId, bookId, prepared.record.id, await conditions(prepared.record.reportHash));
    const entry = await db().codexEntry.findFirstOrThrow({ where: { bookId, entryName: 'Long lore' } });
    expect(entry.entryDescription).toBe(description.trim()); expect(entry.entryDescription!.length).toBeGreaterThan(5000);
  });
});
