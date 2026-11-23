import { createHash, createHmac } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';

const FACTORY_URL = process.env.FACTORY_URL;
const FACTORY_AUTH_SECRET = process.env.FACTORY_AUTH_SECRET || '';
const FACTORY_AUTH_ISSUER = process.env.FACTORY_AUTH_ISSUER || 'proser-author';
const FACTORY_AUTH_AUDIENCE = process.env.FACTORY_AUTH_AUDIENCE || 'proser-factory';
const DEFAULT_PROXY_TIMEOUT_MS = 30_000;
const DEFAULT_PROXY_RESPONSE_LIMIT = 8 * 1024 * 1024;
const PUBLICATION_HEADER_TIMEOUT_MS = 15_000;
const PUBLICATION_IDLE_TIMEOUT_MS = 30_000;
const PUBLIC_PROXY_ROUTES = new Set(['/api/readiness']);
const PUBLICATION_MEDIA_TYPES = new Set([
  'application/pdf',
  'application/epub+zip',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'text/html',
  'text/markdown',
  'text/plain',
]);

const REQUEST_HEADERS_TO_STRIP = new Set([
  'x-proser-expected-user',
  // Identity, internal and network-origin headers that Factory may interpret.
  // The proxy alone asserts who the caller is, through the signed token.
  'forwarded',
  'x-avatar-url',
  'x-email',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-github-id',
  'x-internal-secret',
  'x-metrics-token',
  'x-nova-caller',
  'x-nova-request',
  'x-proser-auth-source',
  'x-real-ip',
  'x-user-id',
  'x-username',
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const RESPONSE_HEADERS_TO_STRIP = new Set([
  'connection',
  'content-disposition',
  'content-encoding',
  'content-location',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'refresh',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'www-authenticate',
  'location',
]);

function normalizeIamUsername(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  const atIndex = raw.indexOf('@');
  return atIndex > 0 ? raw.slice(0, atIndex) : raw;
}

function base64Url(input: string) {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function signBackendJwt(payload: Record<string, unknown>, secret: string) {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${header}.${body}.${signature}`;
}

class SessionScopeChanged extends Error {}
async function buildAuthorizationHeader(expectedIdentity: string | null) {
  const session = await auth();
  const user = session?.user as Record<string, unknown> | undefined;
  if (!user) return null;

  if (!FACTORY_AUTH_SECRET) {
    throw new Error('FACTORY_AUTH_SECRET must be configured for the ProserFactory proxy.');
  }

  const userId = String(user.id ?? '');
  if (expectedIdentity) {
    let expected: string;
    try {
      expected = decodeURIComponent(expectedIdentity);
    } catch (error) {
      throw new SessionScopeChanged('Invalid browser session precondition.', { cause: error });
    }
    if (expected !== userId)
      throw new SessionScopeChanged(
        'Browser session changed. Reload before continuing this request.',
      );
  }
  const provider = String(user.provider ?? 'session');
  const rawUsername = String(user.username ?? user.name ?? user.email ?? 'author');
  const providerKey = provider.toLowerCase();
  const username = providerKey === 'iam' ? normalizeIamUsername(rawUsername) : rawUsername;
  const githubId =
    providerKey === 'github'
      ? `github:${userId || username}`
      : providerKey === 'iam'
        ? `iam:${username}`
        : `${providerKey}:${username || userId || 'author'}`;
  const now = Math.floor(Date.now() / 1000);

  return `Bearer ${signBackendJwt(
    {
      // Use the provider-scoped identity, not the upstream auth system's raw user id.
      // Factory resolves the canonical local DB user from this stable handle.
      sub: githubId,
      githubId,
      username,
      email: typeof user.email === 'string' ? user.email : undefined,
      avatarUrl: typeof user.image === 'string' ? user.image : undefined,
      iss: FACTORY_AUTH_ISSUER,
      aud: FACTORY_AUTH_AUDIENCE,
      iat: now,
      exp: now + 60 * 10,
    },
    FACTORY_AUTH_SECRET,
  )}`;
}

function proxyPolicy(pathname: string): {
  timeoutMs: number;
  responseLimit: number;
  streamResponse?: boolean;
  streamKind?: 'publication' | 'sse';
  idleTimeoutMs?: number;
} {
  if (/^\/api\/books\/[0-9]+\/revision-campaigns(?:\/|$)/.test(pathname))
    return { timeoutMs: 30_000, responseLimit: 8 * 1024 * 1024 };
  if (/^\/api\/books\/[^/]+\/findings$/.test(pathname))
    return { timeoutMs: 30_000, responseLimit: 2 * 1024 * 1024 };
  if (/^\/api\/books\/[0-9]+\/plot-threads\/[0-9]+\/reviews$/.test(pathname))
    return { timeoutMs: 150_000, responseLimit: 2 * 1024 * 1024 };
  if (/^\/api\/books\/[^/]+\/document-discussions\/[^/]+\/proposals$/.test(pathname))
    return { timeoutMs: 150_000, responseLimit: 2 * 1024 * 1024 };
  if (/^\/api\/books\/[^/]+\/import-originals\/[^/]+\/content$/.test(pathname))
    return {
      timeoutMs: PUBLICATION_HEADER_TIMEOUT_MS,
      idleTimeoutMs: PUBLICATION_IDLE_TIMEOUT_MS,
      responseLimit: 32 * 1024 * 1024,
      streamResponse: true,
      streamKind: 'publication',
    };
  if (
    /^\/api\/books\/[0-9]+\/document-publication-artifacts\/[a-f0-9-]{36}\/(download|review)$/.test(
      pathname,
    )
  )
    return {
      timeoutMs: PUBLICATION_HEADER_TIMEOUT_MS,
      idleTimeoutMs: PUBLICATION_IDLE_TIMEOUT_MS,
      responseLimit: 256 * 1024 * 1024,
      streamResponse: true,
      streamKind: 'publication',
    };
  if (/\/publication\/[^/]+$/.test(pathname))
    return {
      timeoutMs: PUBLICATION_HEADER_TIMEOUT_MS,
      idleTimeoutMs: PUBLICATION_IDLE_TIMEOUT_MS,
      responseLimit: 64 * 1024 * 1024,
      streamResponse: true,
      streamKind: 'publication',
    };
  if (/^\/api\/generate\/operations\/[^/]+\/stream$/.test(pathname))
    return {
      timeoutMs: PUBLICATION_HEADER_TIMEOUT_MS,
      idleTimeoutMs: PUBLICATION_IDLE_TIMEOUT_MS,
      responseLimit: 2 * 1024 * 1024,
      streamResponse: true,
      streamKind: 'sse',
    };
  if (/^\/api\/workflows\//.test(pathname))
    return { timeoutMs: 30_000, responseLimit: 1024 * 1024 };
  if (/^\/api\/(generate|images\/generate)/.test(pathname))
    return { timeoutMs: 5 * 60_000, responseLimit: DEFAULT_PROXY_RESPONSE_LIMIT };
  return { timeoutMs: DEFAULT_PROXY_TIMEOUT_MS, responseLimit: DEFAULT_PROXY_RESPONSE_LIMIT };
}

function isPublicProxyRequest(method: string, pathname: string) {
  return (method === 'GET' || method === 'HEAD') && PUBLIC_PROXY_ROUTES.has(pathname);
}

function safePublicationHeaders(pathname: string, upstream: Response, responseLimit: number) {
  const declaredHeader = upstream.headers.get('content-length');
  const declared = declaredHeader && /^\d+$/.test(declaredHeader) ? Number(declaredHeader) : NaN;
  if (!Number.isSafeInteger(declared) || declared < 0)
    throw new Error('UPSTREAM_RESPONSE_SIZE_REQUIRED');
  if (declared > responseLimit) throw new Error('UPSTREAM_RESPONSE_TOO_LARGE');

  const mediaType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!mediaType || !PUBLICATION_MEDIA_TYPES.has(mediaType))
    throw new Error('UPSTREAM_PUBLICATION_TYPE_INVALID');

  const canonicalArtifact =
    /^\/api\/books\/[0-9]+\/document-publication-artifacts\/[a-f0-9-]{36}\/(download|review)$/.test(
      pathname,
    );
  const original = /^\/api\/books\/[0-9]+\/import-originals\/([a-f0-9-]{36})\/content$/.exec(
    pathname,
  );
  const disposition = upstream.headers.get('content-disposition');
  const artifactFilename = canonicalArtifact
    ? /^attachment;\s*filename="([a-zA-Z0-9_.-]{1,150})"$/.exec(disposition ?? '')?.[1]
    : undefined;
  if (canonicalArtifact && !artifactFilename)
    throw new Error('UPSTREAM_PUBLICATION_FILENAME_INVALID');
  const sha256 =
    canonicalArtifact || original ? upstream.headers.get('x-content-sha256') : undefined;
  if ((canonicalArtifact || original) && !/^[a-f0-9]{64}$/.test(sha256 ?? ''))
    throw new Error('UPSTREAM_PUBLICATION_DIGEST_INVALID');
  const encodedFilename =
    artifactFilename ??
    (original
      ? `${original[1]}.${mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? 'docx' : 'json'}`
      : (pathname.split('/').at(-1) ?? ''));
  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    throw new Error('UPSTREAM_PUBLICATION_FILENAME_INVALID');
  }
  if (!filename || filename.includes('/') || filename.includes('\\') || /[\0\r\n]/.test(filename))
    throw new Error('UPSTREAM_PUBLICATION_FILENAME_INVALID');
  const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/[";]/g, '_');
  return {
    declared,
    mediaType: upstream.headers.get('content-type')!,
    sha256: sha256 ?? undefined,
    disposition: `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  };
}

function streamBoundedBody(
  body: ReadableStream<Uint8Array>,
  responseLimit: number,
  expectedBytes: number | undefined,
  progress: () => void,
  cleanup: () => void,
  expectedSha256?: string,
) {
  let total = 0;
  const hash = expectedSha256 ? createHash('sha256') : undefined;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        progress();
        const { done, value } = await reader.read();
        if (done) {
          if (expectedBytes !== undefined && total !== expectedBytes) {
            cleanup();
            controller.error(new Error('UPSTREAM_RESPONSE_LENGTH_MISMATCH'));
            return;
          }
          if (hash && hash.digest('hex') !== expectedSha256) {
            cleanup();
            controller.error(new Error('UPSTREAM_PUBLICATION_DIGEST_MISMATCH'));
            return;
          }
          cleanup();
          controller.close();
          return;
        }
        total += value.byteLength;
        progress();
        if (total > responseLimit || (expectedBytes !== undefined && total > expectedBytes)) {
          await reader.cancel('UPSTREAM_RESPONSE_LENGTH_MISMATCH');
          cleanup();
          controller.error(new Error('UPSTREAM_RESPONSE_LENGTH_MISMATCH'));
          return;
        }
        hash?.update(value);
        controller.enqueue(value);
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        cleanup();
      }
    },
  });
}

