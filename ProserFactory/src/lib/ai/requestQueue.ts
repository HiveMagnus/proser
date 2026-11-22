/**
 * Concurrency-limited request queue for AI providers.
 *
 * When a single GPU server is shared, firing many parallel requests causes
 * HTTP 500s and circuit-breaker trips.  This queue serializes (or limits
 * concurrency of) outgoing requests so only N run at a time.
 *
 * Usage:
 *   const result = await aiRequestQueue.enqueue(() => vllm.generate(prompt));
 *
 * For streaming (async generators that hold the GPU for the full duration):
 *   const release = await aiRequestQueue.acquire('stream');
 *   try { ... yield chunks ... } finally { release(); }
 *
 * Configuration:
 *   AI_MAX_CONCURRENT  — max parallel requests (default 8)
 *   AI_QUEUE_TIMEOUT_MS — per-item wait timeout in queue (default 120 000 ms)
 */

import logger from '../logger';

interface Waiter {
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
  label?: string;
}

export class AIRequestQueue {
  private readonly maxConcurrent: number;
  private readonly queueTimeoutMs: number;
  private running = 0;
  private waiters: Waiter[] = [];
  private completedAcquisitions = 0;
  private totalWaitMs = 0;
  private maxWaitMs = 0;

  constructor(opts?: { maxConcurrent?: number; queueTimeoutMs?: number }) {
    const configuredMaxConcurrent = opts?.maxConcurrent ?? parsePosInt(process.env.AI_MAX_CONCURRENT, 8);
    this.maxConcurrent = clamp(configuredMaxConcurrent, 1, 32);
    this.queueTimeoutMs = opts?.queueTimeoutMs ?? parsePosInt(process.env.AI_QUEUE_TIMEOUT_MS, 120_000);
    if (configuredMaxConcurrent !== this.maxConcurrent) {
      logger.warn(
        { configuredMaxConcurrent, effectiveMaxConcurrent: this.maxConcurrent },
        'AI_MAX_CONCURRENT outside supported bounds; clamped to effective concurrency',
      );
    }
    logger.info(
      { maxConcurrent: this.maxConcurrent, queueTimeoutMs: this.queueTimeoutMs },
      'AI request queue initialized',
    );
  }

  /** Number of requests currently executing. */
  get active(): number {
    return this.running;
  }

  /** Number of requests waiting in the queue. */
  get pending(): number {
    return this.waiters.length;
  }

  get stats(): AIRequestQueueStats {
    return {
      maxConcurrent: this.maxConcurrent,
      active: this.running,
      pending: this.waiters.length,
      queueTimeoutMs: this.queueTimeoutMs,
      completedAcquisitions: this.completedAcquisitions,
      averageWaitMs: this.completedAcquisitions > 0
        ? Math.round(this.totalWaitMs / this.completedAcquisitions)
        : 0,
      maxWaitMs: this.maxWaitMs,
    };
  }

  /**
   * Acquire a concurrency slot.  Resolves when a slot is available.
   * Returns a `release` function — the caller MUST call it when done.
   */
  acquire(label?: string): Promise<() => void> {
    const released = { done: false };
    const release = () => {
      if (released.done) return; // idempotent
      released.done = true;
      this.running--;
      this.wake();
    };

    if (this.running < this.maxConcurrent) {
      this.running++;
      this.recordWait(0);
      return Promise.resolve(release);
    }

    return new Promise<() => void>((resolve, reject) => {
      this.waiters.push({
        resolve: () => {
          this.running++;
          resolve(release);
        },
        reject,
        enqueuedAt: Date.now(),
        label,
      });

      if (this.waiters.length % 10 === 0) {
        logger.info({ pending: this.waiters.length, active: this.running }, 'AI request queue depth');
      }
    });
  }

  /**
   * Enqueue a request. Acquires a slot, runs `fn`, and releases the slot
   * automatically when the promise settles.
   */
  async enqueue<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    const release = await this.acquire(label);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Wake up queued waiters when a slot frees up. */
  private wake(): void {
    while (this.running < this.maxConcurrent && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;

      // Check if this waiter has been waiting too long
      const waited = Date.now() - waiter.enqueuedAt;
      if (waited > this.queueTimeoutMs) {
        waiter.reject(new Error(`AI request queue timeout after ${waited}ms wait`));
        continue;
      }

      if (waited > 500) {
        logger.debug({ waitMs: waited, label: waiter.label, pending: this.waiters.length }, 'AI request dequeued');
      }

      this.recordWait(waited);
      waiter.resolve();
    }
  }

  private recordWait(waitMs: number): void {
    const normalized = Number.isFinite(waitMs) && waitMs > 0 ? Math.round(waitMs) : 0;
    this.completedAcquisitions += 1;
    this.totalWaitMs += normalized;
    this.maxWaitMs = Math.max(this.maxWaitMs, normalized);
  }
}

export interface AIRequestQueueStats {
  maxConcurrent: number;
  active: number;
  pending: number;
  queueTimeoutMs: number;
  completedAcquisitions: number;
  averageWaitMs: number;
  maxWaitMs: number;
}

function parsePosInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Module-level singleton — shared across all VllmService instances so a
 * single physical GPU is never overloaded regardless of how many service
 * instances exist in the process.
 */
export const aiRequestQueue = new AIRequestQueue();
