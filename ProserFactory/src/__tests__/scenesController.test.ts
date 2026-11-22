/// <reference types="jest" />
import request from 'supertest';
import app from '../index';
import { databaseService } from '../lib/database';

async function seedUser() {
  return databaseService.client.user.upsert({
    where: { githubId: 'jest-gh-scenes-controller' },
    update: { username: 'jest-user-scenes-ctrl' },
    create: { githubId: 'jest-gh-scenes-controller', username: 'jest-user-scenes-ctrl' }
  });
}

async function seedBookStructure(userId: number) {
  const book = await databaseService.client.book.create({ data: { userId, title: 'Ctrl Book', genre: 'fantasy', targetAudience: 'adult', summary: 'sum' } });
  const act = await databaseService.client.act.create({ data: { bookId: book.id, actNumber: 1, title: 'Act 1', summary: '' } });
  const chapter = await databaseService.client.chapter.create({ data: { actId: act.id, chapterNumber: 1, title: 'Ch 1', summary: 'ch sum' } });
  return { book, act, chapter };
}

describe('ScenesController endpoints', () => {
  let userId: number; let bookId: number; let chapterId: number; let sceneId: number;
  const auth = (r: request.Test) => r.set('x-user-id', String(userId)).set('x-github-id', 'jest-gh-scenes-controller').set('x-username', 'jest-user-scenes-ctrl');

  beforeAll(async () => {
    const u = await seedUser();
    userId = u.id;
    const seeded = await seedBookStructure(userId);
    bookId = seeded.book.id; chapterId = seeded.chapter.id;
  });

  it('POST /books/:bookId/chapters/:chapterId/scenes creates scene', async () => {
    const res = await auth(request(app).post(`/api/books/${bookId}/chapters/${chapterId}/scenes`)).send({ prose: 'first scene prose', summary: 's' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    sceneId = res.body.data.scene.id;
  });

  it('GET /books/:bookId/chapters/:chapterId/scenes returns scenes including created', async () => {
    const res = await auth(request(app).get(`/api/books/${bookId}/chapters/${chapterId}/scenes`));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.scenes)).toBe(true);
    expect(res.body.data.scenes.some((s: any) => s.id === sceneId)).toBe(true);
  });

  it('PUT /books/:bookId/scenes/:sceneId updates scene', async () => {
    const res = await auth(request(app).put(`/api/books/${bookId}/scenes/${sceneId}`)).send({ prose: 'updated prose', summary: 's2' });
    expect(res.status).toBe(200);
    expect(res.body.data.scene.wordCount).toBeGreaterThan(0);
  });

  it('POST /books/:bookId/chapters/:chapterId/scenes/batch creates multiple', async () => {
    const res = await auth(request(app).post(`/api/books/${bookId}/chapters/${chapterId}/scenes/batch`)).send({ scenes: [ { prose: 'p2' }, { prose: 'p3' } ] });
    expect(res.status).toBe(201);
    expect(res.body.data.scenes.length).toBe(2);
  });
});
