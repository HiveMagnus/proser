import { createHash, createPublicKey, verify } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuthenticatedRequest } from '../types';
import { databaseService } from '../../lib/database';

export const novaGrantActions = [
  'operations.read',
  'capabilities.read', 'books.read', 'books.create', 'books.write', 'codex.read', 'codex.write',
  'generation.read', 'generation.create', 'generation.control', 'images.read', 'images.create',
  'workflows.read', 'workflows.create', 'workflows.control', 'workflows.publish',
  'editorial.read', 'editorial.write',
] as const;
export type NovaGrantAction = typeof novaGrantActions[number];

const actionSet = new Set<string>(novaGrantActions);
const readActions = new Set<NovaGrantAction>([
  'operations.read', 'capabilities.read', 'books.read', 'codex.read', 'generation.read',
  'images.read', 'workflows.read', 'editorial.read',
]);
const sharedActionClasses = new Set(['observe', 'analyze', 'create_artifact', 'create_draft', 'reversible_change', 'deploy', 'external_publish', 'destructive_response']);
const callers = new Set(['operator', 'senti', 'archie', 'magnus', 'aegis']);
const requestPattern = /^nova-[a-f0-9]{32}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const resourcePattern = /^(?:new|(?:book|workflow|image|artifact|finding|review):[A-Za-z0-9][A-Za-z0-9._-]{0,159}|generation:[a-f0-9-]{36})$/;
const workflowResourcePattern = /^workflow:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class NovaGrantError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'NovaGrantError'; }
}

export type NovaGrant = {
  version: 2;
  grantId: string;
  missionId: string;
  missionRevision: number;
  originTaskId: string;
  taskId: string;
  requestId: string;
  caller: string;
  ownerActor: string;
  actionClasses: ReadonlySet<string>;
  issuedAt: number;
  expiresAt: number;
  actions: ReadonlySet<NovaGrantAction>;
  resources: ReadonlySet<string>;
};

type GrantRecord = Record<string, unknown>;
const signedKeys = ['version', 'grant_id', 'mission_id', 'mission_revision', 'origin_task_id', 'task_id', 'request_id', 'caller', 'audience', 'owner_actor', 'action_classes', 'issued_at', 'expires_at', 'actions', 'resources', 'revoked', 'key_id'] as const;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function configuredPublicKey(): { key: ReturnType<typeof createPublicKey>; keyId: string } {
  let pem = process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_PEM?.trim() ?? '';
  const filename = process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_FILE?.trim() ?? '';
  if (pem && filename) throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Configure one Nova grant public key source.');
  if (filename) {
    try {
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o022) !== 0) throw new Error('invalid key file');
      pem = readFileSync(filename, 'utf8');
    } catch { throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Nova grant public key is unavailable.'); }
  }
  if (!pem) throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Nova grant public key is not configured.');
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    const keyId = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
    return { key, keyId };
  } catch { throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Nova grant public key is invalid.'); }
}

