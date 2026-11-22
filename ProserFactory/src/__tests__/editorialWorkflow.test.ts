import request from 'supertest';

import app from '@/index';
import { databaseService } from '@/lib/database';
import { workflowService } from '@/services/workflowService';

const prefix = `jest-editorial-${Date.now()}`;
const passPacks = [
  'line_edit_safe', 'dialogue', 'voice_preservation', 'scene_energy',
  'continuity', 'name_originality', 'final_polish', 'custom',
] as const;

function auth(userId: number, githubId: string, value: request.Test, key = crypto.randomUUID()) {
  return value
    .set('x-user-id', String(userId))
    .set('x-github-id', githubId)
    .set('x-username', githubId)
    .set('idempotency-key', key);
}

describe('autonomous editorial Workflow v1', () => {
  let userId: number;
  let githubId: string;
  let bookId: number;
  let actId: number;
  let chapterId: number;
  let sceneId: number;

  beforeAll(async () => {
    githubId = `${prefix}-owner`;
    const user = await databaseService.client.user.create({ data: { githubId, username: githubId } });
    userId = user.id;
    const book = await databaseService.client.book.create({ data: { userId, title: 'Editorial Fixture', genre: 'gothic fantasy' } });
    bookId = book.id;
    const act = await databaseService.client.act.create({ data: { bookId, actNumber: 1, title: 'Orchard' } });
    actId = act.id;
    const chapter = await databaseService.client.chapter.create({ data: { actId, chapterNumber: 1, title: 'Return' } });
    chapterId = chapter.id;
    const scene = await databaseService.client.scene.create({
      data: {
        chapterId,
        sceneNumber: 1,
        outline: 'Mara returns without revealing the glass pear.',
        prose: 'Mara crossed the empty hall. The empty hall amplified every step. "Still empty," Mara said softly. The glass pear stayed hidden.',
        wordCount: 23,
      },
    });
    sceneId = scene.id;
    await databaseService.client.codexEntry.createMany({
      data: [
        { bookId, entryType: 'character', entryName: 'Mara Vale', entryDescription: 'A guarded botanist.' },
        { bookId, entryType: 'character', entryName: 'Maera Vail', entryDescription: 'The caretaker.' },
      ],
    });
  });

  afterAll(async () => {
    await databaseService.client.user.deleteMany({ where: { githubId: { startsWith: prefix } } });
  });

  it('discovers all versioned pass packs without exposing prompts', async () => {
    const response = await auth(userId, githubId, request(app).get('/api/editorial/pass-packs'));
    expect(response.status).toBe(200);
    expect(response.body.data.map((item: { key: string }) => item.key)).toEqual(passPacks);
    expect(JSON.stringify(response.body.data)).not.toMatch(/promptRecipe|hidden|expectedVerdict/);
  });

  it.each([
    ['book', undefined],
    ['act', () => actId],
    ['chapter', () => chapterId],
    ['scene', () => sceneId],
  ] as const)('launches and terminalizes checkpoint-free %s review scope', async (scopeType, scopeId) => {
    const body = {
      bookId,
      scope: scopeType === 'book' ? { type: scopeType } : { type: scopeType, id: scopeId!() },
      passPack: 'line_edit_safe',
      autonomy: 'review_only',
    };
    const response = await auth(userId, githubId, request(app).post('/api/workflows/editorial-optimize')).send(body);
    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({
      workflowType: 'editorial_optimize',
      status: 'queued',
      passPack: 'line_edit_safe',
    });
    await workflowService.process(response.body.data.runId);
    const run = await workflowService.status(userId, response.body.data.runId);
    expect(run).toMatchObject({ status: 'completed', terminal: true });
    expect(run.editorial?.outcome).toBe('completed_review_only');
    expect(await databaseService.client.workflowCheckpoint.count({ where: { runId: run.runId } })).toBe(0);
  });

  it.each(['review_only', 'propose_only', 'safe_auto', 'max_quality_auto'] as const)(
    'accepts the %s autonomy contract without adding checkpoint state',
    async (autonomy) => {
      const response = await auth(userId, githubId, request(app).post('/api/workflows/editorial-optimize')).send({
        bookId, scope: { type: 'scene', id: sceneId }, passPack: 'line_edit_safe', autonomy,
      });
      expect(response.status).toBe(202);
      expect(await databaseService.client.workflowCheckpoint.count({ where: { runId: response.body.data.runId } })).toBe(0);
      await workflowService.control(userId, response.body.data.runId, 'cancel', githubId);
    },
  );

  it.each(passPacks)('runs the %s pass to a terminal review result', async (passPack) => {
    const response = await auth(userId, githubId, request(app).post('/api/workflows/editorial-optimize')).send({
      bookId,
      scope: { type: 'book' },
      passPack,
      autonomy: 'review_only',
      ...(passPack === 'custom' ? { objective: 'Identify vague local wording while preserving Mara and the glass pear.' } : {}),
    });
    expect(response.status).toBe(202);
    await workflowService.process(response.body.data.runId);
    expect((await workflowService.status(userId, response.body.data.runId)).status).toBe('completed');
    expect(await databaseService.client.workflowCheckpoint.count({ where: { runId: response.body.data.runId } })).toBe(0);
  });

  it('deduplicates an idempotent editorial launch', async () => {
    const key = crypto.randomUUID();
    const launch = () => auth(userId, githubId, request(app).post('/api/workflows/editorial-optimize'), key).send({
      bookId, scope: { type: 'scene', id: sceneId }, passPack: 'continuity', autonomy: 'review_only',
    });
    const [first, second] = await Promise.all([launch(), launch()]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.data.runId).toBe(second.body.data.runId);
    await workflowService.process(first.body.data.runId);
  });

  it('versions profiles immutably, resolves ownership, and rejects IDOR', async () => {
    const create = (styleGoals: string[]) => auth(userId, githubId, request(app).post('/api/editorial/profiles')).send({
      name: 'Mara Voice',
      bookId,
      config: { styleGoals, mustPreserve: ['Mara reserve', 'glass pear'] },
    });
    const first = await create(['clarity']);
    const second = await create(['clarity', 'voice fidelity']);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data.version).toBe('1.0.0');
    expect(second.body.data.version).toBe('2.0.0');
    const activated = await auth(userId, githubId, request(app).post(`/api/books/${bookId}/editorial-profile/activate`)).send({ profileId: second.body.data.id });
    expect(activated.status).toBe(200);
    expect(activated.body.data.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(activated.body.data.config.styleGoals).toEqual(['clarity', 'voice fidelity']);

    const strangerGithub = `${prefix}-stranger`;
    const stranger = await databaseService.client.user.create({ data: { githubId: strangerGithub, username: strangerGithub } });
    const denied = await auth(stranger.id, strangerGithub, request(app).get(`/api/editorial/profiles/${second.body.data.id}`));
    expect(denied.status).toBe(404);
  });

  it('runs deterministic Quality Lab evidence with hidden outcomes isolated', async () => {
    const response = await auth(userId, githubId, request(app).post('/api/editorial/benchmarks')).send({
      suiteKey: 'editorial-deterministic',
      maximumCases: 20,
      live: false,
    });
    expect(response.status).toBe(202);
    expect(response.body.data.reportHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(response.body.data)).not.toContain('expectedVerdict');
    const report = await auth(userId, githubId, request(app).get(`/api/editorial/benchmarks/${response.body.data.id}/report`));
    expect(report.status).toBe(200);
    expect(report.body.data.report.release.blocking.hardInvariants).toBe(true);
  });

  it('exposes incrementally maintained editorial metrics without database scans', async () => {
    const response = await request(app).get('/api/metrics');
    expect(response.status).toBe(200);
    expect(response.body.data.editorial.counters.runs_started).toBeGreaterThan(0);
    expect(response.body.data.editorial.counters.runs_completed).toBeGreaterThan(0);
    expect(response.body.data.editorial.durations.run_total.count).toBeGreaterThan(0);
  });

  it('publishes OpenAPI coverage and stable bounded validation errors', async () => {
    const docs = await request(app).get('/api/docs.json');
    expect(docs.body.paths['/api/workflows/editorial-optimize'].post.responses['202']).toBeDefined();
    expect(docs.body.paths['/api/editorial/benchmarks'].post).toBeDefined();
    const invalid = await auth(userId, githubId, request(app).post('/api/workflows/editorial-optimize')).send({
      bookId, scope: { type: 'scene', id: sceneId }, passPack: 'custom', autonomy: 'safe_auto',
      objective: 'Rewrite the entire book.',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
  });
});
