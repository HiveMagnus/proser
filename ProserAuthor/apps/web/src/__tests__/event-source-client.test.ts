import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventSourceClient } from '../lib/sse/event-source-client';
import type { ConnectionState } from '../lib/sse/event-source-client';

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(e: { data: string }) => void>>();
  readyState = 0; // CONNECTING

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Simulate async connection
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.onopen?.();
    }, 0);
  }

  addEventListener(type: string, handler: (e: { data: string }) => void) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, handler: (e: { data: string }) => void) {
    const handlers = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      handlers.filter((h) => h !== handler),
    );
  }

  dispatchEvent(type: string, data: string) {
    const handlers = this.listeners.get(type) || [];
    for (const h of handlers) h({ data });
  }

  close() {
    this.readyState = 2; // CLOSED
  }

  static reset() {
    MockEventSource.instances = [];
  }
}

// @ts-ignore - Mock EventSource globally
globalThis.EventSource = MockEventSource as any;

describe('EventSourceClient', () => {
  beforeEach(() => {
    MockEventSource.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes in idle state', () => {
    const client = new EventSourceClient({ url: '/test' });
    expect(client.connectionState).toBe('idle');
  });

  it('transitions to connecting on connect()', async () => {
    const states: ConnectionState[] = [];
    const client = new EventSourceClient({
      url: '/test',
      onStateChange: (s: ConnectionState) => states.push(s),
    });

    client.connect();
    expect(client.connectionState).toBe('connecting');
    expect(states).toContain('connecting');
  });

  it('transitions to connected after EventSource opens', async () => {
    const states: ConnectionState[] = [];
    const client = new EventSourceClient({
      url: '/test',
      onStateChange: (s: ConnectionState) => states.push(s),
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(10);

    expect(client.connectionState).toBe('connected');
    expect(states).toEqual(['connecting', 'connected']);
    client.close();
  });

  it('dispatches events to onEvent handler', async () => {
    const events: Array<{ event: string; data: string }> = [];
    const client = new EventSourceClient({
      url: '/test',
      onEvent: (event: string, data: string) => events.push({ event, data }),
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(10);

    const es = MockEventSource.instances[0]!;
    es.dispatchEvent('token', 'hello ');
    es.dispatchEvent('token', 'world');

    expect(events).toEqual([
      { event: 'token', data: 'hello ' },
      { event: 'token', data: 'world' },
    ]);
    client.close();
  });

  it('close() transitions to closed state', async () => {
    const client = new EventSourceClient({ url: '/test' });
    client.connect();
    await vi.advanceTimersByTimeAsync(10);

    client.close();
    expect(client.connectionState).toBe('closed');
  });

  it('does not reconnect after close()', async () => {
    const client = new EventSourceClient({
      url: '/test',
      baseDelay: 100,
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(10);
    client.close();

    // Should stay closed
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.connectionState).toBe('closed');
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('creates EventSource with correct URL', () => {
    const client = new EventSourceClient({ url: 'http://localhost/api/stream' });
    client.connect();
    expect(MockEventSource.instances[0]!.url).toBe('http://localhost/api/stream');
    client.close();
  });

  it('resolves a fresh URL for every safe reconnect', async () => {
    let cursor = 1;
    const client = new EventSourceClient({
      url: () => `/resume?cursor=${cursor}`,
      baseDelay: 100,
      maxRetries: 1,
    });
    client.connect();
    expect(MockEventSource.instances[0]!.url).toBe('/resume?cursor=1');
    cursor = 9;
    MockEventSource.instances[0]!.onerror?.();
    await vi.advanceTimersByTimeAsync(200);
    expect(MockEventSource.instances[1]!.url).toBe('/resume?cursor=9');
    client.close();
  });

  it('handles done event', async () => {
    const events: Array<{ event: string; data: string }> = [];
    const client = new EventSourceClient({
      url: '/test',
      onEvent: (event: string, data: string) => events.push({ event, data }),
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(10);

    const es = MockEventSource.instances[0]!;
    es.dispatchEvent('done', '{}');

    expect(events).toEqual([{ event: 'done', data: '{}' }]);
    client.close();
  });

  it('handles error event', async () => {
    const events: Array<{ event: string; data: string }> = [];
    const client = new EventSourceClient({
      url: '/test',
      onEvent: (event: string, data: string) => events.push({ event, data }),
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(10);

    const es = MockEventSource.instances[0]!;
    es.dispatchEvent('error', '{"message":"fail"}');

    expect(events).toEqual([{ event: 'error', data: '{"message":"fail"}' }]);
    client.close();
  });

  it('connect() is idempotent when already connected', async () => {
    const client = new EventSourceClient({ url: '/test' });
    client.connect();
    await vi.advanceTimersByTimeAsync(10);

    client.connect(); // Should not create another EventSource
    expect(MockEventSource.instances).toHaveLength(1);
    client.close();
  });
});
