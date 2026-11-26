import { createHash } from 'node:crypto';
/// <reference types="jest" />
import request from 'supertest';
import app from '../index';
import { databaseService } from '../lib/database';
import redis from '../lib/redis';

async function seedUser() {
  return databaseService.client.user.upsert({
    where: { githubId: 'jest-gh-codex' },
    update: { username: 'jest-codex' },
    create: { githubId: 'jest-gh-codex', username: 'jest-codex' }
  });
}

const authFor = (userId: number) => (r: request.Test) => r
  .set('x-user-id', String(userId))
  .set('x-github-id', 'jest-gh-codex')
  .set('x-username', 'jest-codex');

describe('Codex, Notes & Export caching', () => {
  let userId: number; let bookId: number; let entryId: number; let noteId: number;

  beforeAll(async () => {
    const user = await seedUser();
    userId = user.id;
    const bookRes = await authFor(userId)(request(app).post('/api/books')).send({ title: 'Codex Book', genre: 'mystery', targetAudience: 'adult', summary: 'Codex testing' });
    expect(bookRes.status).toBe(201);
    bookId = bookRes.body.data.id;
  });

  const auth = () => authFor(userId);

  it('creates a codex entry and lists entries', async () => {
    const create = await auth()(request(app).post(`/api/books/${bookId}/codex`)).send({
      entryType: 'lore',
      entryName: '**Vespera**',
      entryDescription: 'Protagonist',
      attributes: JSON.stringify({ sourceType: 'character', aliases: ['Ves'] }),
    });
    expect(create.status).toBe(201); entryId = create.body.data.id;
    const list = await auth()(request(app).get(`/api/books/${bookId}/codex`));
    expect(list.status).toBe(200);
    const saved = list.body.data.entries.find((e: any) => e.id === entryId);
    expect(saved).toBeTruthy();
    expect(saved.entryName || saved.entry_name).toBe('Vespera');
    expect(saved.entryType).toBe('lore');
    expect(saved.attributes).toContain('"sourceType":"character"');
  });

  it('updates and deletes codex entry (negative fetch after delete)', async () => {
    const upd = await auth()(request(app).put(`/api/codex/${entryId}`)).send({
      entryType: 'character',
      entryName: 'Alice',
      entryDescription: 'Updated desc',
      attributes: JSON.stringify({ imported: true }),
    });
    expect(upd.status).toBe(200);
    expect(upd.body.data.entryType).toBe('character');
    expect(upd.body.data.attributes).toContain('"imported":true');
    const del = await auth()(request(app).delete(`/api/codex/${entryId}`));
    expect(del.status).toBe(200);
    const getDeleted = await auth()(request(app).get(`/api/codex/${entryId}`));
    expect(getDeleted.status).toBe(404);
  });

  it('creates and updates a note, then deletes it', async () => {
    const create = await auth()(request(app).post(`/api/books/${bookId}/notes`)).send({ content: 'Note content line 1' });
    expect(create.status).toBe(201); noteId = create.body.data.note.id;
    const list = await auth()(request(app).get(`/api/books/${bookId}/notes`));
    expect(list.status).toBe(200);
    const upd = await auth()(request(app).put(`/api/books/${bookId}/notes/${noteId}`)).send({ content: 'Updated note' });
    expect(upd.status).toBe(200);
    const del = await auth()(request(app).delete(`/api/books/${bookId}/notes/${noteId}`));
    expect(del.status).toBe(200);
    const getDeleted = await auth()(request(app).put(`/api/books/${bookId}/notes/${noteId}`)).send({ content: 'again' });
    expect(getDeleted.status).toBe(404);
  });

  it('keeps exported manuscript text out of shared caches and tags it with its digest', async () => {
    const first = await auth()(request(app).get(`/api/books/${bookId}/export`).query({ format: 'markdown' }));
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    const etag = first.headers['etag'];
    const digest = createHash('sha256').update(first.body.data.content).digest('base64url');
    expect(etag).toBe(`"${digest}"`);
    const second = await auth()(request(app).get(`/api/books/${bookId}/export`).set('If-None-Match', etag).query({ format: 'markdown' }));
    expect(second.status).toBe(304);
    const act = await auth()(request(app).post(`/api/books/${bookId}/acts`)).send({ title: 'Act Cache' });
    expect(act.status).toBe(201);
    const third = await auth()(request(app).get(`/api/books/${bookId}/export`).set('If-None-Match', etag).query({ format: 'markdown' }));
    expect(third.status).toBe(200);
    expect(third.body.data.content).toContain('Act Cache');
  });

  it('negative auth: missing headers', async () => {
    const res = await request(app).get(`/api/books/${bookId}/codex`);
    expect(res.status).toBe(401); // unauthorized
  });

  it('validation failure: bad format param for export', async () => {
    const res = await auth()(request(app).get(`/api/books/${bookId}/export`).query({ format: 'pdf' }));
    expect(res.status).toBe(422);
  });
});
