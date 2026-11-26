# Proser API

ProserFactory owns the authoring API and data. A browser uses Author's
authenticated, same-origin `/api/*` proxy. Agents and scripts use Factory
directly with their own approved credentials.

| Service       | Local URL               | Purpose                                                      |
| ------------- | ----------------------- | ------------------------------------------------------------ |
| ProserFactory | `http://127.0.0.1:3001` | Direct API when `compose.factory-api.yml` publishes the port |
| ProserAuthor  | `http://localhost:3000` | Browser UI and session-authenticated Factory proxy           |

The versioned, generated route contract is checked in as
[`PROSER_API.generated.md`](PROSER_API.generated.md) and served by Factory at
`GET /api/docs` and `GET /api/docs.json`. `npm run docs:validate` fails when the
checked-in reference drifts from the OpenAPI/Zod contract. Rate-limited
generation routes read the same limit constants used by the generator.

For an agent on another host, use an authenticated private HTTPS Factory
endpoint. See [direct Factory access](docs/COMPOSE.md#direct-factory-api-access)
and the [Hermes setup](ProserFactory/HERMES_AGENT_PLUGIN.md).

Word exchange is implemented through the shared maintained
`@hivemagnus/canvas-word-codec` package. Factory retains document validation,
asset access, revisions, receipts and publication authority.

## Health and metadata

| Method | Path             | Purpose                                                             |
| ------ | ---------------- | ------------------------------------------------------------------- |
| `GET`  | `/health`        | Process liveness plus database, Redis, revision, and build metadata |
| `GET`  | `/health/queue`  | Workflow queue counts, workers, latency, failures, and pause state  |
| `GET`  | `/health/redis`  | Redis connectivity                                                  |
| `GET`  | `/api`           | API metadata                                                        |
| `GET`  | `/api/health`    | API-router liveness                                                 |
| `GET`  | `/api/readiness` | Bounded database, Redis and editorial component readiness states    |
| `GET`  | `/api/docs`      | Swagger UI                                                          |
| `GET`  | `/api/docs.json` | OpenAPI JSON                                                        |

## Authentication

Most routes require:

```http
Authorization: Bearer <short-lived-hs256-jwt>
```

Author JWTs use `FACTORY_AUTH_SECRET`, issuer `proser-author`, and audience `proser-factory`. Hermes uses its dedicated `HERMES_AGENT_AUTH_SECRET`, service identity, issuer, and audience. Do not share the Auth.js session secret with service integrations.

Bearer credentials are accepted only in the `Authorization` header. They are
never accepted from query strings. Browser `EventSource` subscriptions remain
same-origin through ProserAuthor, whose authenticated server-side proxy adds
the Factory authorization header.

Internal routes use:

```http
X-Internal-Secret: <INTERNAL_API_SECRET>
```

`POST /api/auth/sync-user` creates or updates an integration identity. Legacy `x-user-id`, `x-github-id`, `x-username`, `x-email`, and `x-avatar-url` headers are accepted only by the automated test runner (`NODE_ENV=test`) or by a local development process that sets both `NODE_ENV=development` and `ALLOW_LEGACY_HEADER_AUTH=true`.

### Response envelopes

Most JSON success responses use:

```json
{ "success": true, "data": {} }
```

Errors use:

```json
{
  "success": false,
  "error": { "code": "VALIDATION_FAILED", "message": "...", "details": {} }
}
```

Common error codes include `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_FAILED`, `RATE_LIMITED`, `CONFLICT`, `DB_ERROR`, `AI_SERVICE_UNAVAILABLE`, and `INTERNAL_ERROR`.

Every caller is limited to `API_RATE_LIMIT_PER_MINUTE` requests per minute across the API (default 1200, minimum 120), counted per verified signed identity or configured service principal, or per client address for every other request (no token, or a token that fails verification). Generation, imports and other expensive routes have tighter limits of their own. Over a limit, the response is `429 RATE_LIMITED` with `Retry-After` in seconds.

## Make the first request

Use Bash and a short-lived Factory token issued for your identity. This
example assumes Factory is published on the same host.

```bash
export PROSER_BASE_URL=http://127.0.0.1:3001
read -rsp 'Factory bearer token: ' PROSER_TOKEN
printf '\n'
curl -fsS "$PROSER_BASE_URL/api/readiness"
curl -fsS "$PROSER_BASE_URL/api/books" -H "Authorization: Bearer $PROSER_TOKEN"
```

An empty list is valid for an identity that owns no books. A `401` means the
credential was rejected. Check its expiry, issuer, audience, and enrolled
service identity. Use the current owned book ID and revision from the API for
subsequent calls.

A `401` whose `error.details.code` is `SESSION_REVOKED` means the account
signed out everywhere after this token's session began. Author-signed tokens
carry the session's sign-in time in `sessionIssuedAt` (seconds since the
epoch). After a revocation, Factory refuses Author-signed tokens for that
account that lack the claim or carry an earlier time. Agent tokens are not
browser sessions and are unaffected.

## Create a book and first draft

Run the following against a development installation using the default
structured document authority. The example creates a book and a blank
first scene. It needs Node.js and `jq`.

