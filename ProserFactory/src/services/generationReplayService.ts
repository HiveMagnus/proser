import {admitReleaseMutation,bindReleaseAdmission,withReleaseAdmission,releaseAdmissionsOpen} from '@/operations/releaseAdmission';
import {databaseService} from '@/lib/database';
import { createHash, randomUUID } from 'node:crypto';

import redis from '../lib/redis';
import { recordGenerationAdmissionRecovery } from '../metrics/generationOperations';

export type GenerationOperationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface GenerationReplayEvent {
  cursor: number;
  event: string;
  data: Record<string, unknown>;
}

export interface GenerationOperationReceipt {
  operationId: string;
  idempotencyKey: string;
  requestHash: string;
  route: string;
  status: GenerationOperationStatus;
  createdAt: string;
  updatedAt: string;
  latestCursor: number;
  artifactHash?: string;
  errorCode?: string;
}

interface StoredOperation extends GenerationOperationReceipt {
  userId: number;
  requestJson: string;
  cancelRequested: boolean;
  pendingExpiresAt: number;
  absoluteExpiresAt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  provisionalArtifactHash?: string;
}

export class ReplayCursorExpiredError extends Error {
  constructor(public readonly oldestCursor: number) {
    super(`Replay cursor expired; oldest available cursor is ${oldestCursor}`);
    this.name = 'ReplayCursorExpiredError';
  }
}

export class GenerationQuotaError extends Error {
  constructor(public readonly scope: 'user' | 'global') {
    super(`Generation ${scope} active-operation quota reached`);
    this.name = 'GenerationQuotaError';
  }
}

export class GenerationIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used with a different generation request');
    this.name = 'GenerationIdempotencyConflictError';
  }
}

export class GenerationOutputLimitError extends Error {
  constructor() {
    super('Generation exceeded its per-operation byte ceiling');
    this.name = 'GenerationOutputLimitError';
  }
}

const integerConfig = (name: string, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
};

const key = (suffix: string) => `proser:generation:v2:${suffix}`;
const operationKey = (operationId: string) => key(`operation:${operationId}`);
const eventKey = (operationId: string) => key(`events:${operationId}`);
const artifactKey = (operationId: string) => key(`artifact:${operationId}`);
const provisionalArtifactKey = (operationId: string) => key(`artifact:${operationId}:provisional`);
const userOperationsKey = (userId: number) => key(`user:${userId}:operations`);
const userActiveKey = (userId: number) => key(`user:${userId}:active`);
const idempotencyKey = (userId: number, value: string) =>
  key(`user:${userId}:idempotency:${createHash('sha256').update(value).digest('hex')}`);
const globalActiveKey = key('active');
const globalRunningKey = key('running');
const pendingKey = key('pending');

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, item]) => [entryKey, canonicalize(item)]),
    );
  }
  return value;
}

export function normalizedGenerationRequest(request: Record<string, unknown>): {
  json: string;
  hash: string;
} {
  const json = JSON.stringify(canonicalize(request));
  return { json, hash: createHash('sha256').update(json).digest('hex') };
}

function parseStoredOperation(raw: Record<string, string>): StoredOperation | null {
  if (!raw.id || !raw.userId || !raw.status) return null;
  return {
    operationId: raw.id,
    userId: Number(raw.userId),
    idempotencyKey: raw.idempotencyKey,
    requestHash: raw.requestHash,
    requestJson: raw.requestJson,
    route: raw.route,
    status: raw.status as GenerationOperationStatus,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    latestCursor: Number(raw.latestCursor || 0),
    artifactHash: raw.artifactHash || undefined,
    errorCode: raw.errorCode || undefined,
    cancelRequested: raw.cancelRequested === '1',
    pendingExpiresAt: Number(raw.pendingExpiresAt || 0),
    absoluteExpiresAt: Number(raw.absoluteExpiresAt || 0),
    leaseOwner: raw.leaseOwner || undefined,
    leaseExpiresAt: raw.leaseExpiresAt ? Number(raw.leaseExpiresAt) : undefined,
    provisionalArtifactHash: raw.provisionalArtifactHash || undefined,
  };
}

function publicReceipt(operation: StoredOperation): GenerationOperationReceipt {
  const {
    operationId, idempotencyKey: operationIdempotencyKey, requestHash, route, status,
    createdAt, updatedAt, latestCursor, artifactHash, errorCode,
  } = operation;
  return {
    operationId,
    idempotencyKey: operationIdempotencyKey,
    requestHash,
    route,
    status,
    createdAt,
    updatedAt,
    latestCursor,
    artifactHash,
    errorCode,
  };
}

export class GenerationReplayService {
  readonly instanceId = randomUUID();

