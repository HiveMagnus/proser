import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Response } from 'express';
import { Client } from 'pg';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { databaseService } from '@/lib/database';
import type { AuthenticatedRequest } from '@/api/types';
import type { NovaGrant } from '@/api/middleware/novaGrant';
import { generationReplayService, normalizedGenerationRequest } from '@/services/generationReplayService';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const resourceKey = z.string().min(5).max(260).regex(/^(?:repo:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*|provider:[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)*|gpu:[a-z0-9][a-z0-9._-]*)$/);
const resourceFence = z.object({ resourceKey, fenceGeneration: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict();
const caller = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct') }).strict(),
  z.object({ kind: z.literal('delegated'), delegationId: identifier }).strict(),
]);
const claimSchema = z.object({
  leaseId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), version: z.literal(1),
  resources: z.array(resourceFence).min(1).max(8), missionRootId: identifier,
  missionRevision: z.number().int().positive().max(2_147_483_647), taskId: identifier,
  operationId: identifier, requestSha256: digest,
  actionClass: z.enum(['observe', 'analyze', 'create_artifact', 'create_draft', 'reversible_change', 'deploy', 'external_publish', 'destructive_response']),
  deadline: z.number().int().positive().max(253_402_300_799), caller,
  ownerActor: identifier, evidenceDomain: z.literal('nova.provider-result.v1'),
}).strict().superRefine((value, context) => {
  if (new Set(value.resources.map((item) => item.resourceKey)).size !== value.resources.length) context.addIssue({ code: 'custom', message: 'Shared resource fences must be unique.' });
  if (value.resources.some((item, index) => index > 0 && (value.resources[index - 1]?.resourceKey ?? '') >= item.resourceKey)) context.addIssue({ code: 'custom', message: 'Shared resource fences must be canonical-sorted.' });
});

export type SharedResourceClaim = z.infer<typeof claimSchema> & { claimJson: string; claimSha256: string; selectedResourceKey: string };
type TerminalState = 'succeeded' | 'failed' | 'no_effect';
export type SharedResourceExecutionKind = 'workflow' | 'generation';
type SharedResourceDb = Pick<Prisma.TransactionClient, 'sharedResourceOperation' | 'sharedResourceFence'>;

export class SharedResourceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'SharedResourceError'; }
}

