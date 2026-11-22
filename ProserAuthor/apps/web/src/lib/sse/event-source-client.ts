/**
 * EventSourceClient — Robust SSE client with retry, exponential backoff,
 * jitter, and online/offline awareness.
 */

export type ConnectionState =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export interface EventSourceClientOptions {
  /** URL to connect to */
  url: string | (() => string);
  /** Max reconnection attempts (default: 10) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseDelay?: number;
  /** Max delay cap in ms (default: 30000) */
  maxDelay?: number;
  /** Event handlers by event type */
  onEvent?: (event: string, data: string) => void;
  /** Called when connection state changes */
  onStateChange?: (state: ConnectionState) => void;
  /** Called on fatal error or max retries exceeded */
  onError?: (error: Error) => void;
}

export class EventSourceClient {
  private es: EventSource | null = null;
  private state: ConnectionState = 'idle';
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private readonly opts: Required<
    Pick<EventSourceClientOptions, 'url' | 'maxRetries' | 'baseDelay' | 'maxDelay'>
  > &
    EventSourceClientOptions;

  constructor(options: EventSourceClientOptions) {
    this.opts = {
      maxRetries: 10,
      baseDelay: 1000,
      maxDelay: 30_000,
      ...options,
    };
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Start the SSE connection */
  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') return;

    // Online/offline awareness
    if (typeof window !== 'undefined' && !navigator.onLine) {
      this.setState('error');
      this.opts.onError?.(new Error('Browser is offline'));
      this.waitForOnline();
      return;
    }

    this.abortController = new AbortController();
    this.setState('connecting');
    this.createEventSource();
  }

  /** Close the connection permanently */
  close(): void {
    this.setState('closed');
    this.cleanup();
  }

  private createEventSource(): void {
    try {
      const url = typeof this.opts.url === 'function' ? this.opts.url() : this.opts.url;
      this.es = new EventSource(url);

      this.es.onopen = () => {
        this.retryCount = 0;
        this.setState('connected');
      };

      this.es.onmessage = (event) => {
        this.opts.onEvent?.('message', event.data);
      };

      this.es.onerror = () => {
        if (this.state === 'closed') return;
        this.es?.close();
        this.es = null;
        this.scheduleRetry();
      };

      // Listen for named events — EventSource only fires 'message' by default,
      // so we use addEventListener for the specific event types we care about
      const eventTypes = [
        'start',
        'token',
        'meta',
        'trace',
        'done',
        'error',
        'replay_error',
        'progress',
        'ping',
      ];
      for (const type of eventTypes) {
        this.es.addEventListener(type, ((event: MessageEvent) => {
          this.opts.onEvent?.(type, event.data);
        }) as EventListener);
      }
    } catch {
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.state === 'closed') return;

    if (this.retryCount >= this.opts.maxRetries) {
      this.setState('error');
      this.opts.onError?.(new Error(`Max retries (${this.opts.maxRetries}) exceeded`));
      return;
    }

    this.setState('reconnecting');
    this.retryCount++;

    // Exponential backoff with jitter
    const delay = Math.min(
      this.opts.baseDelay * Math.pow(2, this.retryCount - 1),
      this.opts.maxDelay,
    );
    const jitter = delay * 0.3 * Math.random();
    const finalDelay = delay + jitter;

    this.retryTimer = setTimeout(() => {
      if (this.state === 'closed') return;

      if (typeof window !== 'undefined' && !navigator.onLine) {
        this.waitForOnline();
        return;
      }

      this.createEventSource();
    }, finalDelay);
  }

  private waitForOnline(): void {
    if (typeof window === 'undefined') return;

    const handler = () => {
      window.removeEventListener('online', handler);
      if (this.state !== 'closed') {
        this.connect();
      }
    };

    window.addEventListener('online', handler);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
  }

  private cleanup(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
