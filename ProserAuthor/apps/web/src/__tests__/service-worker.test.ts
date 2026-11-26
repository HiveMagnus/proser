import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from '@/lib/service-worker';

const ORIGIN = 'https://author.example';
type Listener = (event: Record<string, unknown>) => void;

/** Run public/sw.js against an in-memory cache and a controllable network. */
function loadWorker(network: (request: Request) => Promise<Response>) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, Response>>([
    ['proser-old-v0', new Map()],
    ['other-app', new Map()],
  ]);
  const caches = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        addAll: async (requests: Request[]) => {
          for (const request of requests) {
            const response = await network(request);
            if (!response.ok) throw new TypeError('bad response');
            store.set(new URL(request.url, ORIGIN).pathname, response);
          }
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (request: Request | string, options: { cacheName: string }) => {
      const url = typeof request === 'string' ? request : new URL(request.url).pathname;
      return stores.get(options.cacheName)?.get(url)?.clone();
    },
  };
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  const RelativeRequest = class extends Request {
    constructor(input: string, init?: RequestInit) {
      super(new URL(input, ORIGIN), init);
    }
  };
  runInNewContext(readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8'), {
    self,
    caches,
    fetch: (request: Request) => network(request),
    Request: RelativeRequest,
    Response,
    URL,
    Promise,
  });
  const lifecycle = async (type: string) => {
    let work: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ waitUntil: (promise: Promise<unknown>) => (work = promise) });
    await work;
  };
  const dispatch = (request: Request) => {
    let answer: Promise<Response> | undefined;
    listeners.get('fetch')!({
      request,
      respondWith: (value: Promise<Response>) => (answer = value),
    });
    return answer;
  };
  return { stores, lifecycle, dispatch, self };
}

const page = (path: string) => {
  const request = new Request(`${ORIGIN}${path}`);
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
};

describe('offline shell service worker', () => {
  it('precaches only public shell files, without credentials, and drops older Proser caches', async () => {
    const network = vi.fn(
      async (request: Request) => new Response(`shell:${new URL(request.url).pathname}`),
    );
    const worker = loadWorker(network);
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    const fetched = network.mock.calls.map(([request]) => request);
    expect(fetched.map((request) => new URL(request.url).pathname)).toEqual([
      '/offline.html',
      '/icon.svg',
      '/apple-icon',
      '/manifest.webmanifest',
    ]);
    for (const request of fetched) {
      expect(request.credentials).toBe('omit');
      // A sign-in redirect must never be stored as the offline page.
      expect(request.redirect).toBe('error');
    }
    expect([...worker.stores.keys()].sort()).toEqual(['other-app', 'proser-shell-v1']);
    expect(worker.self.clients.claim).not.toHaveBeenCalled();
  });

  it('never answers API, auth or non-GET requests, so they are never cached', () => {
    const worker = loadWorker(async () => new Response('network'));
    for (const request of [
      new Request(`${ORIGIN}/api/books/1/documents`),
      new Request(`${ORIGIN}/api/auth/session`),
      page('/api/books/1/import-originals/x/content'),
      page('/auth/signin'),
      new Request(`${ORIGIN}/api/books/1`, { method: 'POST', body: '{}' }),
      new Request(`${ORIGIN}/_next/static/chunks/app.js`),
      new Request('https://fonts.googleapis.com/css2'),
    ])
      expect(worker.dispatch(request)).toBeUndefined();
  });

  it('serves pages from the network without caching them and falls back to the offline page', async () => {
    let online = true;
    const network = vi.fn(async (request: Request) => {
      if (!online) throw new TypeError('offline');
      return new Response(`network:${new URL(request.url).pathname}`);
    });
    const worker = loadWorker(network);
    await worker.lifecycle('install');
    expect(await (await worker.dispatch(page('/m'))!).text()).toBe('network:/m');
    expect(worker.stores.get('proser-shell-v1')!.has('/m')).toBe(false);
    online = false;
    expect(await (await worker.dispatch(page('/m'))!).text()).toBe('network:/offline.html');
    expect(await (await worker.dispatch(new Request(`${ORIGIN}/icon.svg`))!).text()).toBe(
      'network:/icon.svg',
    );
  });
});

describe('service worker registration', () => {
  it('registers only in production on a secure origin', async () => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
    const scope = { isSecureContext: true, navigator: { serviceWorker: { register } } };
    expect(registerServiceWorker('development', scope)).toBeNull();
    expect(registerServiceWorker('production', { ...scope, isSecureContext: false })).toBeNull();
    expect(
      registerServiceWorker('production', { isSecureContext: true, navigator: {} }),
    ).toBeNull();
    await registerServiceWorker('production', scope);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
  });

  it('keeps the app working when registration fails', async () => {
    const register = vi.fn(async () => {
      throw new Error('blocked');
    });
    await expect(
      registerServiceWorker('production', {
        isSecureContext: true,
        navigator: { serviceWorker: { register } },
      }),
    ).resolves.toBeUndefined();
  });
});