  get maxReplayEvents(): number {
    return integerConfig('GENERATION_REPLAY_LIMIT', 500, 1, 2_000);
  }
  get maxReplayBytes(): number {
    return integerConfig('GENERATION_REPLAY_MAX_BYTES', 2 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024);
  }
  get maxOutputBytes(): number {
    return integerConfig('GENERATION_OPERATION_MAX_BYTES', 2 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024);
  }
  get maxUserActive(): number {
    return integerConfig('GENERATION_MAX_ACTIVE_PER_USER', 2, 1, 20);
  }
  get maxGlobalActive(): number {
    return integerConfig('GENERATION_MAX_ACTIVE_GLOBAL', 12, 1, 200);
  }
  get maxConcurrency(): number {
    return integerConfig('GENERATION_MAX_CONCURRENT', 2, 1, 32);
  }
  get leaseMs(): number {
    return integerConfig('GENERATION_OPERATION_LEASE_MS', 300_000, 30_000, 1_800_000);
  }
  get maxPendingMs(): number {
    return integerConfig('GENERATION_OPERATION_MAX_PENDING_MS', 3_600_000, 60_000, 86_400_000);
  }
  get maxLifetimeMs(): number {
    return integerConfig('GENERATION_OPERATION_MAX_LIFETIME_MS', 21_600_000, 300_000, 86_400_000);
  }
  private get replayTtlSeconds(): number {
    return Math.ceil(integerConfig('GENERATION_REPLAY_TTL_MS', 900_000, 60_000, 86_400_000) / 1000);
  }
  private get operationTtlSeconds(): number {
    return integerConfig('GENERATION_OPERATION_TTL_SECONDS', 604_800, 3_600, 2_592_000);
  }

  async create(
    userId: number,
    route: string,
    request: Record<string, unknown>,
    operationIdempotencyKey: string,
    requestedOperationId?: string,
  ): Promise<{ receipt: GenerationOperationReceipt; created: boolean }> {
    const normalized = normalizedGenerationRequest(request);
    const existingId = await redis.get(idempotencyKey(userId, operationIdempotencyKey));
    if (existingId) {
      const existing = await this.getStored(existingId);
      if (existing) {
        if (existing.requestHash !== normalized.hash || existing.route !== route
            || (requestedOperationId && existing.operationId !== requestedOperationId)) throw new GenerationIdempotencyConflictError();
        return { receipt: publicReceipt(existing), created: false };
      }
    }

    const admission=await admitReleaseMutation('generation-create',route,{userId,requestHash:normalized.hash,operationIdempotencyKey},userId);
    const operationId = requestedOperationId ?? randomUUID();
    const now = Date.now();
    const isoNow = new Date(now).toISOString();
    const result = await redis.eval(
      `
      local existing = redis.call('GET', KEYS[1])
      if existing then return {'existing', existing} end
      if redis.call('EXISTS', KEYS[4]) == 1 then return {'operation_exists', ARGV[3]} end
      if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[1]) then return {'quota_user'} end
      if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[2]) then return {'quota_global'} end
      redis.call('HSET', KEYS[4],
        'id', ARGV[3], 'userId', ARGV[4], 'idempotencyKey', ARGV[5],
        'requestHash', ARGV[6], 'requestJson', ARGV[7], 'route', ARGV[8],
        'status', 'pending', 'createdAt', ARGV[9], 'updatedAt', ARGV[9],
        'latestCursor', '0', 'oldestCursor', '1', 'eventBytes', '0',
        'outputBytes', '0', 'cancelRequested', '0',
        'pendingExpiresAt', ARGV[10], 'absoluteExpiresAt', ARGV[11],
        'leaseOwner', '', 'leaseExpiresAt', '')
      redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[12])
      redis.call('ZADD', KEYS[2], ARGV[11], ARGV[3])
      redis.call('ZADD', KEYS[3], ARGV[11], ARGV[3])
      redis.call('ZADD', KEYS[5], ARGV[10], ARGV[3])
      redis.call('ZADD', KEYS[6], ARGV[13], ARGV[3])
      local historyCount = redis.call('ZCARD', KEYS[6])
      if historyCount > 1000 then
        redis.call('ZREMRANGEBYRANK', KEYS[6], 0, historyCount - 1001)
      end
      return {'created', ARGV[3]}
      `,
      6,
      idempotencyKey(userId, operationIdempotencyKey),
      userActiveKey(userId),
      globalActiveKey,
      operationKey(operationId),
      pendingKey,
      userOperationsKey(userId),
      this.maxUserActive,
      this.maxGlobalActive,
      operationId,
      userId,
      operationIdempotencyKey,
      normalized.hash,
      normalized.json,
      route,
      isoNow,
      now + this.maxPendingMs,
      now + this.maxLifetimeMs,
      this.operationTtlSeconds,
      now,
    ) as string[];

    if (result[0] === 'quota_user') throw new GenerationQuotaError('user');
    if (result[0] === 'quota_global') throw new GenerationQuotaError('global');
    if (result[0] === 'operation_exists') throw new Error('Generation operation identity exists without its idempotency index');
    if (result[0] === 'existing') {
      const raced = await this.getStored(result[1]);
      if (!raced) throw new Error('Generation idempotency record is inconsistent');
      if (raced.requestHash !== normalized.hash || raced.route !== route
          || (requestedOperationId && raced.operationId !== requestedOperationId)) throw new GenerationIdempotencyConflictError();
      return { receipt: publicReceipt(raced), created: false };
    }
    const created = await this.getStored(operationId);
    if (!created) throw new Error('Generation receipt was not persisted');
    await withReleaseAdmission(admission.id,()=>databaseService.client.$transaction(tx=>bindReleaseAdmission(tx,'generation',operationId)));
    return { receipt: publicReceipt(created), created: true };
  }

