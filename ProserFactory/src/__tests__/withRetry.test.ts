import { withRetry } from '../lib/resilience';

describe('withRetry', () => {
  it('times out and throws ETIMEDOUT when operation exceeds timeout', async () => {
    const slow = async () => await new Promise((r) => setTimeout(r, 50));
    await expect(withRetry(slow as any, 1, undefined, { timeoutMs: 10 })).rejects.toHaveProperty('code', 'ETIMEDOUT');
  });

  it('retries on failure and eventually succeeds', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw new Error('fail first');
      return 'ok';
    };
    const res = await withRetry(fn, 3, undefined, { jitter: true });
    expect(res).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does not replay failures classified as terminal outcomes', async () => {
    const terminal = new Error('typed terminal outcome');
    const fn = jest.fn(async () => { throw terminal; });
    await expect(withRetry(fn, 3, undefined, { shouldRetry: (error) => error !== terminal })).rejects.toBe(terminal);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
