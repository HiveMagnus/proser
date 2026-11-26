import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '../index';
import { databaseService } from '../lib/database';
import { generateEmbedding } from '../lib/ai/embeddings';
import { VllmService } from '../lib/ai/vllm';
import { isAiRequest, requestBookIds, runWithAiBookScope } from '../lib/ai/bookAiPolicy';
import { admitReleaseMutation, runReleaseProviderEffect } from '../operations/releaseAdmission';
import { workflowService } from '../services/workflowService';

describe('per-book AI switch', () => {
  const prefix = `jest-ai-off-${Date.now()}`;
  let owner: { id: number; githubId: string };
  let other: { id: number; githubId: string };
  let bookId: number;
  let openBookId: number;
  let fetchSpy: jest.SpyInstance;
  const as = (user: { id: number; githubId: string }) => (test: request.Test) =>
    test.set('x-user-id', String(user.id)).set('x-github-id', user.githubId).set('x-username', user.githubId);
  const providerCalls = () => fetchSpy.mock.calls.filter(([url]) => /\/v1\/|sdapi/.test(String(url))).length;

  beforeAll(async () => {
    owner = await databaseService.client.user.create({ data: { githubId: `${prefix}-owner`, username: `${prefix}-owner` } });
    other = await databaseService.client.user.create({ data: { githubId: `${prefix}-other`, username: `${prefix}-other` } });
    bookId = (await databaseService.client.book.create({ data: { userId: owner.id, title: 'Private manuscript' } })).id;
    openBookId = (await databaseService.client.book.create({ data: { userId: owner.id, title: 'Open manuscript' } })).id;
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], data: [{ embedding: [0.1] }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  afterEach(() => fetchSpy.mockRestore());

  afterAll(async () => {
    await databaseService.client.workflowRun.deleteMany({ where: { bookId: { in: [bookId, openBookId] } } });
    await databaseService.client.auditLog.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await databaseService.client.user.deleteMany({ where: { githubId: { startsWith: prefix } } });
  });

  it('stores the switch per book, audits changes and hides other writers\' books', async () => {
    const initial = await as(owner)(request(app).get(`/api/books/${bookId}/ai-policy`)).expect(200);
    expect(initial.body.data).toEqual({ bookId, aiDisabled: false, updatedAt: null });
    const saved = await as(owner)(request(app).put(`/api/books/${bookId}/ai-policy`).send({ aiDisabled: true })).expect(200);
    expect(saved.body.data).toMatchObject({ bookId, aiDisabled: true });
    await as(owner)(request(app).put(`/api/books/${bookId}/ai-policy`).send({ aiDisabled: true })).expect(200);
    expect((await as(owner)(request(app).get('/api/books/ai-policies')).expect(200)).body.data).toEqual({ aiDisabledBookIds: [bookId] });
    const audits = await databaseService.client.auditLog.findMany({ where: { userId: owner.id, entityId: bookId } });
    expect(audits.map((row) => row.metadata)).toEqual([{ command: 'book-ai-policy', aiDisabled: true }]);

    await as(other)(request(app).get(`/api/books/${bookId}/ai-policy`)).expect(404);
    await as(other)(request(app).put(`/api/books/${bookId}/ai-policy`).send({ aiDisabled: false })).expect(404);
    expect((await as(other)(request(app).get('/api/books/ai-policies')).expect(200)).body.data).toEqual({ aiDisabledBookIds: [] });
    await as(owner)(request(app).put(`/api/books/${bookId}/ai-policy`).send({ aiDisabled: 'yes' })).expect(422);
  });

  it('refuses AI requests for the book before any work or provider call', async () => {
    for (const [path, body] of [
      ['/api/generate/prose', { bookId, sceneId: 1 }],
      ['/api/generate/prose/command-revise', { bookId: String(bookId) }],
      ['/api/workflows/quality-review', { bookId }],
      ['/api/images/generate', { bookId, prompt: 'cover' }],
      [`/api/books/${bookId}/plot-threads/1/reviews`, {}],
      [`/api/books/${bookId}/document-discussions/d1/proposals`, {}],
    ] as const) {
      const response = await as(owner)(request(app).post(path).send(body));
      expect([path, response.status, response.body.error?.code]).toEqual([path, 409, 'BOOK_AI_DISABLED']);
    }
    expect(await databaseService.client.workflowRun.count({ where: { bookId } })).toBe(0);
    expect(providerCalls()).toBe(0);
    // Writing without AI still works.
    await as(owner)(request(app).put(`/api/books/${bookId}/writing-goal`).send({ targetWords: 1000, deadline: null, dailyWords: null })).expect(200);
    // Another writer naming the book learns nothing about its switch.
    const foreign = await as(other)(request(app).post('/api/workflows/quality-review').send({ bookId }));
    expect(foreign.body.error?.code).not.toBe('BOOK_AI_DISABLED');
  });

  it('blocks provider dispatch for the book wherever the request came from', async () => {
    await expect(runWithAiBookScope([bookId], () => admitReleaseMutation('provider', 'chat-completions', {}))).rejects.toMatchObject({ code: 'BOOK_AI_DISABLED', status: 409 });
    await expect(runReleaseProviderEffect(() => admitReleaseMutation('provider', 'chat-completions', {}), { kind: 'test', id: randomUUID(), bookId })).rejects.toMatchObject({ code: 'BOOK_AI_DISABLED' });
    const service = new VllmService();
    await expect(runWithAiBookScope([openBookId, bookId], () => service.generateText({ prompt: 'Continue the scene' }))).rejects.toMatchObject({ code: 'BOOK_AI_DISABLED' });
    expect(await runWithAiBookScope([bookId], () => generateEmbedding('scene text'))).toBeNull();
    expect(providerCalls()).toBe(0);

    await expect(runWithAiBookScope([openBookId], () => admitReleaseMutation('provider', 'chat-completions', {}))).resolves.toBeDefined();
    await expect(runWithAiBookScope([openBookId], () => generateEmbedding('scene text'))).resolves.toMatchObject({ embedding: [0.1] });
  });

  it('pauses a queued workflow for the book instead of calling a provider', async () => {
    const id = randomUUID();
    await databaseService.client.workflowRun.create({ data: { id, workflowType: 'quality_review', bookId, userId: owner.id, settings: {}, idempotencyKey: randomUUID() } });
    await workflowService.process(id);
    const run = await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id } });
    expect(run).toMatchObject({ status: 'paused', failureClass: 'validation' });
    expect(run.failureReason).toMatch(/AI is switched off/);
    expect(providerCalls()).toBe(0);
  });

  it('switching AI back on allows requests again', async () => {
    await as(owner)(request(app).put(`/api/books/${bookId}/ai-policy`).send({ aiDisabled: false })).expect(200);
    await expect(runWithAiBookScope([bookId], () => admitReleaseMutation('provider', 'chat-completions', {}))).resolves.toBeDefined();
    const response = await as(owner)(request(app).post('/api/generate/prose/command-revise').send({ bookId }));
    expect(response.body.error?.code).not.toBe('BOOK_AI_DISABLED');
  });

  it('finds the books a request names and recognises AI requests', () => {
    expect(requestBookIds({ path: '/books/12/scenes/3', query: { bookId: '7' }, body: { bookId: 9 } }).sort()).toEqual([12, 7, 9].sort());
    expect(requestBookIds({ path: '/books/trash', query: {}, body: { bookId: 'x', book_id: '0' } })).toEqual([]);
    expect(isAiRequest('POST', '/generate/prose')).toBe(true);
    expect(isAiRequest('POST', '/generate/operations/abc/cancel')).toBe(false);
    expect(isAiRequest('POST', '/books/1/revision-campaigns/5/analyses')).toBe(true);
    expect(isAiRequest('GET', '/generate/operations/abc')).toBe(false);
    expect(isAiRequest('POST', '/books/1/document-commits')).toBe(false);
  });
});