  /** Release inventory reads only metadata and never normalizes deadlines,
   * claims, expires, cancels, or replays retained provider operations. */
  async releaseInventory(cursor='0') {
    if(!/^\d+$/.test(cursor))throw new Error('Invalid Redis inventory cursor');
    const [nextCursor,keys]=await redis.scan(cursor,'MATCH',key('operation:*'),'COUNT',50);
    if(keys.length>256)throw new Error('Redis inventory page exceeds the bounded inspection limit; use a dedicated bounded SCAN inspector. No entries were dropped.');
    const records=await Promise.all(keys.map(async operation=>{
      const fields=await redis.hmget(operation,'id','userId','status','requestHash','createdAt','updatedAt','leaseOwner','leaseExpiresAt','errorCode','pendingExpiresAt','absoluteExpiresAt');
      const names=['id','userId','status','requestHash','createdAt','updatedAt','leaseOwner','leaseExpiresAt','errorCode','pendingExpiresAt','absoluteExpiresAt'];return Object.fromEntries(names.map((name,index)=>[name,fields[index]]));
    }));return {observedAt:new Date().toISOString(),nextCursor,records,consistency:'Redis SCAN is not a PostgreSQL snapshot; repeat complete scans after admissions close.'};
  }
  async unresolved(userId: number, requestedIdempotencyKey?: string): Promise<GenerationOperationReceipt[]> {
    if (requestedIdempotencyKey) {
      const operationId = await redis.get(idempotencyKey(userId, requestedIdempotencyKey));
      if (!operationId) return [];
      const operation = await this.getStored(operationId);
      return operation && operation.userId === userId
        ? [publicReceipt(operation)]
        : [];
    }
    const ids = await redis.zrevrange(userOperationsKey(userId), 0, 99);
    const operations = await Promise.all(ids.map((id) => this.getStored(id)));
    return operations
      .filter((operation): operation is StoredOperation =>
        Boolean(operation && operation.userId === userId && ['pending', 'running'].includes(operation.status)))
      .map(publicReceipt);
  }

  async lookupByIdempotencyKey(
    userId: number,
    requestedIdempotencyKey: string,
  ): Promise<GenerationOperationReceipt | null> {
    const operationId = await redis.get(idempotencyKey(userId, requestedIdempotencyKey));
    if (!operationId) return null;
    const operation = await this.getStored(operationId);
    return operation?.userId === userId ? publicReceipt(operation) : null;
  }

  async getForUser(operationId: string, userId: number): Promise<GenerationOperationReceipt | null> {
    const operation = await this.getStored(operationId);
    return operation?.userId === userId ? publicReceipt(operation) : null;
  }

  async getArtifactForUser(operationId: string, userId: number): Promise<{
    operation: GenerationOperationReceipt;
    artifact: string;
  } | null> {
    const operation = await this.getStored(operationId);
    if (!operation || operation.userId !== userId || operation.status !== 'completed') return null;
    const artifact = await redis.get(artifactKey(operationId));
    return artifact === null ? null : { operation: publicReceipt(operation), artifact };
  }

  async getRequestForRunner(operationId: string, leaseOwner: string): Promise<{
    userId: number;
    route: string;
    request: Record<string, unknown>;
  } | null> {
    const operation = await this.getStored(operationId);
    const now = Date.now();
    if (
      !operation ||
      operation.status !== 'running' ||
      operation.leaseOwner !== leaseOwner ||
      operation.cancelRequested ||
      !operation.leaseExpiresAt ||
      operation.leaseExpiresAt <= now ||
      operation.absoluteExpiresAt <= now
    ) return null;
    return { userId: operation.userId, route: operation.route, request: JSON.parse(operation.requestJson) as Record<string, unknown> };
  }

