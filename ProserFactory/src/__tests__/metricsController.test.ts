import request from 'supertest';
import app from '../index';

describe('Metrics ingest endpoint', () => {
  it('rejects invalid body', async () => {
    const res = await request(app).post('/api/metrics/ingest').send({});
    expect(res.status).toBe(422);
  });

  it('accepts valid storyboard events', async () => {
    const res = await request(app).post('/api/metrics/ingest').send({ events: [ { name: 'storyboard.jump_to_active', bookId: 1 } ] });
    expect(res.status).toBe(204);
  });

  it('rejects oversized and unbounded event payloads', async () => {
    const tooMany = await request(app).post('/api/metrics/ingest').send({ events: Array.from({ length: 51 }, () => ({ name: 'storyboard.click' })) });
    expect(tooMany.status).toBe(422);
    const unknownField = await request(app).post('/api/metrics/ingest').send({ events: [{ name: 'storyboard.click', arbitrary: 'data' }] });
    expect(unknownField.status).toBe(422);
  });
});
