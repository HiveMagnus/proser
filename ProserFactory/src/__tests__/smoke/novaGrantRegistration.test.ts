import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../../server';
let mockReleasePhase = 'open';
jest.mock('../../lib/database', () => ({ databaseService: { client: {
  novaResourceClaim: { findFirst: jest.fn().mockResolvedValue(null) },
  $queryRaw: jest.fn().mockResolvedValue([{id:1}]),
  releaseAdmissionFence: {findUnique: jest.fn().mockImplementation(async () => ({id:1,phase:mockReleasePhase,generation:mockReleasePhase==='open'?0:1}))},
} } }));
import { registerNovaBookReadGrant, registerNovaCapabilitiesGrant, registerNovaGenerationCreateGrant, registerNovaGenerationReadGrant, registerNovaWorkflowPublishGrant, registerNovaWorkflowReadGrant, requireNovaResource, resolveNovaGrant, resolveNovaRecoveryGrant } from '../../api/middleware/novaGrant';
import type { AuthenticatedRequest } from '../../api/types';

const keys = generateKeyPairSync('ed25519');
const requestId = `nova-${'c'.repeat(32)}`;
const keyId = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const now = 1_750_000_000;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function signed(overrides: Record<string, unknown> = {}) {
  const unsigned = { version: 2, grant_id: 'grant-provider-observation', mission_id: 'mission-proser-one', mission_revision: 1,
    origin_task_id: 'senti-message-one', task_id: 'nova-task-one', request_id: requestId, caller: 'senti', audience: 'proser',
    owner_actor: 'service:ardent:nova', action_classes: [], issued_at: now, expires_at: now + 240,
    actions: ['capabilities.read'], resources: [], revoked: false, key_id: keyId, ...overrides };
  return { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), keys.privateKey).toString('base64url') };
}

let directory: string; let registry: string; let auditDir: string;
beforeEach(() => {
  mockReleasePhase = 'open';
  directory = mkdtempSync(join(tmpdir(), 'proser-nova-grant-'));
  chmodSync(directory, 0o700);
  registry = join(directory, 'registry.json');
  auditDir = join(directory, 'audit'); mkdirSync(auditDir, { mode: 0o700 });
  writeFileSync(registry, '{}\n', { mode: 0o600 });
  process.env.PROSER_NOVA_GRANTS_FILE = registry;
  process.env.PROSER_NOVA_GRANT_AUDIT_DIR = auditDir;
  process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});
afterEach(() => {
  delete process.env.PROSER_NOVA_GRANTS_FILE;
  delete process.env.PROSER_NOVA_GRANT_AUDIT_DIR;
  delete process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_PEM;
  delete process.env.PROSER_SERVICE_PRINCIPALS_JSON;
  rmSync(directory, { recursive: true, force: true });
});