  async hasPending():Promise<boolean>{return Number(await redis.zcard(pendingKey))>0;}
  async claimNext(): Promise<string | null> {
    if(!await releaseAdmissionsOpen())return null;
    const now = Date.now();
    const result = await redis.eval(
      `
      local prefix = ARGV[1]
      local now = tonumber(ARGV[2])
      local nowIso = ARGV[3]
      local staleRunning = 0
      local recoveryLatency = 0
      local pendingExpired = 0

      local function terminalize(id, expectedStatus, errorCode, message)
        local opKey = prefix .. 'operation:' .. id
        if redis.call('HGET', opKey, 'status') ~= expectedStatus then
          redis.call('ZREM', KEYS[1], id)
          redis.call('ZREM', KEYS[2], id)
          return false
        end
        local userId = redis.call('HGET', opKey, 'userId')
        local target = redis.call('HGET', opKey, 'cancelRequested') == '1' and 'cancelled' or 'failed'
        local code = target == 'cancelled' and 'GENERATION_CANCELLED' or errorCode
        redis.call('HSET', opKey, 'status', target, 'errorCode', code, 'updatedAt', nowIso,
          'leaseOwner', '', 'leaseExpiresAt', '', 'artifactHash', '', 'provisionalArtifactHash', '')
        redis.call('EXPIRE', opKey, tonumber(ARGV[8]))
        redis.call('DEL', prefix .. 'artifact:' .. id, prefix .. 'artifact:' .. id .. ':provisional')
        redis.call('ZREM', KEYS[1], id)
        redis.call('ZREM', KEYS[2], id)
        redis.call('ZREM', KEYS[3], id)
        if userId then redis.call('ZREM', prefix .. 'user:' .. userId .. ':active', id) end

        local cursor = redis.call('HINCRBY', opKey, 'latestCursor', 1)
        local event = target == 'cancelled' and 'cancelled' or 'error'
        local data = {operationId=id, cursor=cursor, code=code, message=message}
        local encoded = cjson.encode({cursor=cursor, event=event, data=data})
        redis.call('HINCRBY', opKey, 'eventBytes', string.len(encoded))
        redis.call('RPUSH', prefix .. 'events:' .. id, encoded)
        redis.call('EXPIRE', prefix .. 'events:' .. id, tonumber(ARGV[9]))
        while redis.call('LLEN', prefix .. 'events:' .. id) > tonumber(ARGV[11]) or
              tonumber(redis.call('HGET', opKey, 'eventBytes') or '0') > tonumber(ARGV[10]) do
          local removed = redis.call('LPOP', prefix .. 'events:' .. id)
          if not removed then break end
          local parsed = cjson.decode(removed)
          redis.call('HINCRBY', opKey, 'eventBytes', -string.len(removed))
          redis.call('HSET', opKey, 'oldestCursor', tonumber(parsed.cursor) + 1)
        end
        redis.call('PUBLISH', prefix .. 'notify:' .. id, tostring(cursor))
        return true
      end

      local runningCandidates = redis.call('ZRANGE', KEYS[1], 0, 99)
      for _, id in ipairs(runningCandidates) do
        local opKey = prefix .. 'operation:' .. id
        local status = redis.call('HGET', opKey, 'status')
        local leaseExpiresAt = tonumber(redis.call('HGET', opKey, 'leaseExpiresAt') or '0')
        if status ~= 'running' then
          redis.call('ZREM', KEYS[1], id)
        elseif leaseExpiresAt <= now and terminalize(
          id, 'running', 'GENERATION_LEASE_EXPIRED',
          'Generation stopped after its worker lease expired.'
        ) then
          staleRunning = staleRunning + 1
          recoveryLatency = recoveryLatency + math.max(0, now - leaseExpiresAt)
        end
      end

      if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then
        return {'', tostring(staleRunning), tostring(recoveryLatency), tostring(pendingExpired)}
      end

      for attempt = 1, 100 do
        local candidate = redis.call('ZRANGE', KEYS[2], 0, 0)[1]
        if not candidate then
          return {'', tostring(staleRunning), tostring(recoveryLatency), tostring(pendingExpired)}
        end
        local opKey = prefix .. 'operation:' .. candidate
        if redis.call('HGET', opKey, 'status') ~= 'pending' then
          redis.call('ZREM', KEYS[2], candidate)
        else
          local pendingExpiresAt = tonumber(redis.call('HGET', opKey, 'pendingExpiresAt') or '0')
          local absoluteExpiresAt = tonumber(redis.call('HGET', opKey, 'absoluteExpiresAt') or '0')
          if pendingExpiresAt <= now or absoluteExpiresAt <= now then
            local code = absoluteExpiresAt <= now and 'GENERATION_LIFETIME_EXPIRED' or 'GENERATION_QUEUE_EXPIRED'
            local message = absoluteExpiresAt <= now
              and 'Generation exceeded its absolute operation lifetime.'
              or 'Generation expired after exceeding its maximum pending queue age.'
            if terminalize(candidate, 'pending', code, message) then pendingExpired = pendingExpired + 1 end
          else
            local leaseExpiresAt = now + tonumber(ARGV[6])
            redis.call('HSET', opKey, 'status', 'running', 'leaseOwner', ARGV[5],
              'leaseExpiresAt', leaseExpiresAt, 'updatedAt', nowIso)
            redis.call('ZREM', KEYS[2], candidate)
            redis.call('ZADD', KEYS[1], leaseExpiresAt, candidate)
            return {candidate, tostring(staleRunning), tostring(recoveryLatency), tostring(pendingExpired)}
          end
        end
      end
      return {'', tostring(staleRunning), tostring(recoveryLatency), tostring(pendingExpired)}
      `,
      3,
      globalRunningKey,
      pendingKey,
      globalActiveKey,
      key(''),
      now,
      new Date(now).toISOString(),
      this.maxConcurrency,
      this.instanceId,
      this.leaseMs,
      this.maxPendingMs,
      this.operationTtlSeconds,
      this.replayTtlSeconds,
      this.maxReplayBytes,
      this.maxReplayEvents,
    ) as string[];
    recordGenerationAdmissionRecovery(Number(result[1]), Number(result[2]), Number(result[3]));
    return result[0] || null;
  }

