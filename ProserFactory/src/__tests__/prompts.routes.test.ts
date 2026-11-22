import request from 'supertest';
import { createApp } from '@/server';

function authenticated(test: request.Test): request.Test {
  return test
    .set('x-user-id', '1')
    .set('x-github-id', 'prompt-route-test')
    .set('x-username', 'prompt-route-test');
}

describe('GET /api/prompts', () => {
  const app = createApp();
  it('lists prompts', async () => {
    const res = await authenticated(request(app).get('/api/prompts'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.prompts)).toBe(true);
    expect(res.body.data.prompts.length).toBeGreaterThan(5);
    const first = res.body.data.prompts[0];
    expect(first).toHaveProperty('key');
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('template');
    expect(first).toHaveProperty('visibility', 'internal');
  });
});

describe('GET /api/prompts/:key', () => {
  const app = createApp();
  it('returns a known prompt', async () => {
    const resAll = await authenticated(request(app).get('/api/prompts'));
    const key = resAll.body.data.prompts[0].key;
    const res = await authenticated(request(app).get(`/api/prompts/${key}`));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.prompt).toHaveProperty('id');
  });
  it('404s for unknown prompt', async () => {
    const res = await authenticated(request(app).get('/api/prompts/does-not-exist'));
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/prompts/additional/:name', () => {
  const app = createApp();
  it('returns a template string for known name', async () => {
    const res = await authenticated(
      request(app).get('/api/prompts/additional/SCENE_OUTLINE_TEMPLATE'),
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.template).toBe('string');
    expect(res.body.data.template.length).toBeGreaterThan(10);
  });
  it('404s for unknown name', async () => {
    const res = await authenticated(
      request(app).get('/api/prompts/additional/NOT_A_TEMPLATE'),
    );
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
