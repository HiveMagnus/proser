import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProseStream, useWizardStream } from '../hooks/use-streams';
import {
  cancelGenerationOperation,
  createProseOperation,
  getGenerationArtifact,
  lookupGenerationOperation,
} from '../lib/api';

vi.mock('../lib/api', () => ({
  createProseOperation: vi.fn(),
  lookupGenerationOperation: vi.fn(),
  getGenerationArtifact: vi.fn(),
  cancelGenerationOperation: vi.fn(async () => undefined),
}));

function receipt(operationId: string) {
  return {
    operationId,
    idempotencyKey: 'test-key',
    requestHash: 'a'.repeat(64),
    route: 'generate.prose',
    status: 'pending' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    latestCursor: 0,
  };
}

class MockEventSource {
  static latest: MockEventSource | null = null;
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private listeners = new Map<string, EventListener>();

  constructor(public readonly url: string) {
    MockEventSource.latest = this;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as unknown as Event);
  }

  close() {}
}

describe('useProseStream', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource);
    window.sessionStorage.clear();
    vi.mocked(createProseOperation).mockReset();
    vi.mocked(cancelGenerationOperation).mockReset();
    vi.mocked(cancelGenerationOperation).mockResolvedValue({
      ...receipt('cancelled-operation'),
      status: 'cancelled',
    });
    vi.mocked(lookupGenerationOperation).mockReset();
    vi.mocked(getGenerationArtifact).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    MockEventSource.latest = null;
    MockEventSource.instances = [];
  });

  it('stages tokens and commits only after matching metadata, hash, and terminal frames', async () => {
    const { result } = renderHook(() => useProseStream());
    vi.mocked(createProseOperation).mockResolvedValue(receipt('op-1'));
    await act(async () => result.current.start({ bookId: '42' }));
    const stream = MockEventSource.latest!;

    act(() => {
      stream.emit('start', { operationId: 'op-1', cursor: 1 });
      stream.emit('token', { operationId: 'op-1', cursor: 2, text: 'provisional prose' });
    });
    expect(result.current.status).toBe('streaming');
    expect(result.current.text).toBe('');

    act(() => {
      stream.emit('meta', {
        operationId: 'op-1',
        wordCount: 2,
        model: 'test',
        terminalReason: 'stop',
        authoritative: true,
        artifactHash: '1f6546ea83c90ec7fd3bf95bb735a67645132c296039d122c434068499c4fcf2',
        cursor: 3,
      });
      stream.emit('done', {
        operationId: 'op-1',
        cursor: 4,
        status: 'committed',
        artifactHash: '1f6546ea83c90ec7fd3bf95bb735a67645132c296039d122c434068499c4fcf2',
      });
    });
    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.text).toBe('provisional prose');
    expect(result.current.meta?.operationId).toBe('op-1');
  });

  it('discards provisional text on a typed stream error', async () => {
    const { result } = renderHook(() => useProseStream());
    vi.mocked(createProseOperation).mockResolvedValue(receipt('op-2'));
    await act(async () => result.current.start({ bookId: '42' }));
    const stream = MockEventSource.latest!;

    act(() => {
      stream.emit('start', { operationId: 'op-2', cursor: 1 });
      stream.emit('token', { operationId: 'op-2', cursor: 2, text: 'must not commit' });
      stream.emit('error', {
        operationId: 'op-2',
        cursor: 3,
        code: 'STREAM_TRUNCATED',
        message: 'Generation stopped before the response was complete.',
        correlationId: 'ref-1',
        partial: 'discard',
      });
    });
    expect(result.current.status).toBe('error');
    expect(result.current.text).toBe('');
    expect(result.current.error).toContain('ref-1');
    expect(window.sessionStorage.length).toBe(0);
  });

  it('creates by POST and subscribes using only operation ID and cursor', async () => {
    const { result } = renderHook(() => useProseStream());
    vi.mocked(createProseOperation).mockResolvedValue(receipt('op-resume'));
    await act(async () =>
      result.current.start({ bookId: '42', targetWords: 250, prompt: 'secret manuscript text' }),
    );
    const initial = MockEventSource.latest!;
    act(() => {
      initial.emit('start', { operationId: 'op-resume', cursor: 1 });
      initial.emit('token', { operationId: 'op-resume', cursor: 2, text: 'safe prefix ' });
      initial.onerror?.();
    });

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2), { timeout: 2_000 });
    expect(createProseOperation).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'secret manuscript text' }),
      expect.any(String),
    );
    expect(MockEventSource.instances[0]!.url).not.toContain('secret');
    expect(MockEventSource.instances[1]!.url).toContain(
      '/api/generate/operations/op-resume/stream?cursor=2&limit=500',
    );
  });

  it('discards provisional prose that exceeds its derived browser limit', async () => {
    const { result } = renderHook(() => useProseStream());
    vi.mocked(createProseOperation).mockResolvedValue(receipt('op-large'));
    await act(async () => result.current.start({ bookId: '42', targetWords: 50 }));
    const stream = MockEventSource.latest!;
    act(() => {
      stream.emit('start', { operationId: 'op-large', cursor: 1 });
      stream.emit('token', { operationId: 'op-large', cursor: 2, text: 'x'.repeat(17_000) });
    });
    expect(result.current.status).toBe('error');
    expect(result.current.text).toBe('');
    expect(result.current.error).toContain('safety limits');
  });

  it('rejects a terminal artifact hash that does not match provisional prose', async () => {
    const { result } = renderHook(() => useProseStream());
    vi.mocked(createProseOperation).mockResolvedValue(receipt('op-hash'));
    await act(async () => result.current.start({ bookId: '42' }));
    const stream = MockEventSource.latest!;
    act(() => {
      stream.emit('start', { operationId: 'op-hash', cursor: 1 });
      stream.emit('token', { operationId: 'op-hash', cursor: 2, text: 'two words' });
      stream.emit('meta', {
        operationId: 'op-hash',
        cursor: 3,
        wordCount: 2,
        model: 'test',
        terminalReason: 'stop',
        authoritative: true,
        artifactHash: '0'.repeat(64),
      });
      stream.emit('done', {
        operationId: 'op-hash',
        cursor: 4,
        status: 'committed',
        artifactHash: '0'.repeat(64),
      });
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.text).toBe('');
    expect(result.current.error).toContain('artifact verification failed');
  });

  it('distinguishes stop watching from server-side cancellation', async () => {
    const { result } = renderHook(() => useProseStream());
    vi.mocked(createProseOperation).mockResolvedValue(receipt('op-cancel'));
    await act(async () => result.current.start({ bookId: '42', prompt: 'private' }));

    act(() => result.current.stopWatching());
    expect(cancelGenerationOperation).not.toHaveBeenCalled();
    expect(result.current.status).toBe('detached');
    expect(window.sessionStorage.length).toBe(1);

    vi.mocked(createProseOperation).mockResolvedValue(receipt('op-cancel-2'));
    await act(async () => result.current.start({ bookId: '42', prompt: 'private' }));
    await act(async () => result.current.cancel());
    expect(cancelGenerationOperation).toHaveBeenCalledWith('op-cancel-2');
  });

  it('cancels an operation receipt that arrives after a newer generation supersedes it', async () => {
    let resolveStale!: (value: ReturnType<typeof receipt>) => void;
    vi.mocked(createProseOperation)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockResolvedValueOnce(receipt('op-current'));
    vi.mocked(cancelGenerationOperation).mockResolvedValue({
      ...receipt('op-stale'),
      status: 'cancelled',
    });
    const { result } = renderHook(() => useProseStream());

    act(() => {
      void result.current.start({ bookId: '42', prompt: 'stale' });
    });
    await waitFor(() => expect(createProseOperation).toHaveBeenCalledTimes(1));
    await act(async () => result.current.start({ bookId: '42', prompt: 'current' }));
    await act(async () => resolveStale(receipt('op-stale')));

    await waitFor(() => expect(cancelGenerationOperation).toHaveBeenCalledWith('op-stale'));
  });

  it('retains a late operation receipt as detached when its component unmounts', async () => {
    let resolveLate!: (value: ReturnType<typeof receipt>) => void;
    vi.mocked(createProseOperation).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useProseStream());
    act(() => {
      void result.current.start({ bookId: '42', prompt: 'continue in background' });
    });
    await waitFor(() => expect(createProseOperation).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => resolveLate(receipt('op-detached-after-unmount')));

    expect(cancelGenerationOperation).not.toHaveBeenCalled();
    const retained = JSON.parse(window.sessionStorage.getItem(window.sessionStorage.key(0)!)!);
    expect(retained).toMatchObject({
      state: 'detached',
      operationId: 'op-detached-after-unmount',
    });
  });

  it('restores a retained receipt after reload and reconnects with its exact key', async () => {
    const retainedKey = 'retained-key';
    window.sessionStorage.setItem(
      `proser:generation:${retainedKey}`,
      JSON.stringify({
        version: 1,
        idempotencyKey: retainedKey,
        request: { bookId: 42, prompt: 'recover me' },
        state: 'creating',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    vi.mocked(lookupGenerationOperation).mockResolvedValue(receipt('op-restored'));
    vi.mocked(createProseOperation).mockResolvedValue(receipt('op-restored'));

    renderHook(() => useProseStream());

    await waitFor(() =>
      expect(createProseOperation).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, prompt: 'recover me' }),
        retainedKey,
      ),
    );
    await waitFor(() =>
      expect(MockEventSource.latest?.url).toContain(
        '/api/generate/operations/op-restored/stream?cursor=0&limit=500',
      ),
    );
  });
});

describe('useWizardStream', () => {
  it('is a function', () => {
    expect(typeof useWizardStream).toBe('function');
  });
});
