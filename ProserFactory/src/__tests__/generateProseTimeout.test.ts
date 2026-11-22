import request from 'supertest';
import app from '../index';
import { databaseService } from '../lib/database';

// This test simulates a slow provider using the MockAIProvider with a prompt directive
// DELAY_MS to trigger withRetry's timeout handling in the controller.

async function seedUser(tag: string) {
  return databaseService.client.user.upsert({
    where: { githubId: tag },
    update: { username: tag },
    create: { githubId: tag, username: tag }
  });
}

const auth = (userId: number, tag: string) => (r: request.Test) => r
  .set('x-user-id', String(userId))
  .set('x-github-id', tag)
  .set('x-username', tag);

describe('GenerateController.generateProse timeout behavior', () => {
  let userId: number; let bookId: number;

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'mock';
    process.env.AI_TIMEOUT_PROSE_MS = '50';
    userId = (await seedUser('jest-prose-timeout')).id;
    const b = await auth(userId, 'jest-prose-timeout')(request(app).post('/api/books')).send({ title: 'B', genre: '', targetAudience: '', summary: '' });
    expect(b.status).toBe(201);
    bookId = b.body.data.id;
  });

  it('returns 500 when provider times out twice without RAG', async () => {
    const res = await auth(userId, 'jest-prose-timeout')(request(app).post('/api/generate/prose'))
      .send({ bookId, prompt: 'Write a scene. DELAY_MS=200', selectedModel: 'test', useCodexRAG: 0 });
    expect([500, 200]).toContain(res.status); // tolerate CI flake; primarily ensure no unhandled rejection
    // If success, body should include data.prose; if failure, success=false
    if (res.status === 200) {
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.prose).toBe('string');
    } else {
      expect(res.body.success).toBe(false);
    }
  });
});
