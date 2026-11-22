import request from 'supertest';
import app from '../index';
import { databaseService } from '../lib/database';

describe('Mock AI provider integration (deterministic)', () => {
  beforeAll(async () => {
    process.env.AI_PROVIDER = 'mock';
  });

  afterAll(() => {
    delete process.env.AI_PROVIDER;
  });

  async function seed() {
    const user = await databaseService.client.user.upsert({
      where: { githubId: 'jest-mock-ai' },
      update: {},
      create: { githubId: 'jest-mock-ai', username: 'jest', avatarUrl: 'x' }
    });
    const book = await databaseService.client.book.create({ data: { userId: user.id, title: 'B', genre: 'G' } });
    return { user, book };
  }

  function auth(userId: number) {
    return (req: request.Test) => req.set('x-user-id', String(userId)).set('x-github-id', 'jest-mock-ai');
  }

  it('uses mock provider for title generation', async () => {
    const { user } = await seed();
    const res = await auth(user.id)(request(app).post('/api/generate/title')).send({
      genre: 'Fantasy',
      summary: 'A journey',
      // UI now composes and sends the full prompt
      prompt: 'Generate 5 compelling book titles for a Fantasy book with this summary: A journey. Format as a numbered list.',
      selectedModel: 'ignored'
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  expect(Array.isArray(res.body.data)).toBe(true);
  expect(res.body.data.length).toBeGreaterThan(0);
  expect(res.body.data[0]).toMatch(/Mock response [ABCD]/);
  });
});