  async renewLease(operationId: string): Promise<boolean> {
    const now = Date.now();
    const result = await redis.eval(
      `
      if redis.call('HGET', KEYS[1], 'status') ~= 'running' or
         redis.call('HGET', KEYS[1], 'leaseOwner') ~= ARGV[1] or
         redis.call('HGET', KEYS[1], 'cancelRequested') == '1' or
         tonumber(redis.call('HGET', KEYS[1], 'absoluteExpiresAt') or '0') <= tonumber(ARGV[5])
         then return 0 end
      redis.call('HSET', KEYS[1], 'leaseExpiresAt', ARGV[2], 'updatedAt', ARGV[3])
      redis.call('ZADD', KEYS[2], ARGV[2], ARGV[4])
      return 1
      `,
      2,
      operationKey(operationId),
      globalRunningKey,
      this.instanceId,
      now + this.leaseMs,
      new Date(now).toISOString(),
      operationId,
      now,
    );
    return Number(result) === 1;
  }

  async isCancellationRequested(operationId: string): Promise<boolean> {
    const [status, requested] = await redis.hmget(operationKey(operationId), 'status', 'cancelRequested');
    return status === 'cancelled' || requested === '1';
  }

  async releaseLease(operationId: string, preserveDeadlines = false): Promise<void> {
    const operation = await this.getStored(operationId);
    if (
      !operation ||
      operation.status !== 'running' ||
      operation.leaseOwner !== this.instanceId ||
      operation.cancelRequested
    ) return;
    const now = Date.now();
    const result = await redis.eval(
      `
      if redis.call('HGET', KEYS[1], 'status') ~= 'running' or
         redis.call('HGET', KEYS[1], 'leaseOwner') ~= ARGV[1] then return 0 end
      local absoluteExpiresAt = tonumber(redis.call('HGET', KEYS[1], 'absoluteExpiresAt') or '0')
      if ARGV[6] ~= '1' and absoluteExpiresAt <= tonumber(ARGV[4]) then return -1 end
      local pendingExpiresAt = tonumber(redis.call('HGET', KEYS[1], 'pendingExpiresAt') or '0')
      if ARGV[6] ~= '1' then pendingExpiresAt = math.min(tonumber(ARGV[4]) + tonumber(ARGV[5]), absoluteExpiresAt) end
      redis.call('HSET', KEYS[1], 'status', 'pending', 'leaseOwner', '',
        'leaseExpiresAt', '', 'pendingExpiresAt', pendingExpiresAt, 'updatedAt', ARGV[2])
      redis.call('ZREM', KEYS[2], ARGV[3])
      redis.call('ZADD', KEYS[3], pendingExpiresAt, ARGV[3])
      return 1
      `,
      3,
      operationKey(operationId),
      globalRunningKey,
      pendingKey,
      this.instanceId,
      new Date(now).toISOString(),
      operationId,
      now,
      this.maxPendingMs,
      preserveDeadlines ? '1' : '0',
    );
    if (Number(result) === -1) {
      await this.terminal(operationId, 'failed', {
        actor: 'expire_absolute',
        errorCode: 'GENERATION_LIFETIME_EXPIRED',
        message: 'Generation exceeded its absolute operation lifetime.',
      });
    }
  }