```bash
(
  set -euo pipefail
  auth_header="Authorization: Bearer $PROSER_TOKEN"
  book_operation=$(node -p 'require("node:crypto").randomUUID()')
  printf 'Book creation operation: %s\n' "$book_operation" >&2
  book=$(curl -fsS "$PROSER_BASE_URL/api/books" \
    -H "$auth_header" -H 'Content-Type: application/json' \
    --data "$(jq -nc --arg op "$book_operation" \
      '{operationId: $op, title: "The Glass Orchard"}')")
  book_url="$PROSER_BASE_URL/api/books/$(jq -er '.data.id' <<< "$book")"
  head=$(curl -fsS "$book_url/document-manifest" -H "$auth_header")
  draft_operation=$(node -p 'require("node:crypto").randomUUID()')
  draft_request=$(jq -ce --arg op "$draft_operation" '{
    schemaVersion: 1, operationId: $op, expectedRevisionId: .data.revisionId,
    expectedScopes: {structure: .data.scopes.structure.revisionId},
    summary: "Mara arrives at the orchard.",
    outline: "The caretaker warns her to leave before dusk."
  }' <<< "$head")
  printf 'Draft operation: %s for %s\n' "$draft_operation" "$book_url" >&2
  draft=$(curl -fsS "$book_url/document-quick-drafts" \
    -H "$auth_header" -H 'Content-Type: application/json' --data "$draft_request")
  scene_id=$(jq -er '.data.result.sceneId' <<< "$draft")
  curl -fsS "$book_url/scenes/$scene_id/document" -H "$auth_header"
)
```

Use `POST /api/books/:bookId/document-commits` to save the scene document with
its current book and scene revisions. Use `GET /api/books/:bookId/document-operations/:operationId`
to recover the exact receipt after an interrupted save or quick draft.
Compatibility structure routes take `documentPreconditions` with the current
book revision, scoped revisions and a unique operation ID. The generated
reference lists each route and the smoke script shows a save and reopen.
[Generated reference](PROSER_API.generated.md) · [Compose smoke script](scripts/smoke-compose-image.mjs)

## Workflow v1

`WorkflowRun` is the only durable background orchestration root. Wizard, FactoryRun, NovelRun, and ReviewRun APIs have been removed.

Every launch requires an `Idempotency-Key` header and returns HTTP `202`. Reuse the same key when retrying the same logical launch.

### Launch routes

| Method | Path                                | Purpose                                                                                                    |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/workflows/full-book`          | Create or continue a complete manuscript through drafting, editorial child runs, validation, and packaging |
| `POST` | `/api/workflows/quality-review`     | Immutable read-only review of a book, act, chapter, or scene                                               |
| `POST` | `/api/workflows/improve-quality`    | Implement selected findings from named review runs                                                         |
| `POST` | `/api/workflows/guided-improve`     | Apply a free-form instruction under safe-edit and checkpoint policy                                        |
| `POST` | `/api/workflows/editorial-optimize` | Run a checkpoint-free, revision-bound editorial pass for a book, act, chapter, or scene                    |

Full Book input supports `bookId`, `premise`, `title`, `genre`, `audience`, `targetWords`, `pov`, `tense`, `style`, `mustInclude`, `mustAvoid`, `candidateCount`, `reviewModels`, and `maxEditorialRounds`.

Full Book follows active act/chapter/scene order for drafting and its opening
sample, even when chapter numbering restarts per act. An existing `bookId`
preserves the outline and saved prose while initializing the new run's planning
records. Planned scenes remain blank until drafting reaches them; an opening
sample checkpoint requires committed prose in the actual opening chapter.

```bash
curl -sS "$PROSER_BASE_URL/api/workflows/full-book" \
  -H "Authorization: Bearer $PROSER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: glass-orchard-full-book-v1' \
  -d '{"premise":"A botanist inherits an orchard where every tree remembers a buried sin.","genre":"gothic fantasy","targetWords":80000}'
```

Quality Review requires `bookId` and `model`; `scope` defaults to `{ "type": "book" }`. Non-book scopes require an `id`.

Improve Quality requires `bookId` and one or more `reviewRunIds`; optional `findingIds` narrow the work.

Guided Improve requires `bookId` and `instruction`; optional `scope`, `model`, and `acceptanceCriteria` bound the change.

Editorial Optimize requires `bookId`, `scope`, `passPack`, and `autonomy`.
Autonomy is `review_only`, `propose_only`, `safe_auto`, or
`max_quality_auto`; no mode waits for a checkpoint.

### Observe and control

| Method | Path                                                                   | Purpose                                                                            |
| ------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET`  | `/api/workflows/:runId`                                                | Compact status, heartbeat, child runs, revision, checkpoint, and resource versions |
| `GET`  | `/api/workflows/:runId/events?after=0&limit=100`                       | Durable event page                                                                 |
| `GET`  | `/api/workflows/:runId/checkpoints`                                    | Checkpoint summaries                                                               |
| `GET`  | `/api/workflows/:runId/checkpoints/:checkpointId?offset=0&limit=16384` | Bounded checkpoint proposal page; limit is 1–32 KiB                                |
| `GET`  | `/api/workflows/:runId/artifacts`                                      | Workflow artifacts                                                                 |
| `POST` | `/api/workflows/:runId/pause`                                          | Pause at a safe boundary                                                           |
| `POST` | `/api/workflows/:runId/resume`                                         | Resume paused/recoverable work                                                     |
| `POST` | `/api/workflows/:runId/cancel`                                         | Cooperatively cancel                                                               |
| `POST` | `/api/workflows/:runId/checkpoints/:checkpointId/decision`             | Submit `{ "decision": "approved" \| "rejected", "reason"?: "..." }`                |
| `POST` | `/api/workflows/:runId/finalize`                                       | Request final release processing                                                   |
| `GET`  | `/api/workflows/:runId/publication`                                    | Publication gates, manifest, and release state                                     |
| `GET`  | `/api/workflows/:runId/publication/:filename`                          | Download an owned publication artifact                                             |

