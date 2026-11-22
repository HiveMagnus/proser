import request from 'supertest';

import app from '../index';
import { databaseService } from '../lib/database';
import { manuscriptRevisionService, safeRevision } from '../services/manuscriptRevisionService';
import { evidenceMatches, isLocalizedReviewFinding, normalizeFindingCategory, parseExactReplacements, relationshipOnlyReplacement, releaseReviewDisposition, releaseReviewIdempotencyKey, revisionSafety, scoreQualityFindings, scoreSceneCandidate, workflowService } from '../services/workflowService';
import { defaultModelRouter } from '../lib/ai/router';
import { SceneProseService } from '../services/sceneProseService';
import { recoverOrphanedWorkflowRuns } from '../workers/workflowWorker';
import { classifyWorkflowFailure } from '../services/workflowFailure';
import { AIServiceError, ValidationError } from '../lib/errors';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prefix = `workflow-v1-${Date.now()}`;

function auth(userId: number, githubId: string) {
  return (value: request.Test) => value.set('x-user-id', String(userId)).set('x-github-id', githubId).set('x-username', githubId).set('idempotency-key', crypto.randomUUID());
}

describe('multi-workflow book factory v1', () => {
  let userId: number; let githubId: string; let bookId: number; let sceneId: number;

  beforeAll(async () => {
    githubId = `${prefix}-user`;
    const user = await databaseService.client.user.create({ data: { githubId, username: githubId } }); userId = user.id;
    const book = await databaseService.client.book.create({ data: { userId, title: 'Workflow Test', summary: 'A durable workflow test.', genre: 'fantasy' } }); bookId = book.id;
    const act = await databaseService.client.act.create({ data: { bookId, actNumber: 1, title: 'Act One' } });
    const chapter = await databaseService.client.chapter.create({ data: { actId: act.id, chapterNumber: 1, title: 'Opening' } });
    const prose = Array.from({ length: 180 }, (_, index) => `word${index}`).join(' ');
    const scene = await databaseService.client.scene.create({ data: { chapterId: chapter.id, sceneNumber: 1, outline: 'A consequential opening.', prose, wordCount: 180 } }); sceneId = scene.id;
  });

  afterAll(async () => {
    await databaseService.client.user.deleteMany({ where: { githubId: { startsWith: prefix } } });
  });

  it('escalates newly introduced codex relationship contradictions', () => {
    const padding = Array.from({ length: 80 }, (_, index) => `detail${index}`).join(' ');
    const characters = [{ entryName: 'Kaelen Vance', entryDescription: 'Deuteragonist / Fading Sister — Her memories are disappearing.', attributes: '{"aliases":["Kae"]}' }];
    const original = `Kaelen held her ground. ${padding}`;
    const harmful = `Kaelen held his ground. ${padding}`;
    const repaired = `Kaelen held her ground. ${padding}`;
    expect(revisionSafety(original, harmful, characters)).toMatchObject({ safe: false, reasons: expect.arrayContaining(['canon_relationship_changed']) });
    expect(revisionSafety(harmful, repaired, characters).reasons).not.toContain('canon_relationship_changed');
  });

  it('matches small-model evidence across quote styles and explicit ellipses', () => {
    const source = 'Elara opened the ledger. The ink moved beneath her hand. She closed the book.';
    expect(evidenceMatches(source, '“Elara opened the ledger.”')).toBe(true);
    expect(evidenceMatches(source, "'Elara opened the ledger. ... She closed the book.'")).toBe(true);
    expect(evidenceMatches(source, 'Elara opened the door.')).toBe(false);
  });

  it('limits relationship patches to gender and kinship tokens', () => {
    expect(relationshipOnlyReplacement('Kaelen held his ledger.', 'Kaelen held her ledger.')).toBe(true);
    expect(relationshipOnlyReplacement('Silas held his ledger.', 'Kaelen held her ledger.')).toBe(false);
    expect(relationshipOnlyReplacement('Her brother waited.', 'Her sister waited.')).toBe(true);
  });

  it('parses bounded exact replacements from Guided Improve instructions', () => {
    expect(parseExactReplacements('Replace exactly "my brother" with "my sister"; replace exactly [[FROM]]He said "wait."[[WITH]]She said "wait."[[END]].')).toEqual([
      { from: 'my brother', to: 'my sister' }, { from: 'He said "wait."', to: 'She said "wait."' },
    ]);
  });

  it('rechecks an unchanged blocked release without duplicating an active child review', () => {
    const guidedRevision = 'guided-revision';
    const child = (sourceRevisionId: string, status: string, workflowStatus: string) => ({ sourceRevisionId, status, workflowRunId: 'review-run', workflowRun: { status: workflowStatus } });
    expect(releaseReviewDisposition(guidedRevision, [child('older-revision', 'completed', 'completed')])).toEqual({ action: 'start' });
    expect(releaseReviewDisposition(guidedRevision, [child(guidedRevision, 'running', 'running')])).toEqual({ action: 'process', runId: 'review-run' });
    expect(releaseReviewDisposition(guidedRevision, [child(guidedRevision, 'running', 'paused')])).toEqual({ action: 'blocked', runId: 'review-run' });
    expect(releaseReviewDisposition(guidedRevision, [child(guidedRevision, 'completed', 'completed')])).toEqual({ action: 'none' });
  });

  it('uses a distinct durable release-review key for each manuscript revision', async () => {
    const parent = await workflowService.start(userId, 'full_book', { bookId, premise: 'Recheck a corrected release.' }, undefined, false);
    const input = { bookId, scope: { type: 'book' as const }, model: 'critic-a', rubricVersion: 'publishable-v1-release-recheck' };
    const firstRevision = crypto.randomUUID();
    const secondRevision = crypto.randomUUID();
    const firstKey = releaseReviewIdempotencyKey(parent.runId, firstRevision);
    const secondKey = releaseReviewIdempotencyKey(parent.runId, secondRevision);
    expect(firstKey).not.toBe(secondKey);
    const first = await workflowService.start(userId, 'quality_review', input, parent.runId, false, undefined, firstKey);
    const replay = await workflowService.start(userId, 'quality_review', input, parent.runId, false, undefined, firstKey);
    const second = await workflowService.start(userId, 'quality_review', input, parent.runId, false, undefined, secondKey);
    expect(replay.runId).toBe(first.runId);
    expect(second.runId).not.toBe(first.runId);
    expect(await databaseService.client.qualityReviewRun.count({ where: { workflowRunId: { in: [first.runId, second.runId] } } })).toBe(2);
  });

  it('approves only the latest publication package at final release', async () => {
    const started = await workflowService.start(userId, 'full_book', { bookId, premise: 'Keep the rejected package rejected after a corrected release.' }, undefined, false);
    const blockedId = crypto.randomUUID();
    const candidateId = crypto.randomUUID();
    await databaseService.client.publicationPackage.createMany({ data: [
      { id: blockedId, workflowRunId: started.runId, status: 'blocked', gateReport: { pass: false }, artifactManifest: {}, validationReport: {}, createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: candidateId, workflowRunId: started.runId, status: 'publishable_candidate', gateReport: { pass: true }, artifactManifest: {}, validationReport: {}, createdAt: new Date('2026-01-02T00:00:00Z') },
    ] });
    await databaseService.client.workflowRun.update({ where: { id: started.runId }, data: { status: 'queued', phase: 'final_checkpoint' } });
    await workflowService.process(started.runId);
    const packages = await databaseService.client.publicationPackage.findMany({ where: { workflowRunId: started.runId } });
    expect(packages.find((row) => row.id === blockedId)).toMatchObject({ status: 'blocked', approvedById: null });
    expect(packages.find((row) => row.id === candidateId)).toMatchObject({ status: 'release_approved', approvedById: userId });
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: started.runId } })).toMatchObject({ status: 'release_approved' });
  });

  it('allows ordinary narrative uses of outline while rejecting model placeholders', () => {
    const prose = `${'She crossed the archive carefully. '.repeat(20)}Kaelen's wavering outline caught the light.`;
    expect(safeRevision(prose, prose.replace('caught the light', 'shimmered in the light')).reasons).not.toContain('meta_or_placeholder_text');
    expect(safeRevision(prose, `${prose}\n\nScene outline: insert the scene here.`).reasons).toContain('meta_or_placeholder_text');
  });

  it('treats one-beat critic repairs as localized rather than release-blocking', () => {
    expect(isLocalizedReviewFinding('continuity', 'Clarify where she lands.')).toBe(true);
    expect(isLocalizedReviewFinding('continuity', 'Unify Kaelen pronouns throughout this scene.')).toBe(true);
    expect(isLocalizedReviewFinding('pacing', 'Trim the final three sentences.')).toBe(true);
    expect(isLocalizedReviewFinding('continuity', 'Have Elara step away from the door.')).toBe(true);
    expect(isLocalizedReviewFinding('continuity', 'Elara should slacken the satchel strap first.')).toBe(true);
    expect(isLocalizedReviewFinding('continuity', 'Update the stated age to eighty.')).toBe(true);
    expect(isLocalizedReviewFinding('structure', 'Split the chapter and reorder its final three scenes.')).toBe(false);
    expect(isLocalizedReviewFinding('canon', 'Change Kaelen from sister to brother.')).toBe(false);
    expect(isLocalizedReviewFinding('canon', 'Clarify whether solid is a relative description.')).toBe(true);
  });

  it('normalizes small-model category variants into the review rubric', () => {
    expect(normalizeFindingCategory('logic')).toBe('continuity');
    expect(normalizeFindingCategory('show-dont-tell')).toBe('clarity');
    expect(normalizeFindingCategory('invented_category')).toBe('clarity');
  });

  it('starts all four type-specific workflows with small request bodies', async () => {
    const review = await auth(userId, githubId)(request(app).post('/api/workflows/quality-review')).send({ bookId, scope: { type: 'book' }, model: 'critic-a', rubricVersion: 'publishable-v1' });
    expect(review.status).toBe(202); expect(review.body.data.workflowType).toBe('quality_review');
    const reviewId = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: review.body.data.runId } });

    const improve = await auth(userId, githubId)(request(app).post('/api/workflows/improve-quality')).send({ bookId, reviewRunIds: [reviewId.id] });
    expect(improve.status).toBe(202); expect(improve.body.data.workflowType).toBe('improve_quality');

    const guided = await auth(userId, githubId)(request(app).post('/api/workflows/guided-improve')).send({ bookId, instruction: 'Tighten repetitive phrasing.', scope: { type: 'scene', id: sceneId } });
    expect(guided.status).toBe(202); expect(guided.body.data.workflowType).toBe('guided_improve');

    const full = await auth(userId, githubId)(request(app).post('/api/workflows/full-book')).send({ premise: 'A cartographer finds a country erased from every map.', targetWords: 10_000 });
    expect(full.status).toBe(202); expect(full.body.data.workflowType).toBe('full_book');
  });

  it('requires a durable idempotency key and atomically creates one new Full Book graph', async () => {
    const missing = await auth(userId, githubId)(request(app).post('/api/workflows/full-book'))
      .unset('idempotency-key')
      .send({ premise: 'A clockmaker discovers that every repaired clock erases one shared memory.', targetWords: 10_000 });
    expect(missing.status).toBe(400);

    const key = `full-book-concurrent-${crypto.randomUUID()}`;
    const send = () => auth(userId, githubId)(request(app).post('/api/workflows/full-book'))
      .set('idempotency-key', key)
      .send({ premise: 'A clockmaker discovers that every repaired clock erases one shared memory.', title: `Idempotent ${key}`, targetWords: 10_000 });
    const [first, second] = await Promise.all([send(), send()]);
    expect(first.status).toBe(202); expect(second.status).toBe(202);
    expect(first.body.data.runId).toBe(second.body.data.runId);
    expect(await databaseService.client.book.count({ where: { userId, title: `Idempotent ${key}` } })).toBe(1);
    expect(await databaseService.client.workflowTask.count({ where: { runId: first.body.data.runId, taskKey: 'full_book:root' } })).toBe(1);
    expect(await databaseService.client.workflowEnqueueOutbox.count({ where: { runId: first.body.data.runId } })).toBe(1);
  });

  it('treats a simultaneous duplicate delivery as a harmless lease loser', async () => {
    let active = 0; let maximum = 0;
    const choose = jest.spyOn(defaultModelRouter, 'choose').mockReturnValue({
      generateText: jest.fn(async () => {
        active += 1; maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return '{"findings":[]}';
      }), setModel: jest.fn(),
    } as never);
    const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: `lease-race-${Date.now()}`, rubricVersion: 'publishable-v1' }, undefined, false);
    await Promise.all([workflowService.process(started.runId), workflowService.process(started.runId)]);
    expect(maximum).toBe(1);
    expect(await databaseService.client.workflowEvent.count({ where: { runId: started.runId, eventType: 'started' } })).toBe(1);
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: started.runId } })).toMatchObject({ status: 'completed', leaseOwner: null });
    choose.mockRestore();
  });

  it('consumes a checkpoint decision once and creates one durable resume enqueue', async () => {
    const started = await workflowService.start(userId, 'full_book', { bookId, premise: 'A single checkpoint decision resumes exactly one durable execution.' }, undefined, false);
    const checkpointId = crypto.randomUUID();
    await databaseService.client.workflowRun.update({ where: { id: started.runId }, data: { status: 'awaiting_approval', phase: 'architecture_checkpoint' } });
    await databaseService.client.workflowCheckpoint.create({ data: { id: checkpointId, runId: started.runId, checkpointType: 'architecture_outline', proposal: { approved: true } } });
    const decisions = await Promise.allSettled([
      workflowService.decideCheckpoint(userId, started.runId, checkpointId, 'approved', 'Approve once.', githubId),
      workflowService.decideCheckpoint(userId, started.runId, checkpointId, 'approved', 'Duplicate approval.', githubId),
    ]);
    expect(decisions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await databaseService.client.workflowEvent.count({ where: { runId: started.runId, eventType: 'checkpoint_decided' } })).toBe(1);
    expect(await databaseService.client.workflowEnqueueOutbox.count({ where: { runId: started.runId, dedupeKey: `checkpoint:${checkpointId}:approved` } })).toBe(1);
  });

  it('rediscovers persisted top-level book workflows with nested children', async () => {
    const started = await auth(userId, githubId)(request(app).post('/api/workflows/full-book')).send({ bookId, premise: 'A durable workflow history remains visible after an agent disconnects.' });
    expect(started.status).toBe(202);
    const listed = await auth(userId, githubId)(request(app).get(`/api/books/${bookId}/workflows`));
    expect(listed.status).toBe(200);
    expect(listed.body.data.some((run: { runId: string }) => run.runId === started.body.data.runId)).toBe(true);
    expect(listed.body.data.every((run: { parentRunId: string | null }) => run.parentRunId === null)).toBe(true);
  });

  it('keeps review rounds independent by model and exact source revision', async () => {
    const body = (model: string) => ({ bookId, scope: { type: 'book' }, model, rubricVersion: 'publishable-v1' });
    const a = await auth(userId, githubId)(request(app).post('/api/workflows/quality-review')).send(body('critic-a'));
    const b = await auth(userId, githubId)(request(app).post('/api/workflows/quality-review')).send(body('critic-b'));
    const runs = await databaseService.client.qualityReviewRun.findMany({ where: { workflowRunId: { in: [a.body.data.runId, b.body.data.runId] } } });
    expect(runs).toHaveLength(2); expect(new Set(runs.map((run) => run.modelUsed))).toEqual(new Set(['critic-a', 'critic-b']));
    expect(new Set(runs.map((run) => run.sourceRevisionId)).size).toBe(1);
  });

  it('selects blinded prose candidates by contract movement and literary quality, not length alone', () => {
    const filler = Array.from({ length: 100 }, () => 'word').join(' ');
    const moving = Array.from({ length: 10 }, () => 'Mira wanted the cold iron key, but the guard refused, so she chose to risk the dark river; because dawn arrived, she opened the door now.').join(' ');
    const contract = 'Mira must choose whether to risk the river and leave through the guarded door.';
    const fillerScore = scoreSceneCandidate(filler, 100, 100, 'fantasy', contract);
    const movingScore = scoreSceneCandidate(moving, 100, 100, 'fantasy', contract);
    expect(movingScore.contractScore).toBeGreaterThan(fillerScore.contractScore);
    expect(movingScore.selectionScore).toBeGreaterThan(fillerScore.selectionScore);
  });

  it('scores review density while preserving a visible critical-severity penalty', () => {
    expect(scoreQualityFindings([], 48)).toBe(100);
    expect(scoreQualityFindings([{ severity: 'critical', confidence: 1 }], 48)).toBeLessThan(80);
    expect(scoreQualityFindings(Array.from({ length: 20 }, () => ({ severity: 'medium', confidence: 0.8 })), 48)).toBeLessThan(95);
  });

  it('deduplicates repeated active starts instead of multiplying agent retries', async () => {
    const body = { bookId, scope: { type: 'book' as const }, model: `retry-model-${Date.now()}`, rubricVersion: 'publishable-v1' };
    const first = await workflowService.start(userId, 'quality_review', body, undefined, false);
    const repeated = await workflowService.start(userId, 'quality_review', body, undefined, false);
    expect(repeated.runId).toBe(first.runId);
  });

  it('runs a read-only full-book review across every hierarchy level', async () => {
    const prompts: string[] = [];
    const choose = jest.spyOn(defaultModelRouter, 'choose').mockReturnValue({
      generateText: jest.fn(async ({ prompt }: { prompt: string }) => { prompts.push(prompt); return '{"findings":[]}'; }),
      setModel: jest.fn(),
    } as never);
    const before = await manuscriptRevisionService.snapshot(bookId);
    const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'book' }, model: 'mock-model', rubricVersion: 'publishable-v1' }, undefined, false);
    await workflowService.process(started.runId);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: started.runId } });
    expect(review.status).toBe('completed');
    expect(review.score).toBe(100);
    expect(review.coverage).toEqual({ scene: 1, chapter: 1, act: 1, book: 1, characterAliasChecked: true, continuityChecked: true });
    expect(prompts.filter((prompt) => /Analyze this (?:act|book)/.test(prompt))).toHaveLength(2);
    expect(prompts.filter((prompt) => /Analyze this (?:act|book)/.test(prompt)).every((prompt) => prompt.includes('word0'))).toBe(true);
    expect(prompts.filter((prompt) => /Analyze this (?:act|book)/.test(prompt)).every((prompt) => prompt.includes('[Middle intentionally omitted from review context]'))).toBe(true);
    const after = await manuscriptRevisionService.snapshot(bookId);
    expect(after.contentHash).toBe(before.contentHash);
    choose.mockRestore();
  });

  it('resumes review coverage from completed durable scope tasks after a crash', async () => {
    const generateText = jest.fn(async () => '{"findings":[]}');
    const choose = jest.spyOn(defaultModelRouter, 'choose').mockReturnValue({ generateText, setModel: jest.fn() } as never);
    const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: `resume-review-${Date.now()}`, rubricVersion: 'publishable-v1' }, undefined, false);
    await databaseService.client.workflowTask.create({ data: {
      id: crypto.randomUUID(), runId: started.runId, taskKey: `review:scene:${sceneId}`, taskType: 'review_scene', phase: 'review', scopeType: 'scene', scopeId: String(sceneId), status: 'completed', dependencies: [], ordinal: 0, finishedAt: new Date(), inputRevisionId: started.sourceRevisionId,
    } });

    await workflowService.process(started.runId);

    expect(generateText).not.toHaveBeenCalled();
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: started.runId } })).toMatchObject({ status: 'completed', progress: { completed: 1, total: 1, percent: 100, unit: 'review_scopes' } });
    choose.mockRestore();
  });

  it('downgrades unsupported release-blocking severity from a small critic', async () => {
    const choose = jest.spyOn(defaultModelRouter, 'choose').mockReturnValue({
      generateText: jest.fn(async () => '{"findings":[{"category":"clarity","severity":"critical","confidence":0.6,"message":"A vague preference was reported without quoted evidence.","recommendation":"Consider changing it."}]}'),
      setModel: jest.fn(),
    } as never);
    const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: `calibrated-review-${Date.now()}`, rubricVersion: 'publishable-v1' }, undefined, false);

    await workflowService.process(started.runId);

    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: started.runId }, include: { findings: true } });
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({ severity: 'medium', confidence: 0.6, evidence: null });
    choose.mockRestore();
  });

  it('runs independent critics with bounded small-model concurrency', async () => {
    const chapter = await databaseService.client.chapter.findFirstOrThrow({ where: { act: { bookId } } });
    const prose = Array.from({ length: 180 }, (_, index) => `criticword${index}`).join(' ');
    const maximumScene = await databaseService.client.scene.aggregate({ where: { chapterId: chapter.id }, _max: { sceneNumber: true } });
    const extras = await Promise.all([1, 2].map((offset) => databaseService.client.scene.create({ data: { chapterId: chapter.id, sceneNumber: (maximumScene._max.sceneNumber ?? 0) + offset, prose, wordCount: 180 } })));
    let active = 0; let maximum = 0;
    const choose = jest.spyOn(defaultModelRouter, 'choose').mockReturnValue({
      generateText: jest.fn(async () => {
        active += 1; maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return '{"findings":[]}';
      }),
      setModel: jest.fn(),
    } as never);
    const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'book' }, model: `bounded-critic-${Date.now()}`, rubricVersion: 'publishable-v1' }, undefined, false);
    await workflowService.process(started.runId);
    expect(maximum).toBe(2);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: started.runId } });
    expect(review.coverage).toMatchObject({ scene: 3, chapter: 1, act: 1, book: 1 });
    choose.mockRestore();
    await databaseService.client.scene.deleteMany({ where: { id: { in: extras.map((scene) => scene.id) } } });
  });

  it('limits whole-cast name coverage to full-book review scope', async () => {
    const character = await databaseService.client.codexEntry.create({ data: { bookId, entryType: 'character', entryName: 'Absent Character', entryDescription: 'Appears later in the book.' } });
    const choose = jest.spyOn(defaultModelRouter, 'choose').mockReturnValue({ generateText: jest.fn(async () => '{"findings":[]}'), setModel: jest.fn() } as never);
    const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: `scene-critic-${Date.now()}`, rubricVersion: 'publishable-v1' }, undefined, false);
    await workflowService.process(started.runId);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: started.runId } });
    expect(review.coverage).toMatchObject({ characterAliasChecked: false });
    expect(await databaseService.client.qualityFinding.count({ where: { reviewRunId: review.id, category: 'unused_character' } })).toBe(0);
    choose.mockRestore();
    await databaseService.client.codexEntry.delete({ where: { id: character.id } });
  });

  it('mirrors nested editorial checkpoints onto Full Book and propagates approval', async () => {
    const parentId = crypto.randomUUID(); const childId = crypto.randomUUID(); const childCheckpointId = crypto.randomUUID();
    await databaseService.client.workflowRun.create({ data: { id: parentId, workflowType: 'full_book', bookId, userId, status: 'queued', phase: 'editorial_checkpoint', settings: { premise: 'A durable nested checkpoint fixture.', targetWords: 10000 }, configHash: crypto.randomUUID(), idempotencyKey: `fixture:${parentId}`, progress: { completed: 1, total: 4, percent: 25 } } });
    await databaseService.client.workflowRun.create({ data: { id: childId, workflowType: 'improve_quality', parentRunId: parentId, executionParentRunId: parentId, bookId, userId, status: 'awaiting_approval', phase: 'revision_checkpoint', settings: { bookId, reviewRunIds: [] }, configHash: crypto.randomUUID(), idempotencyKey: `fixture:${childId}`, progress: { completed: 0, total: 1, percent: 0 } } });
    await databaseService.client.workflowCheckpoint.create({ data: { id: childCheckpointId, runId: childId, checkpointType: 'structural_scene:test', proposal: { sceneId, revised: 'proposed text' } } });
    await databaseService.client.workflowArtifact.create({ data: { id: crypto.randomUUID(), runId: parentId, artifactType: 'editorial_state', scopeType: 'book', scopeId: String(bookId), contentHash: crypto.randomUUID(), payload: { nextRound: 0, reports: [], pendingChildRunId: childId } } });

    await workflowService.process(parentId);
    const parentCheckpoint = await databaseService.client.workflowCheckpoint.findFirstOrThrow({ where: { runId: parentId, status: 'pending' } });
    expect(parentCheckpoint.checkpointType).toBe(`editorial_child_${childCheckpointId}`);
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: parentId } })).toMatchObject({ status: 'awaiting_approval' });

    await workflowService.decideCheckpoint(userId, parentId, parentCheckpoint.id, 'approved', 'Approve the concrete scene revision.', githubId);
    expect(await databaseService.client.workflowCheckpoint.findUniqueOrThrow({ where: { id: childCheckpointId } })).toMatchObject({ decision: 'approved', decidedById: userId });
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: childId } })).toMatchObject({ status: 'queued' });
  });

  it('records implementation per finding and forbids manually forging it', async () => {
    const started = await auth(userId, githubId)(request(app).post('/api/workflows/quality-review')).send({ bookId, scope: { type: 'book' }, model: 'critic-state', rubricVersion: 'publishable-v1' });
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: started.body.data.runId } });
    const finding = await databaseService.client.qualityFinding.create({ data: { id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'scene', scopeId: sceneId, category: 'clarity', severity: 'medium', confidence: 0.8, message: 'A sentence is unclear.', evidence: 'word1 word2', recommendation: 'Clarify it.' } });
    const forged = await auth(userId, githubId)(request(app).patch(`/api/findings/${finding.id}`)).send({ implemented: true });
    expect(forged.status).toBe(400);
    const waived = await auth(userId, githubId)(request(app).patch(`/api/findings/${finding.id}`)).send({ waived: true, waiverReason: 'Intentional voice.' });
    expect(waived.status).toBe(200); expect(waived.body.data.waived).toBe(true);
  });

  it('derives stale finding aggregates from manuscript revision ancestry', async () => {
    const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: `critic-stale-${Date.now()}`, rubricVersion: 'publishable-v1' }, undefined, false);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: started.runId } });
    const finding = await databaseService.client.qualityFinding.create({ data: { id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'scene', scopeId: sceneId, category: 'clarity', severity: 'medium', confidence: 0.8, message: 'This applies only to the source revision.' } });
    const source = await databaseService.client.scene.findUniqueOrThrow({ where: { id: sceneId } });
    await databaseService.client.scene.update({ where: { id: sceneId }, data: { prose: `${source.prose} revision-drift`, wordCount: (source.wordCount ?? 0) + 1 } });
    await manuscriptRevisionService.capture(bookId, undefined, [{ type: 'scene', id: sceneId }]);
    const summaries = await workflowService.listReviews(userId, bookId);
    expect(summaries.find((item) => item.id === review.id)).toMatchObject({ stale: true, aggregates: { open: 0, stale: 1 } });
    expect((await workflowService.findings(userId, review.id)).find((item) => item.id === finding.id)).toMatchObject({ stale: true, reviewStale: true });
  });

  it('returns bounded, filterable book findings with review metadata', async () => {
    const reviewRun = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: 'critic-aggregate', rubricVersion: 'publishable-v1' }, undefined, false);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: reviewRun.runId } });
    await databaseService.client.qualityFinding.createMany({ data: [
      { id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'scene', scopeId: sceneId, category: 'clarity', severity: 'high', confidence: 0.9, message: 'Open aggregate finding.' },
      { id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'book', category: 'voice', severity: 'low', confidence: 0.7, message: 'Waived aggregate finding.', waived: true, waiverReason: 'Intentional.' },
    ] });

    const response = await auth(userId, githubId)(request(app).get(`/api/books/${bookId}/findings?state=open&model=critic-aggregate&severity=high&scope=scene&limit=1`));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ limit: 1, nextCursor: null });
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({ message: 'Open aggregate finding.', review: { id: review.id, modelUsed: 'critic-aggregate', rubricVersion: 'publishable-v1' } });
  });

  it('summarizes checkpoint proposals and pages details only on request', async () => {
    const run = await workflowService.start(userId, 'guided_improve', { bookId, instruction: 'Reshape the chapter structure safely.' }, undefined, false);
    const checkpointId = crypto.randomUUID();
    await databaseService.client.workflowCheckpoint.create({ data: { id: checkpointId, runId: run.runId, checkpointType: 'large_plan', proposal: { revisionId: crypto.randomUUID(), architecture: 'x'.repeat(40_000) } } });
    const status = await workflowService.status(userId, run.runId);
    expect(status.activeCheckpoint).toMatchObject({ id: checkpointId, summary: expect.stringContaining('object with'), artifactRefs: expect.arrayContaining([expect.stringMatching(/^revisionId:/)]) });
    expect(status.activeCheckpoint).not.toHaveProperty('proposal');
    expect(status).toMatchObject({ terminal: false, statusVersion: expect.any(Number) });
    await databaseService.client.workflowRun.update({ where: { id: run.runId }, data: { phase: 'checkpoint_inspected' } });
    const updatedStatus = await workflowService.status(userId, run.runId);
    expect(updatedStatus.statusVersion).toBeGreaterThan(status.statusVersion);

    const first = await workflowService.checkpointDetail(userId, run.runId, checkpointId, 0, 16_384);
    expect(first.proposalChunk.length).toBeLessThanOrEqual(16_384);
    expect(first.nextOffset).toBe(16_384);
    const second = await workflowService.checkpointDetail(userId, run.runId, checkpointId, first.nextOffset!, 16_384);
    expect(second.offset).toBe(first.nextOffset);
  });

  it('advances workflow status version exactly once through every supported mutation path', async () => {
    const run = await workflowService.start(userId, 'guided_improve', { bookId, instruction: 'Exercise every workflow mutation path.' }, undefined, false);
    const initial = await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: run.runId }, select: { statusVersion: true } });

    await databaseService.client.workflowRun.update({
      where: { id: run.runId },
      data: { phase: 'extension_write' },
    });
    const extended = await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: run.runId }, select: { statusVersion: true } });
    expect(extended.statusVersion).toBe(initial.statusVersion + 1);

    await databaseService.client.$executeRawUnsafe(
      'UPDATE workflow_runs SET phase = $1 WHERE id = $2',
      'raw_sql_write',
      run.runId,
    );
    const raw = await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: run.runId }, select: { statusVersion: true } });
    expect(raw.statusVersion).toBe(extended.statusVersion + 1);

    const alternate = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
    });
    try {
      await alternate.$connect();
      await alternate.workflowRun.update({
        where: { id: run.runId },
        data: { phase: 'alternate_client_write' },
      });
      const alternateResult = await alternate.workflowRun.findUniqueOrThrow({ where: { id: run.runId }, select: { statusVersion: true } });
      expect(alternateResult.statusVersion).toBe(raw.statusVersion + 1);
    } finally {
      await alternate.$disconnect();
    }
  });

  it('creates immutable revision lineage only when manuscript content changes', async () => {
    const first = await manuscriptRevisionService.current(bookId); const same = await manuscriptRevisionService.current(bookId); expect(same).toBe(first);
    await databaseService.client.scene.update({ where: { id: sceneId }, data: { prose: `${Array.from({ length: 180 }, (_, index) => `word${index}`).join(' ')} changed`, wordCount: 181 } });
    const second = await manuscriptRevisionService.capture(bookId, undefined, [{ type: 'scene', id: sceneId }]);
    expect(second).not.toBe(first); expect(await manuscriptRevisionService.isAncestor(first, second)).toBe(true);
    const rollback = await manuscriptRevisionService.restore(bookId, first);
    expect(rollback).not.toBe(first);
    expect(await manuscriptRevisionService.isAncestor(second, rollback)).toBe(true);
    const [originalRevision, rollbackRevision] = await Promise.all([first, rollback].map((id) => databaseService.client.manuscriptRevision.findUniqueOrThrow({ where: { id } })));
    expect(rollbackRevision.contentHash).toBe(originalRevision.contentHash);
  });

  it('auto-apply safety rejects truncation, length drift, entity changes, and large rewrites', () => {
    const original = Array.from({ length: 100 }, (_, index) => index === 0 ? 'Mira' : `word${index}`).join(' ');
    expect(safeRevision(original, original.replace('word50', 'clearer')).safe).toBe(true);
    expect(safeRevision(original, 'Looks good.').reasons).toContain('truncated_or_empty');
    expect(safeRevision(original, original.replace('Mira', 'Kael')).reasons).toContain('named_entities_changed');
    expect(safeRevision(original, Array.from({ length: 100 }, (_, index) => `different${index}`).join(' ')).reasons).toContain('change_exceeds_twenty_percent');
    expect(safeRevision(original, original.split(' ').reverse().join(' ')).reasons).toContain('change_exceeds_twenty_percent');
  });

  it('marks a finding implemented only after a persisted change and targeted verification', async () => {
    const original = Array.from({ length: 180 }, (_, index) => `verify${index}`).join(' ');
    await databaseService.client.scene.update({ where: { id: sceneId }, data: { prose: original, wordCount: 180 } });
    const reviewRun = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: 'critic-verify', rubricVersion: 'publishable-v1' }, undefined, false);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: reviewRun.runId } });
    const finding = await databaseService.client.qualityFinding.create({ data: { id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'scene', scopeId: sceneId, category: 'clarity', severity: 'medium', confidence: 0.9, message: 'The wording is unclear.', evidence: 'verify50', recommendation: 'Replace the unclear word.' } });
    const revised = original.replace('verify50', 'clearer');
    const revision = jest.spyOn(SceneProseService.prototype, 'reviewProse').mockResolvedValue({ revised });
    const improve = await workflowService.start(userId, 'improve_quality', { bookId, reviewRunIds: [review.id], findingIds: [finding.id], model: 'editor-verify' }, undefined, false);
    await workflowService.process(improve.runId);
    const stored = await databaseService.client.qualityFinding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(stored).toMatchObject({ implemented: true, verificationStatus: 'passed', implementingWorkflowRunId: improve.runId });
    expect(stored.implementedRevisionId).toBeTruthy();
    expect(stored.verificationEvidence).toContain('quoted source evidence is absent');
    expect(await databaseService.client.workflowTask.findUniqueOrThrow({ where: { runId_taskKey: { runId: improve.runId, taskKey: `revise:finding:${finding.id}` } } })).toMatchObject({
      status: 'completed', inputRevisionId: expect.any(String), outputRevisionId: stored.implementedRevisionId,
    });
    revision.mockRestore();
  });

  it('groups compatible findings for one scene into one coherent revision', async () => {
    const original = Array.from({ length: 180 }, (_, index) => `group${index}`).join(' ');
    await databaseService.client.scene.update({ where: { id: sceneId }, data: { prose: original, wordCount: 180 } });
    const reviewRun = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: 'critic-group', rubricVersion: 'publishable-v1' }, undefined, false);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: reviewRun.runId } });
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await databaseService.client.qualityFinding.createMany({ data: [
      { id: ids[0], reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'scene', scopeId: sceneId, category: 'clarity', severity: 'medium', confidence: 0.9, message: 'The first phrase is unclear.', evidence: 'group40', recommendation: 'Clarify it.' },
      { id: ids[1], reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'scene', scopeId: sceneId, category: 'cadence', severity: 'medium', confidence: 0.9, message: 'The second phrase breaks cadence.', evidence: 'group50', recommendation: 'Smooth it.' },
    ] });
    const revised = original.replace('group40', 'clearer').replace('group50', 'smoother');
    const revision = jest.spyOn(SceneProseService.prototype, 'reviewProse').mockResolvedValue({ revised });
    const improve = await workflowService.start(userId, 'improve_quality', { bookId, reviewRunIds: [review.id], findingIds: ids, model: 'editor-group' }, undefined, false);

    await workflowService.process(improve.runId);

    expect(revision).toHaveBeenCalledTimes(1);
    const stored = await databaseService.client.qualityFinding.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((finding) => finding.implementedRevisionId)).size).toBe(1);
    expect(stored.every((finding) => finding.implemented && finding.verificationStatus === 'passed')).toBe(true);
    expect(await databaseService.client.workflowTask.count({ where: { runId: improve.runId, status: 'completed' } })).toBeGreaterThanOrEqual(3);
    revision.mockRestore();
  });

  it('marks stale structural evidence before conflict or approval checkpoints', async () => {
    const chapter = await databaseService.client.chapter.findFirstOrThrow({ where: { act: { bookId } } });
    const reviewRun = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'chapter', id: chapter.id }, model: `critic-stale-structure-${Date.now()}`, rubricVersion: 'publishable-v1' }, undefined, false);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: reviewRun.runId } });
    const finding = await databaseService.client.qualityFinding.create({ data: { id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'chapter', scopeId: chapter.id, category: 'structure', severity: 'high', confidence: 0.9, message: 'Restructure a beat that no longer exists.', evidence: 'this quoted evidence is absent', recommendation: 'Move the absent beat.' } });
    const improve = await workflowService.start(userId, 'improve_quality', { bookId, reviewRunIds: [review.id], findingIds: [finding.id] }, undefined, false);
    await workflowService.process(improve.runId);
    expect(await databaseService.client.qualityFinding.findUniqueOrThrow({ where: { id: finding.id } })).toMatchObject({ stale: true, implemented: false });
    expect(await databaseService.client.workflowCheckpoint.count({ where: { runId: improve.runId } })).toBe(0);
  });

  it('never retries a finding that is already marked stale', async () => {
    const scene = await databaseService.client.scene.findUniqueOrThrow({ where: { id: sceneId } });
    const reviewRun = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: `critic-prestale-${Date.now()}`, rubricVersion: 'publishable-v1' }, undefined, false);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: reviewRun.runId } });
    const finding = await databaseService.client.qualityFinding.create({ data: { id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'scene', scopeId: sceneId, category: 'specificity', severity: 'medium', confidence: 0.8, message: 'An obsolete diagnosis.', evidence: scene.prose!.split(/\s+/)[20], stale: true } });
    const revision = jest.spyOn(SceneProseService.prototype, 'reviewProse');
    const improve = await workflowService.start(userId, 'improve_quality', { bookId, reviewRunIds: [review.id], findingIds: [finding.id] }, undefined, false);

    await workflowService.process(improve.runId);

    expect(revision).not.toHaveBeenCalled();
    expect(await databaseService.client.qualityFinding.findUniqueOrThrow({ where: { id: finding.id } })).toMatchObject({ stale: true, implemented: false });
    revision.mockRestore();
  });

  it('does not claim implementation when the editor produces no manuscript change', async () => {
    const scene = await databaseService.client.scene.findUniqueOrThrow({ where: { id: sceneId } });
    const reviewRun = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: 'critic-no-change', rubricVersion: 'publishable-v1' }, undefined, false);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: reviewRun.runId } });
    const finding = await databaseService.client.qualityFinding.create({ data: { id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'scene', scopeId: sceneId, category: 'cadence', severity: 'medium', confidence: 0.8, message: 'Cadence needs work.', evidence: scene.prose!.split(/\s+/)[60], recommendation: 'Improve the cadence.' } });
    const revision = jest.spyOn(SceneProseService.prototype, 'reviewProse').mockResolvedValue({ revised: scene.prose! });
    const improve = await workflowService.start(userId, 'improve_quality', { bookId, reviewRunIds: [review.id], findingIds: [finding.id] }, undefined, false);
    await workflowService.process(improve.runId);
    expect(await databaseService.client.qualityFinding.findUniqueOrThrow({ where: { id: finding.id } })).toMatchObject({ implemented: false, verificationStatus: 'failed' });
    await databaseService.client.workflowRun.update({ where: { id: improve.runId }, data: { status: 'queued' } });
    await workflowService.process(improve.runId);
    expect(revision).toHaveBeenCalledTimes(1);
    revision.mockRestore();
  });

  it('pauses for conflicting cross-model recommendations instead of choosing silently', async () => {
    const reviews = [];
    for (const model of ['critic-expand', 'critic-cut']) {
      const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model, rubricVersion: 'publishable-v1' }, undefined, false);
      reviews.push(await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: started.runId } }));
    }
    const relatedFingerprint = crypto.randomUUID();
    await databaseService.client.qualityFinding.createMany({ data: reviews.map((review, index) => ({ id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), relatedFingerprint, scopeType: 'scene', scopeId: sceneId, category: 'pacing', severity: 'medium', confidence: 0.8, message: 'The beat length is disputed.', recommendation: index ? 'Cut this beat.' : 'Expand this beat.' })) });
    const improve = await workflowService.start(userId, 'improve_quality', { bookId, reviewRunIds: reviews.map((review) => review.id) }, undefined, false);
    await workflowService.process(improve.runId);
    const stored = await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: improve.runId } });
    expect(stored).toMatchObject({ status: 'awaiting_approval', phase: 'conflict_checkpoint' });
    expect(await databaseService.client.workflowCheckpoint.findFirst({ where: { runId: improve.runId, checkpointType: 'conflicting_review_advice', status: 'pending' } })).toBeTruthy();
  });

  it('groups high-impact findings into one developmental revision checkpoint', async () => {
    const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'book' }, model: 'critic-developmental', rubricVersion: 'publishable-v1' }, undefined, false);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: started.runId } });
    const findings = await databaseService.client.qualityFinding.createMany({ data: [
      { id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'book', category: 'structure', severity: 'high', confidence: 0.9, message: 'The midpoint lacks a reversal.', recommendation: 'Strengthen the midpoint reversal.' },
      { id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'scene', scopeId: sceneId, category: 'canon', severity: 'high', confidence: 0.9, message: 'A canon fact changes.', recommendation: 'Restore the established fact.' },
    ] });
    expect(findings.count).toBe(2);
    const improve = await workflowService.start(userId, 'improve_quality', { bookId, reviewRunIds: [review.id] }, undefined, false);
    await workflowService.process(improve.runId);
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: improve.runId } })).toMatchObject({ status: 'awaiting_approval', phase: 'developmental_revision_checkpoint' });
    const checkpoints = await databaseService.client.workflowCheckpoint.findMany({ where: { runId: improve.runId, status: 'pending' } });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].checkpointType).toBe('developmental_revision_plan');
    expect((checkpoints[0].proposal as { findingIds: string[] }).findingIds).toHaveLength(2);
  });

  it('does not turn ungrounded cross-scope advice into a whole-book rewrite', async () => {
    const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'book' }, model: `critic-ungrounded-${Date.now()}`, rubricVersion: 'publishable-v1' }, undefined, false);
    const review = await databaseService.client.qualityReviewRun.findUniqueOrThrow({ where: { workflowRunId: started.runId } });
    const finding = await databaseService.client.qualityFinding.create({ data: { id: crypto.randomUUID(), reviewRunId: review.id, fingerprint: crypto.randomUUID(), scopeType: 'book', category: 'structure', severity: 'high', confidence: 0.9, message: 'The structure should feel different.', recommendation: 'Rewrite the structure broadly.' } });
    const improve = await workflowService.start(userId, 'improve_quality', { bookId, reviewRunIds: [review.id], findingIds: [finding.id] }, undefined, false);
    await workflowService.process(improve.runId);
    const checkpoint = await databaseService.client.workflowCheckpoint.findFirstOrThrow({ where: { runId: improve.runId, checkpointType: 'developmental_revision_plan' } });
    await workflowService.decideCheckpoint(userId, improve.runId, checkpoint.id, 'approved');
    const revision = jest.spyOn(SceneProseService.prototype, 'reviewProse');

    await workflowService.process(improve.runId);

    expect(revision).not.toHaveBeenCalled();
    expect(await databaseService.client.qualityFinding.findUniqueOrThrow({ where: { id: finding.id } })).toMatchObject({ implemented: false, verificationStatus: 'failed' });
    revision.mockRestore();
  });

  it('recovers the persisted sample_drafting phase after a worker restart', async () => {
    const started = await workflowService.start(userId, 'full_book', { bookId, premise: 'An archivist must preserve a city whose history rewrites itself every dawn.', targetWords: 10_000 }, undefined, false);
    await databaseService.client.workflowCheckpoint.create({ data: { id: crypto.randomUUID(), runId: started.runId, checkpointType: 'architecture_outline', status: 'decided', decision: 'approved', proposal: {} } });
    await databaseService.client.workflowRun.update({ where: { id: started.runId }, data: { status: 'queued', phase: 'sample_drafting' } });
    await workflowService.process(started.runId);
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: started.runId } })).toMatchObject({ status: 'awaiting_approval', phase: 'sample_checkpoint' });
    expect(await databaseService.client.workflowCheckpoint.findFirst({ where: { runId: started.runId, checkpointType: 'prose_sample', status: 'pending' } })).toBeTruthy();
  });

  it('stops drafting at the next scene boundary when paused without starting review', async () => {
    const chapter = await databaseService.client.chapter.findFirstOrThrow({ where: { act: { bookId } } });
    const maximumScene = await databaseService.client.scene.aggregate({ where: { chapterId: chapter.id }, _max: { sceneNumber: true } });
    const [second, third] = await Promise.all([1, 2].map((offset) => {
      const sceneNumber = (maximumScene._max.sceneNumber ?? 0) + offset;
      return databaseService.client.scene.create({ data: { chapterId: chapter.id, sceneNumber, outline: `Pause test scene ${sceneNumber}.` } });
    }));
    const started = await workflowService.start(userId, 'full_book', { bookId, premise: 'Pause safely at a durable scene boundary.', targetWords: 10_000, candidateCount: 2 }, undefined, false);
    await databaseService.client.workflowRun.update({ where: { id: started.runId }, data: { status: 'queued', phase: 'drafting' } });
    let candidateOrdinal = 0;
    const generation = jest.spyOn(SceneProseService.prototype, 'generateProse').mockImplementation(async () => {
      candidateOrdinal += 1;
      const prose = Array.from({ length: 2300 }, (_, index) => `pauseword${candidateOrdinal}-${index}`).join(' ');
      await databaseService.client.workflowRun.update({ where: { id: started.runId }, data: { status: 'paused' } });
      return { prose, wordCount: 2300, validatorResults: [] } as never;
    });
    await workflowService.process(started.runId);
    expect(await databaseService.client.scene.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ prose: null });
    expect(await databaseService.client.scene.findUniqueOrThrow({ where: { id: third.id } })).toMatchObject({ prose: null });
    expect(await databaseService.client.workflowRun.count({ where: { parentRunId: started.runId, workflowType: 'quality_review' } })).toBe(0);
    const budget = await databaseService.client.workflowArtifact.findFirstOrThrow({ where: { runId: started.runId, artifactType: 'word_budget_reconciliation' } });
    const payload = budget.payload as { targetWords: number; actBudgets: Array<{ words: number }>; chapterBudgets: Array<{ words: number }>; sceneBudgets: Array<{ words: number }> };
    expect(payload.targetWords).toBe(10_000);
    for (const rows of [payload.actBudgets, payload.chapterBudgets, payload.sceneBudgets]) expect(rows.reduce((sum, row) => sum + row.words, 0)).toBe(10_000);
    generation.mockRestore();
    await databaseService.client.scene.deleteMany({ where: { id: { in: [second.id, third.id] } } });
  });

  it('re-enqueues an orphaned durable workflow after a worker crash', async () => {
    const started = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: `crash-recovery-${Date.now()}`, rubricVersion: 'publishable-v1' }, undefined, false);
    await databaseService.client.workflowRun.update({ where: { id: started.runId }, data: { status: 'running', attemptCount: 2, deliveryAttemptCount: 2, failureReason: 'worker disappeared' } });
    const enqueue = jest.fn(async () => undefined);
    const recovered = await recoverOrphanedWorkflowRuns({ getJob: jest.fn(async () => undefined) } as never, enqueue, [started.runId]);
    expect(recovered).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(started.runId, userId);
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: started.runId } })).toMatchObject({ status: 'queued', attemptCount: 2, deliveryAttemptCount: 2, recoveryCount: 1, failureReason: null });
    expect(await workflowService.status(userId, started.runId)).toMatchObject({
      attempts: { executions: 2, currentDelivery: 2, recoveries: 1, maximumDeliveryAttempts: 3 },
    });
    expect(await databaseService.client.workflowEvent.findFirst({ where: { runId: started.runId, eventType: 'orphan_recovered' } })).toBeTruthy();
  });

  it('recovers only infrastructure-classified failures', async () => {
    expect(classifyWorkflowFailure(new AIServiceError(new Error('socket closed'), 'inference failed'))).toBe('infrastructure');
    expect(classifyWorkflowFailure(new ValidationError('Invalid workflow configuration'))).toBe('validation');
    expect(classifyWorkflowFailure(new Error('Manuscript revision contains placeholder prose'))).toBe('content');

    const permanent = await workflowService.start(userId, 'guided_improve', { bookId, instruction: 'A permanently invalid request.' }, undefined, false);
    await databaseService.client.workflowRun.update({ where: { id: permanent.runId }, data: { status: 'failed', failureReason: 'Invalid configuration', failureClass: 'validation' } });
    const enqueue = jest.fn(async () => undefined);
    expect(await recoverOrphanedWorkflowRuns({ getJob: jest.fn(async () => undefined) } as never, enqueue, [permanent.runId])).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: permanent.runId } })).toMatchObject({ status: 'failed', failureClass: 'validation', attemptCount: 0 });
  });

  it('pauses orphan recovery when the current delivery attempt budget is exhausted', async () => {
    const started = await workflowService.start(userId, 'guided_improve', { bookId, instruction: 'Do not exceed the configured execution budget.' }, undefined, false);
    await databaseService.client.workflowRun.update({
      where: { id: started.runId },
      data: { status: 'running', attemptCount: 7, deliveryAttemptCount: 3, recoveryCount: 2 },
    });
    const enqueue = jest.fn(async () => undefined);
    expect(await recoverOrphanedWorkflowRuns({ getJob: jest.fn(async () => undefined) } as never, enqueue, [started.runId])).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: started.runId } })).toMatchObject({
      status: 'paused', attemptCount: 7, deliveryAttemptCount: 3, recoveryCount: 2,
    });
  });

  it('does not reset an execution lease acquired after orphan selection', async () => {
    const started = await workflowService.start(userId, 'guided_improve', { bookId, instruction: 'Exercise the recovery lease race.' }, undefined, false);
    await databaseService.client.workflowRun.update({ where: { id: started.runId }, data: { status: 'running', leaseOwner: null, leaseExpiresAt: null } });
    const activeOwner = crypto.randomUUID();
    const queue = { getJob: jest.fn(async () => {
      await databaseService.client.workflowRun.update({
        where: { id: started.runId },
        data: { leaseOwner: activeOwner, leaseExpiresAt: new Date(Date.now() + 60_000) },
      });
      return undefined;
    }) };
    const enqueue = jest.fn(async () => undefined);

    expect(await recoverOrphanedWorkflowRuns(queue as never, enqueue, [started.runId])).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: started.runId } })).toMatchObject({ status: 'running', leaseOwner: activeOwner });
    expect(await databaseService.client.workflowEvent.count({ where: { runId: started.runId, eventType: 'orphan_recovered' } })).toBe(0);
  });

  it('does not independently recover a nested workflow owned by an active database parent', async () => {
    const parent = await workflowService.start(userId, 'full_book', { bookId, premise: 'A parent owns its nested editorial execution.' }, undefined, false);
    const child = await workflowService.start(userId, 'quality_review', { bookId, scope: { type: 'scene', id: sceneId }, model: `nested-recovery-${Date.now()}`, rubricVersion: 'publishable-v1' }, parent.runId, false);
    await databaseService.client.workflowRun.update({ where: { id: child.runId }, data: { status: 'running' } });
    const queue = { getJob: jest.fn(async () => undefined) };
    const enqueue = jest.fn(async () => undefined);

    expect(await recoverOrphanedWorkflowRuns(queue as never, enqueue, [child.runId])).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await databaseService.client.workflowRun.findUniqueOrThrow({ where: { id: child.runId } })).toMatchObject({ status: 'running' });
  });
});