export function sharedResourceCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sharedResourceCanonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${sharedResourceCanonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const pathOf = (req: AuthenticatedRequest) => req.originalUrl.split('?')[0] || '';
function generationRequestIdentity(req: AuthenticatedRequest): { idempotencyKey: string; requestHash: string } | null {
  if (req.method !== 'POST' || pathOf(req) !== '/api/generate/operations') return null;
  const idempotencyKey = String(req.header('Idempotency-Key') ?? '').trim();
  if (!idempotencyKey || idempotencyKey.length > 200 || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new SharedResourceError('SHARED_RESOURCE_GENERATION_INVALID', 'Generation request identity is invalid.');
  }
  const { kind: _kind, ...request } = req.body as Record<string, unknown>;
  return { idempotencyKey, requestHash: normalizedGenerationRequest(request).hash };
}
const header = (req: AuthenticatedRequest, name: string) => {
  const value = req.headers[name] as string | undefined;
  if (!value) throw new SharedResourceError('SHARED_RESOURCE_CLAIM_REQUIRED', `Missing ${name}.`);
  return value;
};

export function parseSharedResourceClaim(req: AuthenticatedRequest, grant: NovaGrant, allowExpired = false): SharedResourceClaim {
  const encoded = header(req, 'x-magnus-fence-set');
  if (!/^[A-Za-z0-9_-]{1,32768}$/.test(encoded)) throw new SharedResourceError('INVALID_SHARED_RESOURCE_CLAIM', 'The shared resource claim encoding is invalid.');
  let claimJson: string;
  try { claimJson = Buffer.from(encoded, 'base64url').toString('utf8'); } catch { throw new SharedResourceError('INVALID_SHARED_RESOURCE_CLAIM', 'The shared resource claim encoding is invalid.'); }
  if (Buffer.from(claimJson).toString('base64url') !== encoded || Buffer.byteLength(claimJson) > 24 * 1024) throw new SharedResourceError('INVALID_SHARED_RESOURCE_CLAIM', 'The shared resource claim encoding is not canonical.');
  let raw: unknown;
  try { raw = JSON.parse(claimJson); } catch { throw new SharedResourceError('INVALID_SHARED_RESOURCE_CLAIM', 'The shared resource claim is not valid JSON.'); }
  const parsed = claimSchema.safeParse(raw);
  if (!parsed.success || sharedResourceCanonicalJson(parsed.data) !== claimJson) throw new SharedResourceError('INVALID_SHARED_RESOURCE_CLAIM', 'The shared resource claim is not exact canonical JSON.');
  const claimSha256 = sha256(claimJson);
  if (header(req, 'x-magnus-fence-set-sha256') !== claimSha256
      || header(req, 'x-magnus-lease-id') !== parsed.data.leaseId
      || header(req, 'x-magnus-operation-id') !== parsed.data.operationId
      || header(req, 'x-magnus-request-sha256') !== parsed.data.requestSha256
      || header(req, 'x-magnus-evidence-domain') !== parsed.data.evidenceDomain) {
    throw new SharedResourceError('INVALID_SHARED_RESOURCE_CLAIM', 'Shared resource headers do not match the canonical claim.');
  }
  const selectedResourceKey = header(req, 'x-magnus-resource-key');
  const selectedFence = header(req, 'x-magnus-fence-generation');
  if (!parsed.data.resources.some((item) => item.resourceKey === selectedResourceKey && item.fenceGeneration === selectedFence)) throw new SharedResourceError('INVALID_SHARED_RESOURCE_CLAIM', 'The selected provider fence is absent from the ordered claim.');
  if ((!allowExpired && parsed.data.deadline <= Math.floor(Date.now() / 1_000))
      || parsed.data.missionRootId !== grant.missionId || parsed.data.missionRevision !== grant.missionRevision
      || parsed.data.taskId !== grant.originTaskId || parsed.data.caller.kind !== 'delegated'
      || parsed.data.caller.delegationId !== grant.taskId || parsed.data.ownerActor !== grant.ownerActor
      || !grant.actionClasses.has(parsed.data.actionClass)) {
    throw new SharedResourceError('SHARED_RESOURCE_IDENTITY_MISMATCH', 'The shared resource claim does not match the active delegated grant.');
  }
  return { ...parsed.data, claimJson, claimSha256, selectedResourceKey };
}

async function resolveBookId(req: AuthenticatedRequest): Promise<string | null> {
  const path = pathOf(req); const body = req.body as Record<string, unknown> | undefined;
  const nested = body?.request && typeof body.request === 'object' && !Array.isArray(body.request) ? body.request as Record<string, unknown> : undefined;
  const pathBook = path.match(/^\/api\/books\/(\d+)(?:\/|$)/)?.[1];
  if (pathBook) return pathBook;
  const workflowId = path.match(/^\/api\/workflows\/([0-9a-f]{8}-[0-9a-f-]{27})(?:\/|$)/i)?.[1];
  if (workflowId) return String((await databaseService.client.workflowRun.findUnique({ where: { id: workflowId }, select: { bookId: true } }))?.bookId ?? '') || null;
  const codexId = path.match(/^\/api\/codex\/(\d+)/)?.[1];
  if (codexId) return String((await databaseService.client.codexEntry.findUnique({ where: { id: Number(codexId) }, select: { bookId: true } }))?.bookId ?? '') || null;
  const imageId = path.match(/^\/api\/images\/(\d+)/)?.[1];
  if (imageId) return String((await databaseService.client.imageAsset.findUnique({ where: { id: Number(imageId) }, select: { bookId: true } }))?.bookId ?? '') || null;
  const findingId = path.match(/^\/api\/findings\/([^/]+)/)?.[1];
  if (findingId) return String((await databaseService.client.qualityFinding.findUnique({ where: { id: findingId }, select: { reviewRun: { select: { bookId: true } } } }))?.reviewRun.bookId ?? '') || null;
  const reviewId = path.match(/^\/api\/reviews\/([^/]+)/)?.[1];
  if (reviewId) return String((await databaseService.client.qualityReviewRun.findUnique({ where: { id: reviewId }, select: { bookId: true } }))?.bookId ?? '') || null;
  const proposalId = path.match(/^\/api\/editorial\/proposals\/([^/]+)/)?.[1];
  if (proposalId) return String((await databaseService.client.editorialProposal.findUnique({ where: { id: proposalId }, select: { bookId: true } }))?.bookId ?? '') || null;
  const runId = path.match(/^\/api\/(?:editorial\/runs|editorial-runs)\/([^/]+)/)?.[1];
  if (runId) return String((await databaseService.client.editorialRun.findUnique({ where: { id: runId }, select: { bookId: true } }))?.bookId ?? '') || null;
  const bodyBook = String(body?.bookId ?? nested?.bookId ?? '');
  return /^\d+$/.test(bodyBook) ? bodyBook : null;
}

export async function resolveSharedResourceProviderKey(req: AuthenticatedRequest): Promise<string> {
  const path = pathOf(req);
  if (req.method === 'POST' && (path === '/api/books' || path === '/api/editorial/benchmarks'
      || path === '/api/workflows/full-book' && !((req.body as Record<string, unknown> | undefined)?.bookId))) return 'provider:new:proser';
  const bookId = await resolveBookId(req);
  if (bookId) return `provider:proser:${bookId}`;
  throw new SharedResourceError('SHARED_RESOURCE_IDENTITY_MISMATCH', 'The provider mutation cannot be mapped to one exact Proser resource.');
}

function normalizedJson(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new SharedResourceError('SHARED_RESOURCE_RESULT_INVALID', 'The provider response is not bounded JSON.');
  return JSON.parse(encoded) as unknown;
}

function signingKey() {
  const filename = process.env.PROSER_SHARED_RESOURCE_SIGNING_KEY_FILE?.trim() ?? '';
  const issuer = process.env.PROSER_SHARED_RESOURCE_SIGNING_ISSUER?.trim() || 'proser';
  if (!filename || !identifier.safeParse(issuer).success) throw new SharedResourceError('SHARED_RESOURCE_SIGNER_UNAVAILABLE', 'The provider terminal evidence signer is not configured.');
  try {
    const uid = process.getuid?.(); if (uid === undefined) throw new Error('owner unavailable');
    const status = lstatSync(filename); const parent = lstatSync(dirname(resolve(filename)));
    if (status.isSymbolicLink() || !status.isFile() || status.uid !== uid || status.nlink !== 1 || (status.mode & 0o077) !== 0 || status.size <= 0 || status.size > 16_384
        || parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0 || realpathSync(filename) !== resolve(filename)) throw new Error('unsafe key');
    const privateKey = createPrivateKey(readFileSync(filename)); if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong key');
    const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    return { issuer, keyId: createHash('sha256').update(publicDer).digest('hex'), privateKey };
  } catch { throw new SharedResourceError('SHARED_RESOURCE_SIGNER_UNAVAILABLE', 'The provider terminal evidence signer is unavailable.'); }
}

export async function assertSharedResourceOperationCurrent(
  operationId: string,
  db: SharedResourceDb = databaseService.client,
  requireRunning = false,
): Promise<void> {
  const operation = await db.sharedResourceOperation.findUnique({ where: { operationId } });
  if (!operation) throw new SharedResourceError('SHARED_RESOURCE_OPERATION_MISSING', 'The shared resource operation journal is missing.');
  if (requireRunning && operation.state !== 'running') {
    throw new SharedResourceError('SHARED_RESOURCE_OPERATION_ACTIVE', 'The shared resource execution is no longer running.');
  }
  const claim = claimSchema.parse(JSON.parse(operation.claimJson));
  for (const resource of claim.resources) {
    const fence = await db.sharedResourceFence.findUnique({ where: { resourceKey: resource.resourceKey } });
    if (fence?.operationId !== operationId || fence.highestGeneration !== BigInt(resource.fenceGeneration)) throw new SharedResourceError('SHARED_RESOURCE_FENCE_LOST', 'The shared resource operation was superseded before publication.');
  }
}

export async function sealSharedResourceOperation(
  operationId: string,
  state: TerminalState,
  responseStatus: number | null,
  response: unknown,
  completedAt = new Date(),
  db: SharedResourceDb = databaseService.client,
) {
  const operation = await db.sharedResourceOperation.findUnique({ where: { operationId } });
  if (!operation) throw new SharedResourceError('SHARED_RESOURCE_OPERATION_MISSING', 'The shared resource operation journal is missing.');
  if (operation.terminalEvidenceJson && operation.resultJson) return {
    evidence: JSON.parse(operation.terminalEvidenceJson) as Record<string, unknown>,
    resultRecord: JSON.parse(operation.resultJson) as Record<string, unknown>,
  };
  const claim = claimSchema.parse(JSON.parse(operation.claimJson)); const responseValue = normalizedJson(response);
  const responseJson = sharedResourceCanonicalJson(responseValue);
  const resultRecord = { domain: operation.evidenceDomain, operationId, claimSha256: operation.claimSha256, terminalState: state,
    result: { method: operation.method, route: operation.route, bodySha256: operation.bodySha256,
      responseStatus, responseSha256: sha256(responseJson), response: responseValue } };
  const evidenceSha256 = sha256(sharedResourceCanonicalJson(resultRecord)); const signer = signingKey();
  const unsigned = { version: claim.version, resources: claim.resources, missionRootId: claim.missionRootId,
    missionRevision: claim.missionRevision, taskId: claim.taskId, operationId: claim.operationId,
    requestSha256: claim.requestSha256, actionClass: claim.actionClass, deadline: claim.deadline,
    caller: claim.caller, ownerActor: claim.ownerActor, outcome: state, evidenceSha256,
    completedAt: Math.floor(completedAt.getTime() / 1_000), issuer: signer.issuer, keyId: signer.keyId };
  const payload = sharedResourceCanonicalJson({ domain: 'magnus.shared-resource-terminal.v1', ...unsigned });
  const evidence = { ...unsigned, signature: sign(null, Buffer.from(payload), signer.privateKey).toString('base64') };
  await db.sharedResourceOperation.update({ where: { operationId }, data: {
    state, responseStatus, responseJson, resultJson: sharedResourceCanonicalJson(resultRecord), evidenceSha256,
    terminalEvidenceJson: sharedResourceCanonicalJson(evidence), completedAt,
  } });
  return { evidence, resultRecord };
}

async function admit(claim: SharedResourceClaim, req: AuthenticatedRequest) {
  const method = req.method.toUpperCase(); const route = pathOf(req);
  const bodyJson = sharedResourceCanonicalJson(normalizedJson(req.body ?? null)); const bodySha256 = sha256(bodyJson);
  const generation = generationRequestIdentity(req);
  const prior = await databaseService.client.sharedResourceOperation.findUnique({ where: { operationId: claim.operationId } });
  if (prior) {
    if (prior.claimJson !== claim.claimJson || prior.claimSha256 !== claim.claimSha256 || prior.leaseId !== claim.leaseId
        || prior.requestSha256 !== claim.requestSha256 || prior.method !== method || prior.route !== route || prior.bodySha256 !== bodySha256
        || prior.generationIdempotencyKey !== (generation?.idempotencyKey ?? null)
        || prior.generationRequestHash !== (generation?.requestHash ?? null)) throw new SharedResourceError('SHARED_RESOURCE_REPLAY_CONFLICT', 'The operation ID is already bound to another exact claim or request.');
    return { row: prior, created: false } as const;
  }
  await databaseService.client.$transaction(async (tx) => {
    for (const resource of claim.resources) {
      const fence = await tx.sharedResourceFence.findUnique({ where: { resourceKey: resource.resourceKey } });
      if (fence && BigInt(resource.fenceGeneration) <= fence.highestGeneration) throw new SharedResourceError('SHARED_RESOURCE_FENCE_STALE', 'A shared resource fence is stale or already consumed.');
    }
    await tx.sharedResourceOperation.create({ data: { operationId: claim.operationId, leaseId: claim.leaseId,
      claimJson: claim.claimJson, claimSha256: claim.claimSha256, requestSha256: claim.requestSha256,
      evidenceDomain: claim.evidenceDomain, method, route, bodySha256,
      generationIdempotencyKey: generation?.idempotencyKey, generationRequestHash: generation?.requestHash } });
    for (const resource of claim.resources) await tx.sharedResourceFence.upsert({ where: { resourceKey: resource.resourceKey },
      create: { resourceKey: resource.resourceKey, highestGeneration: BigInt(resource.fenceGeneration), operationId: claim.operationId },
      update: { highestGeneration: BigInt(resource.fenceGeneration), operationId: claim.operationId } });
  });
  return { row: await databaseService.client.sharedResourceOperation.findUniqueOrThrow({ where: { operationId: claim.operationId } }), created: true } as const;
}

export async function bindSharedResourceExecution(
  db: SharedResourceDb,
  operationId: string,
  executionKind: SharedResourceExecutionKind,
  executionId: string,
): Promise<void> {
  await assertSharedResourceOperationCurrent(operationId, db);
  const operation = await db.sharedResourceOperation.findUnique({ where: { operationId } });
  if (!operation) throw new SharedResourceError('SHARED_RESOURCE_OPERATION_MISSING', 'The shared resource operation journal is missing.');
  if (operation.executionKind || operation.executionId) {
    if (operation.executionKind !== executionKind || operation.executionId !== executionId) {
      throw new SharedResourceError('SHARED_RESOURCE_REPLAY_CONFLICT', 'The operation is already bound to another durable execution.');
    }
    if (operation.state !== 'running') throw new SharedResourceError('SHARED_RESOURCE_OPERATION_ACTIVE', 'The bound operation is no longer running.');
    return;
  }
  if (operation.state !== 'admitted') throw new SharedResourceError('SHARED_RESOURCE_OPERATION_ACTIVE', 'The operation cannot be bound from its current state.');
  const existing = await db.sharedResourceOperation.findFirst({ where: { executionKind, executionId } });
  if (existing && existing.operationId !== operationId) {
    throw new SharedResourceError('SHARED_RESOURCE_REPLAY_CONFLICT', 'The durable execution is already bound to another operation.');
  }
  await db.sharedResourceOperation.update({ where: { operationId }, data: {
    executionKind, executionId, state: 'running', startedAt: new Date(),
  } });
}

/** Persist the exact Redis creation identity before crossing the database boundary. */
export async function bindSharedResourceGeneration(
  operationId: string,
  generationId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ created: boolean }> {
  if (!z.string().uuid().safeParse(generationId).success || !idempotencyKey || idempotencyKey.length > 200
      || !digest.safeParse(requestHash).success) {
    throw new SharedResourceError('SHARED_RESOURCE_GENERATION_INVALID', 'Generation binding is invalid.');
  }
  return databaseService.client.$transaction(async (tx) => {
    await assertSharedResourceOperationCurrent(operationId, tx);
    const operation = await tx.sharedResourceOperation.findUniqueOrThrow({ where: { operationId } });
    if (operation.executionKind) {
      if (operation.executionKind !== 'generation' || operation.executionId !== generationId
          || operation.generationIdempotencyKey !== idempotencyKey || operation.generationRequestHash !== requestHash) {
        throw new SharedResourceError('SHARED_RESOURCE_REPLAY_CONFLICT', 'Generation identity differs from the retained binding.');
      }
      if (operation.state !== 'running') throw new SharedResourceError('SHARED_RESOURCE_OPERATION_ACTIVE', 'Generation creation is already terminal.');
      return { created: false };
    }
    if (operation.state !== 'admitted') throw new SharedResourceError('SHARED_RESOURCE_OPERATION_ACTIVE', 'Generation cannot bind from its current state.');
    await tx.sharedResourceOperation.update({ where: { operationId }, data: {
      executionKind: 'generation', executionId: generationId,
      generationIdempotencyKey: idempotencyKey, generationRequestHash: requestHash,
      state: 'running', startedAt: new Date(),
    } });
    return { created: true };
  });
}

export async function sharedResourceExecutionOperation(
  executionKind: SharedResourceExecutionKind,
  executionId: string,
) {
  return databaseService.client.sharedResourceOperation.findFirst({ where: { executionKind, executionId } });
}

export async function finalizeSharedResourceExecution(
  executionKind: SharedResourceExecutionKind,
  executionId: string,
  state: Extract<TerminalState, 'succeeded' | 'failed'>,
  responseStatus: number,
  response: unknown,
) {
  const operation = await sharedResourceExecutionOperation(executionKind, executionId);
  if (!operation) return null;
  return sealSharedResourceOperation(operation.operationId, state, responseStatus, response);
}

function supportedDetachedMutation(path: string, method: string): boolean {
  if (method !== 'POST') return false;
  return /^\/api\/books\/[1-9]\d*\/revision-campaigns\/[a-f0-9-]{36}\/analyses$/.test(path) || path === '/api/generate/operations' || /^\/api\/workflows\/(?:quality-review|editorial-optimize)$/.test(path);
}

function unsupportedDetachedMutation(path: string, method: string): boolean {
  return method === 'POST' && /^\/api\/workflows\/(?:full-book|improve-quality|guided-improve)$/.test(path);
}

export async function acquireSharedResourceAuthorityLock(): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try { await client.query("SELECT pg_advisory_lock(hashtextextended('proser-shared-resource-authority-v1', 0))"); }
  catch (error) { await client.end().catch(() => undefined); throw error; }
  let released = false;
  return async () => { if (released) return; released = true; try { await client.query("SELECT pg_advisory_unlock(hashtextextended('proser-shared-resource-authority-v1', 0))"); } finally { await client.end(); } };
}

