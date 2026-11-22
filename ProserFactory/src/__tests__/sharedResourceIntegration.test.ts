// This boundary test needs Redis's real atomic creation script and durable key
// lookup; the general Jest Redis mock intentionally implements neither.
jest.unmock('../lib/redis');
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { databaseService } from '../lib/database';
import { createApp } from '../server';
import { sharedResourceCanonicalJson } from '../services/sharedResourceService';
import * as sharedResourceService from '../services/sharedResourceService';
import { generationReplayService } from '../services/generationReplayService';
import redis from '../lib/redis';
import * as generationRunner from '../services/generationOperationRunner';
import { processWorkflowJob } from '../workers/workflowWorker';
import { defaultModelRouter } from '../lib/ai/router';

const keys = generateKeyPairSync('ed25519');
const requestId = `nova-${'d'.repeat(32)}`;
const token = `pnv_${'A'.repeat(43)}`;
const directory = mkdtempSync(join(tmpdir(), 'proser-shared-resource-'));
const signingFile = join(directory, 'terminal.pem');
const keyId = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const now = Math.floor(Date.now() / 1000);
const grantUnsigned = {
  version: 2, grant_id: 'grant-proser-fence', mission_id: 'mission-one', mission_revision: 1,
  origin_task_id: 'origin-task', task_id: 'delegated-task', request_id: requestId, caller: 'senti',
  audience: 'proser', owner_actor: 'service:shared-resource:nova', action_classes: ['create_draft'],
  issued_at: now - 10, expires_at: now + 3600, actions: ['books.create', 'editorial.write', 'generation.create', 'operations.read', 'workflows.create'], resources: ['book:4242', 'new'],
  revoked: false, key_id: keyId,
};
const signedGrant = (resources = grantUnsigned.resources) => {
  const unsigned = { ...grantUnsigned, resources };
  return { ...unsigned, signature: sign(null, Buffer.from(sharedResourceCanonicalJson(unsigned)), keys.privateKey).toString('base64url') };
};
const grant = signedGrant();
let generationScheduleSpy: jest.SpyInstance;
let ownerId: number;
const createdGenerations: Array<{ id: string; key: string }> = [];

function headers(operationId: string, generation: string, selectedResourceKey = 'provider:new:proser') {
  const claim = { leaseId: `lease_${operationId.padEnd(16, 'x').slice(0, 32)}`, version: 1,
    resources: [{ resourceKey: selectedResourceKey, fenceGeneration: generation }],
    missionRootId: 'mission-one', missionRevision: 1, taskId: 'origin-task', operationId,
    requestSha256: createHash('sha256').update(operationId).digest('hex'), actionClass: 'create_draft',
    deadline: now + 1800, caller: { kind: 'delegated', delegationId: 'delegated-task' },
    ownerActor: 'service:shared-resource:nova', evidenceDomain: 'nova.provider-result.v1' };
  const json = sharedResourceCanonicalJson(claim);
  return { Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId,
    'X-Magnus-Fence-Set': Buffer.from(json).toString('base64url'),
    'X-Magnus-Fence-Set-Sha256': createHash('sha256').update(json).digest('hex'),
    'X-Magnus-Lease-Id': claim.leaseId, 'X-Magnus-Operation-Id': operationId,
    'X-Magnus-Request-Sha256': claim.requestSha256, 'X-Magnus-Evidence-Domain': claim.evidenceDomain,
    'X-Magnus-Resource-Key': selectedResourceKey, 'X-Magnus-Fence-Generation': generation };
}