  async append(
    operationId: string,
    event: string,
    data: Record<string, unknown>,
    expectedLeaseOwner: string,
  ): Promise<GenerationReplayEvent> {
    const now = Date.now();
    const textBytes = event === 'token' && typeof data.text === 'string'
      ? Buffer.byteLength(data.text, 'utf8')
      : 0;
    const result = await redis.eval(
      `
      if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
      local status = redis.call('HGET', KEYS[1], 'status')
      if status ~= 'running' or redis.call('HGET', KEYS[1], 'leaseOwner') ~= ARGV[9] or
         redis.call('HGET', KEYS[1], 'cancelRequested') == '1' or
         tonumber(redis.call('HGET', KEYS[1], 'leaseExpiresAt') or '0') <= tonumber(ARGV[10]) or
         tonumber(redis.call('HGET', KEYS[1], 'absoluteExpiresAt') or '0') <= tonumber(ARGV[10])
         then return -2 end
      local output = tonumber(redis.call('HGET', KEYS[1], 'outputBytes') or '0')
      if output + tonumber(ARGV[4]) > tonumber(ARGV[5]) then return -1 end

      local cursor = redis.call('HINCRBY', KEYS[1], 'latestCursor', 1)
      local data = cjson.decode(ARGV[3])
      data['operationId'] = ARGV[1]
      data['cursor'] = cursor
      local encoded = cjson.encode({cursor=cursor, event=ARGV[2], data=data})
      local frameBytes = string.len(encoded)

      redis.call('HINCRBY', KEYS[1], 'outputBytes', ARGV[4])
      redis.call('HINCRBY', KEYS[1], 'eventBytes', frameBytes)
      redis.call('HSET', KEYS[1], 'updatedAt', ARGV[6])
      redis.call('RPUSH', KEYS[2], encoded)
      while redis.call('LLEN', KEYS[2]) > tonumber(ARGV[8]) or
            tonumber(redis.call('HGET', KEYS[1], 'eventBytes') or '0') > tonumber(ARGV[7]) do
        local removed = redis.call('LPOP', KEYS[2])
        if not removed then break end
        local parsed = cjson.decode(removed)
        redis.call('HINCRBY', KEYS[1], 'eventBytes', -string.len(removed))
        redis.call('HSET', KEYS[1], 'oldestCursor', tonumber(parsed.cursor) + 1)
      end
      redis.call('PUBLISH', KEYS[3], tostring(cursor))
      return {cursor, encoded}
      `,
      3,
      operationKey(operationId),
      eventKey(operationId),
      key(`notify:${operationId}`),
      operationId,
      event,
      JSON.stringify(data),
      textBytes,
      this.maxOutputBytes,
      new Date(now).toISOString(),
      this.maxReplayBytes,
      this.maxReplayEvents,
      expectedLeaseOwner,
      now,
    ) as string[] | number;
    if (Number(result) === -1) throw new GenerationOutputLimitError();
    if (Number(result) === -2) throw new Error('Generation worker lease was lost before replay event admission');
    if (!Array.isArray(result)) throw new Error(`Unknown generation operation ${operationId}`);
    const cursor = Number(result[0]);
    const payload = (JSON.parse(result[1]) as GenerationReplayEvent).data;
    return { cursor, event, data: payload };
  }

  async setArtifact(operationId: string, artifact: string): Promise<string> {
    const artifactHash = createHash('sha256').update(artifact).digest('hex');
    const now = Date.now();
    const result = await redis.eval(
      `
      if redis.call('HGET', KEYS[1], 'status') ~= 'running' or
         redis.call('HGET', KEYS[1], 'leaseOwner') ~= ARGV[1] or
         redis.call('HGET', KEYS[1], 'cancelRequested') == '1' or
         tonumber(redis.call('HGET', KEYS[1], 'leaseExpiresAt') or '0') <= tonumber(ARGV[2])
         then return 0 end
      redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[5])
      redis.call('HSET', KEYS[1], 'provisionalArtifactHash', ARGV[4], 'updatedAt', ARGV[6])
      return 1
      `,
      2,
      operationKey(operationId),
      provisionalArtifactKey(operationId),
      this.instanceId,
      now,
      artifact,
      artifactHash,
      this.operationTtlSeconds,
      new Date(now).toISOString(),
    );
    if (Number(result) !== 1) throw new Error('Generation worker lease was lost before artifact staging');
    return artifactHash;
  }

  async complete(operationId: string): Promise<GenerationOperationStatus | null> {
    return this.terminal(operationId, 'completed', {
      actor: 'worker',
      expectedOwner: this.instanceId,
    });
  }

  async fail(
    operationId: string,
    errorCode = 'GENERATION_FAILED',
    message = 'Generation failed.',
    correlationId = '',
  ): Promise<GenerationOperationStatus | null> {
    return this.terminal(operationId, 'failed', {
      actor: 'worker',
      expectedOwner: this.instanceId,
      errorCode,
      message,
      correlationId,
    });
  }

  async cancel(operationId: string, userId: number): Promise<GenerationOperationReceipt | null> {
    const transitioned = await this.terminal(operationId, 'cancelled', {
      actor: 'cancel',
      requestedUserId: userId,
      errorCode: 'GENERATION_CANCELLED',
      message: 'Generation was cancelled.',
    });
    if (!transitioned) return null;
    const updated = await this.getStored(operationId);
    return updated ? publicReceipt(updated) : null;
  }

  async replay(operationId: string, userId: number, afterCursor: number, requestedLimit: number) {
    const operation = await this.getStored(operationId);
    if (!operation || operation.userId !== userId) return null;
    const oldestCursor = Number(await redis.hget(operationKey(operationId), 'oldestCursor') || 1);
    if (afterCursor < oldestCursor - 1) throw new ReplayCursorExpiredError(oldestCursor);
    const limit = Math.min(Math.max(requestedLimit, 1), this.maxReplayEvents);
    const encoded = await redis.lrange(eventKey(operationId), 0, -1);
    const available = encoded
      .map((value) => JSON.parse(value) as GenerationReplayEvent)
      .filter((replayEvent) => replayEvent.cursor > afterCursor);
    return {
      events: available.slice(0, limit),
      hasMore: available.length > limit,
      status: operation.status,
      artifactHash: operation.artifactHash,
      oldestCursor,
      latestCursor: operation.latestCursor,
      limit,
    };
  }

