import { afterEach, describe, expect, it, vi } from 'vitest';

import { FactoryResponseTooLargeError, FactoryTimeoutError, listBookWorkflows } from '@/lib/api';

describe('Factory browser client safety', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns a typed oversized-response error before parsing JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(9 * 1024 * 1024) },
        }),
      ),
    );

    await expect(listBookWorkflows('4')).rejects.toBeInstanceOf(FactoryResponseTooLargeError);
  });

  it('cancels a stalled request at the default timeout with a typed error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    );

    const request = listBookWorkflows('4');
    const assertion = expect(request).rejects.toBeInstanceOf(FactoryTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('never starts fetch when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Stale request', 'AbortError'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(listBookWorkflows('4', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
