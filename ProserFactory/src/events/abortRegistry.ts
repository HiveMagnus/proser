export class AbortRegistry {
  private controllers = new Map<string, AbortController>();

  create(sessionId: string): AbortSignal {
    const existing = this.controllers.get(sessionId);
    if (existing) return existing.signal;
    const c = new AbortController();
    this.controllers.set(sessionId, c);
    return c.signal;
  }

  get(sessionId: string): AbortSignal | undefined {
    return this.controllers.get(sessionId)?.signal;
  }

  abort(sessionId: string): void {
    const c = this.controllers.get(sessionId);
    if (c) c.abort();
    this.controllers.delete(sessionId);
  }

  clear(sessionId: string): void {
    this.controllers.delete(sessionId);
  }
}

export const globalAbortRegistry = new AbortRegistry();