  async expireIdleOperations(): Promise<number> {
    if(!await releaseAdmissionsOpen())return 0;
    const now = Date.now();
    const absoluteExpired = await redis.zrangebyscore(globalActiveKey, 0, now);
    const pendingExpired = await redis.zrangebyscore(pendingKey, 0, now);
    const runningExpired = await redis.zrangebyscore(globalRunningKey, 0, now);
    let count = 0;
    const candidates = new Map<string, 'expire_absolute' | 'expire_pending' | 'expire_running'>();
    for (const operationId of runningExpired) candidates.set(operationId, 'expire_running');
    for (const operationId of pendingExpired) candidates.set(operationId, 'expire_pending');
    for (const operationId of absoluteExpired) candidates.set(operationId, 'expire_absolute');
    for (const [operationId, actor] of candidates) {
      if (await this.normalizeLegacyDeadlines(operationId)) continue;
      const errorCode = actor === 'expire_pending'
        ? 'GENERATION_QUEUE_EXPIRED'
        : actor === 'expire_running'
          ? 'GENERATION_LEASE_EXPIRED'
          : 'GENERATION_LIFETIME_EXPIRED';
      const message = actor === 'expire_pending'
        ? 'Generation expired after exceeding its maximum pending queue age.'
        : actor === 'expire_running'
          ? 'Generation stopped after its worker lease expired.'
          : 'Generation exceeded its absolute operation lifetime.';
      const status = await this.terminal(operationId, 'failed', {
        actor,
        errorCode,
        message,
      });
      if (status === 'failed' || status === 'cancelled') count += 1;
    }
    return count;
  }

  private async normalizeLegacyDeadlines(operationId: string): Promise<boolean> {
    const operation = await this.getStored(operationId);
    if (!operation || operation.absoluteExpiresAt > 0) return false;
    const createdAt = Date.parse(operation.createdAt);
    if (!Number.isFinite(createdAt)) return false;
    const pendingExpiresAt = createdAt + this.maxPendingMs;
    const absoluteExpiresAt = createdAt + this.maxLifetimeMs;
    const normalized = await redis.eval(
      `
      if redis.call('EXISTS', KEYS[1]) == 0 or
         redis.call('HEXISTS', KEYS[1], 'absoluteExpiresAt') == 1 then return 0 end
      redis.call('HSET', KEYS[1],
        'pendingExpiresAt', ARGV[1], 'absoluteExpiresAt', ARGV[2])
      redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
      redis.call('ZADD', KEYS[3], ARGV[2], ARGV[3])
      if redis.call('HGET', KEYS[1], 'status') == 'pending' then
        redis.call('HSET', KEYS[1], 'leaseExpiresAt', '')
        redis.call('ZADD', KEYS[4], ARGV[1], ARGV[3])
      end
      return 1
      `,
      4,
      operationKey(operationId),
      globalActiveKey,
      userActiveKey(operation.userId),
      pendingKey,
      pendingExpiresAt,
      absoluteExpiresAt,
      operationId,
    );
    return Number(normalized) === 1;
  }