test('registration route denies anonymous and wrong principal, then accepts the exact signed request', async () => {
  const token = `pnv_${'A'.repeat(43)}`;
  const principal = { sha256: createHash('sha256').update(token).digest('hex'), name: 'nova-creative',
    ownerGithubId: 'owner-one', scopes: ['content:read'], callers: ['senti'], expiresAt: '2099-01-01T00:00:00.000Z' };
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([principal]);
  const app = createApp();
  const current = Math.floor(Date.now() / 1000);
  const record = signed({ issued_at: current, expires_at: current + 240 });
  await request(app).post('/api/nova-grants/capabilities-read').send(record).expect(401);
  await request(app).post('/api/nova-grants/capabilities-read').set({ Authorization: 'Bearer pnv_' + 'B'.repeat(43),
    'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId }).send(record).expect(401);
  const headers = { Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId };
  await request(app).post('/api/nova-grants/capabilities-read').set(headers).send(record).expect(401);
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([{ ...principal, scopes: ['content:read', 'grant:register'] }]);
  const accepted = await request(app).post('/api/nova-grants/capabilities-read').set(headers).send(record).expect(201);
  expect(accepted.body).toMatchObject({ success: true, data: { grantId: 'grant-provider-observation', duplicate: false } });
  await request(app).post('/api/nova-grants/capabilities-read').set(headers).send(record).expect(200);
  await request(app).post('/api/nova-grants/capabilities-read').set(headers).send(signed({ issued_at: current, expires_at: current + 240, revoked: true })).expect(403);
});

test('closed admission fence denies new mutation grants while read-only grant renewal remains available', async () => {
  const token = `pnv_${'A'.repeat(43)}`;
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([{sha256:createHash('sha256').update(token).digest('hex'),name:'nova-creative',ownerGithubId:'owner-one',scopes:['content:read','grant:register'],callers:['senti'],expiresAt:'2099-01-01T00:00:00.000Z'}]);
  const current = Math.floor(Date.now()/1000);
  const headers = {Authorization:`Bearer ${token}`,'X-Nova-Caller':'senti','X-Nova-Request':requestId};
  const record = signed({issued_at:current,expires_at:current+240,actions:['generation.create','operations.read'],resources:['book:42'],action_classes:['create_draft'],owner_actor:'service:shared-resource:ardent-nova'});
  mockReleasePhase = 'fenced';
  const app = createApp();
  const blocked = await request(app).post('/api/nova-grants/generation-create').set(headers).send(record).expect(503);
  expect(blocked.body.error.code).toBe('DOCUMENT_ADMISSIONS_FENCED');
  expect(JSON.parse(readFileSync(registry,'utf8'))).toEqual({});
  await request(app).post('/api/nova-grants/capabilities-read').set(headers).send(signed({issued_at:current,expires_at:current+240})).expect(201);
});

test('registers one exact read-only signed request and reuses only identical bytes', () => {
  const record = signed();
  expect(registerNovaCapabilitiesGrant(record, 'senti', requestId, now)).toEqual({ grantId: record.grant_id, duplicate: false });
  expect(registerNovaCapabilitiesGrant(record, 'senti', requestId, now)).toEqual({ grantId: record.grant_id, duplicate: true });
  expect(resolveNovaGrant(requestId, 'senti', 'capabilities.read', now)).toMatchObject({ taskId: 'nova-task-one', originTaskId: 'senti-message-one' });
  expect(JSON.parse(readFileSync(registry, 'utf8'))).toEqual({ [requestId]: record });
  expect(() => registerNovaCapabilitiesGrant(signed({ expires_at: now + 180 }), 'senti', requestId, now)).toThrow(expect.objectContaining({ code: 'DELEGATION_CONFLICT' }));
});

test('book-read registration accepts only one exact book and cannot use the provider route', async () => {
  const token = `pnv_${'A'.repeat(43)}`;
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([{ sha256: createHash('sha256').update(token).digest('hex'),
    name: 'nova-creative', ownerGithubId: 'owner-one', scopes: ['content:read', 'grant:register'],
    callers: ['senti'], expiresAt: '2099-01-01T00:00:00.000Z' }]);
  const current = Math.floor(Date.now() / 1000);
  const record = signed({ issued_at: current, expires_at: current + 240, actions: ['books.read'], resources: ['book:42'] });
  const headers = { Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId };
  const app = createApp();
  await request(app).post('/api/nova-grants/capabilities-read').set(headers).send(record).expect(403);
  const accepted = await request(app).post('/api/nova-grants/books-read').set(headers).send(record).expect(201);
  expect(accepted.body).toMatchObject({ success: true, data: { grantId: record.grant_id, duplicate: false } });
  await request(app).post('/api/nova-grants/books-read').set(headers).send(record).expect(200);
  expect(resolveNovaGrant(requestId, 'senti', 'books.read', current).resources).toEqual(new Set(['book:42']));
  expect(() => resolveNovaGrant(requestId, 'senti', 'capabilities.read', current))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_ACTION_DENIED' }));
});

test.each([
  [['book:42', 'book:43'], 'DELEGATED_ACTION_DENIED'],
  [['new'], 'DELEGATED_ACTION_DENIED'],
  [[], 'DELEGATED_ACTION_DENIED'],
])('book registration denies a broader or missing resource', (resources, code) => {
  expect(() => registerNovaBookReadGrant(signed({ actions: ['books.read'], resources }), 'senti', requestId, now))
    .toThrow(expect.objectContaining({ code }));
});

test('generation status grant is exact and cannot read artifact bytes, lists, or a second operation', async () => {
  const operationId = 'f561e4a7-f2b9-4def-b87c-f2b5ec4487b8';
  const record = signed({ actions: ['generation.read'], resources: [`generation:${operationId}`] });
  expect(registerNovaGenerationReadGrant(record, 'senti', requestId, now).duplicate).toBe(false);
  const grant = resolveNovaGrant(requestId, 'senti', 'generation.read', now);
  const check = (method: string, originalUrl: string) => requireNovaResource({ method, originalUrl } as AuthenticatedRequest, grant);
  await expect(check('GET', `/api/generate/operations/${operationId}`)).resolves.toBeUndefined();
  await expect(check('GET', `/api/generate/operations/${operationId}/artifact`)).rejects.toMatchObject({ code: 'DELEGATED_RESOURCE_DENIED' });
  await expect(check('GET', '/api/generate/operations/unresolved')).rejects.toMatchObject({ code: 'DELEGATED_RESOURCE_DENIED' });
  await expect(check('GET', '/api/generate/operations/11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'DELEGATED_RESOURCE_DENIED' });
  expect(() => resolveNovaGrant(requestId, 'senti', 'books.read', now)).toThrow(expect.objectContaining({ code: 'DELEGATED_ACTION_DENIED' }));
});

test('generation status registration route requires the dedicated grant principal', async () => {
  const token = `pnv_${'A'.repeat(43)}`;
  const principal = { sha256: createHash('sha256').update(token).digest('hex'), name: 'nova-creative',
    ownerGithubId: 'owner-one', scopes: ['content:read'], callers: ['senti'], expiresAt: '2099-01-01T00:00:00.000Z' };
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([principal]);
  const current = Math.floor(Date.now() / 1000);
  const record = signed({ issued_at: current, expires_at: current + 240, actions: ['generation.read'],
    resources: ['generation:f561e4a7-f2b9-4def-b87c-f2b5ec4487b8'] });
  const headers = { Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId };
  const app = createApp();
  await request(app).post('/api/nova-grants/generation-read').set(headers).send(record).expect(401);
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([{ ...principal, scopes: ['content:read', 'grant:register'] }]);
  await request(app).post('/api/nova-grants/generation-read').set(headers).send(record).expect(201);
  await request(app).post('/api/nova-grants/books-read').set(headers).send(record).expect(403);
});

test('generation-create registration is bound to one book, action class and distinct owner actor', async () => {
  const token = `pnv_${'A'.repeat(43)}`;
  const principal = { sha256: createHash('sha256').update(token).digest('hex'), name: 'nova-creative',
    ownerGithubId: 'owner-one', scopes: ['content:read'], callers: ['senti'], expiresAt: '2099-01-01T00:00:00.000Z' };
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([principal]);
  const current = Math.floor(Date.now() / 1000);
  const base = { issued_at: current, expires_at: current + 240,
    actions: ['generation.create', 'operations.read'], resources: ['book:42'], action_classes: ['create_draft'],
    owner_actor: 'service:shared-resource:ardent-nova' };
  const record = signed(base);
  const headers = { Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId };
  const app = createApp();
  await request(app).post('/api/nova-grants/generation-create').set(headers).send(record).expect(401);
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([{ ...principal, scopes: ['content:read', 'grant:register'] }]);
  const accepted = await request(app).post('/api/nova-grants/generation-create').set(headers).send(record).expect(201);
  expect(accepted.body).toMatchObject({ success: true, data: { grantId: record.grant_id, duplicate: false } });
  await request(app).post('/api/nova-grants/generation-create').set(headers).send(record).expect(200);
  const grant = resolveNovaGrant(requestId, 'senti', 'generation.create', current);
  expect(grant).toMatchObject({ ownerActor: 'service:shared-resource:ardent-nova' });
  expect(grant.actions).toEqual(new Set(['generation.create', 'operations.read']));
  await expect(requireNovaResource({ method: 'POST', originalUrl: '/api/generate/operations', body: { bookId: 42 } } as AuthenticatedRequest, grant)).resolves.toBeUndefined();
  await expect(requireNovaResource({ method: 'POST', originalUrl: '/api/generate/operations', body: { bookId: 43 } } as AuthenticatedRequest, grant))
    .rejects.toMatchObject({ code: 'DELEGATED_RESOURCE_DENIED' });
  expect(resolveNovaRecoveryGrant(requestId, 'senti', 'operations.read')).toMatchObject({ requestId });
  for (const mutation of [
    { actions: ['generation.create'] },
    { resources: ['book:42', 'book:43'] },
    { action_classes: ['observe'] },
    { owner_actor: 'service:shared-resource:nova' },
  ]) {
    expect(() => registerNovaGenerationCreateGrant(signed({ ...base, ...mutation }), 'senti', requestId, current))
      .toThrow(expect.objectContaining({ code: 'DELEGATED_ACTION_DENIED' }));
  }
});

test('workflow publication registration is exact, short lived and separate from read and write scopes', async () => {
  const runId = '5ec31909-9caa-4d94-b6e7-265764101796';
  const token = `pnv_${'A'.repeat(43)}`;
  const principal = { sha256: createHash('sha256').update(token).digest('hex'), name: 'nova-creative',
    ownerGithubId: 'owner-one', scopes: ['content:read', 'content:write'], callers: ['senti'], expiresAt: '2099-01-01T00:00:00.000Z' };
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([principal]);
  const current = Math.floor(Date.now() / 1000);
  const base = { issued_at: current, expires_at: current + 240,
    actions: ['workflows.publish', 'workflows.read', 'operations.read'], resources: [`workflow:${runId}`],
    action_classes: ['external_publish'], owner_actor: 'service:shared-resource:ardent-nova' };
  const record = signed(base);
  const headers = { Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId };
  const app = createApp();
  await request(app).post('/api/nova-grants/workflow-publish').set(headers).send(record).expect(401);
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([{ ...principal, scopes: ['content:read', 'grant:register'] }]);
  await request(app).post('/api/nova-grants/workflow-publish').set(headers).send(record).expect(201);
  await request(app).post('/api/nova-grants/workflow-publish').set(headers).send(record).expect(200);
  await request(app).post('/api/nova-grants/books-read').set(headers).send(record).expect(403);
  const grant = resolveNovaGrant(requestId, 'senti', 'workflows.publish', current);
  expect(grant).toMatchObject({ originTaskId: 'senti-message-one', taskId: 'nova-task-one', requestId });
  expect(resolveNovaRecoveryGrant(requestId, 'senti', 'operations.read').resources).toEqual(new Set([`workflow:${runId}`]));
  const check = (method: string, originalUrl: string, body: unknown = {}) =>
    requireNovaResource({ method, originalUrl, body } as AuthenticatedRequest, grant);
  await expect(check('POST', `/api/workflows/${runId}/finalize`)).resolves.toBeUndefined();
  await expect(check('GET', `/api/workflows/${runId}`)).resolves.toBeUndefined();
  await expect(check('GET', `/api/workflows/${runId}/publication`)).resolves.toBeUndefined();
  for (const [method, path, body] of [
    ['POST', `/api/workflows/${runId}/finalize`, { decision: 'approved' }],
    ['POST', '/api/workflows/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/finalize', {}],
    ['POST', `/api/workflows/${runId}/checkpoints/checkpoint-one/decision`, { decision: 'approved' }],
    ['GET', `/api/workflows/${runId}/publication/book.epub`, {}],
    ['GET', '/api/workflows/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/publication', {}],
  ] as const) await expect(check(method, path, body)).rejects.toMatchObject({ code: 'DELEGATED_RESOURCE_DENIED' });
  expect(() => resolveNovaGrant(requestId, 'senti', 'books.read', current)).toThrow(expect.objectContaining({ code: 'DELEGATED_ACTION_DENIED' }));
  expect(() => resolveNovaGrant(requestId, 'archie', 'workflows.publish', current)).toThrow(expect.objectContaining({ code: 'DELEGATION_PRINCIPAL_MISMATCH' }));
  for (const mutation of [
    { actions: ['workflows.publish', 'operations.read'] },
    { resources: [`workflow:${runId}`, 'workflow:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
    { resources: ['book:84'] },
    { action_classes: ['create_draft'] },
    { owner_actor: 'service:shared-resource:nova' },
    { expires_at: current + 301 },
  ]) expect(() => registerNovaWorkflowPublishGrant(signed({ ...base, ...mutation }), 'senti', requestId, current))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_ACTION_DENIED' }));
});

test('separate workflow read grant observes only one workflow and its publication metadata', async () => {
  const runId = '5ec31909-9caa-4d94-b6e7-265764101796';
  const token = `pnv_${'A'.repeat(43)}`;
  const principal = { sha256: createHash('sha256').update(token).digest('hex'), name: 'nova-creative',
    ownerGithubId: 'owner-one', scopes: ['content:read'], callers: ['senti'], expiresAt: '2099-01-01T00:00:00.000Z' };
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([principal]);
  const current = Math.floor(Date.now() / 1000);
  const base = { issued_at: current, expires_at: current + 240,
    actions: ['workflows.read'], resources: [`workflow:${runId}`], action_classes: [], owner_actor: 'service:ardent:nova' };
  const record = signed(base);
  const headers = { Authorization: `Bearer ${token}`, 'X-Nova-Caller': 'senti', 'X-Nova-Request': requestId };
  const app = createApp();
  await request(app).post('/api/nova-grants/workflow-read').set(headers).send(record).expect(401);
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([{ ...principal, scopes: ['content:read', 'grant:register'] }]);
  await request(app).post('/api/nova-grants/workflow-read').set(headers).send(record).expect(201);
  await request(app).post('/api/nova-grants/workflow-read').set(headers).send(record).expect(200);
  await request(app).post('/api/nova-grants/workflow-publish').set(headers).send(record).expect(403);
  const grant = resolveNovaGrant(requestId, 'senti', 'workflows.read', current);
  const check = (method: string, path: string) => requireNovaResource({ method, originalUrl: path, body: {} } as AuthenticatedRequest, grant);
  await expect(check('GET', `/api/workflows/${runId}`)).resolves.toBeUndefined();
  await expect(check('GET', `/api/workflows/${runId}/publication`)).resolves.toBeUndefined();
  for (const [method, path] of [
    ['POST', `/api/workflows/${runId}/finalize`],
    ['GET', `/api/workflows/${runId}/publication/book.epub`],
    ['GET', '/api/workflows/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/publication'],
    ['GET', `/api/workflows/${runId}/checkpoints`],
  ]) await expect(check(method, path)).rejects.toMatchObject({ code: 'DELEGATED_RESOURCE_DENIED' });
  expect(() => resolveNovaGrant(requestId, 'senti', 'workflows.publish', current)).toThrow(expect.objectContaining({ code: 'DELEGATED_ACTION_DENIED' }));
  for (const mutation of [
    { actions: ['workflows.read', 'operations.read'] },
    { resources: [`workflow:${runId}`, 'workflow:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
    { resources: ['book:84'] },
    { action_classes: ['observe'] },
    { owner_actor: 'service:shared-resource:ardent-nova' },
    { expires_at: current + 301 },
  ]) expect(() => registerNovaWorkflowReadGrant(signed({ ...base, ...mutation }), 'senti', requestId, current))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_ACTION_DENIED' }));
});

test.each([
  [signed({ actions: ['books.read'] }), 'DELEGATED_ACTION_DENIED'],
  [signed({ expires_at: now + 301 }), 'DELEGATED_ACTION_DENIED'],
  [signed({ revoked: true }), 'DELEGATED_ACTION_DENIED'],
  [{ ...signed(), resources: ['book:42'] }, 'INVALID_DELEGATION_SIGNATURE'],
])('denies broader, expired, revoked or tampered registration', (record, code) => {
  expect(() => registerNovaCapabilitiesGrant(record, 'senti', requestId, now)).toThrow(expect.objectContaining({ code }));
});

test('denies a wrong caller and unsafe registry permissions', () => {
  expect(() => registerNovaCapabilitiesGrant(signed(), 'archie', requestId, now)).toThrow(expect.objectContaining({ code: 'DELEGATED_ACTION_DENIED' }));
  chmodSync(registry, 0o644);
  expect(() => registerNovaCapabilitiesGrant(signed(), 'senti', requestId, now)).toThrow(expect.objectContaining({ code: 'INVALID_DELEGATION_CONFIG' }));
});

test('archives expired live grants before pruning and keeps the request binding across calls', () => {
  const expiredId = `nova-${'d'.repeat(32)}`;
  const expired = signed({ request_id: expiredId, issued_at: now - 200, expires_at: now - 1 });
  writeFileSync(registry, JSON.stringify({ [expiredId]: expired }) + '\n');
  const current = signed();
  expect(registerNovaCapabilitiesGrant(current, 'senti', requestId, now).duplicate).toBe(false);
  expect(JSON.parse(readFileSync(registry, 'utf8'))).toEqual({ [requestId]: current });
  expect(JSON.parse(readFileSync(join(auditDir, `${expiredId}.json`), 'utf8'))).toEqual(expired);
  expect(resolveNovaRecoveryGrant(expiredId, 'senti', 'capabilities.read')).toMatchObject({ requestId: expiredId, taskId: 'nova-task-one' });
  expect(() => resolveNovaGrant(expiredId, 'senti', 'capabilities.read', now)).toThrow(expect.objectContaining({ code: 'DELEGATION_NOT_GRANTED' }));
  expect(registerNovaCapabilitiesGrant(current, 'senti', requestId, now).duplicate).toBe(true);
  expect(() => registerNovaCapabilitiesGrant(signed({ request_id: expiredId, grant_id: 'other-grant' }), 'senti', expiredId, now))
    .toThrow(expect.objectContaining({ code: 'DELEGATION_CONFLICT' }));
});

test('recovers capacity when all 256 live grants have expired', () => {
  const old = Object.fromEntries(Array.from({ length: 256 }, (_, index) => {
    const id = `nova-${index.toString(16).padStart(32, '0')}`;
    return [id, signed({ request_id: id, grant_id: `old-${index}`, issued_at: now - 200, expires_at: now - 1 })];
  }));
  writeFileSync(registry, JSON.stringify(old) + '\n');
  expect(registerNovaCapabilitiesGrant(signed(), 'senti', requestId, now).duplicate).toBe(false);
  expect(Object.keys(JSON.parse(readFileSync(registry, 'utf8')))).toEqual([requestId]);
  expect(readdirSync(auditDir)).toHaveLength(257);
});