export async function beginSharedResourceMutation(req: AuthenticatedRequest, res: Response, next: () => void): Promise<void> {
  if (!req.novaGrant || ['GET', 'HEAD'].includes(req.method)) { next(); return; }
  const claim = parseSharedResourceClaim(req, req.novaGrant);
  if (req.method === 'POST' && pathOf(req) === '/api/generate/operations' && claim.actionClass !== 'create_draft') {
    throw new SharedResourceError('SHARED_RESOURCE_IDENTITY_MISMATCH', 'Delegated generation requires create_draft authority.');
  }
  const expected = await resolveSharedResourceProviderKey(req);
  if (claim.selectedResourceKey !== expected || !claim.resources.some((item) => item.resourceKey === expected)) throw new SharedResourceError('SHARED_RESOURCE_IDENTITY_MISMATCH', `The ordered claim does not contain the required ${expected} provider fence.`);
  const release = await acquireSharedResourceAuthorityLock();
  try {
    const admission = await admit(claim, req); const operation = admission.row;
    if (operation.terminalEvidenceJson) {
      const body = JSON.parse(operation.responseJson ?? 'null') as Record<string, unknown>;
      res.status(operation.responseStatus ?? 200).json(body && typeof body === 'object' && !Array.isArray(body) ? {
        ...body, sharedResourceResult: JSON.parse(operation.resultJson!), sharedResourceEvidence: JSON.parse(operation.terminalEvidenceJson),
      } : body);
      await release(); return;
    }
    if (pathOf(req) === '/api/generate/operations' && req.method === 'POST'
        && process.env.PROSER_DELEGATED_GENERATION_ENABLED !== 'true') {
      if (operation.state !== 'admitted') throw new SharedResourceError('SHARED_RESOURCE_OPERATION_ACTIVE', 'A generation dispatch is unresolved; recover its exact operation.');
      const response = { success: false, error: { code: 'SHARED_RESOURCE_ASYNC_UNSUPPORTED',
        message: 'Delegated generation remains disabled until the Ardent owner admission path is active.' } };
      const terminal = await sealSharedResourceOperation(claim.operationId, 'no_effect', 409, response);
      await release(); res.status(409).json({ ...response, sharedResourceResult: terminal.resultRecord, sharedResourceEvidence: terminal.evidence }); return;
    }
    if (!admission.created && operation.state === 'admitted' && !supportedDetachedMutation(pathOf(req), req.method)) {
      const response = { success: false, error: { code: 'SHARED_RESOURCE_NO_EFFECT', message: 'The prior admitted operation did not begin dispatch.' } };
      const terminal = await sealSharedResourceOperation(claim.operationId, 'no_effect', 409, response);
      res.status(409).json({ success: false, error: { code: 'SHARED_RESOURCE_NO_EFFECT', message: 'The prior admitted operation had no effect.' }, sharedResourceResult: terminal.resultRecord, sharedResourceEvidence: terminal.evidence });
      await release(); return;
    }
    const path = pathOf(req);
    if (supportedDetachedMutation(path, req.method)) {
      if (!['admitted', 'running'].includes(operation.state)) throw new SharedResourceError('SHARED_RESOURCE_OPERATION_ACTIVE', 'The exact operation cannot be resumed.');
      req.sharedResourceOperationId = claim.operationId;
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        void release().catch(() => undefined);
      };
      res.once('finish', releaseOnce);
      res.once('close', releaseOnce);
      next();
      return;
    }
    if (operation.state !== 'admitted') throw new SharedResourceError('SHARED_RESOURCE_OPERATION_ACTIVE', 'The exact operation is already running; recover it by operation ID.');
    if (unsupportedDetachedMutation(path, req.method)) {
      const message = 'This checkpoint-capable workflow remains disabled for shared-resource callers until continuation authority can transfer durably across later decisions.';
      const response = { success: false, error: { code: 'SHARED_RESOURCE_ASYNC_UNSUPPORTED', message } };
      const terminal = await sealSharedResourceOperation(claim.operationId, 'no_effect', 409, response);
      await release(); res.status(409).json({ ...response, sharedResourceResult: terminal.resultRecord, sharedResourceEvidence: terminal.evidence }); return;
    }
    req.sharedResourceOperationId = claim.operationId;
    await databaseService.client.sharedResourceOperation.update({ where: { operationId: claim.operationId }, data: { state: 'running', startedAt: new Date() } });
    const originalJson = res.json.bind(res); let finalized = false;
    res.json = ((body: unknown) => {
      if (finalized) return res; finalized = true;
      void (async () => {
        try {
          await assertSharedResourceOperationCurrent(claim.operationId);
          const normalized = normalizedJson(body); const status = res.statusCode >= 200 && res.statusCode < 300 ? 'succeeded' : 'failed';
          const terminal = await sealSharedResourceOperation(claim.operationId, status, res.statusCode, normalized);
          await release();
          const outgoing = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
            ? { ...(normalized as Record<string, unknown>), sharedResourceResult: terminal.resultRecord, sharedResourceEvidence: terminal.evidence } : normalized;
          originalJson(outgoing);
        } catch (error) {
          await release().catch(() => undefined);
          if (!res.headersSent) { res.status(500); originalJson({ success: false, error: { code: error instanceof SharedResourceError ? error.code : 'SHARED_RESOURCE_TERMINAL_FAILED', message: 'The fenced provider result could not be sealed.' } }); }
        }
      })();
      return res;
    }) as typeof res.json;
    next();
  } catch (error) { await release().catch(() => undefined); throw error; }
}

