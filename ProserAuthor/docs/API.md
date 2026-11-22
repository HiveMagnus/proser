# ProserAuthor API boundary

_Last verified: 2026-07-20_

ProserAuthor does not run its own authoring API. It exposes a same-origin Next.js proxy at `apps/web/src/app/api/[...path]/route.ts`; ProserFactory owns the actual Express API, data, generation, images, and workflows.

For the direct Factory route reference, see [`../../PROSER_API.md`](../../PROSER_API.md) or the running Factory's `GET /api/docs` and `GET /api/docs.json` endpoints.

## Browser contract

Browser components call relative URLs:

```ts
const response = await fetch('/api/books');
```

Do not put `FACTORY_URL`, an internal hostname, a service JWT, or a browser-supplied `Authorization` header into client code. The proxy derives identity from the current Auth.js session and creates the Factory authorization header server-side.

The relative path is preserved. For example:

| Browser request               | Factory request                             |
| ----------------------------- | ------------------------------------------- |
| `GET /api/books`              | `GET ${FACTORY_URL}/api/books`              |
| `POST /api/generate/prose`    | `POST ${FACTORY_URL}/api/generate/prose`    |
| `GET /api/books/12/workflows` | `GET ${FACTORY_URL}/api/books/12/workflows` |
| `GET /api/images/42/content`  | `GET ${FACTORY_URL}/api/images/42/content`  |

The proxy supports `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`.

## Authentication

For an authenticated session, the proxy signs a 10-minute HS256 JWT with:

- `FACTORY_AUTH_SECRET`
- issuer `FACTORY_AUTH_ISSUER` (default `proser-author`)
- audience `FACTORY_AUTH_AUDIENCE` (default `proser-factory`)
- a stable provider-scoped identity such as `iam:<username>` or `github:<id>`

Browser cookies, browser-supplied authorization, hop-by-hop headers, and the original host are not forwarded. Factory `Set-Cookie`, redirect, refresh, content-location, and authentication-challenge headers are never relayed to the Author origin. `NEXTAUTH_SECRET` protects the web session and is not the Factory signing secret.

The proxy requires an authenticated session by default. Only `GET` or `HEAD /api/readiness` is intentionally public; an unauthenticated request to any other proxied route receives HTTP `401` with `AUTH_REQUIRED` without contacting Factory. Unexpected upstream 3xx responses are rejected with `UPSTREAM_REDIRECT_REJECTED` rather than forwarding an internal `Location` value.

If `FACTORY_AUTH_SECRET` is missing for an authenticated request, the proxy returns HTTP `503` with `Factory authentication is not configured`.

## Proxy limits

The proxy requests uncompressed upstream responses and reads JSON/API responses through a bounded buffer. Publication artifacts are the exception: after validating an explicit content length, allowlisted media type, and URL-derived filename, the proxy streams the body with byte-count enforcement and reconstructed download headers. Publication connections must return headers within 15 seconds; once streaming begins, a renewable 30-second idle timeout replaces that header deadline, so steady downloads are not constrained by total transfer time. The 64 MiB limit remains appropriate for local Factory packages; larger releases should move to short-lived signed object-storage downloads rather than increasing proxy memory or trust boundaries.

| Route family                      | Timeout                | Response limit |
| --------------------------------- | ---------------------- | -------------- |
| Default                           | 30 seconds             | 8 MiB          |
| `GET /api/books/:bookId/findings` | 30 seconds             | 2 MiB          |
| `/api/workflows/*`                | 30 seconds             | 1 MiB          |
| Publication artifact download     | 15s headers / 30s idle | 64 MiB         |
| Generation and image generation   | 5 minutes              | 8 MiB          |

Typed proxy failures:

- HTTP `504`, `UPSTREAM_TIMEOUT` when Factory exceeds the route timeout.
- HTTP `502`, `UPSTREAM_RESPONSE_TOO_LARGE` when a response exceeds its limit.
- HTTP `502`, `UPSTREAM_REDIRECT_REJECTED` for an unexpected Factory redirect.
- HTTP `502`, `UPSTREAM_RESPONSE_SIZE_REQUIRED` or `UPSTREAM_PUBLICATION_TYPE_INVALID` when a download cannot be safely streamed.
- HTTP `502`, `Backend unavailable` for other upstream/network failures.

