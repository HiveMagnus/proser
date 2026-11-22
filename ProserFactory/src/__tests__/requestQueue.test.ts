import { AIRequestQueue } from '../lib/ai/requestQueue';

describe('AIRequestQueue', () => {
  it('honors configured parallelism instead of serializing every request', async () => {
    const queue = new AIRequestQueue({ maxConcurrent: 3, queueTimeoutMs: 10_000 });
    let active = 0;
    let peak = 0;
    let releaseTasks: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTasks = resolve;
    });

    const tasks = Array.from({ length: 6 }, () =>
      queue.enqueue(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return true;
      }),
    );

    await waitFor(() => queue.active === 3 && queue.pending === 3);
    expect(queue.active).toBe(3);
    expect(queue.pending).toBe(3);
    expect(queue.stats.maxConcurrent).toBe(3);
    expect(queue.stats.active).toBe(3);
    expect(queue.stats.pending).toBe(3);
    expect(peak).toBe(3);

    releaseTasks?.();
    await expect(Promise.all(tasks)).resolves.toEqual([true, true, true, true, true, true]);
    expect(queue.active).toBe(0);
    expect(queue.pending).toBe(0);
    expect(queue.stats.completedAcquisitions).toBe(6);
    expect(queue.stats.averageWaitMs).toEqual(expect.any(Number));
  });

  it('clamps configured concurrency to supported bounds', async () => {
    const queue = new AIRequestQueue({ maxConcurrent: 100, queueTimeoutMs: 10_000 });
    let releaseTask: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });

    const tasks = Array.from({ length: 40 }, () =>
      queue.enqueue(async () => {
        await gate;
        return true;
      }),
    );

    await waitFor(() => queue.active === 32 && queue.pending === 8);
    expect(queue.active).toBe(32);
    expect(queue.pending).toBe(8);

    releaseTask?.();
    await Promise.all(tasks);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for queue state');
}