export async function sharedResourceOperationView(operationId: string, grant: NovaGrant, ownerUserId: number) {
  let row = await databaseService.client.sharedResourceOperation.findUnique({ where: { operationId } });
  if (!row) return null;
  const claim = claimSchema.parse(JSON.parse(row.claimJson));
  if (claim.missionRootId !== grant.missionId || claim.missionRevision !== grant.missionRevision
      || claim.taskId !== grant.originTaskId || claim.caller.kind !== 'delegated' || claim.caller.delegationId !== grant.taskId
      || claim.ownerActor !== grant.ownerActor || !grant.actionClasses.has(claim.actionClass)) throw new SharedResourceError('SHARED_RESOURCE_IDENTITY_MISMATCH', 'The operation is outside this signed recovery authority.');
  if (grant.actions.has('workflows.publish')) {
    const resource = [...grant.resources][0];
    const route = resource?.startsWith('workflow:') ? `/api/workflows/${resource.slice('workflow:'.length)}/finalize` : '';
    if (grant.resources.size !== 1 || claim.actionClass !== 'external_publish' || row.method !== 'POST' || row.route !== route)
      throw new SharedResourceError('SHARED_RESOURCE_IDENTITY_MISMATCH', 'The operation is outside the exact workflow publication authority.');
  }
  if (row.state === 'running' && row.executionKind === 'generation' && row.executionId) {
    const receipt = await generationReplayService.getForUser(row.executionId, ownerUserId);
    if (receipt) {
      if (receipt.idempotencyKey !== row.generationIdempotencyKey || receipt.requestHash !== row.generationRequestHash
          || receipt.route !== 'generate.prose') throw new SharedResourceError('SHARED_RESOURCE_REPLAY_CONFLICT', 'Redis generation receipt differs from the retained binding.');
      await sealSharedResourceOperation(operationId, 'succeeded', 202, { success: true, data: receipt });
      row = await databaseService.client.sharedResourceOperation.findUniqueOrThrow({ where: { operationId } });
    }
  }
  return { data: { operationId: row.operationId, state: row.state, method: row.method, route: row.route,
      generationOperationId: row.executionKind === 'generation' ? row.executionId : null,
      responseStatus: row.responseStatus, result: row.resultJson ? JSON.parse(row.resultJson) : null },
    ...(row.terminalEvidenceJson ? { sharedResourceEvidence: JSON.parse(row.terminalEvidenceJson) } : {}) };
}