General JSON responses remain bounded and buffered. Validated publication downloads and authenticated generation SSE use streaming passthrough. Generation streams require `text/event-stream`, renew a 30-second idle timeout as bytes arrive, and are capped at 2 MiB by the proxy.

## Active route families used by the UI

- Books, structure, scenes, codex, notes, exports: `/api/books/*`, `/api/codex/*`
- One-shot generation and traces: `/api/generate/*`, `/api/prose/*`
- Private images: `/api/images/*`
- Runtime inspection and user settings: `/api/models/*`, `/api/settings`
- Workflow v1: `/api/workflows/*`, `/api/books/:bookId/workflows`, `/reviews`, `/findings`, `/revisions`

`WorkflowRun` is the only durable background orchestration model. The retired `/api/wizard`, `/api/factory`, `/api/novels`, and legacy review-run route families are not part of the current contract.

## Workflow launch example

The browser stores a request-scoped idempotency key and normalized input before launch. The Pending Operations center retains it for typed conflict, in-progress, timeout, throttling, gateway, and other uncertain outcomes; users can reconcile with the same key or intentionally abandon it. Only typed validation, authorization, or not-found rejections clear it automatically. Factory owns all subsequent task progress.

```ts
await fetch('/api/workflows/quality-review', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  },
  body: JSON.stringify({
    bookId: 12,
    scope: { type: 'book' },
    model: 'qwen3.6-35b',
  }),
});
```

A `202` response means the workflow was accepted. The client reconnects through `GET /api/books/:bookId/workflows` and reads compact status from `GET /api/workflows/:runId`; it does not advance internal tasks.

Prose generation first stores an explicit session receipt, then sends authenticated `POST /api/generate/operations` with JSON and an `Idempotency-Key`. Factory persists and returns the operation receipt before inference begins. Only then does the browser open `/api/generate/operations/:operationId/stream?cursor=0&limit=500`; manuscript prompts and generation parameters never enter the subscription URL. If creation has an uncertain response, `GET /api/generate/operations/lookup?idempotencyKey=...` reconciles the exact user-scoped key and can return recent active or terminal work. A receipt arriving after an explicit superseding generation is cancelled; navigation, unmount, and stop-watching retain late receipts as detached background work. On reload, retained receipts are enumerated, the newest active request reconnects, and older work appears globally. Completed operations fetch `/api/generate/operations/:operationId/artifact`, verify its SHA-256, and remain in the Completed Generation inbox until dismissed; failed and cancelled outcomes likewise remain visible before removal. Reconciliation pauses while hidden or offline, uses capped jittered backoff on failures, and coordinates tabs with a browser lock plus `BroadcastChannel`. Reconnects use the last accepted cursor. `POST /api/generate/operations/:operationId/cancel` cancels Factory work, while “Stop tracking” only closes EventSource and records a detached state. The browser rejects non-monotonic cursors, excessive provisional bytes/words/frames/duration, mismatched word counts, and terminal SHA-256 mismatches before exposing generated text.

## Private image loading

Use `/api/images/:id/content`. Do not render Factory filesystem paths or `/images/:filename` URLs. The same-origin request allows the proxy to attach the user's Factory identity, and Factory returns `404` for missing or differently owned assets.

## Configuration

Required production values:

```dotenv
FACTORY_URL=http://127.0.0.1:3001
FACTORY_AUTH_SECRET=<shared-with-factory>
FACTORY_AUTH_ISSUER=proser-author
FACTORY_AUTH_AUDIENCE=proser-factory
NEXTAUTH_SECRET=<web-session-secret>
NEXTAUTH_URL=https://proser.example.com
AUTH_URL=https://proser.example.com
```

The certificate-matching FQDN is the canonical external Auth.js origin. See [`ENVIRONMENT.md`](ENVIRONMENT.md) for authentication-provider and local-development settings.