  private async terminal(
    operationId: string,
    status: Extract<GenerationOperationStatus, 'completed' | 'failed' | 'cancelled'>,
    options: {
      actor: 'worker' | 'cancel' | 'expire_pending' | 'expire_running' | 'expire_absolute';
      expectedOwner?: string;
      requestedUserId?: number;
      errorCode?: string;
      message?: string;
      correlationId?: string;
    },
  ): Promise<GenerationOperationStatus | null> {
    const now = Date.now();
    const result = await redis.eval(
      `
      if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
      local current = redis.call('HGET', KEYS[1], 'status')
      local userId = redis.call('HGET', KEYS[1], 'userId')
      if ARGV[3] == 'cancel' and userId ~= ARGV[5] then return {'missing'} end
      if current == 'completed' or current == 'failed' or current == 'cancelled' then
        return {'immutable', current}
      end

      local target = ARGV[2]
      if ARGV[3] == 'worker' then
        if current ~= 'running' or redis.call('HGET', KEYS[1], 'leaseOwner') ~= ARGV[4] or
           tonumber(redis.call('HGET', KEYS[1], 'leaseExpiresAt') or '0') <= tonumber(ARGV[8])
           then return {'fenced', current} end
        if redis.call('HGET', KEYS[1], 'cancelRequested') == '1' then target = 'cancelled' end
      elseif ARGV[3] == 'cancel' then
        if current ~= 'pending' and current ~= 'running' then return {'invalid', current} end
        redis.call('HSET', KEYS[1], 'cancelRequested', '1')
        target = 'cancelled'
      elseif ARGV[3] == 'expire_pending' then
        if current ~= 'pending' or
           tonumber(redis.call('HGET', KEYS[1], 'pendingExpiresAt') or '0') > tonumber(ARGV[8])
           then return {'stale', current} end
      elseif ARGV[3] == 'expire_running' then
        if current ~= 'running' or
           tonumber(redis.call('HGET', KEYS[1], 'leaseExpiresAt') or '0') > tonumber(ARGV[8])
           then return {'stale', current} end
        if redis.call('HGET', KEYS[1], 'cancelRequested') == '1' then target = 'cancelled' end
      elseif ARGV[3] == 'expire_absolute' then
        if tonumber(redis.call('HGET', KEYS[1], 'absoluteExpiresAt') or '0') > tonumber(ARGV[8])
           then return {'stale', current} end
        if redis.call('HGET', KEYS[1], 'cancelRequested') == '1' then target = 'cancelled' end
      end

      if current == 'pending' and target ~= 'cancelled' and ARGV[3] ~= 'expire_pending' and
         ARGV[3] ~= 'expire_absolute' then return {'invalid', current} end
      if current == 'pending' and target ~= 'cancelled' then target = 'failed' end

      local artifactHash = ''
      if target == 'completed' then
        local provisional = redis.call('GET', KEYS[5])
        artifactHash = redis.call('HGET', KEYS[1], 'provisionalArtifactHash') or ''
        if not provisional or artifactHash == '' then return {'fenced', current} end
        redis.call('SET', KEYS[4], provisional, 'EX', ARGV[10])
        redis.call('DEL', KEYS[5])
      else
        redis.call('DEL', KEYS[4], KEYS[5])
      end

      local errorCode = ''
      if target ~= 'completed' then errorCode = ARGV[6] end
      if target == 'cancelled' then errorCode = 'GENERATION_CANCELLED' end
      redis.call('HSET', KEYS[1],
        'status', target, 'errorCode', errorCode, 'updatedAt', ARGV[9],
        'leaseOwner', '', 'leaseExpiresAt', '', 'artifactHash', artifactHash,
        'provisionalArtifactHash', '')
      redis.call('EXPIRE', KEYS[1], ARGV[10])
      redis.call('ZREM', KEYS[6], ARGV[1])
      redis.call('ZREM', KEYS[7], ARGV[1])
      redis.call('ZREM', KEYS[8], ARGV[1])
      redis.call('ZREM', 'proser:generation:v2:user:' .. userId .. ':active', ARGV[1])

      local event = 'error'
      local data = {code=errorCode, message=ARGV[7]}
      if ARGV[14] ~= '' then
        data['correlationId'] = ARGV[14]
        data['partial'] = 'discard'
      end
      if target == 'completed' then
        event = 'done'
        data = {status='committed', artifactHash=artifactHash}
      elseif target == 'cancelled' then
        event = 'cancelled'
        data = {status='cancelled', code=errorCode}
      end
      local cursor = redis.call('HINCRBY', KEYS[1], 'latestCursor', 1)
      data['operationId'] = ARGV[1]
      data['cursor'] = cursor
      local encoded = cjson.encode({cursor=cursor, event=event, data=data})
      redis.call('HINCRBY', KEYS[1], 'eventBytes', string.len(encoded))
      redis.call('RPUSH', KEYS[2], encoded)
      while redis.call('LLEN', KEYS[2]) > tonumber(ARGV[13]) or
            tonumber(redis.call('HGET', KEYS[1], 'eventBytes') or '0') > tonumber(ARGV[12]) do
        local removed = redis.call('LPOP', KEYS[2])
        if not removed then break end
        local parsed = cjson.decode(removed)
        redis.call('HINCRBY', KEYS[1], 'eventBytes', -string.len(removed))
        redis.call('HSET', KEYS[1], 'oldestCursor', tonumber(parsed.cursor) + 1)
      end
      redis.call('EXPIRE', KEYS[2], ARGV[11])
      redis.call('PUBLISH', KEYS[3], tostring(cursor))
      return {'transitioned', target, tostring(cursor)}
      `,
      8,
      operationKey(operationId),
      eventKey(operationId),
      key(`notify:${operationId}`),
      artifactKey(operationId),
      provisionalArtifactKey(operationId),
      globalActiveKey,
      globalRunningKey,
      pendingKey,
      operationId,
      status,
      options.actor,
      options.expectedOwner ?? '',
      options.requestedUserId === undefined ? '' : String(options.requestedUserId),
      options.errorCode ?? '',
      options.message ?? '',
      now,
      new Date(now).toISOString(),
      this.operationTtlSeconds,
      this.replayTtlSeconds,
      this.maxReplayBytes,
      this.maxReplayEvents,
      options.correlationId ?? '',
    ) as string[];
    if (!Array.isArray(result) || result[0] === 'missing') return null;
    if (result[0] === 'transitioned' || result[0] === 'immutable') {
      return result[1] as GenerationOperationStatus;
    }
    return null;
  }

  private async getStored(operationId: string): Promise<StoredOperation | null> {
    return parseStoredOperation(await redis.hgetall(operationKey(operationId)));
  }
}

export const generationReplayService = new GenerationReplayService();
