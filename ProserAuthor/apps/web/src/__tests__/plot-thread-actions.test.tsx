import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlotThreadActions } from '@/hooks/use-plot-thread-actions';
import { FactoryRequestError } from '@/lib/api';
import type { PlotThreadIntent } from '@/lib/plot-thread-journal';
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  request: vi.fn(),
}));
vi.mock('@/lib/plot-thread-journal', () => ({
  readPlotThreadIntent: mocks.read,
  writePlotThreadIntent: mocks.write,
  deletePlotThreadIntent: mocks.remove,
}));
vi.mock('@/lib/plot-thread-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plot-thread-api')>()),
  plotRequest: mocks.request,
}));
const original: PlotThreadIntent = {
  userId: 'owner',
  bookId: '7',
  operationId: 'original',
  kind: 'mutation',
  method: 'POST',
  path: '/api/books/7/plot-threads',
  recoveryPath: '/receipt',
  body: { operationId: 'original', expectedVersion: 0, question: 'Who betrayed her?' },
};
const receipt = { operationId: 'original', threadId: 4, version: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(undefined);
  mocks.write.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
});
const mounted = async () => {
  const view = renderHook(() => usePlotThreadActions('owner', '7'));
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  return view;
};
describe('Plot Threads action recovery', () => {
  it('returns the original create receipt after a dropped acknowledgment', async () => {
    mocks.read.mockResolvedValue(original);
    const view = await mounted();
    mocks.request.mockResolvedValue(receipt);
    let recovered;
    await act(async () => {
      recovered = await view.result.current.recover();
    });
    expect(recovered).toEqual({ intent: original, result: receipt });
    expect(mocks.request).toHaveBeenCalledWith('/receipt', 'owner');
    expect(mocks.remove).toHaveBeenCalledWith('owner', '7', 'original');
    expect(view.result.current.blocked).toBe(false);
  });
  it('clears a no-receipt replay rejected for stale source, preserving unknown transport attempts', async () => {
    mocks.read.mockResolvedValue(original);
    const view = await mounted();
    mocks.request
      .mockRejectedValueOnce(
        new FactoryRequestError(404, 'No original receipt', 'PLOT_THREAD_OPERATION_NOT_FOUND'),
      )
      .mockRejectedValueOnce(
        new FactoryRequestError(412, 'Select the saved source again', 'DOCUMENT_SOURCE_STALE'),
      );
    await act(async () => {
      await view.result.current.retry();
    });
    expect(view.result.current.pending).toBeUndefined();
    expect(view.result.current.error).toContain('saved source');
    expect(mocks.remove).toHaveBeenCalledWith('owner', '7', 'original');
  });
  it('never redispatches a recovered unknown provider operation', async () => {
    const intent = { ...original, kind: 'review' as const };
    mocks.read.mockResolvedValue(intent);
    const view = await mounted();
    mocks.request.mockResolvedValue({ id: 'original', status: 'unknown' });
    await act(async () => {
      await view.result.current.retry();
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith('/receipt', 'owner');
    expect(view.result.current.pending).toBeUndefined();
  });
  it('retains running and malformed acknowledgments without reporting successful recovery', async () => {
    const intent = { ...original, kind: 'review' as const };
    mocks.read.mockResolvedValue(intent);
    const view = await mounted();
    mocks.request.mockResolvedValue({ id: 'original', status: 'running' });
    let recovered;
    await act(async () => {
      recovered = await view.result.current.recover();
    });
    expect(recovered).toBeUndefined();
    expect(view.result.current.pending).toEqual(intent);
    mocks.request.mockResolvedValue({ id: 'original' });
    await act(async () => {
      recovered = await view.result.current.retry();
    });
    expect(recovered).toBeUndefined();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
  it('adopts another tab’s durable slot if a competing journal write fails', async () => {
    const view = await mounted();
    mocks.write.mockRejectedValue(new Error('Competing journal request'));
    mocks.read.mockResolvedValue(original);
    await act(async () => {
      await expect(
        view.result.current.dispatch({
          ...original,
          operationId: 'new',
          body: { operationId: 'new' },
        }),
      ).rejects.toThrow('Competing');
    });
    expect(view.result.current.pending).toEqual(original);
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.request.mockResolvedValue(receipt);
    await act(async () => {
      await view.result.current.recover();
    });
    expect(view.result.current.pending).toBeUndefined();
  });
  it('does not let late reads from another identity replace current recovery state', async () => {
    let complete!: (value: PlotThreadIntent | undefined) => void;
    mocks.read
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const view = renderHook(({ user }) => usePlotThreadActions(user, '7'), {
      initialProps: { user: 'owner' },
    });
    view.rerender({ user: 'other' });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    await act(async () => {
      complete(original);
    });
    expect(view.result.current.pending).toBeUndefined();
  });
  it('prevents two synchronous dispatches from issuing competing calls', async () => {
    const view = await mounted();
    let complete!: (value: unknown) => void;
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { userId: _user, bookId: _book, ...input } = original;
    let first!: Promise<unknown>;
    await act(async () => {
      first = view.result.current.dispatch(input);
      await expect(view.result.current.dispatch(input)).rejects.toThrow('previous request');
      await Promise.resolve();
    });
    await act(async () => {
      complete(receipt);
      await first;
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});