function loadRegistry(): Record<string, GrantRecord> {
  let raw = process.env.PROSER_NOVA_GRANTS_JSON?.trim() ?? '';
  const filename = process.env.PROSER_NOVA_GRANTS_FILE?.trim() ?? '';
  if (raw && filename) throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Configure one Nova grant registry source.');
  if (filename) {
    try {
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('invalid registry file');
      raw = readFileSync(filename, 'utf8');
    } catch { throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Nova grant registry is unavailable.'); }
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 256
        || Object.values(parsed).some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('shape');
    return parsed as Record<string, GrantRecord>;
  } catch { throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Nova grant registry must be a bounded JSON object.'); }
}

function parseGrant(requestId: string, record: GrantRecord): NovaGrant {
  const allowed = new Set([...signedKeys, 'signature']);
  const actions = record.actions; const resources = record.resources; const classes = record.action_classes;
  if (!requestPattern.test(requestId) || record.version !== 2 || record.request_id !== requestId || record.audience !== 'proser'
      || typeof record.grant_id !== 'string' || !idPattern.test(record.grant_id)
      || typeof record.mission_id !== 'string' || !idPattern.test(record.mission_id)
      || !Number.isSafeInteger(record.mission_revision) || Number(record.mission_revision) < 1
      || typeof record.origin_task_id !== 'string' || !idPattern.test(record.origin_task_id)
      || typeof record.task_id !== 'string' || !idPattern.test(record.task_id)
      || typeof record.caller !== 'string' || !callers.has(record.caller)
      || !Number.isSafeInteger(record.issued_at) || !Number.isSafeInteger(record.expires_at)
      || Number(record.issued_at) >= Number(record.expires_at)
      || !Array.isArray(actions) || actions.length === 0 || actions.length > novaGrantActions.length
      || actions.some((item) => typeof item !== 'string' || !actionSet.has(item)) || new Set(actions).size !== actions.length
      || typeof record.owner_actor !== 'string' || !idPattern.test(record.owner_actor)
      || !Array.isArray(classes) || classes.length > sharedActionClasses.size
      || classes.some((item) => typeof item !== 'string' || !sharedActionClasses.has(item)) || new Set(classes).size !== classes.length
      || (classes.length === 0 && actions.some((item) => !readActions.has(item as NovaGrantAction)))
      || !Array.isArray(resources) || resources.length > 256
      || resources.some((item) => typeof item !== 'string' || !resourcePattern.test(item)) || new Set(resources).size !== resources.length
      || typeof record.revoked !== 'boolean' || typeof record.key_id !== 'string' || !/^[a-f0-9]{64}$/.test(record.key_id)
      || typeof record.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(record.signature)
      || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Nova provider grant is malformed.');
  }
  const { key, keyId } = configuredPublicKey();
  if (record.key_id !== keyId) throw new NovaGrantError('INVALID_DELEGATION_SIGNATURE', 'Nova provider grant key does not match the configured issuer.');
  const signed = Object.fromEntries(signedKeys.map((keyName) => [keyName, record[keyName]]));
  let signature: Buffer;
  try { signature = Buffer.from(record.signature, 'base64url'); } catch { throw new NovaGrantError('INVALID_DELEGATION_SIGNATURE', 'Nova provider grant signature is invalid.'); }
  if (!verify(null, Buffer.from(canonical(signed)), key, signature)) throw new NovaGrantError('INVALID_DELEGATION_SIGNATURE', 'Nova provider grant signature is invalid.');
  return {
    version: 2, grantId: record.grant_id, missionId: record.mission_id, missionRevision: Number(record.mission_revision),
    originTaskId: record.origin_task_id,
    taskId: record.task_id, requestId, caller: record.caller, issuedAt: Number(record.issued_at),
    ownerActor: record.owner_actor, actionClasses: new Set(classes as string[]),
    expiresAt: Number(record.expires_at), actions: new Set(actions as NovaGrantAction[]), resources: new Set(resources as string[]),
  };
}

/** Register one exact short-lived signed authority from Nova's dedicated issuer. */
function registerNovaScopedGrant(input: unknown, caller: string, requestId: string,
  action: 'capabilities.read' | 'books.read' | 'generation.read' | 'generation.create' | 'workflows.read' | 'workflows.publish', now: number): { grantId: string; duplicate: boolean } {
  if (!requestPattern.test(requestId) || !callers.has(caller) || !input || typeof input !== 'object' || Array.isArray(input))
    throw new NovaGrantError('INVALID_DELEGATION', 'Nova grant registration identity is invalid.');
  const record = input as GrantRecord;
  const grant = parseGrant(requestId, record);
  const exactResource = action === 'capabilities.read' ? grant.resources.size === 0
    : action === 'books.read' ? grant.resources.size === 1 && [...grant.resources].every((resource) =>
      /^book:[1-9]\d*$/.test(resource) && Number.isSafeInteger(Number(resource.slice(5))))
      : action === 'generation.create' ? grant.resources.size === 1 && [...grant.resources].every((resource) =>
        /^book:[1-9]\d*$/.test(resource) && Number.isSafeInteger(Number(resource.slice(5))))
      : action === 'workflows.read' || action === 'workflows.publish'
        ? grant.resources.size === 1 && [...grant.resources].every((resource) => workflowResourcePattern.test(resource))
      : grant.resources.size === 1 && [...grant.resources].every((resource) =>
        /^generation:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(resource));
  const exactActions = action === 'generation.create'
    ? grant.actions.size === 2 && grant.actions.has('generation.create') && grant.actions.has('operations.read')
    : action === 'workflows.publish'
      ? grant.actions.size === 3 && grant.actions.has('workflows.publish') && grant.actions.has('workflows.read') && grant.actions.has('operations.read')
    : grant.actions.size === 1 && grant.actions.has(action);
  const exactClasses = action === 'generation.create' || action === 'workflows.publish'
    ? grant.actionClasses.size === 1
      && grant.actionClasses.has(action === 'generation.create' ? 'create_draft' : 'external_publish')
      && grant.ownerActor === 'service:shared-resource:ardent-nova'
    : grant.actionClasses.size === 0 && (action !== 'workflows.read' || grant.ownerActor === 'service:ardent:nova');
  if (grant.caller !== caller || record.revoked !== false || grant.issuedAt > now + 30 || grant.expiresAt <= now || grant.expiresAt > now + 300
      || !exactActions || !exactResource || !exactClasses)
    throw new NovaGrantError('DELEGATED_ACTION_DENIED', 'Only the exact short-lived Nova authority may be registered.');
  if (process.env.PROSER_NOVA_GRANTS_JSON?.trim()) throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Live registration requires a private registry file.');
  const filename = process.env.PROSER_NOVA_GRANTS_FILE?.trim() ?? '';
  const auditDir = process.env.PROSER_NOVA_GRANT_AUDIT_DIR?.trim() ?? '';
  if (!filename.startsWith('/') || !auditDir.startsWith('/')) throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Private Nova grant registry or audit is unavailable.');
  let parent; let file; let auditParent;
  try { parent = lstatSync(dirname(filename)); file = lstatSync(filename); auditParent = lstatSync(auditDir); }
  catch { throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Private Nova grant registry is unavailable.'); }
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()
      || !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.()
      || !auditParent.isDirectory() || auditParent.isSymbolicLink() || (auditParent.mode & 0o077) !== 0 || auditParent.uid !== process.getuid?.())
    throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Private Nova grant registry ownership is invalid.');
  const registry = loadRegistry();
  const audit = (id: string, value: GrantRecord): void => {
    if (!requestPattern.test(id)) throw new NovaGrantError('INVALID_DELEGATION_CONFIG', 'Invalid audit request identity.');
    const path = join(auditDir, `${id}.json`);
    const encoded = JSON.stringify(value) + '\n';
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()
          || readFileSync(path, 'utf8') !== encoded)
        throw new NovaGrantError('DELEGATION_CONFLICT', 'Nova request has different retained authority.');
      return;
    } catch (error) {
      if (error instanceof NovaGrantError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, encoded, 'utf8'); fsyncSync(fd); }
    finally { closeSync(fd); }
    const directory = openSync(auditDir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  const previous = registry[requestId];
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(record)) throw new NovaGrantError('DELEGATION_CONFLICT', 'Nova request is already registered with different authority.');
    audit(requestId, previous);
    return { grantId: grant.grantId, duplicate: true };
  }
  for (const [id, previousRecord] of Object.entries(registry)) {
    const prior = parseGrant(id, previousRecord);
    if (prior.expiresAt <= now && previousRecord.revoked === false) {
      audit(id, previousRecord);
      delete registry[id];
    }
  }
  if (Object.keys(registry).length >= 256) throw new NovaGrantError('DELEGATION_REGISTRY_FULL', 'Nova grant registry is full.');
  // A retained audit record prevents reusing an expired request ID with different authority.
  audit(requestId, record);
  const temporary = join(dirname(filename), `.nova-grants-${process.pid}-${Date.now()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify({ ...registry, [requestId]: record }) + '\n', 'utf8');
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, filename);
    const directory = openSync(dirname(filename), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* Rename may already have completed. */ }
    throw error;
  }
  return { grantId: grant.grantId, duplicate: false };
}

export function registerNovaCapabilitiesGrant(input: unknown, caller: string, requestId: string, now = Math.floor(Date.now() / 1000)): { grantId: string; duplicate: boolean } {
  return registerNovaScopedGrant(input, caller, requestId, 'capabilities.read', now);
}

export function registerNovaBookReadGrant(input: unknown, caller: string, requestId: string, now = Math.floor(Date.now() / 1000)): { grantId: string; duplicate: boolean } {
  return registerNovaScopedGrant(input, caller, requestId, 'books.read', now);
}

export function registerNovaGenerationReadGrant(input: unknown, caller: string, requestId: string, now = Math.floor(Date.now() / 1000)): { grantId: string; duplicate: boolean } {
  return registerNovaScopedGrant(input, caller, requestId, 'generation.read', now);
}

export function registerNovaGenerationCreateGrant(input: unknown, caller: string, requestId: string, now = Math.floor(Date.now() / 1000)): { grantId: string; duplicate: boolean } {
  return registerNovaScopedGrant(input, caller, requestId, 'generation.create', now);
}

export function registerNovaWorkflowPublishGrant(input: unknown, caller: string, requestId: string, now = Math.floor(Date.now() / 1000)): { grantId: string; duplicate: boolean } {
  return registerNovaScopedGrant(input, caller, requestId, 'workflows.publish', now);
}

export function registerNovaWorkflowReadGrant(input: unknown, caller: string, requestId: string, now = Math.floor(Date.now() / 1000)): { grantId: string; duplicate: boolean } {
  return registerNovaScopedGrant(input, caller, requestId, 'workflows.read', now);
}

export function resolveNovaGrant(requestId: string, caller: string, action: NovaGrantAction, now = Math.floor(Date.now() / 1000)): NovaGrant {
  if (!requestPattern.test(requestId) || !callers.has(caller)) throw new NovaGrantError('INVALID_DELEGATION', 'Nova caller or request identity is invalid.');
  const record = loadRegistry()[requestId];
  if (!record) throw new NovaGrantError('DELEGATION_NOT_GRANTED', 'No signed provider grant exists for this request.');
  const grant = parseGrant(requestId, record);
  if (record.revoked) throw new NovaGrantError('DELEGATION_REVOKED', 'The provider grant has been revoked.');
  if (grant.caller !== caller) throw new NovaGrantError('DELEGATION_PRINCIPAL_MISMATCH', 'The provider grant belongs to another caller.');
  if (grant.issuedAt > now + 30) throw new NovaGrantError('DELEGATION_NOT_YET_VALID', 'The provider grant is not yet valid.');
  if (grant.expiresAt <= now) throw new NovaGrantError('DELEGATION_EXPIRED', 'The provider grant has expired.');
  if (!grant.actions.has(action)) throw new NovaGrantError('DELEGATED_ACTION_DENIED', 'The provider grant does not allow this action.');
  return grant;
}

/** Verify the immutable signed identity for operation recovery after expiry/revocation. */
export function resolveNovaRecoveryGrant(requestId: string, caller: string, action: NovaGrantAction): NovaGrant {
  if (!requestPattern.test(requestId) || !callers.has(caller)) throw new NovaGrantError('INVALID_DELEGATION', 'Nova caller or request identity is invalid.');
  let record = loadRegistry()[requestId];
  if (!record) {
    const auditDir = process.env.PROSER_NOVA_GRANT_AUDIT_DIR?.trim() ?? '';
    if (auditDir.startsWith('/')) {
      try {
        const parent = lstatSync(auditDir);
        const filename = join(auditDir, `${requestId}.json`);
        const file = lstatSync(filename);
        if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0
            || !file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0
            || file.size <= 0 || file.size > 32_768) throw new Error('unsafe audit');
        const parsed = JSON.parse(readFileSync(filename, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid audit');
        record = parsed as GrantRecord;
      } catch { /* No retained signed recovery authority. */ }
    }
  }
  if (!record) throw new NovaGrantError('DELEGATION_NOT_GRANTED', 'No signed provider grant exists for this request.');
  const grant = parseGrant(requestId, record);
  if (grant.caller !== caller) throw new NovaGrantError('DELEGATION_PRINCIPAL_MISMATCH', 'The provider grant belongs to another caller.');
  if (!grant.actions.has(action)) throw new NovaGrantError('DELEGATED_ACTION_DENIED', 'The provider grant does not allow this recovery action.');
  return grant;
}

export function novaAction(method: string, pathname: string, _body: unknown): NovaGrantAction {
  const read = ['GET', 'HEAD'].includes(method);
  if (method === 'GET' && /^\/api\/shared-resource-operations\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(pathname)) return 'operations.read';
  if (/^\/api\/(?:models|ollama)(?:\/|$)/.test(pathname)) return 'capabilities.read';
  if (pathname === '/api/images/health' || pathname === '/api/image/health') return 'capabilities.read';
  if (/^\/api\/workflows(?:\/|$)/.test(pathname)) {
    if (/\/(?:finalize|decision)$/.test(pathname)) return 'workflows.publish';
    if (/\/workflows\/[^/]+\/(?:pause|resume|cancel)$/.test(pathname)) return 'workflows.control';
    return read ? 'workflows.read' : 'workflows.create';
  }
  if (/^\/api\/(?:reviews|findings|editorial|editorial-runs)(?:\/|$)/.test(pathname)) return read ? 'editorial.read' : 'editorial.write';
  if (/^\/api\/codex(?:\/|$)/.test(pathname) || /^\/api\/books\/\d+\/codex(?:\/|$)/.test(pathname)) return read ? 'codex.read' : 'codex.write';
  if (/^\/api\/generate(?:\/|$)/.test(pathname)) return /\/cancel$/.test(pathname) ? 'generation.control' : read ? 'generation.read' : 'generation.create';
  if (/^\/api\/images(?:\/|$)/.test(pathname)) return read ? 'images.read' : 'images.create';
  if (pathname === '/api/books' && method === 'POST') return 'books.create';
  if (/^\/api\/books(?:\/|$)/.test(pathname)) return read ? 'books.read' : 'books.write';
  if (/\/workflows\/[^/]+\/(?:pause|resume|cancel)$/.test(pathname)) return 'workflows.control';
  throw new NovaGrantError('DELEGATED_ACTION_DENIED', 'This service route has no Nova grant action.');
}

function resourceAllowed(grant: NovaGrant, kind: string, id: string): boolean {
  return grant.resources.has(`${kind}:${id}`);
}

async function claimed(grant: NovaGrant, kind: string, id: string): Promise<boolean> {
  return Boolean(await databaseService.client.novaResourceClaim.findFirst({ where: { kind, resourceId: id, requestId: grant.requestId, caller: grant.caller } }));
}

export async function requireNovaResource(req: AuthenticatedRequest, grant: NovaGrant): Promise<void> {
  const path = req.originalUrl.split('?')[0] || '';
  if (novaAction(req.method, path, req.body) === 'capabilities.read') return;
  if (grant.actions.size === 1 && grant.actions.has('generation.read')) {
    const operation = req.method === 'GET' ? path.match(/^\/api\/generate\/operations\/([a-f0-9-]{36})$/)?.[1] : undefined;
    if (operation && grant.resources.size === 1 && grant.resources.has(`generation:${operation}`)) return;
    throw new NovaGrantError('DELEGATED_RESOURCE_DENIED', 'The signed grant permits only the exact generation status receipt.');
  }
  if ((grant.actions.size === 1 && grant.actions.has('workflows.read'))
      || (grant.actions.size === 3 && grant.actions.has('workflows.publish') && grant.actions.has('workflows.read') && grant.actions.has('operations.read'))) {
    const resource = [...grant.resources][0];
    const workflow = resource && workflowResourcePattern.test(resource) ? resource.slice('workflow:'.length) : '';
    const base = workflow ? `/api/workflows/${workflow}` : '';
    const read = req.method === 'GET' && (path === base || path === `${base}/publication`);
    const publish = grant.actions.has('workflows.publish') && req.method === 'POST' && path === `${base}/finalize`
      && req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)
      && Object.keys(req.body as Record<string, unknown>).length === 0;
    if (read || publish) return;
    throw new NovaGrantError('DELEGATED_RESOURCE_DENIED', 'The signed grant permits only the exact workflow status, publication metadata, and final release approval.');
  }
  const body = req.body as Record<string, unknown> | undefined;
  const nestedRequest = body?.request && typeof body.request === 'object' && !Array.isArray(body.request) ? body.request as Record<string, unknown> : undefined;
  const queryBook = typeof req.query?.bookId === 'string' ? req.query.bookId : '';
  let bookId = String(body?.bookId ?? nestedRequest?.bookId ?? queryBook);
  const pathBook = path.match(/^\/api\/books\/(\d+)(?:\/|$)/)?.[1];
  if (pathBook) bookId = pathBook;
  const runId = path.match(/^\/api\/(?:workflows|editorial-runs)\/([^/]+)/)?.[1];
  if (!bookId && runId) bookId = String((await databaseService.client.workflowRun.findUnique({ where: { id: runId }, select: { bookId: true } }))?.bookId ?? '');
  const imageId = path.match(/^\/api\/images\/(\d+)(?:\/|$)/)?.[1];
  if (!bookId && imageId) {
    const image = await databaseService.client.imageAsset.findUnique({ where: { id: Number(imageId) }, select: { bookId: true } });
    if (image?.bookId) bookId = String(image.bookId);
    else if (resourceAllowed(grant, 'image', imageId) || await claimed(grant, 'image', imageId)) return;
  }
  const codexId = path.match(/^\/api\/codex\/(\d+)(?:\/|$)/)?.[1];
  if (!bookId && codexId) bookId = String((await databaseService.client.codexEntry.findUnique({ where: { id: Number(codexId) }, select: { bookId: true } }))?.bookId ?? '');
  const findingId = path.match(/^\/api\/findings\/([^/]+)/)?.[1];
  if (!bookId && findingId) {
    const finding = await databaseService.client.qualityFinding.findUnique({ where: { id: findingId }, select: { reviewRun: { select: { bookId: true } } } });
    bookId = String(finding?.reviewRun.bookId ?? '');
  }
  const reviewId = path.match(/^\/api\/reviews\/([^/]+)/)?.[1];
  if (!bookId && reviewId) bookId = String((await databaseService.client.qualityReviewRun.findUnique({ where: { id: reviewId }, select: { bookId: true } }))?.bookId ?? '');
  const proposalId = path.match(/^\/api\/editorial\/proposals\/([^/]+)/)?.[1];
  if (!bookId && proposalId) bookId = String((await databaseService.client.editorialProposal.findUnique({ where: { id: proposalId }, select: { bookId: true } }))?.bookId ?? '');
  const editorialRunId = path.match(/^\/api\/(?:editorial\/runs|editorial-runs)\/([^/]+)/)?.[1];
  if (!bookId && editorialRunId) bookId = String((await databaseService.client.editorialRun.findUnique({ where: { id: editorialRunId }, select: { bookId: true } }))?.bookId ?? '');
  if (bookId) {
    if (resourceAllowed(grant, 'book', bookId) || await claimed(grant, 'book', bookId)) return;
    throw new NovaGrantError('DELEGATED_RESOURCE_DENIED', 'The provider grant does not allow this book or a verified related resource.');
  }
  const action = novaAction(req.method, path, req.body);
  if (action === 'books.create' || (action === 'workflows.create' && !bookId)
      || (action === 'editorial.write' && path === '/api/editorial/benchmarks')
      || (!['GET', 'HEAD'].includes(req.method) && /^\/api\/(?:generate|images)(?:\/|$)/.test(path) && !bookId)) {
    if (grant.resources.has('new')) return;
    throw new NovaGrantError('DELEGATED_RESOURCE_DENIED', 'The provider grant does not allow creating an unbound resource.');
  }
  // Bounded catalogue routes filter their output; static metadata needs only its exact action.
  if (path === '/api/books' || path === '/api/images/list' || /^\/api\/(?:editorial\/pass-packs|prompts)(?:\/|$)/.test(path)) return;
  throw new NovaGrantError('DELEGATED_RESOURCE_DENIED', 'The provider resource cannot be related to this grant.');
}

export async function claimNovaResource(req: AuthenticatedRequest, kind: string, resourceId: string | number): Promise<void> {
  const grant = req.novaGrant;
  if (!grant) return;
  // Explicit resources remain shareable across separately authorized missions;
  // only newly created/request-owned resources enter the exclusive claim table.
  if (grant.resources.has(`${kind}:${String(resourceId)}`)) return;
  await databaseService.client.novaResourceClaim.upsert({
    where: { kind_resourceId: { kind, resourceId: String(resourceId) } },
    create: { kind, resourceId: String(resourceId), requestId: grant.requestId, caller: grant.caller, grantId: grant.grantId },
    update: {},
  });
  const owner = await databaseService.client.novaResourceClaim.findUnique({ where: { kind_resourceId: { kind, resourceId: String(resourceId) } } });
  if (!owner || owner.requestId !== grant.requestId || owner.caller !== grant.caller) throw new NovaGrantError('DELEGATED_RESOURCE_CONFLICT', 'The created resource is already owned by another request.');
}

export async function novaVisibleBookIds(req: AuthenticatedRequest): Promise<number[] | undefined> {
  const grant = req.novaGrant;
  if (!grant) return undefined;
  const explicit = [...grant.resources].flatMap((value) => /^book:(\d+)$/.exec(value)?.[1] ?? []).map(Number);
  const owned = await databaseService.client.novaResourceClaim.findMany({ where: { requestId: grant.requestId, caller: grant.caller, kind: 'book' }, select: { resourceId: true }, take: 256 });
  return [...new Set([...explicit, ...owned.map((item) => Number(item.resourceId)).filter(Number.isSafeInteger)])];
}

export async function novaVisibleResourceIds(req: AuthenticatedRequest, kind: 'image'): Promise<number[] | undefined> {
  const grant = req.novaGrant;
  if (!grant) return undefined;
  const explicit = [...grant.resources].flatMap((value) => new RegExp(`^${kind}:(\\d+)$`).exec(value)?.[1] ?? []).map(Number);
  const owned = await databaseService.client.novaResourceClaim.findMany({ where: { requestId: grant.requestId, caller: grant.caller, kind }, select: { resourceId: true }, take: 256 });
  return [...new Set([...explicit, ...owned.map((item) => Number(item.resourceId)).filter(Number.isSafeInteger)])];
}
