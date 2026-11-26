import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { createZipBuffer, readZipBuffer } from '@/lib/zipArchive';
import { documentService } from '@/documents/service';
import { exportBookArchive, importBookArchive, importableDocument, parseBookArchive } from '@/documents/bookArchive';
import { documentFromText, projectDocument, type DocumentParagraph, type ProserDocument } from '@/documents/model';

// A 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('portable book archive', () => {
  const db = () => databaseService.client;
  const old = process.env.DOCUMENT_AUTHORITY_ENABLED;
  let userId: number; let githubId: string; let otherId: number;
  const books: number[] = [];
  const imageName = `archive-fixture-${randomUUID()}.png`;
  let bookId: number; let firstScene: number; let assetId: number;

  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true';
    githubId = `archive-${randomUUID()}`;
    userId = (await db().user.create({ data: { githubId, username: 'Archive owner' } })).id;
    otherId = (await db().user.create({ data: { githubId: `archive-other-${randomUUID()}`, username: 'Archive other' } })).id;
    await fs.mkdir(path.resolve('public/images'), { recursive: true });
    await fs.writeFile(path.resolve('public/images', imageName), PNG);
  });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, title: 'Archive fixture', genre: 'Mystery', summary: 'A test book.', tagline: 'Find it.', storyOutline: 'Outline.', acts: { create: { actNumber: 1, title: 'Part one', chapters: { create: [{ chapterNumber: 1, title: 'Arrival', scenes: { create: [{ sceneNumber: 1, prose: 'placeholder', summary: 'First', outline: 'Open' }, { sceneNumber: 2, prose: 'The second scene.' }] } }, { chapterNumber: 2, title: 'Departure', scenes: { create: [{ sceneNumber: 1, prose: 'The end.' }] } }] } } }, codexEntries: { create: [{ entryType: 'character', entryName: 'Mara', entryDescription: 'A detective.' }] }, notes: { create: [{ title: 'Idea', content: 'Use the lighthouse.' }] } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
    bookId = book.id; books.push(bookId);
    firstScene = book.acts[0].chapters[0].scenes[0].id;
    const asset = await db().imageAsset.create({ data: { userId, bookId, name: imageName, url: `/images/${imageName}`, source: 'nova-import', configJson: JSON.stringify({ sha256: digest(PNG), mediaType: 'image/png', byteLength: PNG.length, width: 1, height: 1 }) } });
    assetId = asset.id;
    await db().book.update({ where: { id: bookId }, data: { selectedImageId: assetId } });
    await db().plotThread.create({ data: { bookId, threadKey: 'who-lit-the-lamp', question: 'Who lit the lamp?', firstSceneId: firstScene } });
    await db().bookWritingGoal.create({ data: { bookId, targetWords: 80000, dailyWords: 500 } });
    await db().bookAiPolicy.create({ data: { bookId, aiDisabled: true } });
    await documentService.initialize(userId, bookId);
    // Scene one: styled runs, an inline image and an open comment.
    const source = await documentService.read(userId, bookId, firstScene);
    const document = documentFromText('The lamp was lit.\n\nNobody saw.', randomUUID);
    const paragraph = document.blocks[0] as DocumentParagraph;
    paragraph.runs = [{ id: randomUUID(), text: 'The lamp ', style: {} }, { id: randomUUID(), text: 'was lit.', style: { italic: true } }, { id: randomUUID(), text: '', style: {}, inlineImage: { assetId, sha256: digest(PNG), alt: 'Lamp', width: 1, height: 1 } }];
    document.comments = [{ id: 'check-lamp', authorId: userId, authorName: 'Archive owner', createdAt: new Date().toISOString(), text: 'Check the lamp.', anchors: [{ blockId: paragraph.id, runId: paragraph.runs[1].id, start: 0, end: 3, sourceText: 'was' }], resolved: false }];
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId: firstScene, expectedRevisionId: source.revisionId, document }] });
  });
  afterAll(async () => {
    if (old === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = old;
    for (const id of books) {
      await db().sceneDocumentSearchIndex.deleteMany({ where: { bookId: id } });
      await db().documentOperation.deleteMany({ where: { bookId: id } });
      await db().bookDocumentHead.deleteMany({ where: { bookId: id } });
      await db().bookDocumentRevision.deleteMany({ where: { bookId: id } });
      await db().bookDocumentScopeRevision.deleteMany({ where: { bookId: id } });
      await db().sceneDocumentRevision.deleteMany({ where: { bookId: id } });
      await db().book.updateMany({ where: { id }, data: { selectedImageId: 0 } });
      await db().imageAsset.deleteMany({ where: { bookId: id } });
      await db().book.deleteMany({ where: { id } });
    }
    for (const file of await fs.readdir(path.resolve('public/images'))) if (file === imageName || file.startsWith(`archive-${userId}-`) || file.startsWith(`archive-${otherId}-`)) await fs.rm(path.resolve('public/images', file), { force: true });
    await db().user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  });

  const scenesOf = async (owner: number, id: number) => {
    const acts = await db().act.findMany({ where: { bookId: id }, orderBy: { actNumber: 'asc' }, include: { chapters: { orderBy: { chapterNumber: 'asc' }, include: { scenes: { orderBy: { sceneNumber: 'asc' } } } } } });
    const result: Array<{ chapter: string | null; text: string; document: ProserDocument }> = [];
    for (const act of acts) for (const chapter of act.chapters) for (const scene of chapter.scenes) {
      const read = await documentService.read(owner, id, scene.id);
      result.push({ chapter: chapter.title, text: read.projection.text, document: read.document });
    }
    return result;
  };

  test('exports a complete book and imports it as a new book on another account', async () => {
    const exported = await exportBookArchive(userId, bookId);
    expect(exported.manifest).toMatchObject({ format: 'proser-book-archive', formatVersion: 1, counts: { scenes: 3, images: 1 } });
    const files = await readZipBuffer(exported.archive, { maxEntries: 100, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 });
    expect([...files.keys()].sort()).toEqual(['book.json', `images/${digest(PNG)}.png`, 'proser-archive.json', 'scenes/0001.json', 'scenes/0002.json', 'scenes/0003.json']);
    for (const file of exported.manifest.files) expect(digest(files.get(file.path)!)).toBe(file.sha256);

    const receipt = await importBookArchive(otherId, exported.archive, randomUUID());
    books.push(receipt.bookId);
    expect(receipt).toMatchObject({ title: 'Archive fixture', status: 'completed', counts: { acts: 1, chapters: 2, scenes: 3, codex: 1, notes: 1, plotThreads: 1, images: 1 }, losses: { commentsDropped: 0, plainTextFallbacks: 0 } });
    expect(receipt.bookId).not.toBe(bookId);
    const imported = await db().book.findUniqueOrThrow({ where: { id: receipt.bookId }, include: { notes: true, codexEntries: true, writingGoal: true, aiPolicy: true, images: true } });
    expect(imported).toMatchObject({ userId: otherId, genre: 'Mystery', summary: 'A test book.', tagline: 'Find it.', storyOutline: 'Outline.', writingGoal: { targetWords: 80000, dailyWords: 500 }, aiPolicy: { aiDisabled: true } });
    expect(imported.notes.map((note) => note.content)).toEqual(['Use the lighthouse.']);
    expect(imported.codexEntries.map((entry) => entry.entryName)).toEqual(['Mara']);
    expect(imported.images).toHaveLength(1);
    expect(imported.selectedImageId).toBe(imported.images[0].id);
    const scenes = await scenesOf(otherId, receipt.bookId);
    expect(scenes.map((scene) => [scene.chapter, scene.text])).toEqual([['Arrival', 'The lamp was lit.￼\n\nNobody saw.'], ['Arrival', 'The second scene.'], ['Departure', 'The end.']]);
    const first = scenes[0].document.blocks[0] as DocumentParagraph;
    expect(first.runs.map((run) => run.style)).toEqual([{}, { italic: true }, {}]);
    expect(first.runs[2].inlineImage?.assetId).toBe(imported.images[0].id);
    expect(scenes[0].document.comments).toEqual([expect.objectContaining({ text: 'Check the lamp.', authorId: otherId, resolved: false })]);
    const thread = await db().plotThread.findFirstOrThrow({ where: { bookId: receipt.bookId } });
    const firstImportedScene = (await db().scene.findFirstOrThrow({ where: { sceneNumber: 1, chapter: { chapterNumber: 1, act: { bookId: receipt.bookId } } } })).id;
    expect(thread).toMatchObject({ threadKey: 'who-lit-the-lamp', firstSceneId: firstImportedScene });

    // A second export of the imported book carries the same content.
    const again = await parseBookArchive((await exportBookArchive(otherId, receipt.bookId)).archive);
    const original = await parseBookArchive(exported.archive);
    const strip = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => ['sourceId', 'selectedImageId', 'firstSceneId', 'lastSceneId', 'sceneId', 'codexId', 'name', 'source'].includes(key) ? undefined : item)) as unknown;
    expect(strip({ ...again.book, layout: undefined })).toEqual(strip({ ...original.book, layout: undefined }));
    expect([...again.documents.values()].map((document) => projectDocument(document).text)).toEqual([...original.documents.values()].map((document) => projectDocument(document).text));
  });

  test('retrying an import returns the same book, and the source book is untouched', async () => {
    const { archive } = await exportBookArchive(userId, bookId);
    const head = (await documentService.manifest(userId, bookId)).revisionId;
    const operationId = randomUUID();
    const first = await importBookArchive(userId, archive, operationId); books.push(first.bookId);
    const count = await db().book.count({ where: { userId } });
    expect(await importBookArchive(userId, archive, operationId)).toEqual(first);
    expect(await db().book.count({ where: { userId } })).toBe(count);
    expect((await documentService.manifest(userId, bookId)).revisionId).toBe(head);
  });

  test('tampered, unknown-version and foreign archives are refused before a book is created', async () => {
    const { archive } = await exportBookArchive(userId, bookId);
    const files = await readZipBuffer(archive, { maxEntries: 100, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 });
    const rebuild = (changes: Record<string, Buffer>) => createZipBuffer([...files.entries()].map(([name, content]) => ({ name, content: changes[name] ?? content })));
    const before = await db().book.count({ where: { userId: otherId } });
    const scene = JSON.parse(files.get('scenes/0002.json')!.toString()) as ProserDocument;
    (scene.blocks[0] as DocumentParagraph).runs[0].text = 'Changed after export.';
    await expect(importBookArchive(otherId, await rebuild({ 'scenes/0002.json': Buffer.from(JSON.stringify(scene)) }), randomUUID())).rejects.toMatchObject({ code: 'DOCUMENT_ARCHIVE_DIGEST_MISMATCH', status: 422 });
    const manifest = JSON.parse(files.get('proser-archive.json')!.toString()) as Record<string, unknown>;
    await expect(importBookArchive(otherId, await rebuild({ 'proser-archive.json': Buffer.from(JSON.stringify({ ...manifest, formatVersion: 2 })) }), randomUUID())).rejects.toMatchObject({ code: 'DOCUMENT_ARCHIVE_VERSION_UNSUPPORTED' });
    await expect(importBookArchive(otherId, await createZipBuffer([...files.entries()].map(([name, content]) => ({ name, content })).concat([{ name: 'extra.txt', content: Buffer.from('x') }])), randomUUID())).rejects.toMatchObject({ code: 'DOCUMENT_ARCHIVE_INVALID' });
    await expect(importBookArchive(otherId, Buffer.from('not a zip'), randomUUID())).rejects.toMatchObject({ code: 'DOCUMENT_ARCHIVE_INVALID' });
    expect(await db().book.count({ where: { userId: otherId } })).toBe(before);
    await expect(exportBookArchive(otherId, bookId)).rejects.toThrow('Book not found');
  });

  test('routes download the archive and import it as a new book', async () => {
    const auth = (test: request.Test) => test.set('x-user-id', String(userId)).set('x-github-id', githubId).set('x-username', 'Archive owner');
    const download = await auth(request(app).get(`/api/books/${bookId}/archive`)).buffer(true).parse((res, callback) => { const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks))); });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['content-disposition']).toBe(`attachment; filename="book-${bookId}-archive.proser.zip"`);
    expect(download.headers['cache-control']).toBe('private, no-store');
    const body = download.body as Buffer;
    expect(download.headers['x-content-sha256']).toBe(digest(body));
    expect((await auth(request(app).post(`/api/books/archive-imports?operationId=${randomUUID()}`)).set('Content-Type', 'application/json').send({})).status).toBe(415);
    expect((await auth(request(app).post('/api/books/archive-imports')).set('Content-Type', 'application/zip').send(body)).status).toBe(422);
    const imported = await auth(request(app).post(`/api/books/archive-imports?operationId=${randomUUID()}`)).set('Content-Type', 'application/zip').send(body);
    expect(imported.status).toBe(201);
    books.push(imported.body.data.bookId);
    expect(imported.body.data).toMatchObject({ title: 'Archive fixture', counts: { scenes: 3 } });
  });

  test('resolved tracked changes fold into the text and pending ones stay for review', () => {
    const document = documentFromText('Kept text.', randomUUID);
    const paragraph = document.blocks[0] as DocumentParagraph;
    const deleted = { id: randomUUID(), text: ' Deleted.', style: {}, changeId: 'gone' };
    const inserted = { id: randomUUID(), text: ' Pending.', style: {}, changeId: 'open' };
    paragraph.runs.push(deleted, inserted);
    const change = (id: string, kind: 'insertion' | 'deletion', status: 'accepted' | 'pending', runId: string) => ({ id, kind, authorId: 1, authorName: 'Elsewhere', createdAt: '2026-01-01T00:00:00.000Z', status, origin: 'manual' as const, targetRunIds: [runId] });
    document.changes = [change('gone', 'deletion', 'accepted', deleted.id), change('open', 'insertion', 'pending', inserted.id)];
    document.comments = [{ id: 'done', authorId: 1, authorName: 'Elsewhere', createdAt: '2026-01-01T00:00:00.000Z', text: 'Resolved.', anchors: [{ blockId: paragraph.id, runId: paragraph.runs[0].id, start: 0, end: 4, sourceText: 'Kept' }], resolved: true }];
    const losses = { resolvedReviewFolded: 0, commentsDropped: 0, plainTextFallbacks: 0 };
    const result = importableDocument(document, losses);
    expect((result.blocks[0] as DocumentParagraph).runs.map((run) => run.text)).toEqual(['Kept text.', ' Pending.']);
    expect(result.changes.map((item) => [item.id, item.status])).toEqual([['open', 'pending']]);
    expect(projectDocument(result).text).toBe('Kept text. Pending.');
    expect(losses).toEqual({ resolvedReviewFolded: 1, commentsDropped: 1, plainTextFallbacks: 0 });
  });

  test('an accepted paragraph join folds the two paragraphs into one', () => {
    const document = documentFromText('First half\n\n second half.\n\nNext paragraph.', randomUUID);
    const [left, right] = document.blocks as DocumentParagraph[];
    left.boundaryChangeId = 'join';
    document.changes = [{ id: 'join', kind: 'paragraphJoin', authorId: 1, authorName: 'Elsewhere', createdAt: '2026-01-01T00:00:00.000Z', status: 'accepted', origin: 'manual', targetRunIds: [], targetBlockIds: [left.id, right.id] }];
    expect(projectDocument(document).text).toBe('First half second half.\n\nNext paragraph.');
    const losses = { resolvedReviewFolded: 0, commentsDropped: 0, plainTextFallbacks: 0 };
    const result = importableDocument(document, losses);
    expect(result.blocks).toHaveLength(2);
    expect(result.changes).toEqual([]);
    expect(projectDocument(result).text).toBe('First half second half.\n\nNext paragraph.');
    expect(losses).toMatchObject({ resolvedReviewFolded: 1, plainTextFallbacks: 0 });
  });
});
