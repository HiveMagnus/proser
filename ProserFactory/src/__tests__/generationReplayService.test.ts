import { createHash, randomUUID } from 'node:crypto';

jest.unmock('../lib/redis');

import redis from '../lib/redis';
import {
  GenerationIdempotencyConflictError,
  GenerationOutputLimitError,
  GenerationQuotaError,
  ReplayCursorExpiredError,
  generationReplayService,
} from '../services/generationReplayService';

describe('durable generation replay protocol', () => {
  const userId = 910_000 + Math.floor(Math.random() * 1_000);
  const createdOperations: string[] = [];

  afterAll(async () => {
    const keys = await redis.keys('proser:generation:v2:*');
    const ownedKeys: string[] = [];
    for (const candidate of keys) {
      if (
        candidate.includes(`user:${userId}:`) ||
        createdOperations.some((operationId) => candidate.includes(operationId))
      ) ownedKeys.push(candidate);
    }
    if (ownedKeys.length) await redis.del(...ownedKeys);
    await redis.quit();
  });

  it('durably creates an idempotent receipt before work is claimed', async () => {
    const idempotencyKey = randomUUID();
    const request = { bookId: 42, prompt: 'private manuscript prompt', targetWords: 500 };
    const first = await generationReplayService.create(userId, 'generate.prose', request, idempotencyKey);
    createdOperations.push(first.receipt.operationId);
    const second = await generationReplayService.create(userId, 'generate.prose', request, idempotencyKey);

    expect(first.created).toBe(true);
    expect(first.receipt.status).toBe('pending');
    expect(second.created).toBe(false);
    expect(second.receipt.operationId).toBe(first.receipt.operationId);
    expect(second.receipt.requestHash).toBe(first.receipt.requestHash);
    await expect(
      generationReplayService.create(userId, 'generate.prose', { ...request, prompt: 'different' }, idempotencyKey),
    ).rejects.toBeInstanceOf(GenerationIdempotencyConflictError);

    await generationReplayService.cancel(first.receipt.operationId, userId);
    expect(await generationReplayService.lookupByIdempotencyKey(userId, idempotencyKey))
      .toMatchObject({
        operationId: first.receipt.operationId,
        status: 'cancelled',
      });
  });

  it('assigns monotonic cursors, bounds replay, and stores the authoritative artifact hash', async () => {
    const created = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'test' },
      randomUUID(),
    );
    const operationId = created.receipt.operationId;
    createdOperations.push(operationId);
    expect(await generationReplayService.claimNext()).toBe(operationId);
    await generationReplayService.append(operationId, 'start', {}, generationReplayService.instanceId);
    await generationReplayService.append(operationId, 'token', { text: 'hello ' }, generationReplayService.instanceId);
    await generationReplayService.append(operationId, 'token', { text: 'world' }, generationReplayService.instanceId);
    const artifactHash = await generationReplayService.setArtifact(operationId, 'hello world');
    await generationReplayService.complete(operationId);

    expect(artifactHash).toBe(createHash('sha256').update('hello world').digest('hex'));
    const first = (await generationReplayService.replay(operationId, userId, 0, 2))!;
    expect(first.events.map((event) => event.cursor)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    const rest = (await generationReplayService.replay(operationId, userId, 2, 10_000))!;
    expect(rest.events.map((event) => event.cursor)).toEqual([3, 4]);
    expect(rest.limit).toBe(generationReplayService.maxReplayEvents);
    expect(rest.status).toBe('completed');
    expect(rest.artifactHash).toBe(artifactHash);
    expect(await generationReplayService.replay(operationId, userId + 1, 0, 10)).toBeNull();
  });

  it('does not expire pending work merely because one worker lease duration elapsed', async () => {
    const previousLease = process.env.GENERATION_OPERATION_LEASE_MS;
    const previousPending = process.env.GENERATION_OPERATION_MAX_PENDING_MS;
    const previousLifetime = process.env.GENERATION_OPERATION_MAX_LIFETIME_MS;
    process.env.GENERATION_OPERATION_LEASE_MS = '30000';
    process.env.GENERATION_OPERATION_MAX_PENDING_MS = '120000';
    process.env.GENERATION_OPERATION_MAX_LIFETIME_MS = '300000';
    const createdAt = Date.now();
    const created = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'wait behind long-running work' },
      randomUUID(),
    );
    createdOperations.push(created.receipt.operationId);
    const now = jest.spyOn(Date, 'now').mockReturnValue(createdAt + 30_001);
    try {
      expect(await generationReplayService.expireIdleOperations()).toBe(0);
      expect((await generationReplayService.getForUser(created.receipt.operationId, userId))?.status)
        .toBe('pending');
    } finally {
      now.mockRestore();
      await generationReplayService.cancel(created.receipt.operationId, userId);
      if (previousLease === undefined) delete process.env.GENERATION_OPERATION_LEASE_MS;
      else process.env.GENERATION_OPERATION_LEASE_MS = previousLease;
      if (previousPending === undefined) delete process.env.GENERATION_OPERATION_MAX_PENDING_MS;
      else process.env.GENERATION_OPERATION_MAX_PENDING_MS = previousPending;
      if (previousLifetime === undefined) delete process.env.GENERATION_OPERATION_MAX_LIFETIME_MS;
      else process.env.GENERATION_OPERATION_MAX_LIFETIME_MS = previousLifetime;
    }
  });

  it('terminalizes an expired queue head and claims the valid operation behind it', async () => {
    const expired = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'expired head' },
      randomUUID(),
    );
    const valid = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'valid follower' },
      randomUUID(),
    );
    createdOperations.push(expired.receipt.operationId, valid.receipt.operationId);
    const expiredAt = Date.now() - 1;
    await redis.hset(
      `proser:generation:v2:operation:${expired.receipt.operationId}`,
      'pendingExpiresAt',
      expiredAt,
    );
    await redis.zadd('proser:generation:v2:pending', expiredAt, expired.receipt.operationId);

    expect(await generationReplayService.claimNext()).toBe(valid.receipt.operationId);
    expect((await generationReplayService.getForUser(expired.receipt.operationId, userId))?.status)
      .toBe('failed');
    expect((await generationReplayService.getForUser(expired.receipt.operationId, userId))?.errorCode)
      .toBe('GENERATION_QUEUE_EXPIRED');
    await generationReplayService.cancel(valid.receipt.operationId, userId);
  });

  it('rejects replay writes from a worker after its lease is replaced or expired', async () => {
    const created = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'lease fencing' },
      randomUUID(),
    );
    const operationId = created.receipt.operationId;
    createdOperations.push(operationId);
    expect(await generationReplayService.claimNext()).toBe(operationId);
    await generationReplayService.append(
      operationId,
      'start',
      {},
      generationReplayService.instanceId,
    );
    await redis.hset(
      `proser:generation:v2:operation:${operationId}`,
      'leaseOwner',
      'replacement-worker',
    );

    await expect(
      generationReplayService.append(
        operationId,
        'token',
        { text: 'stale worker output' },
        generationReplayService.instanceId,
      ),
    ).rejects.toThrow('Generation worker lease was lost');
    expect((await generationReplayService.getForUser(operationId, userId))?.latestCursor).toBe(1);
    await generationReplayService.cancel(operationId, userId);
  });

  it('starts a fresh bounded pending interval when a running lease is released', async () => {
    const previousPending = process.env.GENERATION_OPERATION_MAX_PENDING_MS;
    process.env.GENERATION_OPERATION_MAX_PENDING_MS = '60000';
    const createdAt = Date.now();
    const created = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'requeue after original pending interval' },
      randomUUID(),
    );
    const operationId = created.receipt.operationId;
    createdOperations.push(operationId);
    expect(await generationReplayService.claimNext()).toBe(operationId);
    const releasedAt = createdAt + 60_001;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(releasedAt);
    try {
      await generationReplayService.releaseLease(operationId);
      const values = await redis.hmget(
        `proser:generation:v2:operation:${operationId}`,
        'status',
        'pendingExpiresAt',
        'absoluteExpiresAt',
      );
      expect(values[0]).toBe('pending');
      expect(Number(values[1])).toBe(releasedAt + 60_000);
      expect(Number(values[1])).toBeLessThanOrEqual(Number(values[2]));
      expect(await generationReplayService.claimNext()).toBe(operationId);
    } finally {
      clock.mockRestore();
      await generationReplayService.cancel(operationId, userId);
      if (previousPending === undefined) delete process.env.GENERATION_OPERATION_MAX_PENDING_MS;
      else process.env.GENERATION_OPERATION_MAX_PENDING_MS = previousPending;
    }
  });

  it('requeues a released lease before its original pending deadline', async () => {
    const created = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'ordinary retry' },
      randomUUID(),
    );
    const operationId = created.receipt.operationId;
    createdOperations.push(operationId);
    expect(await generationReplayService.claimNext()).toBe(operationId);

    await generationReplayService.releaseLease(operationId);

    const [status, pendingExpiresAt, absoluteExpiresAt] = await redis.hmget(
      `proser:generation:v2:operation:${operationId}`,
      'status',
      'pendingExpiresAt',
      'absoluteExpiresAt',
    );
    expect(status).toBe('pending');
    expect(Number(pendingExpiresAt)).toBeGreaterThan(Date.now());
    expect(Number(pendingExpiresAt)).toBeLessThanOrEqual(Number(absoluteExpiresAt));
    await generationReplayService.cancel(operationId, userId);
  });

  it('recovers expired running leases before applying the concurrency ceiling', async () => {
    const previousConcurrency = process.env.GENERATION_MAX_CONCURRENT;
    process.env.GENERATION_MAX_CONCURRENT = '1';
    const abandoned = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'abandoned running work' },
      randomUUID(),
    );
    const waiting = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'waiting work' },
      randomUUID(),
    );
    createdOperations.push(abandoned.receipt.operationId, waiting.receipt.operationId);
    await redis.zadd(
      'proser:generation:v2:pending',
      Date.now() + generationReplayService.maxPendingMs + 1,
      waiting.receipt.operationId,
    );
    expect(await generationReplayService.claimNext()).toBe(abandoned.receipt.operationId);
    const expiredAt = Date.now() - 250;
    await redis.hset(
      `proser:generation:v2:operation:${abandoned.receipt.operationId}`,
      'leaseExpiresAt',
      expiredAt,
    );
    await redis.zadd('proser:generation:v2:running', expiredAt, abandoned.receipt.operationId);

    expect(await generationReplayService.claimNext()).toBe(waiting.receipt.operationId);
    expect((await generationReplayService.getForUser(abandoned.receipt.operationId, userId))?.errorCode)
      .toBe('GENERATION_LEASE_EXPIRED');
    await generationReplayService.cancel(waiting.receipt.operationId, userId);
    if (previousConcurrency === undefined) delete process.env.GENERATION_MAX_CONCURRENT;
    else process.env.GENERATION_MAX_CONCURRENT = previousConcurrency;
  });

  it('admits events and assigns cursors atomically without gaps or partial unknown hashes', async () => {
    const previousOutput = process.env.GENERATION_OPERATION_MAX_BYTES;
    process.env.GENERATION_OPERATION_MAX_BYTES = '65536';
    const created = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'atomic cursors' },
      randomUUID(),
    );
    const operationId = created.receipt.operationId;
    createdOperations.push(operationId);
    expect(await generationReplayService.claimNext()).toBe(operationId);
    const admitted = await generationReplayService.append(operationId, 'token', {
      text: 'a'.repeat(65_536),
    }, generationReplayService.instanceId);
    await expect(
      generationReplayService.append(
        operationId,
        'token',
        { text: 'b' },
        generationReplayService.instanceId,
      ),
    ).rejects.toBeInstanceOf(GenerationOutputLimitError);
    expect((await generationReplayService.getForUser(operationId, userId))?.latestCursor)
      .toBe(admitted.cursor);

    const unknownId = randomUUID();
    await expect(
      generationReplayService.append(
        unknownId,
        'token',
        { text: 'nope' },
        generationReplayService.instanceId,
      ),
    )
      .rejects.toThrow(`Unknown generation operation ${unknownId}`);
    expect(await redis.exists(`proser:generation:v2:operation:${unknownId}`)).toBe(0);
    await generationReplayService.cancel(operationId, userId);
    if (previousOutput === undefined) delete process.env.GENERATION_OPERATION_MAX_BYTES;
    else process.env.GENERATION_OPERATION_MAX_BYTES = previousOutput;
  });

  it('keeps terminal states immutable under concurrent completion and cancellation', async () => {
    const created = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'terminal race' },
      randomUUID(),
    );
    const operationId = created.receipt.operationId;
    createdOperations.push(operationId);
    expect(await generationReplayService.claimNext()).toBe(operationId);
    await generationReplayService.setArtifact(operationId, 'race winner');

    await Promise.all([
      generationReplayService.complete(operationId),
      generationReplayService.cancel(operationId, userId),
    ]);
    const settled = (await generationReplayService.getForUser(operationId, userId))!;
    expect(['completed', 'cancelled']).toContain(settled.status);
    await generationReplayService.fail(operationId, 'TOO_LATE');
    expect((await generationReplayService.getForUser(operationId, userId))?.status)
      .toBe(settled.status);
    const replay = (await generationReplayService.replay(operationId, userId, 0, 500))!;
    expect(replay.events.filter((event) => ['done', 'error', 'cancelled'].includes(event.event)))
      .toHaveLength(1);
  });

  it('removes provisional artifacts when a claimed operation never completes', async () => {
    const created = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'provisional cleanup' },
      randomUUID(),
    );
    const operationId = created.receipt.operationId;
    createdOperations.push(operationId);
    expect(await generationReplayService.claimNext()).toBe(operationId);
    await generationReplayService.setArtifact(operationId, 'must not survive failure');
    expect(await redis.exists(`proser:generation:v2:artifact:${operationId}:provisional`)).toBe(1);
    await generationReplayService.fail(operationId, 'TEST_FAILURE');
    expect(await redis.exists(`proser:generation:v2:artifact:${operationId}:provisional`)).toBe(0);
    expect(await generationReplayService.getArtifactForUser(operationId, userId)).toBeNull();
  });

  it('enforces active admission quotas before work is claimed', async () => {
    const previous = process.env.GENERATION_MAX_ACTIVE_PER_USER;
    process.env.GENERATION_MAX_ACTIVE_PER_USER = '1';
    const first = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'first' },
      randomUUID(),
    );
    createdOperations.push(first.receipt.operationId);
    await expect(
      generationReplayService.create(
        userId,
        'generate.prose',
        { bookId: 42, prompt: 'second' },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(GenerationQuotaError);
    await generationReplayService.cancel(first.receipt.operationId, userId);
    if (previous === undefined) delete process.env.GENERATION_MAX_ACTIVE_PER_USER;
    else process.env.GENERATION_MAX_ACTIVE_PER_USER = previous;
  });

  it('bounds replay by bytes and reports an expired initial cursor', async () => {
    const previousReplay = process.env.GENERATION_REPLAY_MAX_BYTES;
    const previousOutput = process.env.GENERATION_OPERATION_MAX_BYTES;
    process.env.GENERATION_REPLAY_MAX_BYTES = '65536';
    process.env.GENERATION_OPERATION_MAX_BYTES = '1048576';
    const created = await generationReplayService.create(
      userId,
      'generate.prose',
      { bookId: 42, prompt: 'bounded' },
      randomUUID(),
    );
    createdOperations.push(created.receipt.operationId);
    expect(await generationReplayService.claimNext()).toBe(created.receipt.operationId);
    await generationReplayService.append(created.receipt.operationId, 'start', {}, generationReplayService.instanceId);
    await generationReplayService.append(created.receipt.operationId, 'token', { text: 'a'.repeat(40_000) }, generationReplayService.instanceId);
    await generationReplayService.append(created.receipt.operationId, 'token', { text: 'b'.repeat(40_000) }, generationReplayService.instanceId);
    await expect(
      generationReplayService.replay(created.receipt.operationId, userId, 0, 10),
    ).rejects.toBeInstanceOf(ReplayCursorExpiredError);
    await generationReplayService.cancel(created.receipt.operationId, userId);
    if (previousReplay === undefined) delete process.env.GENERATION_REPLAY_MAX_BYTES;
    else process.env.GENERATION_REPLAY_MAX_BYTES = previousReplay;
    if (previousOutput === undefined) delete process.env.GENERATION_OPERATION_MAX_BYTES;
    else process.env.GENERATION_OPERATION_MAX_BYTES = previousOutput;
  });
});
