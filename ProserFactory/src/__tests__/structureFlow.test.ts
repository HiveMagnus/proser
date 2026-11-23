/// <reference types="jest" />
import request from 'supertest';
import app from '../index';
import { databaseService } from '../lib/database';

async function seedUser() {
  return databaseService.client.user.upsert({
    where: { githubId: 'jest-gh-structure' },
    update: { username: 'jest-structure' },
    create: { githubId: 'jest-gh-structure', username: 'jest-structure' }
  });
}

const authFor = (userId: number) => (r: request.Test) => r
  .set('x-user-id', String(userId))
  .set('x-github-id', 'jest-gh-structure')
  .set('x-username', 'jest-structure');

describe('Acts/Chapters/Scenes flow', () => {
  let userId: number; let bookId: number; let act1Id: number; let act2Id: number;
  let chapter1Id: number; let chapter2Id: number; let scene1Id: number; let scene2Id: number;

  beforeAll(async () => {
    const user = await seedUser();
    userId = user.id;
    // create a book
    const bookRes = await authFor(userId)(request(app).post('/api/books')).send({ title: 'Structure Book', genre: 'fantasy', targetAudience: 'adult', summary: 'Testing structure' });
    expect(bookRes.status).toBe(201);
    bookId = bookRes.body.data.id;
  });

  const auth = () => authFor(userId);

  it('creates two acts', async () => {
    const a1 = await auth()(request(app).post(`/api/books/${bookId}/acts`)).send({ title: 'Act 1', summary: 'First act' });
    expect(a1.status).toBe(201); act1Id = a1.body.data.act.id; expect(a1.body.data.act.actNumber).toBe(1);
    const a2 = await auth()(request(app).post(`/api/books/${bookId}/acts`)).send({ title: 'Act 2' });
    expect(a2.status).toBe(201); act2Id = a2.body.data.act.id; expect(a2.body.data.act.actNumber).toBe(2);
  });

  it('reorders acts', async () => {
    const reorder = await auth()(request(app).post(`/api/books/${bookId}/reorder-acts`)).send({ reorderedActs: [{ id: act2Id }, { id: act1Id }] });
    expect(reorder.status).toBe(200);
    const structure = await auth()(request(app).get(`/api/books/${bookId}/structure`));
    expect(structure.status).toBe(200);
    const acts = structure.body.data.acts;
    expect(acts[0].id).toBe(act2Id); // now first
    expect(acts[0].actNumber).toBe(1);
  });

  it('creates chapters under first act (which was act2)', async () => {
    const c1 = await auth()(request(app).post(`/api/books/${bookId}/acts/${act2Id}/chapters`)).send({ title: 'Chapter 1' });
    expect(c1.status).toBe(201); chapter1Id = c1.body.data.chapter.id; expect(c1.body.data.chapter.chapterNumber).toBe(1);
    const c2 = await auth()(request(app).post(`/api/books/${bookId}/acts/${act2Id}/chapters`)).send({ title: 'Chapter 2' });
    expect(c2.status).toBe(201); chapter2Id = c2.body.data.chapter.id; expect(c2.body.data.chapter.chapterNumber).toBe(2);
  });

  it('reorders chapters', async () => {
    const reorder = await auth()(request(app).post(`/api/books/${bookId}/acts/${act2Id}/reorder-chapters`)).send({ reorderedChapters: [{ id: chapter2Id }, { id: chapter1Id }] });
    expect(reorder.status).toBe(200);
  });

  it('batch creates scenes in second chapter (now chapterNumber 1 after reorder)', async () => {
    const batch = await auth()(request(app).post(`/api/books/${bookId}/chapters/${chapter2Id}/scenes/batch`)).send({ scenes: [{}, { prose: 'Some words here' }] });
    expect(batch.status).toBe(201);
    expect(batch.body.data.scenes.length).toBe(2);
    scene1Id = batch.body.data.scenes[0].id;
    scene2Id = batch.body.data.scenes[1].id;
  });

  it('reorders scenes', async () => {
    const reorder = await auth()(request(app).post(`/api/books/${bookId}/chapters/${chapter2Id}/reorder-scenes`)).send({ reorderedScenes: [{ id: scene2Id }, { id: scene1Id }] });
    expect(reorder.status).toBe(200);
  });

  it('rejects scene IDs that do not belong to the addressed chapter', async () => {
    const before = await databaseService.client.scene.findMany({ where: { id: { in: [scene1Id, scene2Id] } }, select: { id: true, sceneNumber: true }, orderBy: { id: 'asc' } });
    const foreign = await auth()(request(app).post(`/api/books/${bookId}/chapters/${chapter1Id}/reorder-scenes`)).send({ reorderedScenes: [{ id: scene1Id }, { id: scene2Id }] });
    expect(foreign.status).toBe(422);
    const partial = await auth()(request(app).post(`/api/books/${bookId}/chapters/${chapter2Id}/reorder-scenes`)).send({ reorderedScenes: [{ id: scene1Id }, { id: scene1Id }] });
    expect(partial.status).toBe(422);
    const after = await databaseService.client.scene.findMany({ where: { id: { in: [scene1Id, scene2Id] } }, select: { id: true, sceneNumber: true }, orderBy: { id: 'asc' } });
    expect(after).toEqual(before);
  });

  it('updates a scene', async () => {
    const upd = await auth()(request(app).put(`/api/books/${bookId}/scenes/${scene1Id}`)).send({ prose: 'Updated prose text' });
    expect(upd.status).toBe(200);
  });

  it('deletes a scene and ensures numbering adjusts', async () => {
    const del = await auth()(request(app).delete(`/api/books/${bookId}/scenes/${scene2Id}`));
    expect(del.status).toBe(200);
    const scenes = await auth()(request(app).get(`/api/books/${bookId}/chapters/${chapter2Id}/scenes`));
    expect(scenes.body.data.scenes.length).toBe(1);
    expect(scenes.body.data.scenes[0].sceneNumber).toBe(1);
  });
});