beforeAll(async () => {
  generationScheduleSpy = jest.spyOn(generationRunner, 'scheduleGenerationOperations').mockResolvedValue();
  process.env.GENERATION_MAX_ACTIVE_PER_USER = '20';
  process.env.GENERATION_MAX_ACTIVE_GLOBAL = '100';
  process.env.PROSER_DELEGATED_GENERATION_ENABLED = 'true';
  chmodSync(directory, 0o700); writeFileSync(signingFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  process.env.PROSER_SHARED_RESOURCE_SIGNING_KEY_FILE = signingFile;
  process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  process.env.PROSER_NOVA_GRANTS_JSON = JSON.stringify({ [requestId]: grant });
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([{ sha256: createHash('sha256').update(token).digest('hex'), name: 'nova-proser',
    ownerGithubId: 'owner-one', scopes: ['content:read', 'content:write'], callers: ['senti'], expiresAt: new Date(Date.now() + 3600_000).toISOString() }]);
  await databaseService.connect();
  const user = await databaseService.client.user.create({ data: { githubId: 'owner-one', username: 'owner' } });
  ownerId = user.id;
  await databaseService.client.book.create({ data: { id: 4242, userId: user.id, title: 'Editorial authorization fixture' } });
  await databaseService.client.manuscriptRevision.create({ data: { id: 'revision-editorial-one', bookId: 4242,
    contentHash: 'a'.repeat(64), wordCount: 2, changedScopes: [], snapshot: { scenes: [], codex: [] } } });
  await databaseService.client.workflowRun.create({ data: { id: 'workflow-editorial-one', workflowType: 'editorial_optimize',
    bookId: 4242, userId: user.id, sourceRevisionId: 'revision-editorial-one', settings: {}, idempotencyKey: 'editorial-auth-fixture' } });
  await databaseService.client.editorialRun.create({ data: { id: 'editorial-run-one', workflowRunId: 'workflow-editorial-one',
    bookId: 4242, sourceRevisionId: 'revision-editorial-one', passPackKey: 'line_edit_safe', passPackVersion: '1',
    policyVersion: '1', autonomy: 'propose_only', scopeType: 'book', status: 'completed', requestConfig: {} } });
  await databaseService.client.editorialProposal.create({ data: { id: 'proposal-editorial-one', editorialRunId: 'editorial-run-one',
    sourceRevisionId: 'revision-editorial-one', bookId: 4242, scopeType: 'book', passKey: 'line_edit_safe', passVersion: '1',
    risk: 'low', confidence: 1, fingerprint: 'editorial-auth-fingerprint', sourceHash: 'b'.repeat(64), originalText: 'Original.',
    startOffset: 0, endOffset: 9, expectedBenefits: [], protectedClaims: [], findingIds: [], detectorIds: [] } });
});

test('authorizes proposal mutation from its database owner and rejects a grant for another book', async () => {
  const app = createApp();
  const requestHeaders = headers('operation-editorial-one', '1', 'provider:proser:4242');
  process.env.PROSER_NOVA_GRANTS_JSON = JSON.stringify({ [requestId]: signedGrant(['book:4243']) });
  let denied: request.Response;
  try {
    denied = await request(app).post('/api/editorial/proposals/proposal-editorial-one/preference')
      .set(requestHeaders).send({ evidenceType: 'choose_original' }).expect(403);
  } finally {
    process.env.PROSER_NOVA_GRANTS_JSON = JSON.stringify({ [requestId]: grant });
  }
  expect(denied.body).toMatchObject({ error: { details: { code: 'DELEGATED_RESOURCE_DENIED' } } });

  const accepted = await request(app).post('/api/editorial/proposals/proposal-editorial-one/preference')
    .set(requestHeaders).send({ evidenceType: 'choose_original' }).expect(201);
  expect(accepted.body).toMatchObject({ sharedResourceResult: { operationId: 'operation-editorial-one', terminalState: 'succeeded' },
    sharedResourceEvidence: { operationId: 'operation-editorial-one', outcome: 'succeeded' } });
  expect(await databaseService.client.editorialPreferenceEvidence.count({ where: { proposalId: 'proposal-editorial-one' } })).toBe(1);
});

test('database rejects truncation of operation and fence history', async () => {
  await expect(databaseService.client.$executeRawUnsafe('TRUNCATE TABLE "shared_resource_operations"')).rejects.toThrow(/cannot be truncated/i);
  await expect(databaseService.client.$executeRawUnsafe('TRUNCATE TABLE "shared_resource_fences"')).rejects.toThrow(/cannot be truncated/i);
});
afterAll(async () => {
  generationScheduleSpy.mockRestore();
  for (const operation of createdGenerations) {
    await generationReplayService.cancel(operation.id, ownerId).catch(() => null);
    await redis.zrem('proser:generation:v2:active', operation.id).catch(() => 0);
    await redis.zrem('proser:generation:v2:pending', operation.id).catch(() => 0);
    await redis.zrem('proser:generation:v2:running', operation.id).catch(() => 0);
    await redis.zrem(`proser:generation:v2:user:${ownerId}:active`, operation.id).catch(() => 0);
    await redis.zrem(`proser:generation:v2:user:${ownerId}:operations`, operation.id).catch(() => 0);
    await redis.del(`proser:generation:v2:operation:${operation.id}`, `proser:generation:v2:events:${operation.id}`,
      `proser:generation:v2:artifact:${operation.id}`, `proser:generation:v2:artifact:${operation.id}:provisional`,
      `proser:generation:v2:user:${ownerId}:idempotency:${createHash('sha256').update(operation.key).digest('hex')}`).catch(() => 0);
  }
  delete process.env.GENERATION_MAX_ACTIVE_PER_USER;
  delete process.env.GENERATION_MAX_ACTIVE_GLOBAL;
  delete process.env.PROSER_DELEGATED_GENERATION_ENABLED;
  redis.disconnect();
  await databaseService.disconnect(); rmSync(directory, { recursive: true, force: true });
  delete process.env.PROSER_SHARED_RESOURCE_SIGNING_KEY_FILE; delete process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_PEM;
  delete process.env.PROSER_NOVA_GRANTS_JSON; delete process.env.PROSER_SERVICE_PRINCIPALS_JSON;
});

test('fails closed unfenced, commits one fenced mutation, replays it exactly, and recovers signed evidence', async () => {
  const app = createApp(); const body = { title: 'Fenced manuscript' };
  await request(app).post('/api/books').set({ Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId }).send(body).expect(409);
  const first = await request(app).post('/api/books').set(headers('operation-one', '1')).send(body).expect(201);
  expect(first.body.sharedResourceEvidence).toMatchObject({ operationId: 'operation-one', outcome: 'succeeded', issuer: 'proser' });
  const bookId = first.body.data.id;
  expect(first.body.sharedResourceResult).toMatchObject({ domain: 'nova.provider-result.v1', operationId: 'operation-one', terminalState: 'succeeded',
    result: { responseStatus: 201, response: { success: true, data: { id: bookId } } } });
  expect(createHash('sha256').update(sharedResourceCanonicalJson(first.body.sharedResourceResult)).digest('hex')).toBe(first.body.sharedResourceEvidence.evidenceSha256);
  const { signature, ...unsignedEvidence } = first.body.sharedResourceEvidence;
  expect(verify(null, Buffer.from(sharedResourceCanonicalJson({ domain: 'magnus.shared-resource-terminal.v1', ...unsignedEvidence })), keys.publicKey, Buffer.from(signature, 'base64'))).toBe(true);
  const replay = await request(app).post('/api/books').set(headers('operation-one', '1')).send(body).expect(201);
  expect(replay.body.data.id).toBe(bookId);
  expect(await databaseService.client.book.count({ where: { title: 'Fenced manuscript' } })).toBe(1);
  const recovered = await request(app).get('/api/shared-resource-operations/operation-one')
    .set({ Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId }).expect(200);
  expect(recovered.body).toMatchObject({ data: { operationId: 'operation-one', state: 'succeeded' }, sharedResourceEvidence: { outcome: 'succeeded' } });
  await request(app).post('/api/books').set(headers('operation-two', '1')).send({ title: 'Stale' }).expect(409);
  expect(await databaseService.client.book.count({ where: { title: 'Fenced manuscript' } })).toBe(1);
  const detached = await request(app).post('/api/workflows/quality-review').set(headers('operation-three', '2', 'provider:proser:4242'))
    .set('Idempotency-Key', 'detached-workflow-one').send({ bookId: 4242, scope: { type: 'book' }, model: 'fixture', rubricVersion: 'fixture-v1' });
  expect(detached.status).toBe(202);
  const detachedRunId = detached.body.data.runId as string;
  expect(await databaseService.client.sharedResourceOperation.findUnique({ where: { operationId: 'operation-three' } }))
    .toMatchObject({ state: 'running', executionKind: 'workflow', executionId: detachedRunId });
  await expect(databaseService.client.sharedResourceOperation.update({ where: { operationId: 'operation-three' }, data: { executionId: 'different-run' } }))
    .rejects.toThrow(/execution binding is immutable/i);
  const detachedReplay = await request(app).post('/api/workflows/quality-review').set(headers('operation-three', '2', 'provider:proser:4242'))
    .set('Idempotency-Key', 'detached-workflow-one').send({ bookId: 4242, scope: { type: 'book' }, model: 'fixture', rubricVersion: 'fixture-v1' }).expect(202);
  expect(detachedReplay.body.data.runId).toBe(detachedRunId);
  expect(await databaseService.client.workflowRun.count({ where: { id: detachedRunId } })).toBe(1);

  const successor = await request(app).post('/api/workflows/quality-review').set(headers('operation-four', '3', 'provider:proser:4242'))
    .set('Idempotency-Key', 'detached-workflow-successor').send({ bookId: 4242, scope: { type: 'book' }, model: 'fixture-2', rubricVersion: 'fixture-v1' }).expect(202);
  const successorRunId = successor.body.data.runId as string;
  await processWorkflowJob({
    data: { runId: detachedRunId, userId: 1 },
    log: jest.fn(async () => undefined), updateProgress: jest.fn(async () => undefined),
  } as never);
  expect(await databaseService.client.workflowRun.findUnique({ where: { id: detachedRunId } }))
    .toMatchObject({ status: 'cancelled', cancelRequested: true, failureClass: 'validation' });
  expect(await databaseService.client.sharedResourceOperation.findUnique({ where: { operationId: 'operation-three' } }))
    .toMatchObject({ state: 'failed' });

  const choose = jest.spyOn(defaultModelRouter, 'choose').mockReturnValue({
    generateText: jest.fn(async () => '{"findings":[]}'), setModel: jest.fn(),
  } as never);
  try {
    await processWorkflowJob({
      data: { runId: successorRunId, userId: 1 },
      log: jest.fn(async () => undefined), updateProgress: jest.fn(async () => undefined),
    } as never);
  } finally {
    choose.mockRestore();
  }
  expect(await databaseService.client.workflowRun.findUnique({ where: { id: successorRunId } }))
    .toMatchObject({ status: 'completed' });
  expect(await databaseService.client.sharedResourceOperation.findUnique({ where: { operationId: 'operation-four' } }))
    .toMatchObject({ state: 'succeeded', executionKind: 'workflow', executionId: successorRunId });

  // Simulate a process crash after authoritative workflow completion but before
  // the terminal provider evidence was sealed. Redelivery must reconcile it.
  const recovery = await request(app).post('/api/workflows/quality-review').set(headers('operation-five', '4', 'provider:proser:4242'))
    .set('Idempotency-Key', 'detached-workflow-recovery').send({ bookId: 4242, scope: { type: 'book' }, model: 'fixture-3', rubricVersion: 'fixture-v1' }).expect(202);
  const recoveryRunId = recovery.body.data.runId as string;
  await databaseService.client.workflowRun.update({ where: { id: recoveryRunId }, data: {
    status: 'completed', phase: 'completed', finishedAt: new Date(),
  } });
  await processWorkflowJob({
    data: { runId: recoveryRunId, userId: 1 },
    log: jest.fn(async () => undefined), updateProgress: jest.fn(async () => undefined),
  } as never);
  expect(await databaseService.client.sharedResourceOperation.findUnique({ where: { operationId: 'operation-five' } }))
    .toMatchObject({ state: 'succeeded', executionKind: 'workflow', executionId: recoveryRunId });

  const unsupportedWorkflow = await request(app).post('/api/workflows/full-book').set(headers('operation-full-book', '2'))
    .set('Idempotency-Key', 'unsupported-full-book').send({ premise: 'A sufficiently detailed unsupported full-book premise.' }).expect(409);
  expect(unsupportedWorkflow.body).toMatchObject({ error: { code: 'SHARED_RESOURCE_ASYNC_UNSUPPORTED' },
    sharedResourceResult: { terminalState: 'no_effect' }, sharedResourceEvidence: { outcome: 'no_effect' } });

  const generation = await request(app).post('/api/generate/operations').set(headers('operation-generation', '5', 'provider:proser:4242'))
    .set('Idempotency-Key', 'fenced-generation').send({ kind: 'prose', bookId: 4242, prompt: 'fixture' }).expect(202);
  expect(generation.body).toMatchObject({ data: { idempotencyKey: 'fenced-generation', route: 'generate.prose' },
    sharedResourceResult: { terminalState: 'succeeded' }, sharedResourceEvidence: { outcome: 'succeeded' } });
  const generationId = generation.body.data.operationId as string;
  createdGenerations.push({ id: generationId, key: 'fenced-generation' });
  expect(await databaseService.client.sharedResourceOperation.findUnique({ where: { operationId: 'operation-generation' } }))
    .toMatchObject({ executionKind: 'generation', executionId: generationId, generationIdempotencyKey: 'fenced-generation',
      generationRequestHash: generation.body.data.requestHash });
  const generationReplay = await request(app).post('/api/generate/operations').set(headers('operation-generation', '5', 'provider:proser:4242'))
    .set('Idempotency-Key', 'fenced-generation').send({ kind: 'prose', bookId: 4242, prompt: 'fixture' }).expect(202);
  expect(generationReplay.body.data.operationId).toBe(generationId);
  await request(app).post('/api/generate/operations').set(headers('operation-generation', '5', 'provider:proser:4242'))
    .set('Idempotency-Key', 'different-key').send({ kind: 'prose', bookId: 4242, prompt: 'fixture' }).expect(409);
  await request(app).post('/api/generate/operations').set(headers('operation-generation', '5', 'provider:proser:4242'))
    .set('Idempotency-Key', 'fenced-generation').send({ kind: 'prose', bookId: 4242, prompt: 'different' }).expect(409);

  const benchmark = await request(app).post('/api/editorial/benchmarks').set(headers('operation-benchmark', '3'))
    .set('Idempotency-Key', 'fenced-benchmark-one').send({ maximumCases: 1 }).expect(202);
  expect(benchmark.body).toMatchObject({ sharedResourceResult: { terminalState: 'succeeded' }, sharedResourceEvidence: { outcome: 'succeeded' } });
});

test('recovers a Redis-created generation after sealing fails, and holds unknown when Redis has no receipt', async () => {
  const app = createApp();
  const body = { kind: 'prose', bookId: 4242, prompt: 'A short disposable test paragraph.' };
  const noBinding = jest.spyOn(sharedResourceService, 'bindSharedResourceGeneration').mockRejectedValueOnce(new Error('simulated crash before dispatch binding'));
  await request(app).post('/api/generate/operations').set(headers('operation-generation-before-binding', '8', 'provider:proser:4242'))
    .set('Idempotency-Key', 'fenced-generation-before-binding').send(body).expect(500);
  noBinding.mockRestore();
  expect(await databaseService.client.sharedResourceOperation.findUniqueOrThrow({ where: { operationId: 'operation-generation-before-binding' } }))
    .toMatchObject({ state: 'admitted', executionKind: null, generationIdempotencyKey: 'fenced-generation-before-binding' });
  const resumedBeforeDispatch = await request(createApp()).post('/api/generate/operations')
    .set(headers('operation-generation-before-binding', '8', 'provider:proser:4242'))
    .set('Idempotency-Key', 'fenced-generation-before-binding').send(body).expect(202);
  expect(resumedBeforeDispatch.body).toMatchObject({ sharedResourceEvidence: { outcome: 'succeeded' } });
  createdGenerations.push({ id: resumedBeforeDispatch.body.data.operationId as string, key: 'fenced-generation-before-binding' });

  const noRedis = jest.spyOn(generationReplayService, 'create').mockRejectedValueOnce(new Error('simulated crash before Redis creation'));
  await request(createApp()).post('/api/generate/operations').set(headers('operation-generation-before-redis', '9', 'provider:proser:4242'))
    .set('Idempotency-Key', 'fenced-generation-before-redis').send(body).expect(500);
  noRedis.mockRestore();
  const uncertain = await databaseService.client.sharedResourceOperation.findUniqueOrThrow({ where: { operationId: 'operation-generation-before-redis' } });
  expect(uncertain).toMatchObject({ state: 'running', executionKind: 'generation',
    generationIdempotencyKey: 'fenced-generation-before-redis' });
  expect(await generationReplayService.getForUser(uncertain.executionId!, ownerId)).toBeNull();
  const noReplay = await request(createApp()).post('/api/generate/operations').set(headers('operation-generation-before-redis', '9', 'provider:proser:4242'))
    .set('Idempotency-Key', 'fenced-generation-before-redis').send(body).expect(409);
  expect(noReplay.body.error.code).toBe('SHARED_RESOURCE_UNKNOWN_EFFECT');
  const unresolved = await request(createApp()).get('/api/shared-resource-operations/operation-generation-before-redis')
    .set({ Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId }).expect(200);
  expect(unresolved.body).toMatchObject({ data: { state: 'running', generationOperationId: uncertain.executionId } });
  expect(unresolved.body.sharedResourceEvidence).toBeUndefined();

  const noSeal = jest.spyOn(sharedResourceService, 'sealSharedResourceOperation').mockRejectedValueOnce(new Error('simulated crash after Redis creation'));
  await request(createApp()).post('/api/generate/operations').set(headers('operation-generation-before-seal', '10', 'provider:proser:4242'))
    .set('Idempotency-Key', 'fenced-generation-before-seal').send(body).expect(500);
  noSeal.mockRestore();
  const pending = await databaseService.client.sharedResourceOperation.findUniqueOrThrow({ where: { operationId: 'operation-generation-before-seal' } });
  expect(pending).toMatchObject({ state: 'running', executionKind: 'generation' });
  expect(await generationReplayService.getForUser(pending.executionId!, ownerId)).toMatchObject({ operationId: pending.executionId });
  createdGenerations.push({ id: pending.executionId!, key: 'fenced-generation-before-seal' });
  const recovered = await request(createApp()).get('/api/shared-resource-operations/operation-generation-before-seal')
    .set({ Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId }).expect(200);
  expect(recovered.body).toMatchObject({ data: { state: 'succeeded', generationOperationId: pending.executionId },
    sharedResourceEvidence: { outcome: 'succeeded' } });
  const replay = await request(createApp()).post('/api/generate/operations').set(headers('operation-generation-before-seal', '10', 'provider:proser:4242'))
    .set('Idempotency-Key', 'fenced-generation-before-seal').send(body).expect(202);
  expect(replay.body.data.operationId).toBe(pending.executionId);
});

test('holds delegated generation at signed no_effect while activation is disabled', async () => {
  delete process.env.PROSER_DELEGATED_GENERATION_ENABLED;
  try {
    const body = { kind: 'prose', bookId: 4242, prompt: 'A gated draft.' };
    const denied = await request(createApp()).post('/api/generate/operations')
      .set(headers('operation-generation-disabled', '11', 'provider:proser:4242'))
      .set('Idempotency-Key', 'fenced-generation-disabled').send(body).expect(409);
    expect(denied.body).toMatchObject({ error: { code: 'SHARED_RESOURCE_ASYNC_UNSUPPORTED' },
      sharedResourceResult: { terminalState: 'no_effect' }, sharedResourceEvidence: { outcome: 'no_effect' } });
    expect(await databaseService.client.sharedResourceOperation.findUniqueOrThrow({ where: { operationId: 'operation-generation-disabled' } }))
      .toMatchObject({ state: 'no_effect', executionKind: null });
  } finally { process.env.PROSER_DELEGATED_GENERATION_ENABLED = 'true'; }
});
