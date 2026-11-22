/// <reference types="jest" />
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import request from 'supertest';

import app from '../index';
import { databaseService } from '../lib/database';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

describe('context-efficient export artifacts', () => {
  let exportRoot: string;
  let userId: number;
  let otherUserId: number;
  let bookId: number;
  let chapterId: number;
  let firstSceneId: number;
  let artifactId: string;

  const authFor = (id: number, githubId = 'jest-export-artifacts') => (test: request.Test) => test
    .set('x-user-id', String(id))
    .set('x-github-id', githubId)
    .set('x-username', githubId);

  beforeAll(async () => {
    exportRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'proser-export-artifacts-'));
    process.env.EXPORT_ARTIFACT_DIR = exportRoot;
    const user = await databaseService.client.user.upsert({
      where: { githubId: 'jest-export-artifacts' },
      update: { username: 'jest-export-artifacts' },
      create: { githubId: 'jest-export-artifacts', username: 'jest-export-artifacts' },
    });
    const other = await databaseService.client.user.upsert({
      where: { githubId: 'jest-export-artifacts-other' },
      update: { username: 'jest-export-artifacts-other' },
      create: { githubId: 'jest-export-artifacts-other', username: 'jest-export-artifacts-other' },
    });
    userId = user.id;
    otherUserId = other.id;

    const book = await authFor(userId)(request(app).post('/api/books')).send({ title: 'Artifact Reader Book' });
    bookId = book.body.data.id;
    const act = await authFor(userId)(request(app).post(`/api/books/${bookId}/acts`)).send({ title: 'First Act' });
    const firstChapter = await authFor(userId)(request(app).post(`/api/books/${bookId}/acts/${act.body.data.act.id}/chapters`)).send({ title: 'Opening' });
    chapterId = firstChapter.body.data.chapter.id;
    const sceneOne = await authFor(userId)(request(app).post(`/api/books/${bookId}/chapters/${chapterId}/scenes`)).send({
      summary: 'The opening scene.',
      prose: 'First scene prose. A door opens onto the rain.',
    });
    firstSceneId = sceneOne.body.data.scene.id;
    await authFor(userId)(request(app).post(`/api/books/${bookId}/chapters/${chapterId}/scenes`)).send({
      summary: 'The second scene.',
      prose: 'Second scene prose. The traveler crosses the threshold.',
    });
    const secondChapter = await authFor(userId)(request(app).post(`/api/books/${bookId}/acts/${act.body.data.act.id}/chapters`)).send({ title: 'Elsewhere' });
    await authFor(userId)(request(app).post(`/api/books/${bookId}/chapters/${secondChapter.body.data.chapter.id}/scenes`)).send({
      prose: 'Chapter two must not appear in a Chapter One reading.',
    });
  });

  afterAll(async () => {
    delete process.env.EXPORT_ARTIFACT_DIR;
    await fs.rm(exportRoot, { recursive: true, force: true });
  });

  it('creates a file artifact without returning manuscript content', async () => {
    const response = await authFor(userId)(request(app).post(`/api/books/${bookId}/export-artifacts`)).send({ format: 'markdown' });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      bookId,
      format: 'markdown',
      bookTitle: 'Artifact Reader Book',
    });
    expect(response.body.data).not.toHaveProperty('content');
    expect(response.body.data.tableOfContents).toHaveLength(2);
    artifactId = response.body.data.artifactId;
    expect(artifactId).toMatch(/^[a-f0-9]{64}$/);
    await expect(fs.stat(path.join(exportRoot, String(userId), String(bookId), `${artifactId}.md`))).resolves.toBeDefined();
  });

  it('assembles only the selected chapter or scene', async () => {
    const chapter = await authFor(userId)(request(app)
      .get(`/api/books/${bookId}/export-artifacts/${artifactId}/read`)
      .query({ scope: 'chapter', chapterId }));
    expect(chapter.status).toBe(200);
    expect(chapter.body.data.selection).toMatchObject({ chapterId, chapterNumber: 1 });
    expect(chapter.body.data.content).toContain('First scene prose');
    expect(chapter.body.data.content).toContain('Second scene prose');
    expect(chapter.body.data.content).not.toContain('Chapter two must not appear');
    expect(chapter.body.data.truncated).toBe(false);

    const scene = await authFor(userId)(request(app)
      .get(`/api/books/${bookId}/export-artifacts/${artifactId}/read`)
      .query({ scope: 'scene', sceneId: firstSceneId }));
    expect(scene.status).toBe(200);
    expect(scene.body.data.selection).toMatchObject({ sceneId: firstSceneId, sceneNumber: 1 });
    expect(scene.body.data.content).toContain('First scene prose');
    expect(scene.body.data.content).not.toContain('Second scene prose');
  });

  it('bounds large reads and exposes a continuation offset', async () => {
    const response = await authFor(userId)(request(app)
      .get(`/api/books/${bookId}/export-artifacts/${artifactId}/read`)
      .query({ scope: 'book', maxChars: 80 }));
    expect(response.status).toBe(200);
    expect(response.body.data.returnedChars).toBe(80);
    expect(response.body.data.truncated).toBe(true);
    expect(response.body.data.nextOffset).toBe(80);
  });

  it('does not expose artifacts across users', async () => {
    const response = await authFor(otherUserId, 'jest-export-artifacts-other')(
      request(app).get(`/api/books/${bookId}/export-artifacts/${artifactId}`),
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 for stale user and signed Nova reads without deleting artifact evidence', async () => {
    const directory = path.join(exportRoot, String(userId), String(bookId));
    const markdownPath = path.join(directory, `${artifactId}.md`);
    const manifestPath = path.join(directory, `${artifactId}.json`);
    const originalMarkdown = await fs.readFile(markdownPath);
    const originalManifest = await fs.readFile(manifestPath);
    const keys = generateKeyPairSync('ed25519');
    const keyId = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const token = `pnv_${'A'.repeat(43)}`;
    const requestId = `nova-${'d'.repeat(32)}`;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = {
      version: 2, grant_id: 'grant-stale-export-read', mission_id: 'mission-stale-export', mission_revision: 1,
      origin_task_id: 'senti-stale-export', task_id: 'nova-stale-export', request_id: requestId,
      caller: 'senti', audience: 'proser', owner_actor: 'service:ardent:nova', action_classes: [],
      issued_at: now, expires_at: now + 240, actions: ['books.read'], resources: [`book:${bookId}`],
      revoked: false, key_id: keyId,
    };
    const grant = { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), keys.privateKey).toString('base64url') };
    const novaHeaders = { Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId };
    process.env.PROSER_NOVA_GRANTS_JSON = JSON.stringify({ [requestId]: grant });
    process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([{
      sha256: createHash('sha256').update(token).digest('hex'), name: 'nova-creative',
      ownerGithubId: 'jest-export-artifacts', scopes: ['content:read'], callers: ['senti'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }]);
    try {
      await request(app).get(`/api/books/${bookId}/export-artifacts/${artifactId}`).set(novaHeaders).expect(200);
      const update = await authFor(userId)(request(app).put(`/api/books/${bookId}/scenes/${firstSceneId}`)).send({
        prose: 'Updated first scene prose. The stale sentence is gone.',
      });
      expect(update.status).toBe(200);

      for (const suffix of ['', '/read?scope=book', '/download']) {
        const url = `/api/books/${bookId}/export-artifacts/${artifactId}${suffix}`;
        const ordinary = await authFor(userId)(request(app).get(url));
        const delegated = await request(app).get(url).set(novaHeaders);
        for (const response of [ordinary, delegated]) {
          expect(response.status).toBe(404);
          expect(response.body.error.message).toContain('stale');
        }
      }
      expect(await fs.readFile(markdownPath)).toEqual(originalMarkdown);
      expect(await fs.readFile(manifestPath)).toEqual(originalManifest);
    } finally {
      delete process.env.PROSER_NOVA_GRANTS_JSON;
      delete process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_PEM;
      delete process.env.PROSER_SERVICE_PRINCIPALS_JSON;
    }

    const fresh = await authFor(userId)(request(app).post(`/api/books/${bookId}/export-artifacts`)).send({ format: 'markdown' });
    expect(fresh.status).toBe(201);
    expect(fresh.body.data.artifactId).not.toBe(artifactId);
    artifactId = fresh.body.data.artifactId;
    const chapter = await authFor(userId)(request(app)
      .get(`/api/books/${bookId}/export-artifacts/${artifactId}/read`)
      .query({ scope: 'chapter', chapterId }));
    expect(chapter.body.data.content).toContain('Updated first scene prose');
    expect(chapter.body.data.content).not.toContain('A door opens onto the rain');
  });

  it('downloads and deletes the artifact', async () => {
    const download = await authFor(userId)(request(app).get(`/api/books/${bookId}/export-artifacts/${artifactId}/download`));
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('.md');
    expect(download.text).toContain('Updated first scene prose');

    const deleted = await authFor(userId)(request(app).delete(`/api/books/${bookId}/export-artifacts/${artifactId}`));
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual({ artifactId, deleted: true });
  });
});
