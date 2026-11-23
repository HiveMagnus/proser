import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const authMock = vi.fn();

vi.mock('@/auth', () => ({
  auth: authMock,
}));

describe('Factory API proxy', () => {
  it('streams original imports beyond the generic response ceiling with exact size/checksum and private headers', async () => {
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    const bytes = new Uint8Array(9 * 1024 * 1024).fill(65);
    const digest = createHash('sha256').update(bytes).digest('hex');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          headers: {
            'content-length': String(bytes.byteLength),
            'content-type': 'application/json',
            'cache-control': 'private, no-store',
            'x-content-sha256': digest,
          },
        }),
      ),
    );
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(
      new NextRequest(
        'https://author.example/api/books/1/import-originals/00000000-0000-4000-8000-000000000001/content',
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-sha256')).toBe(digest);
    expect((await response.arrayBuffer()).byteLength).toBe(bytes.byteLength);
  });
  it('streams revision-bound PDF artifacts with exact SHA and safe Factory filenames beyond the generic ceiling', async () => {
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    const bytes = new Uint8Array(9 * 1024 * 1024).fill(65);
    const digest = createHash('sha256').update(bytes).digest('hex');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          headers: {
            'content-length': String(bytes.byteLength),
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="Owned_book.pdf"',
            'x-content-sha256': digest,
          },
        }),
      ),
    );
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(
      new NextRequest(
        'https://author.example/api/books/1/document-publication-artifacts/00000000-0000-4000-8000-000000000001/download',
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toContain('Owned_book.pdf');
    expect((await response.arrayBuffer()).byteLength).toBe(bytes.byteLength);
  });
  it('fails completion when retained artifact bytes do not match the declared digest', async () => {
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('corrupt', {
          headers: {
            'content-length': '7',
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="Owned_book.pdf"',
            'x-content-sha256': 'a'.repeat(64),
          },
        }),
      ),
    );
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(
      new NextRequest(
        'https://author.example/api/books/1/document-publication-artifacts/00000000-0000-4000-8000-000000000001/download',
      ),
    );
    await expect(response.arrayBuffer()).rejects.toThrow('UPSTREAM_PUBLICATION_DIGEST_MISMATCH');
  });
  it('rejects missing digest or unsafe authoritative artifact filename before forwarding bytes', async () => {
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('safe', {
          headers: {
            'content-length': '4',
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="Owned_book.pdf"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('safe', {
          headers: {
            'content-length': '4',
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="../unsafe.pdf"',
            'x-content-sha256': 'a'.repeat(64),
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const url =
      'https://author.example/api/books/1/document-publication-artifacts/00000000-0000-4000-8000-000000000001/download';
    expect(await (await GET(new NextRequest(url))).json()).toMatchObject({
      error: { code: 'UPSTREAM_PUBLICATION_DIGEST_INVALID' },
    });
    expect(await (await GET(new NextRequest(url))).json()).toMatchObject({
      error: { code: 'UPSTREAM_PUBLICATION_FILENAME_INVALID' },
    });
  });
  it('forwards authenticated DOCX originals as streaming bytes and rejects a declared upload over 32 MiB', async () => {
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{"success":true}', { headers: { 'content-type': 'application/json' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const url =
      'https://author.example/api/books/1/docx-import-originals/00000000-0000-4000-8000-000000000001';
    const response = await POST(
      new NextRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
        body: new Uint8Array([80, 75, 3, 4]),
      }),
    );
    expect(response.status).toBe(200);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect((init.headers as Headers).get('content-type')).toBe('application/octet-stream');
    const oversized = await POST(
      new NextRequest(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(32 * 1024 * 1024 + 1),
        },
        body: 'fixture',
      }),
    );
    expect(oversized.status).toBe(413);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('refuses an outdated browser identity before dispatching a read or new-book mutation', async () => {
    authMock.mockResolvedValue({
      user: { id: 'new-author', username: 'new-author', provider: 'iam' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET, POST } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(
      new NextRequest('https://author.example/api/books', {
        headers: { 'x-proser-expected-user': 'old-author' },
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'SESSION_SCOPE_CHANGED' } });
    const mutation = await POST(
      new NextRequest('https://author.example/api/books', {
        method: 'POST',
        headers: { 'x-proser-expected-user': 'old-author', 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Private original draft',
          operationId: 'original-operation',
        }),
      }),
    );
    expect(mutation.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses matching browser identity only as a precondition and strips it before Factory dispatch', async () => {
    authMock.mockResolvedValue({
      user: { id: 'same-author', username: 'actual-author', provider: 'iam' },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{"ok":true,"data":[]}', { headers: { 'content-type': 'application/json' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(
      new NextRequest('https://author.example/api/books', {
        headers: {
          'x-proser-expected-user': 'same-author',
          'x-user-id': '1',
          'x-github-id': 'iam:someone-else',
          'x-internal-secret': 'guess',
          'x-nova-caller': 'operator',
          'x-forwarded-for': '203.0.113.9',
          'idempotency-key': 'kept',
        },
      }),
    );
    expect(response.status).toBe(200);
    const forwarded = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(forwarded.get('x-proser-expected-user')).toBeNull();
    for (const name of [
      'x-user-id',
      'x-github-id',
      'x-internal-secret',
      'x-nova-caller',
      'x-forwarded-for',
    ]) {
      expect(forwarded.get(name)).toBeNull();
    }
    expect(forwarded.get('idempotency-key')).toBe('kept');
    expect(authMock).toHaveBeenCalledTimes(1);
  });
  const originalFactoryUrl = process.env.FACTORY_URL;
  const originalSecret = process.env.FACTORY_AUTH_SECRET;

  beforeEach(() => {
    process.env.FACTORY_URL = 'https://factory.example';
    process.env.FACTORY_AUTH_SECRET = 'test-secret';
    authMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    process.env.FACTORY_URL = originalFactoryUrl;
    process.env.FACTORY_AUTH_SECRET = originalSecret;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('requests identity encoding and strips upstream content-encoding headers', async () => {
    authMock.mockResolvedValue({
      user: {
        id: '42',
        username: 'fixture-author',
        provider: 'iam',
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"ok":true,"data":{"entries":[]}}', {
        status: 200,
        headers: {
          'content-encoding': 'gzip',
          'content-type': 'application/json',
          location: 'http://factory.internal/private',
          'set-cookie': 'factory-session=unsafe; Path=/',
          'www-authenticate': 'Bearer realm="factory"',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');

    const response = await GET(
      new NextRequest('https://author.example/api/books/10/codex?pageSize=200'),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://factory.example/api/books/10/codex?pageSize=200');

    const headers = init.headers as Headers;
    expect(headers.get('accept-encoding')).toBe('identity');
    expect(headers.get('authorization')).toMatch(/^Bearer /);
    const payload = JSON.parse(
      Buffer.from(headers.get('authorization')!.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      sub: 'iam:fixture-author',
      githubId: 'iam:fixture-author',
      username: 'fixture-author',
      iss: 'proser-author',
      aud: 'proser-factory',
    });

    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.text()).resolves.toContain('"entries":[]');
  });

  it('allows only public readiness without forwarding browser credentials', async () => {
    authMock.mockResolvedValue(null);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const { GET, POST } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    await GET(
      new NextRequest('https://author.example/api/readiness', {
        headers: {
          authorization: 'Bearer browser-controlled',
          cookie: 'private=session',
          'content-type': 'application/json',
          'keep-alive': 'timeout=5',
          'proxy-authorization': 'Basic private',
          trailer: 'x-checksum',
          upgrade: 'websocket',
        },
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('keep-alive')).toBeNull();
    expect(headers.get('proxy-authorization')).toBeNull();
    expect(headers.get('trailer')).toBeNull();
    expect(headers.get('upgrade')).toBeNull();

    const rejected = await POST(
      new NextRequest('https://author.example/api/readiness', { method: 'POST', body: '{}' }),
    );
    expect(rejected.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a session on every non-allowlisted Factory route', async () => {
    authMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(new NextRequest('https://author.example/api/books'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTH_REQUIRED' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when an authenticated request has no Factory signing secret', async () => {
    delete process.env.FACTORY_AUTH_SECRET;
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();

    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(new NextRequest('https://author.example/api/books'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Factory authentication is not configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects workflow responses larger than the endpoint limit', async () => {
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(2 * 1024 * 1024) },
        }),
      ),
    );
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(new NextRequest('https://author.example/api/workflows/run-1'));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UPSTREAM_RESPONSE_TOO_LARGE' },
    });
  });

  it('times out a stalled Factory request with a typed proxy error', async () => {
    vi.useFakeTimers();
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    );
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const request = GET(new NextRequest('https://author.example/api/workflows/run-1'));
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await request;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'UPSTREAM_TIMEOUT' } });
  });

  it('rejects upstream redirects without exposing their destination', async () => {
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'http://factory.internal/admin' },
        }),
      ),
    );
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(new NextRequest('https://author.example/api/books'));

    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UPSTREAM_REDIRECT_REJECTED' },
    });
  });

  it('streams validated publication downloads with reconstructed safe headers', async () => {
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    const chunks = [
      new TextEncoder().encode('chapter one'),
      new TextEncoder().encode('chapter two'),
    ];
    const total = chunks.reduce((bytes, chunk) => bytes + chunk.byteLength, 0);
    let index = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            pull(controller) {
              if (index >= chunks.length) controller.close();
              else controller.enqueue(chunks[index++]);
            },
          }),
          {
            status: 200,
            headers: {
              'content-length': String(total),
              'content-type': 'application/epub+zip',
              'content-disposition': 'attachment; filename="untrusted.epub"',
              'set-cookie': 'unsafe=yes',
            },
          },
        ),
      ),
    );
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(
      new NextRequest(
        'https://author.example/api/workflows/run-1/publication/My%20Finished%20Book.epub',
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(total));
    expect(response.headers.get('content-disposition')).toContain(
      'filename="My Finished Book.epub"',
    );
    expect(response.headers.get('content-disposition')).not.toContain('untrusted.epub');
    expect(response.headers.get('set-cookie')).toBeNull();
    await expect(response.text()).resolves.toBe('chapter onechapter two');
  });

  it('passes authenticated generation SSE through incrementally for cursor subscriptions', async () => {
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    const firstFrame = new TextEncoder().encode(
      'event: token\ndata: {"operationId":"op-1","cursor":2,"text":"hello"}\n\n',
    );
    let sent = false;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(firstFrame);
            }
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(
      new NextRequest(
        'https://author.example/api/generate/operations/op-1/stream?cursor=1&limit=500',
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('content-length')).toBeNull();
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: firstFrame });
    await reader.cancel();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain('/api/generate/operations/op-1/stream?cursor=1&limit=500');
    expect((init.headers as Headers).get('authorization')).toMatch(/^Bearer /);
  });

  it('rejects a generation subscription that is not event-stream media', async () => {
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>sign in</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(
      new NextRequest('https://author.example/api/generate/operations/op-1/stream?cursor=0'),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UPSTREAM_SSE_TYPE_INVALID' },
    });
  });

  it('renews the publication idle timeout whenever download bytes arrive', async () => {
    vi.useFakeTimers();
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    const chunk = new TextEncoder().encode('steady progress');
    let sent = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            async pull(controller) {
              if (sent === 4) {
                controller.close();
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 20_000));
              controller.enqueue(chunk);
              sent += 1;
            },
          }),
          {
            status: 200,
            headers: {
              'content-length': String(chunk.byteLength * 4),
              'content-type': 'text/markdown',
            },
          },
        ),
      ),
    );
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(
      new NextRequest('https://author.example/api/workflows/run-1/publication/book.md'),
    );
    const content = response.text();
    for (let index = 0; index < 4; index += 1) await vi.advanceTimersByTimeAsync(20_000);
    await expect(content).resolves.toBe('steady progress'.repeat(4));
  });

  it('uses the short publication timeout only while waiting for headers', async () => {
    vi.useFakeTimers();
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    );
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const request = GET(
      new NextRequest('https://author.example/api/workflows/run-1/publication/book.epub'),
    );
    await vi.advanceTimersByTimeAsync(14_999);
    let settled = false;
    void request.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await request).status).toBe(504);
  });

  it('rejects publication downloads without a known content length', async () => {
    authMock.mockResolvedValue({ user: { id: '42', username: 'author', provider: 'iam' } });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('book', { status: 200, headers: { 'content-type': 'text/markdown' } }),
        ),
    );
    const { GET } = await import('@/app/api/[...path]/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(
      new NextRequest('https://author.example/api/workflows/run-1/publication/book.md'),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UPSTREAM_RESPONSE_SIZE_REQUIRED' },
    });
  });
});
