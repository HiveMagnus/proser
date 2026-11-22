import { randomUUID } from 'node:crypto';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { workflowService } from '@/services/workflowService';
import { SceneProseService } from '@/services/sceneProseService';
import * as liveJudge from '@/services/liveProseJudgeService';
import { defaultModelRouter } from '@/lib/ai/router';

const db = () => databaseService.client;

describe('canonical Full Book planning and sample order', () => {
  jest.setTimeout(30000);
  const prior = process.env.DOCUMENT_AUTHORITY_ENABLED;
  let userId: number; let bookId: number; let firstChapterId: number; let sceneIds: number[];
  beforeAll(() => { process.env.DOCUMENT_AUTHORITY_ENABLED = 'true'; });
  beforeEach(async () => {
    userId = (await db().user.create({ data: { githubId: `book-plan-${randomUUID()}`, username: 'Planning fixture' } })).id;
    bookId = (await db().book.create({ data: { userId, title: 'Ordered fixture', summary: 'Tuesday through Thursday.' } })).id;
    // Deliberately create later acts/chapters before the opening; numbering restarts per act.
    const later = await db().act.create({ data: { bookId, actNumber: 2 } });
    const laterChapter = await db().chapter.create({ data: { actId: later.id, chapterNumber: 1 } });
    const laterScene = await db().scene.create({ data: { chapterId: laterChapter.id, sceneNumber: 1, outline: 'Thursday consequence.' } });
    const first = await db().act.create({ data: { bookId, actNumber: 1 } });
    const secondChapter = await db().chapter.create({ data: { actId: first.id, chapterNumber: 2 } });
    const middle = await db().scene.create({ data: { chapterId: secondChapter.id, sceneNumber: 1, outline: 'Wednesday choice.' } });
    firstChapterId = (await db().chapter.create({ data: { actId: first.id, chapterNumber: 1, title: 'The announcement' } })).id;
    const secondScene = await db().scene.create({ data: { chapterId: firstChapterId, sceneNumber: 2, outline: 'Tuesday afternoon.' } });
    const opening = await db().scene.create({ data: { chapterId: firstChapterId, sceneNumber: 1, outline: 'Tuesday at 9:17 a.m.' } });
    await db().scene.create({ data: { chapterId: firstChapterId, sceneNumber: 3, outline: 'Removed scene.', deletedAt: new Date() } });
    sceneIds = [opening.id, secondScene.id, middle.id, laterScene.id];
    await db().codexEntry.create({ data: { bookId, entryType: 'character', entryName: 'Elena Reyes', entryDescription: 'Continuity official.', attributes: JSON.stringify({ arc: 'Accepts a costly public correction.' }) } });
    await documentService.initialize(userId, bookId);
    jest.spyOn(liveJudge, 'enqueueLiveProseJudge').mockResolvedValue('queued');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db().user.delete({ where: { id: userId } });
  });
  afterAll(() => { if (prior === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = prior; });

  const launch = () => workflowService.start(userId, 'full_book', { bookId, premise: 'An unexpected announcement changes three lives over seventy-two hours.', targetWords: 10000, style: 'Intimate prose.', pov: 'close third person', tense: 'past', mustInclude: ['A disputed announcement.'], mustAvoid: ['An instant global takeover.'] }, undefined, false);

  test('continuation initializes budgets, style, canon arcs and promises once in actual hierarchy order', async () => {
    const started = await launch();
    await workflowService.process(started.runId);
    const artifacts = await db().workflowArtifact.findMany({ where: { runId: started.runId } });
    expect(artifacts.map((row) => row.artifactType)).toEqual(expect.arrayContaining(['architecture', 'voice_style_bible', 'character_arc', 'word_budget_reconciliation', 'scene_contract']));
    const architecture = artifacts.find((row) => row.artifactType === 'architecture')!.payload as { orderedSceneIds: number[] };
    expect(architecture.orderedSceneIds).toEqual(sceneIds);
    const budget = artifacts.find((row) => row.artifactType === 'word_budget_reconciliation')!.payload as { sceneBudgets: Array<{ sceneId: number; words: number }> };
    expect(budget.sceneBudgets.map((row) => row.sceneId)).toEqual(sceneIds);
    expect(budget.sceneBudgets.reduce((sum, row) => sum + row.words, 0)).toBe(10000);
    expect(artifacts.find((row) => row.artifactType === 'voice_style_bible')!.payload).toMatchObject({ voice: 'Intimate prose.', constraints: expect.arrayContaining(['A disputed announcement.', 'Avoid: An instant global takeover.']) });
    expect(await db().narrativeLedger.findFirstOrThrow({ where: { workflowRunId: started.runId } })).toMatchObject({ introducedSceneId: sceneIds[0], dueSceneId: sceneIds.at(-1), status: 'open' });
    // Simulate recovery after catalog commit but before the checkpoint was dispatched.
    await db().workflowCheckpoint.deleteMany({ where: { runId: started.runId } });
    await db().workflowRun.update({ where: { id: started.runId }, data: { status: 'queued', phase: 'queued' } });
    await workflowService.process(started.runId);
    expect(await db().workflowArtifact.count({ where: { runId: started.runId } })).toBe(artifacts.length);
    expect(await db().narrativeLedger.count({ where: { workflowRunId: started.runId } })).toBe(1);
  });

  test('drafts only the opening chapter and proposes its committed prose with frozen preceding-scene evidence', async () => {
    const started = await launch();
    await workflowService.process(started.runId);
    const checkpoint = await db().workflowCheckpoint.findFirstOrThrow({ where: { runId: started.runId, checkpointType: 'architecture_outline' } });
    await workflowService.decideCheckpoint(userId, started.runId, checkpoint.id, 'approved');
    let ordinal = 0;
    const model = jest.spyOn(SceneProseService.prototype, 'generateProse').mockImplementation(async (context) => {
      ordinal += 1;
      const words = context.targetWords ?? 2500;
      const prose = Array.from({ length: words }, (_, index) => `scene${context.sceneId}candidate${ordinal}word${index}.`).join(' ');
      return { prose, wordCount: words, validatorResults: [] };
    });
    await workflowService.process(started.runId);
    const sample = await db().workflowCheckpoint.findFirstOrThrow({ where: { runId: started.runId, checkpointType: 'prose_sample' } });
    const proposal = sample.proposal as { chapter: { id: number; scenes: Array<{ id: number; prose: string }> } };
    expect(proposal.chapter.id).toBe(firstChapterId);
    expect(proposal.chapter.scenes.map((scene) => scene.id)).toEqual(sceneIds.slice(0, 2));
    for (const scene of proposal.chapter.scenes) expect(scene.prose).toBe((await documentService.read(userId, bookId, scene.id)).projection.text);
    expect(proposal.chapter.scenes.every((scene) => scene.prose.trim().length > 0)).toBe(true);
    for (const id of sceneIds.slice(2)) expect((await documentService.read(userId, bookId, id)).projection.text).toBe('');
    expect(model.mock.calls.map(([context]) => context.sceneId)).toEqual([sceneIds[0], sceneIds[0], sceneIds[1], sceneIds[1]]);
    expect(model.mock.calls[2][0].previousSceneSummary).toContain('Exact committed ending');
    expect(model.mock.calls[2][0].previousSceneSummary).toContain(`scene${sceneIds[0]}`);
    expect(model.mock.calls[2][0].instructions).toContain('A disputed announcement.');
    const tasks = await db().workflowTask.findMany({ where: { runId: started.runId, taskType: 'draft_scene' }, orderBy: { ordinal: 'asc' } });
    expect(tasks.map((task) => Number(task.scopeId))).toEqual(sceneIds);
    expect(tasks[2].dependencies).toEqual([`draft:scene:${sceneIds[1]}`]);
    const effect = await db().documentWorkflowEffect.findFirstOrThrow({ where: { runId: started.runId, sceneId: sceneIds[1] } });
    expect(effect.request).toMatchObject({ disclosure: { sceneIds: sceneIds.slice(0, 2), previousScene: { sceneId: sceneIds[0] } } });
  });

  test('reviews active scenes in hierarchy order rather than scene or chapter creation order', async () => {
    jest.spyOn(defaultModelRouter, 'choose').mockReturnValue({ id: 'fixture-review', generateText: jest.fn(async () => '{"findings":[]}'), setModel: jest.fn() } as never);
    const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'book' }, model: 'fixture-review', rubricVersion: 'publishable-v1' }, undefined, false);
    await workflowService.process(started.runId);
    const tasks = await db().workflowTask.findMany({ where: { runId: started.runId, taskType: 'review_scene' }, orderBy: { ordinal: 'asc' } });
    expect(tasks.map((task) => Number(task.scopeId))).toEqual(sceneIds);
    expect(await workflowService.status(userId, started.runId)).toMatchObject({ status: 'completed', findings: { total: expect.any(Number) } });
  });
});