async function readBoundedBody(response: Response, responseLimit: number) {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > responseLimit) throw new Error('UPSTREAM_RESPONSE_TOO_LARGE');
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > responseLimit) {
      await reader.cancel();
      throw new Error('UPSTREAM_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function proxy(req: NextRequest) {
  if (!FACTORY_URL) {
    return NextResponse.json(
      { ok: false, error: 'FACTORY_URL is not configured' },
      { status: 500 },
    );
  }

  const url = new URL(req.nextUrl.pathname + req.nextUrl.search, FACTORY_URL);
  // Dot segments are resolved while building the URL. Refuse anything that no
  // longer addresses the Factory API on the configured origin.
  if (url.origin !== new URL(FACTORY_URL).origin || !url.pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
  }
  const policy = proxyPolicy(req.nextUrl.pathname);
  const headers = new Headers();
  for (const [key, value] of req.headers.entries()) {
    if (!REQUEST_HEADERS_TO_STRIP.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  // Ask Factory for an uncompressed response so the proxy can safely relay it.
  headers.set('accept-encoding', 'identity');

  let proxyTimedOut = false;
  try {
    if (!isPublicProxyRequest(req.method, req.nextUrl.pathname)) {
      const authorization = await buildAuthorizationHeader(
        req.headers.get('x-proser-expected-user'),
      );
      if (!authorization) {
        return NextResponse.json(
          { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } },
          { status: 401 },
        );
      }
      headers.set('authorization', authorization);
    }
    if (
      req.method === 'POST' &&
      /^\/api\/books\/[0-9]+\/(docx-)?import-originals\/[a-f0-9-]{36}$/.test(req.nextUrl.pathname)
    ) {
      const declared = req.headers.get('content-length');
      if (
        declared !== null &&
        (!/^\d+$/.test(declared) ||
          !Number.isSafeInteger(Number(declared)) ||
          Number(declared) > 32 * 1024 * 1024)
      )
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'DOCUMENT_IMPORT_TOO_LARGE',
              message: 'Original exceeds the 32 MiB upload limit.',
            },
          },
          { status: 413 },
        );
    }

    const controller = new AbortController();
    let timeout = globalThis.setTimeout(() => {
      proxyTimedOut = true;
      controller.abort();
    }, policy.timeoutMs);
    const abortFromClient = () => controller.abort('client_cancelled');
    if (req.signal.aborted) controller.abort(req.signal.reason ?? 'client_cancelled');
    req.signal.addEventListener('abort', abortFromClient, { once: true });
    let cleanupDeferredToStream = false;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      globalThis.clearTimeout(timeout);
      req.signal.removeEventListener('abort', abortFromClient);
    };
    const init: RequestInit = {
      method: req.method,
      headers,
      redirect: 'manual',
      signal: controller.signal,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req.body;
      // @ts-expect-error Node fetch supports duplex streaming.
      init.duplex = 'half';
    }

    let upstream: Response;
    try {
      upstream = await fetch(url, init);
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: 'UPSTREAM_REDIRECT_REJECTED',
              message: 'Factory returned an unexpected redirect',
            },
          },
          { status: 502 },
        );
      }
      const responseHeaders = new Headers();
      for (const [key, value] of upstream.headers.entries()) {
        if (!RESPONSE_HEADERS_TO_STRIP.has(key.toLowerCase())) {
          responseHeaders.set(key, value);
        }
      }

      if (policy.streamResponse && upstream.ok && upstream.body) {
        globalThis.clearTimeout(timeout);
        const renewIdleTimeout = () => {
          globalThis.clearTimeout(timeout);
          timeout = globalThis.setTimeout(() => {
            proxyTimedOut = true;
            controller.abort('upstream_idle_timeout');
          }, policy.idleTimeoutMs ?? PUBLICATION_IDLE_TIMEOUT_MS);
        };
        renewIdleTimeout();
        let expectedBytes: number | undefined;
        let expectedSha256: string | undefined;
        if (policy.streamKind === 'publication') {
          let publication;
          try {
            publication = safePublicationHeaders(
              req.nextUrl.pathname,
              upstream,
              policy.responseLimit,
            );
          } catch (error) {
            await upstream.body.cancel('invalid_publication_headers');
            throw error;
          }
          expectedBytes = publication.declared;
          expectedSha256 = publication.sha256;
          responseHeaders.set('content-type', publication.mediaType);
          responseHeaders.set('content-length', String(publication.declared));
          responseHeaders.set('content-disposition', publication.disposition);
          if (publication.sha256) {
            responseHeaders.set('cache-control', 'private, no-store');
            responseHeaders.set('x-content-sha256', publication.sha256);
          }
        } else {
          const mediaType = upstream.headers
            .get('content-type')
            ?.split(';', 1)[0]
            ?.trim()
            .toLowerCase();
          if (mediaType !== 'text/event-stream') throw new Error('UPSTREAM_SSE_TYPE_INVALID');
          responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
          responseHeaders.set('cache-control', 'no-cache');
          responseHeaders.delete('content-length');
        }
        const response = new NextResponse(
          streamBoundedBody(
            upstream.body,
            policy.responseLimit,
            expectedBytes,
            renewIdleTimeout,
            cleanup,
            expectedSha256,
          ),
          { status: upstream.status, headers: responseHeaders },
        );
        cleanupDeferredToStream = true;
        return response;
      }

      const responseBody = await readBoundedBody(upstream, policy.responseLimit);
      return new NextResponse(responseBody, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } finally {
      if (!cleanupDeferredToStream) cleanup();
    }
  } catch (err) {
    if (err instanceof SessionScopeChanged)
      return NextResponse.json(
        {
          ok: false,
          success: false,
          error: { code: 'SESSION_SCOPE_CHANGED', message: err.message },
        },
        { status: 409 },
      );
    console.error('[api proxy]', err);
    if (err instanceof Error && err.message.startsWith('FACTORY_AUTH_SECRET')) {
      return NextResponse.json(
        { ok: false, error: 'Factory authentication is not configured' },
        { status: 503 },
      );
    }
    if (err instanceof Error && err.message === 'UPSTREAM_RESPONSE_TOO_LARGE') {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'UPSTREAM_RESPONSE_TOO_LARGE',
            message: 'Factory response exceeded the configured endpoint limit',
          },
        },
        { status: 502 },
      );
    }
    if (
      err instanceof Error &&
      [
        'UPSTREAM_RESPONSE_SIZE_REQUIRED',
        'UPSTREAM_PUBLICATION_TYPE_INVALID',
        'UPSTREAM_PUBLICATION_FILENAME_INVALID',
        'UPSTREAM_PUBLICATION_DIGEST_INVALID',
        'UPSTREAM_SSE_TYPE_INVALID',
      ].includes(err.message)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.message,
            message: 'Factory streaming response failed proxy validation',
          },
        },
        { status: 502 },
      );
    }
    if (proxyTimedOut) {
      return NextResponse.json(
        { ok: false, error: { code: 'UPSTREAM_TIMEOUT', message: 'Factory request timed out' } },
        { status: 504 },
      );
    }
    return NextResponse.json({ ok: false, error: 'Backend unavailable' }, { status: 502 });
  }
}

export const dynamic = 'force-dynamic';

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