Reconnect and editorial history:

| Method  | Path                                                | Purpose                                                                                         |
| ------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET`   | `/api/books/:bookId/workflows`                      | Top-level runs with child summaries                                                             |
| `GET`   | `/api/books/:bookId/reviews`                        | Review history                                                                                  |
| `GET`   | `/api/books/:bookId/findings`                       | Paginated aggregate findings; filters: `state`, `model`, `severity`, `scope`, `cursor`, `limit` |
| `GET`   | `/api/reviews/:reviewRunId/findings`                | Findings for one review                                                                         |
| `PATCH` | `/api/findings/:findingId`                          | Waive or update implementation state                                                            |
| `GET`   | `/api/books/:bookId/revisions`                      | Immutable revision ancestry                                                                     |
| `POST`  | `/api/books/:bookId/revisions/:revisionId/rollback` | Restore a compatible snapshot as a new descendant revision                                      |

Structural, canon, chronology, POV, tense, large, conflicting, and cross-chapter edits require checkpoints. A workflow can be complete without being `release_approved`; publication gates and human release approval are separate states.

## Endpoint groups

All routes below are under `/api` unless shown otherwise.

### Editorial Engine and Quality Lab

`/editorial/pass-packs` discovers versioned passes; `/editorial/runs/:runId/*`
returns compact summaries and bounded proposal evidence; `/editorial/profiles`
manages immutable profile versions; `/editorial/proposals/:proposalId/*`
records optional preferences and revision-safe apply/undo; and
`/editorial/benchmarks` runs bounded deterministic or live Quality Lab suites.
Book history and resolved profiles are under `/books/:bookId/editorial-*`.

### Books, structure, notes, and exports

| Method                         | Path                                                   | Purpose                                                                                           |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `GET`, `POST`                  | `/books`                                               | List or create books                                                                              |
| `GET`, `PUT`, `DELETE`         | `/books/:id`                                           | Read, update, or soft-delete a book                                                               |
| `GET`                          | `/books/trash`                                         | Deleted books and the revision that restores each one                                             |
| `GET`, `POST`                  | `/books/:bookId/structure`                             | Read or replace the structure tree                                                                |
| `POST`                         | `/books/:bookId/reorder-acts`                          | Reorder acts                                                                                      |
| `POST`, `PUT`, `DELETE`        | `/books/:bookId/acts...`                               | Create/update/delete acts and chapters                                                            |
| `GET`, `POST`, `PUT`, `DELETE` | `/books/:bookId/.../scenes...`                         | List/create/update/delete/reorder/regenerate scenes                                               |
| `GET`, `POST`, `PUT`, `DELETE` | `/books/:bookId/notes...`                              | Manage notes                                                                                      |
| `GET`                          | `/books/:bookId/export?format=markdown`                | Immediate `markdown`, `html`, or `rtf` export                                                     |
| `POST`                         | `/books/:bookId/export-artifacts`                      | Create content-addressed Markdown artifact metadata and table of contents                         |
| `GET`                          | `/books/:bookId/export-artifacts/:artifactId`          | Artifact metadata                                                                                 |
| `GET`                          | `/books/:bookId/export-artifacts/:artifactId/read`     | Bounded `book`, `chapter`, or `scene` read                                                        |
| `GET`                          | `/books/:bookId/export-artifacts/:artifactId/download` | Download artifact bytes                                                                           |
| `DELETE`                       | `/books/:bookId/export-artifacts/:artifactId`          | Delete artifact                                                                                   |
| `GET`                          | `/books/:bookId/prose/quality`                         | Local prose-quality overview                                                                      |
| `POST`                         | `/books/:bookId/reset`                                 | Delete workflow/revision/memory/skill/structure state while preserving the book, codex, and notes |
| `GET`                          | `/books/:bookId/writing-stats?days=30&tz=Area/City`    | Daily words written, totals, streaks and goal pacing                                              |
| `PUT`                          | `/books/:bookId/writing-goal`                          | Set or clear the length target, deadline and daily goal                                           |
| `GET`                          | `/books/:bookId/recommendations?tz=Area/City`          | Next writing steps for the book                                                                   |
| `GET`, `PUT`                   | `/books/:bookId/ai-policy`                             | Read or set the book's AI switch (`{ "aiDisabled": true }`)                                       |
| `GET`                          | `/books/ai-policies`                                   | IDs of the caller's books with AI switched off                                                    |
| `GET`                          | `/plot/archetypes`                                     | Story archetypes a book's `storyArchetypeKey` can name                                            |

Writing statistics read the last saved book revision of each day in the
requested time zone (`tz`, default UTC; `days` 7–365, default 30). Changes in
scenes saved by hand count as `written`; text from imports, AI generation and
workflows is `other` and never fills a goal or streak. Installs with document
authority off have no book revisions, so their statistics stay empty.

While a book's `aiDisabled` is true, Factory refuses every model-provider
request made for it with `409 BOOK_AI_DISABLED`: generation, revision, review,
proposals, campaigns, plot-thread reviews, workflows, image generation and the
Hermes and Nova service routes. Known AI routes refuse before recording any
operation; every other provider dispatch is checked at the provider gate.
Queued workflows for the book pause, generation operations fail with
`BOOK_AI_DISABLED`, and retrieval skips embeddings and falls back to keyword
search.

Export artifacts are revision-bound. A stale artifact is removed and must be recreated. `read` accepts stable chapter/scene IDs or unambiguous numbers with `offset` and `maxChars`.

### Codex

| Method                 | Path                          | Purpose                            |
| ---------------------- | ----------------------------- | ---------------------------------- |
| `GET`, `POST`          | `/books/:bookId/codex`        | List/create entries                |
| `GET`                  | `/books/:bookId/codex/search` | Bounded RAG retrieval/debug search |
| `GET`, `PUT`, `DELETE` | `/codex/:id`                  | Read/update/delete an entry        |

Valid entry types are `character`, `location`, `lore`, `item`, `faction`, `event`, `rule`, `culture`, and `relationship`.

### One-shot generation and traces

| Method | Path                                                              | Purpose                                                 |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------- |
| `POST` | `/generate/operations`                                            | Create durable prose operation (`Idempotency-Key`)      |
| `GET`  | `/generate/operations/unresolved`                                 | Reconcile user-scoped uncertain operation receipts      |
| `GET`  | `/generate/operations/:id/stream`                                 | Read-only cursor SSE subscription                       |
| `GET`  | `/generate/operations/:id/artifact`                               | Read authoritative completed artifact                   |
| `POST` | `/generate/operations/:id/cancel`                                 | Persist cancellation and abort inference                |
| `POST` | `/generate/{character \| location \| item \| codex}`              | Generate codex-style material                           |
| `POST` | `/generate/{outline \| summary \| title \| tagline \| structure}` | Generate planning material                              |
| `POST` | `/generate/{inline-suggestion \| feedback}`                       | Editor suggestion/feedback                              |
| `POST` | `/generate/prose`                                                 | Generate prose                                          |
| `POST` | `/generate/prose/batch`                                           | Bounded batch prose generation                          |
| `POST` | `/generate/prose/revise`                                          | Revise from structured findings                         |
| `POST` | `/generate/prose/command-revise`                                  | Revise a scene or paragraph from a typed/spoken command |
| `GET`  | `/prose/traces/:traceId`                                          | Trace detail                                            |
| `GET`  | `/prose/traces/:traceId/stream`                                   | Stored trace stream                                     |

SSE clients should handle heartbeat comments plus `meta`, `done`, and `error`
events. Direct Factory clients must use a fetch-based SSE implementation that
sets `Authorization`. Browser `EventSource` clients use ProserAuthor’s
same-origin session and never place a JWT in the subscription URL.

### Images

All image routes require authentication. Asset routes enforce ownership.

| Method   | Path                     | Purpose                                                   |
| -------- | ------------------------ | --------------------------------------------------------- |
| `GET`    | `/images/health`         | Forge availability                                        |
| `POST`   | `/images/generate`       | OpenAI-style image request through Forge                  |
| `POST`   | `/images/generate/flux`  | Flux-specific generation controls                         |
| `GET`    | `/images/list`           | Paginated owned assets, optionally filtered by owned book |
| `GET`    | `/images/:id/content`    | Owned image bytes; other owners receive `404`             |
| `POST`   | `/images/suggest-prompt` | Generate a book-aware image prompt                        |
| `DELETE` | `/images/:id`            | Delete an owned asset                                     |

The compatibility mount `/api/image/*` maps to the same router. There is no public `/images/:filename` route.

Verified image list entries include `sha256` and available intrinsic dimensions.
Generated assets bind these values to retained local bytes. Verified content
downloads include `X-Content-SHA256`; changed bytes fail with
`DOCUMENT_ASSET_INTEGRITY` (`503`). Deleting an asset referenced by any preserved
scene or layout revision fails with `DOCUMENT_ASSET_REFERENCED` (`409`), including
inline images and table/header/footer stories. This protection remains active
when structured editing is disabled. Unreferenced asset deletion retains physical
bytes for a separate reachability cleanup.

### Models, settings, prompts, and metrics

| Method       | Path                                                     | Auth            | Purpose                                                                           |
| ------------ | -------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------- |
| `GET`        | `/models`, `/models/models`                              | Optional        | Models from the configured backend                                                |
| `GET`        | `/models/settings`, `/models/status`                     | Optional        | Active backend settings/status                                                    |
| `GET`        | `/ollama/*`                                              | Same as models  | Compatibility alias                                                               |
| `GET`, `PUT` | `/settings`                                              | Bearer          | Per-user preferences                                                              |
| `POST`       | `/settings/sessions/revoke`                              | Bearer          | Sign out everywhere: refuse every browser session signed in before now            |
| `GET`        | `/prompts`, `/prompts/:key`, `/prompts/additional/:name` | Bearer          | Read internal prompt templates                                                    |
| `GET`        | `/metrics`                                               | Metrics token   | Incremental server metrics; timing-safe credential check and failed-auth throttle |
| `POST`       | `/metrics/ingest`                                        | Rate-limited    | UI metric batch                                                                   |
| `POST`       | `/auth/diagnostics/rate-limit`                           | Internal secret | Deterministic Redis limiter proof in a disposable isolated namespace              |

Arbitrary inference probes and shared model mutations are internal-only:

- `GET /api/admin/models/probe`
- `PUT /api/admin/models/settings`
- `GET|POST /api/admin/adapter/*`

## ProserAuthor proxy

Browser code inside ProserAuthor should call relative `/api/*` paths. The proxy:

- reads `FACTORY_URL`;
- requires the current Auth.js session for protected work;
- signs a 10-minute Factory JWT with `FACTORY_AUTH_SECRET`;
- strips browser cookies and supplied authorization headers;
- requests uncompressed upstream responses;
- applies bounded response sizes and endpoint-specific timeouts.

Server-to-server clients should normally call ProserFactory directly.

## Hermes plugin

`ProserFactory/hermes/plugins/proser-api/` registers utility tools for books, exports, bounded context, codex, generation, settings, models, and images, plus Workflow v1 launch/status/control/checkpoint/publication tools.

The retired Factory, Wizard, NovelRun, ReviewRun, quality-scan, and continuity-scan tools are absent. Whole-book work should use `proser_full_book`; review and editing should use the corresponding workflow tools. See `ProserFactory/HERMES_AGENT_PLUGIN.md`.

## Deployment-relevant environment

| Variable                                                      | Purpose                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                | Required PostgreSQL URL on the Compose network or an operator-configured endpoint   |
| `DATABASE_POOL_SIZE`                                          | Per-process PostgreSQL pool ceiling, bounded from 2 to 100 (default `20`)           |
| `POSTGRES_PASSWORD`                                           | Host-local credential consumed by Compose and the Factory connection URL            |
| `MIGRATION_EVIDENCE_SIGNING_KEY`                              | Host-local HMAC key for signed one-time cutover evidence                            |
| `FACTORY_AUTH_SECRET`                                         | Author-to-Factory JWT verification                                                  |
| `INTERNAL_API_SECRET`                                         | Internal API authentication                                                         |
| `METRICS_TOKEN`                                               | Required production credential for `GET /api/metrics`                               |
| `HERMES_AGENT_AUTH_SECRET`                                    | Dedicated Hermes JWT verification                                                   |
| `REDIS_URL` or `REDIS_HOST`/`REDIS_PORT`                      | BullMQ, rate limits, caching, and workflow coordination                             |
| `INFERENCE_HOST`                                              | Preferred OpenAI-compatible endpoint; current topology uses `http://127.0.0.1:8000` |
| `OLLAMA_BASE_URL`, `VLLM_BASE_URL`                            | Compatibility endpoint aliases                                                      |
| `OLLAMA_MODEL`, `VLLM_MODEL`                                  | Compatibility model aliases                                                         |
| `WEBUI_FORGE_URL`                                             | Current image endpoint, default `http://127.0.0.1:7861`                             |
| `CORS_ALLOWLIST`                                              | Comma-separated production browser origins                                          |
| `TLS_ENABLED`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `TLS_CA_FILE` | Native HTTPS                                                                        |

Nova service-principal writes require an exact v2 mission grant and the complete
Magnus shared-resource fence header set. `GET
/api/shared-resource-operations/{operationId}` recovers the exact journaled state,
`sharedResourceResult`, and signed `sharedResourceEvidence`. Existing-book
mutations use `provider:proser:{bookId}`; new books, unbound full-book launches,
and bounded editorial benchmarks use `provider:new:proser`. Generation and image writes require an exact
owning book, and ambiguous or unbound non-book mutations fail before reserve.
`POST /api/nova-grants/workflow-publish` registers an exact workflow-UUID,
short-lived signed `workflows.publish` grant with status and recovery reads.
It requires `grant:register`; the subsequent empty-body
`POST /api/workflows/{runId}/finalize` requires `content:publish`, the
`external_publish` shared-resource fence for that book, and a pending final
release checkpoint. Its 202 response records approval and dispatch, while
the later `release_approved` workflow and publication package are the
completion evidence. The grant cannot fetch publication bytes or approve a
different checkpoint.
`POST /api/nova-grants/workflow-read` can register a later signed,
exact-workflow `workflows.read` grant for status and publication metadata
after the short-lived publish grant expires; it has no mutation authority.
Checkpoint-free Quality Review and Editorial Optimize workflows bind admission
to one durable run, retain the complete resource/GPU fence through worker claim
and recovery, and sign the final result at terminal publication. A superseded
queued worker cancels without publishing. Full Book, Improve Quality, and Guided
Improve launches remain signed durable `no_effect` until continuation authority
can transfer safely across checkpoint decisions. Redis-backed durable prose-operation
launches also fail before dispatch; their cross-store publication boundary remains open. See
[`ProserFactory/docs/NOVA_PROVIDER_GRANTS.md`](ProserFactory/docs/NOVA_PROVIDER_GRANTS.md).

The trusted Nova Playwright runner and local browser-run receipt exporter are
not HTTP APIs. The runner derives its build, fixture, sorted cases, and retained
evidence digests from execution. Its insert-only Factory journal and operator-key
contract are documented in
[`ProserFactory/docs/NOVA_BROWSER_RUN_RECEIPTS.md`](ProserFactory/docs/NOVA_BROWSER_RUN_RECEIPTS.md).
It signs only a retained terminal run by identifier and grants no browser run,
publication, promotion, or acceptance authority.

Production uses the [root Compose stack](docs/COMPOSE.md). Factory and its
worker share the application image with Author. The migration check, reviewed
database transition, backups, and live API verification protect an existing
installation. The legacy native deployment retained by
`ProserFactory/scripts/deploy-to-proser.sh` has a separate migration path. Its explicit `--record-existing-cutover <maintenance-window-operation-id>` operator flow is bound to the SQLite source hash, a PostgreSQL checkpoint hash, and a deterministic source/target report covering rows, primary keys, nullability, and aggregates. It re-enables relationship enforcement, checks target orphans and constraints, performs representative application reads, records `_proser_cutover_receipts`, and writes signed deployment evidence.

Authenticated inference, export, rollback, reset, benchmark, and manuscript-wide
workflow launch routes have shared runtime contracts for per-user and per-book
concurrency, daily budgets, request bytes, and deadlines. Book-scoped admission
uses the canonical ID from a successful owner lookup, never a raw path, query,
or body value. Active slots are renewable operation-owned Redis leases; renewal
requires a strictly unexpired score, and an old response cannot release a newer
operation's capacity. Synchronous route deadlines stop renewal, release
capacity, abort downstream work, fence later writes, and close noncompliant
responses after a short grace period; workflow-launch
deadlines cover queue acceptance only, while durable worker leases govern
background execution. The exact current ceilings are generated into
`PROSER_API.generated.md`; Redis failure is fail-closed for these allocations.
The deployed smoke proves fixed-window enforcement through the internal
diagnostic endpoint, whose disposable keyspace cannot consume an ordinary
user's generation budget.

## Structured document transition APIs

Owned book document capabilities are available at
`GET /api/books/:bookId/document-capabilities`. Canonical scene reads, manifest
reads, explicit initialization, atomic commits, receipt recovery and restoration
are documented in the generated contract. They require
`DOCUMENT_AUTHORITY_ENABLED=true`; production activation remains blocked by the
selected release checklist and reviewed preservation procedure. R2/R6
certification is deferred by user instruction. Commit preconditions reject stale writes
with 412, operation reuse conflicts with 409, and missing preconditions with 428.

The active editor reads ordered `/scenes/:sceneId/document-passages` windows.
Stable anchor navigation and last-edge navigation return exact canonical run
coordinates. Bounded typed operations use `/document-passages/operations`, with
source frame, window digest, expected scene/book revisions and an operation UUID.
A scene request with `sourceFrame.projection: "markup"` accepts only
`resolve-change` operations qualified by the displayed review record and target
hashes. Its acknowledgement and recovered receipt contain the committed Markup
passage. Direct editing and compound commits use the working projection.
`/document-passage-commits` commits up to eight changed scene scopes atomically.
`/document-passage-transfers` moves complete qualified blocks or splits/joins
scene boundaries; `/document-passage-scope-restores` restores affected complete
scene bodies only when unrelated manifest/layout/structure references still match.
Responses and recovery receipts contain bounded passages and revision references.

Book-wide find and replace has two steps. `POST /api/books/:bookId/document-replace/preview`
takes `q`, `replacement` and `caseSensitive`, and lists every match in the saved
manuscript (up to 1000 matches in 100 scenes) with an excerpt and whether it can
be replaced. A match that crosses formatting, a paragraph, an object or a pending
tracked change is listed with a reason and cannot be selected.
`POST /api/books/:bookId/document-replace` takes the selected matches, the
previewed book revision and an operation UUID, and commits every changed scene
as one book revision. A stale book returns 412; a match that no longer matches
returns 409. The receipt names `previousRevisionId`; restore it through
`/document-revisions/:revisionId/restore` to undo the replace.

Comment creation/resolution/reanchoring uses `/document-passages/comments`.
Immutable comment detail and review-history endpoints page retained evidence by
revision and record digest. Factory supplies local attribution, derives exact
formatting/split/move lineage and marks removed or ambiguous targets stale. The
first bounded passage exposes orphaned-comment summaries for explicit review.

Authenticated clients can negotiate capabilities before their first book at
`GET /api/books/document-capabilities`. New-book creation uses an operation UUID;
`GET /api/books/document-creation-operations/:operationId` recovers the creator's
book ID after a lost acknowledgement. The guarded
`POST /api/books/:bookId/document-quick-drafts` atomically appends a drafting scene
and any missing hierarchy. Its original catalog receipt is recovered through the
document operation endpoint; retrying does not fetch a newer source revision.

Author's scoped book-list/new-book consumers send `X-Proser-Expected-User` with an
encoded authenticated session ID. The same-origin proxy compares it with the
server session, returns `409 SESSION_SCOPE_CHANGED` on a mismatch, and strips
the header before Factory dispatch. This is a browser-session precondition,
never a substitute for authentication or Factory ownership checks.

Saved structured feedback is read at
`GET /api/books/:bookId/document-traces?sceneId=:sceneId`. Findings and compare
cards expose bound, stale, unbound or review-blocked targets; quotation matching
does not relocate them. Trace analysis retains its exact source revision and
provider outcome at `/document-analysis-operations/:operationId`; unknown effects
cannot be replayed automatically. Cancellation suppresses late findings while
retaining returned provider evidence.

Workflow provider receipts are read at
`GET /api/books/:bookId/document-workflow-effects?runId=UUID&limit=50` with
`items`, `hasMore` and an owned `nextCursor`. Supply `cursor` for subsequent pages
(maximum 100 records). Individual `/document-workflow-effects/:operationId`
reads default to status; `view=request|result`, `offset` and `limit` page retained
JSON with explicit UTF-16 offsets and checksum. Private responses never expose
another author's receipt. `POST /:operationId/cancel` suppresses application;
an unknown provider outcome remains unknown and cannot be repeated automatically.

The existing `/scenes/:sceneId/prose/preferences` mutation now requires operation,
book and scene revision preconditions when structured authority is active. An
applied choice additionally requires explicit revalidation through
`/document-traces/:traceId/compare-cards/:cardId/revalidate`. It preserves existing
editorial verification and commits the choice, audit, receipt and pending tracked
edits atomically. Preference recording, applying edits, accepting changes and
publication approval remain separate actions. Author retains interrupted choices
in a user/book/scene-scoped IndexedDB journal for thirty days and recovers the
original receipt before offering an exact retry.

Import originals are uploaded as `application/octet-stream` to
`POST /api/books/:bookId/import-originals/:originalId` (1 byte to 32 MiB), then
converted through `POST /api/books/:bookId/import-previews`. The original UUID
remains recoverable even when malformed content fails conversion. Read the
mapping/report at `/import-previews/:previewId` and owned original bytes at
`/import-originals/:originalId/content`. The commit endpoint
`POST /import-previews/:previewId/commit` requires source book/structure/canon
revisions, an operation UUID and consent to the exact report hash. It appends
new identities and preserves existing manuscript/review history. Previews support
the documented legacy Markdown bundle and bounded rich-text DOCX conversion.
Add `?format=markdown` or `?format=plain-text` to the original upload for a
single Markdown or plain-text manuscript; the same preview and commit endpoints
then map its chapter headings, part headings and scene-break lines, and the
report (`codec: proser-plain-manuscript`) lists what the conversion changes.

`GET /api/books/:bookId/import-originals` lists the book's originals with their
preview count, whether a committed import came from each one, and storage use
against the quota. `DELETE /api/books/:bookId/import-originals/:originalId`
deletes an original that no committed import used, together with its
uncommitted previews, and frees its quota. An original a committed import came
from returns `409 DOCUMENT_IMPORT_ORIGINAL_COMMITTED` and stays as that import's
evidence. Only the account owner can delete; a delegated agent receives `403`.
A deleted original's UUID can be uploaded again.
Identified conversion losses require consent to the retained report. Supported
header/footer review graphs become owned layout stories; scene bodies retain
empty compatibility fragments. Full exchange/rendering acceptance and production
publication integration remain required before release.

Book/chapter layout changes use the layout scope revision precondition. Ordinary
scene document commits cannot mutate their retained `layout` snapshot and return
`DOCUMENT_LAYOUT_SCOPE_REQUIRED` (`409`) if it changes. Exact owned historical
restoration and verified import conversion are handled by the document service.

Structure saves now upsert stable act/chapter identities and retain existing
scenes. Omission does not delete manuscript content; deletion requires an explicit
operation. Legacy prose/structural writes are refused after authority activation
until routed through structured operations. See
[Factory document operations](ProserFactory/docs/STRUCTURED_DOCUMENTS.md).

### Chapter transitions

`GET /api/books/:bookId/chapter-transitions` returns the first three adjacent active
chapter pairs from one saved final-view book revision, ordered by act/chapter/scene.
Each edge contains a chapter label, scene revision/hash, bounded actual text and
truncation disclosure. Empty boundaries remain empty. Opening edges may expose an
editable stable paragraph target. Requires owned book and active document authority.

`POST /api/books/:bookId/document-discussions` accepts optional
`transitionChapterId` (the ending chapter). Factory freezes both adjacent excerpts
and accepts only the exact saved opening target, with no local draft or parent
discussion. Existing proposal/recovery routes produce one small opening revision
plus continuity, momentum and reading-motivation notes. Any intervening book
revision rejects revalidation/application; original operation recovery is preserved.

## Plot Threads: questions, saved evidence, and earned payoff

`/api/books/:bookId/plot-threads` requires authentication, ownership of an active
book, and active structured document authority. Author proxies every browser
request through the same origin. Factory owns all thread and inference data.

| Method      | Route suffix                              | Behavior                                                                                 |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET         | `/`                                       | List questions and stage counts; `archived=true` and numeric `after` paginate 50 threads |
| POST        | `/`                                       | Create a question with `operationId` and `expectedVersion: 0`                            |
| GET / PATCH | `/:threadId`                              | Read detail or update question, description, notes, status, or `archived`                |
| POST        | `/:threadId/evidence`                     | Attach saved setup/escalation/payoff text; optionally replace an existing evidence ID    |
| POST        | `/:threadId/evidence/:evidenceId/remove`  | Remove a live link while retaining its historical row                                    |
| GET         | `/operations/:operationId`                | Recover the exact owned mutation receipt                                                 |
| POST        | `/:threadId/reviews`                      | Review frozen linked excerpts, retaining request, result, citations, and provenance      |
| GET         | `/:threadId/reviews/:reviewId`            | Recover the exact review, including source staleness and author assessment               |
| POST        | `/:threadId/reviews/:reviewId/cancel`     | Cancel pending inference; dispatched cancellation remains unknown until recovered        |
| POST        | `/:threadId/reviews/:reviewId/assessment` | Save the author's judgment and review notes separately                                   |

Updates, links, removal, reviews, and assessments require an operation UUID and
`expectedVersion`. Evidence attachment additionally supplies `sceneId`,
`expectedRevisionId`, `expectedSceneRevisionId`, `expectedContentHash`, and
ordered `targets` (`blockId`, UTF-16 `from` / `to`, and exact `sourceText`).
Factory validates complete Unicode boundaries, active hierarchy membership,
saved document hashes, and pending-review/object conflicts. Review creation
also supplies the saved book `expectedRevisionId`; `selectedModel` is optional.
Thread mutations return a receipt with operation and thread identities/version.

Statuses remain `open`, `escalated`, `resolved`, and `abandoned`. Reviews return
`earned`, `weak`, or `insufficient-evidence` plus observations with exact
`evidenceId` / `quote` citations and suggestions. Missing linked stages do not
establish that the manuscript lacks those stages. The complete source snapshot
and prompt must fit 64,000 bytes; context is not silently truncated. Provider
calls have a 120-second bound and a 150-second Author proxy allowance. Per-user
and owned-book inference quotas match the existing document proposal budget.

Recovery validates retained provider bytes after a crash between result storage
and critique finalization; it never dispatches inference. Exact multi-paragraph
quotations are allowed, with complete Unicode grapheme boundaries. A pending
request rejected by changed source/admission receives a terminal failure receipt.
Cancelling a running call does not prove provider cancellation: it remains
`unknown`, blocks another review of the same frozen inputs, and can become
`ready` if its original completed result arrives. Earlier dispatched cancellation
records receive the same conservative interpretation.

`DocumentDiscussionInput` optionally accepts paired `plotThreadReviewId` and
`plotThreadEvidenceId`. Factory verifies the current completed review and exact
saved target, then includes its frozen question/evidence/critique in proposal
context. This cannot be combined with a local draft, parent discussion, or
chapter-transition context. Proposal revalidation/application reject changed
thread inputs or manuscript sources and retain the existing tracked-change,
operation, audit, and receipt contracts. Thread proposals allow at most 600
removed/inserted characters. A known receipt is recovered before source checks;
unknown provider outcomes never authorize automatic redispatch.

## Revision campaign API

All campaign routes are authenticated, owned-book-scoped and private/no-store.
`/api/books/:bookId/revision-campaigns` supports list/create; `/:campaignId`
supports read/version-checked update. `/:campaignId/analyses` accepts an operation
UUID, expected campaign version, canonical book revision and mode
`plan | preview | recheck`. Preview includes an exact proposal ID and optional
selected target IDs. The `202` receipt contains `runId`, `planId` and `statusUrl`
for the existing workflow APIs. `/:campaignId/plans/:planId/decisions` records
approval, requested changes, skip, resolved tracked edits or completion.
`/operations/:operationId` recovers the original mutation receipt; the exact-plan
GET retains older evidence independently of the latest-plan list.

Document discussions optionally take `revisionCampaignPlanId` and
`revisionCampaignStepId` together. Factory supplies the trusted frozen campaign
context; browser-provided facts or consequences cannot authorize application.
Prose uses the existing proposal/revalidate/apply endpoints. Application requires
matching candidate verification and rejects stale source, rules or plot evidence.
See [the campaign guide](ProserAuthor/docs/REVISION_CAMPAIGNS.md).
