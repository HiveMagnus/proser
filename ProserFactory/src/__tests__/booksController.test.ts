/// <reference types="jest" />
import request from 'supertest';
import app from '../index';
import { databaseService } from '../lib/database';

async function seedUser() {
  return databaseService.client.user.upsert({
    where: { githubId: 'jest-gh' },
    update: { username: 'jest-user' },
    create: { githubId: 'jest-gh', username: 'jest-user' }
  });
}

describe('BooksController basic CRUD', () => {
  let userId: number; let bookId: number;
  let chapterId: number;
  beforeAll(async () => {
    const user = await seedUser();
    userId = user.id;
  });
  // DB connection handled in global setup/teardown

  const auth = (r: request.Test) => r.set('x-user-id', String(userId)).set('x-github-id', 'jest-gh').set('x-username', 'jest-user');

  it('creates a book', async () => {
    const payload = { title: 'My Test Book', genre: 'fantasy', targetAudience: 'adult', summary: 'Short summary' };
    const res = await auth(request(app).post('/api/books')).send(payload);
    // Some validation may enforce strings; ensure success
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    bookId = res.body.data.id;
  });

  it('lists books and includes new one', async () => {
    const res = await auth(request(app).get('/api/books'));
    expect(res.status).toBe(200);
    expect(res.body.data.books.some((b: any) => b.id === bookId)).toBe(true);
  });

  it('lists books with aggregated manuscript word count', async () => {
    const act = await auth(request(app).post(`/api/books/${bookId}/acts`)).send({ title: 'Act 1' });
    expect(act.status).toBe(201);

    const chapter = await auth(request(app).post(`/api/books/${bookId}/acts/${act.body.data.act.id}/chapters`)).send({ title: 'Chapter 1' });
    expect(chapter.status).toBe(201);
    chapterId = chapter.body.data.chapter.id;

    const scene = await auth(request(app).post(`/api/books/${bookId}/chapters/${chapterId}/scenes`)).send({
      prose: 'This imported manuscript scene should contribute to the project word count.',
    });
    expect(scene.status).toBe(201);
    expect(scene.body.data.scene.wordCount).toBeGreaterThan(0);

    const res = await auth(request(app).get('/api/books'));
    expect(res.status).toBe(200);

    const listed = res.body.data.books.find((b: any) => b.id === bookId);
    expect(listed).toBeTruthy();
    expect(listed.wordCount).toBeGreaterThan(0);
  });

  it('updates book', async () => {
    const updatePayload = {
      title: 'My Test Book',
      genre: 'fantasy',
      targetAudience: 'adult',
      summary: 'Updated summary',
      tagline: 'A tale of testing',
      storyOutline: 'Outline content',
      draftStatus: 'review'
    };
    const res = await auth(request(app).put(`/api/books/${bookId}`)).send(updatePayload);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toBe('Updated summary');
  });

  it('gets book detail', async () => {
    const res = await auth(request(app).get(`/api/books/${bookId}`));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(bookId);
  });

  it('deletes book', async () => {
    const res = await auth(request(app).delete(`/api/books/${bookId}`));
    expect(res.status).toBe(200);
    const list = await auth(request(app).get('/api/books'));
    expect(list.body.data.books.some((b: any) => b.id === bookId)).toBe(false);
  });
});
