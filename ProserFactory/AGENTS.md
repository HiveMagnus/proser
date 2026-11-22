# AGENTS.md — proser-factory

Express 5 API server + BullMQ workers. Prisma/PostgreSQL for persistence, Redis for queues/pub-sub, and a configured OpenAI-compatible inference endpoint.

The Factory now also backs ProserAuthor's phone-first mobile shell, including command-driven prose revision for scene-wide or paragraph-scoped edits.

## Quick Start

```bash
npm install
npm run db:generate          # Generate Prisma client
POSTGRES_PASSWORD=... docker compose -f docker-compose.postgres.yml up -d --wait
npm run db:migrate           # Run PostgreSQL migrations
npm run dev                  # tsx watch on port 3001 (HTTPS when TLS_ENABLED=true)
```

For native HTTPS development, generate certificates as follows.

```bash
bash ../ProserAuthor/scripts/generate-certs.sh ../ProserAuthor/certs
```

Workers (requires Redis + `USE_BULLMQ=true`):

```bash
npx tsx watch src/workers/index.ts  # Workflow and live-prose-judge workers
```

Production uses the [root Compose stack](../docs/COMPOSE.md), with Factory
and its worker sharing the pinned application image. Verify the current
database schema, durable Redis state, and exact installed image before resuming
traffic. The steps below describe the separate native release tooling.

Native deployment must run the Redis persistence preflight before stopping either service. A successful `PING` is insufficient: the preflight verifies an expiring write/read, forces a background snapshot, requires a healthy persistence result with no consecutive failures, then verifies writes again.
`bash scripts/deploy-to-proser.sh --dry-run` runs typecheck, smoke tests, and
build, then reads the installed revision and service state without changing
production. The native migration deployment compares the candidate with the
installed Git revision. It accepts only unchanged Prisma authority or a new
additive migration with immutable earlier SQL. It stops the API and worker
before replacing release bytes, takes a pre-migration PostgreSQL dump, applies
the candidate migrations to a disposable restored database, and proves a
second restore before touching the live schema. A failure after byte
replacement leaves both services stopped with an owner-only release record
under `~/.local/state/proser-factory-migrations/`. Reconcile writes, exact
code, and Prisma state before reopening traffic or restoring data. A candidate
may accept writes between restart and its final probe, so the pre-migration
dump is never an automatic live rollback.
For a Council reviewed code-only patch with unchanged Factory package, Prisma
schema/migrations, and service units, use
`node scripts/council-code-factory-release.mjs dry-run|deploy|rollback
--release-id ID --revision FULL_SHA --record-dir ABS` from the Proser root.
This path requires zero pending or unresolved Prisma migrations, stages an
exact built `dist` archive, takes a validated PostgreSQL dump before code
activation, and rolls back only code while retaining the database. It does
not replace the native migration deployment above; a schema-changing Council
patch uses the separate reviewed native path and candidate-specific proof.

## Test Commands

| Command              | What it runs                                 | Needs DB? |
| -------------------- | -------------------------------------------- | --------- |
| `npm test`           | Full Jest suite (`--runInBand --coverage`)   | Yes       |
| `npm run test:smoke` | Smoke tests only (envelope contracts, no DB) | No        |
| `npm run test:cli`   | CLI-specific tests                           | No        |
| `npm run typecheck`  | `tsc --noEmit`                               | No        |

- Tests share the configured PostgreSQL database and must clean up their fixtures.
- Full Jest refuses to start unless `DATABASE_URL` explicitly selects
  `127.0.0.1:55441/proser_canvas_*` and `REDIS_URL` explicitly selects
  `127.0.0.1:56441`. This guard runs before dotenv; host `.env` never authorizes
  database-backed tests. Smoke and CLI mock suites remain separate configurations.
- Mock AI by overriding `global.fetch` in `beforeAll`.
- Always shut down pub/sub and BullMQ connections in `afterAll`.

## Lint / Format

```bash
npm run lint                 # ESLint (flat config, v10)
```

- No Prettier configured; ESLint is the single code-quality gate.
- The `no-restricted-globals` rule bans raw `fetch` in `src/` — use `withRetry` + `VllmService` instead.
- EPUB and DOCX ZIP containers use the buffer-oriented `yazl` adapter in
  `src/lib/zipArchive.ts`; Factory remains a CommonJS build.

## Build

```bash
npm run build                # owned TypeScript compiler pipeline → dist/
```

- `scripts/build.mjs` uses the installed TypeScript compiler to resolve `@/` module specifiers during JavaScript/declaration emission. It preserves prose strings and emits source maps through the compiler. `npm run test:build` verifies static/dynamic imports, declarations and failure without emission.
- Node.js builtins that collide with `src/` directory names (e.g. `events`) must use the `node:` protocol prefix (`import … from 'node:events'`) to make the runtime boundary explicit.

## Companion Systems

ProserFactory is standalone. It may be used directly through its HTTP API or the bundled CLI, and it does not require a companion ProserTrainer service at runtime.

## Prisma Driver Adapter

Prisma v7 uses the **client** engine type with `@prisma/adapter-pg`
(`PrismaPg`). The adapter is initialised in `src/lib/database/index.ts` with
the required PostgreSQL `DATABASE_URL`; `DATABASE_POOL_SIZE` sets the bounded
per-process pool.

## Code Conventions

### Nova provider-status grant boundary

The Ardent Nova provider-status registration route requires the explicit
`grant:register` scope on the configured `nova-creative` service principal.
Never authorize registration by borrowing `content:read` or a GET route's
permission. Accept only a short-lived, Ed25519-signed v2 grant bound to the
exact request and caller, with `capabilities.read`, empty resources and action
classes, and no mutation authority. Keep the live registry and retained audit
records in owner-only paths; archive expired live entries before pruning and
preserve active or revoked authority. No standing direct-owner grant or model
text may mint a request grant.

The separate `/api/nova-grants/books-read` route may register only one
short-lived signed `books.read` action for one exact numeric `book:{id}`
resource. Keep its `grant:register` principal check, private registry and
audit rules identical to the provider route. It grants no book mutation or
artifact delivery claim. That book-level read covers its metadata and export
manifests without a per-manifest grant; validate the requested artifact ID and
returned digest, and require Ardent's separate `create_artifact` action before
fetching bytes.

The separate `/api/nova-grants/generation-read` route may register only one
short-lived signed `generation.read` action for one exact generation operation
UUID. It permits only that operation's status GET, never its artifact endpoint,
operation listing, creation, cancellation, or a book read. Ardent must retain
an owner-issued task-to-operation receipt before trying this staged read.

The separate `/api/nova-grants/workflow-publish` route may register one
short-lived signed grant for one exact workflow UUID with
`workflows.publish`, `workflows.read`, and `operations.read`, under the
`external_publish` shared-resource class. Require a `content:publish`
principal and the current `provider:proser:{bookId}` fence for finalization.
Constrain the grant to that workflow's empty-body finalize request, status,
publication metadata, and exact operation recovery. A 202 finalize response
means checkpoint approval and dispatch; only the owner's later
`release_approved` workflow and publication receipt proves completion.
Unknown effects remain unknown until exact operation recovery proves them.
For an asynchronous approval that outlives its five-minute publish grant,
`/api/nova-grants/workflow-read` may register a new task-bound, exact-workflow
`workflows.read` grant with no mutation class. It permits only workflow status
and publication metadata GETs, never another finalize or artifact-byte fetch.

- **TypeScript strict mode** — no `any` unless unavoidable.
- **`@/*` path alias** maps to `src/*`. Use it for all imports.
- **Logging**: `import logger from '@/lib/logger'` (Pino).
- **Errors**: Throw `ValidationError`, `NotFoundError`, `AIServiceError` from `@/lib/errors`. Caught by `errorHandler` middleware.
- **API responses**: Use `respondSuccess(res, data)` / `respondError(res, ErrorCodes.X, msg, status)` from `@/api/utils/response.ts`.
- **AI calls**: Always wrap with `withRetry()` from `@/lib/resilience`. Pass `params: { temperature, maxTokens }` — `maxTokens` is propagated through all `VllmService` call paths.
- **Prompts**: Define in `@/config/prompts.ts`, access via `@/prompts/service`.
- **Prose generation**: Use `SceneProseService` — never call the inference backend directly. It automatically sizes `maxTokens` proportional to `targetWords` (`Math.max(512, ceil(targetWords * 1.8))`), and post-processes output with `stripReasoningPreamble()` to remove any planning text that leaks through.
- **Mobile command revisions**: `POST /api/generate/prose/command-revise` is the backend contract for the mobile Studio command bar. It validates `bookId`, accepts `scope: "scene" | "paragraph"`, and delegates to `SceneProseService.reviewProse`.
- **Reasoning tokens**: The default prose model is `qwen3.6-35b` on llama.cpp. `VllmService` sends `chat_template_kwargs.enable_thinking=false` by default and returns only `content`; `reasoning_content` / `delta.reasoning` are captured into `lastInferenceMetadata` when `AI_CAPTURE_REASONING_ENABLED=true` and then discarded from the response. `stripThinkingBlocks()` from `@/lib/ai/sanitize` handles any `<think>` tags that appear inline in `content`.

## PR Expectations

- **Branch naming**: `feature/<short-name>`, `fix/<short-name>`, `chore/<short-name>`
- **Commit messages**: Imperative mood, ≤72 chars first line. Example: `Add retry logic to prose generation endpoint`
- **Scope discipline**: Change only what the issue/task asks for. No drive-by refactors.

## Definition of Done

- [ ] `npm run typecheck` — zero errors
- [ ] `npm run lint` — zero errors, no new warnings
- [ ] `npm test` — all tests pass (or `npm run test:smoke` if no DB available)
- [ ] `npm run build` — compiles cleanly
- [ ] New code has tests (or justification for skipping)
- [ ] No secrets or credentials in committed files

## Structured document transition

Use the root Node 24.22.1 pin for local builds and checks. Structured documents
are active in production. Unprepared installations keep
`DOCUMENT_AUTHORITY_ENABLED=false` until the selected writer and release
conditions in `../CANVAS_RELEASE_CHECKLIST.md` pass. R2 device/accessibility
certification is active and incomplete; follow `../CANVAS_R2_ACCEPTANCE.md` for
the exact candidate and evidence boundaries. Revision campaigns use the practical
automated gate; unavailable physical-device or actual screen-reader certification
is nonblocking for development and release. R6 performance certification remains
deferred. Preserve prior release evidence and its original scope.
Native release installs `../scripts/install-node-runtime.py` on the host and
selects `/opt/proser-runtime/node-v24.22.1/bin/node`. Retain its exact official
archive checksums and full-tree receipt; never replace host-wide Node as a shortcut.
`src/documents/model.ts` owns the generated Author contract. Document revisions,
heads, receipts and projections must commit atomically through the document service.
Do not add independently writable prose authority or bypass workflow/resource fences.
Saved generation feedback must bind through `documents/traceAnalysis.ts` to the
original operation and immutable committed revision. Compare-card application
requires explicit target revalidation and top-level book/scene revisions plus an
operation ID; preserve editorial verification and atomically record pending
tracked edits, choice, audit and receipt. Never relocate targets by quotation
search or replay an analysis with an unknown provider outcome.
Factory lint includes `documents:writers`, a source restriction across runtime
and operator TypeScript. Only the document service persists prose/counts; its
temporary compatibility helpers reject active-authority use. Backfill apply must
verify existing heads, not skip them. Import utilities preserve original bytes,
preview/report before commit, require exact loss consent and append identities;
never delete manuscript or review history to reimport a bundle.

Readiness requires healthy persistent configured Redis and fresh consumers when
BullMQ is enabled. Each worker publishes an expiring instance receipt only after
initialization; readiness checks both queues and the configured installed revision.
It is distinct from process liveness and inference availability. Active authority
also requires supported/backfilled schema, reviewed database enforcement, writable
asset/artifact storage, Chromium and a verified installed font/license manifest.
Keep enforcement installation and activation outside the additive deployment
classifier until the candidate-specific reviewed rehearsal passes.

Workflow provider calls must retain exact request/source/result receipts before
application. Unknown outcomes never authorize another call. Selected drafts and
their task/memory/trace side records commit atomically; review/source checkpoints
must reject formatting/layout/object changes even when prose still matches.

## Maintained Word exchange codec

Factory consumes the exact public `@hivemagnus/canvas-word-codec` dependency
maintained in `ChefTaco/canvas-word`; its CommonJS entry preserves Factory
module behavior. `vendor/canvas-docx-codec` retains regression fixtures, original
upstream snapshots and historical source-lock notices, with no runtime fork or
independent dependency installation. Factory owns validation of owned documents,
asset access, hierarchy mapping, original preservation, publication jobs and
artifact persistence. Do not move those business rules into the codec. Run
`npm run codec:test` and the Factory import/publication corpus for codec changes.
Verify the installed shared packages and run `node scripts/generate-canvas-release-ledger.mjs --check`
against exact final distributions before release. See
`docs/canvas-dependencies.json` and `docs/canvas-release-sbom.json`.

The native deploy script installs the shared codec through frozen runtime
installation and installs checksum-pinned licensed fonts from
`config/publication-font-pins.json`. Its byte checkpoint includes existing vendor,
config and publication-font directories. Systemd binds publication rendering to
`/opt/proser-factory/publication-fonts/manifest.json`; preserve that manifest and
font licenses with the release. No activation or deployment follows merely from
a successful codec build. Microsoft Word acceptance remains unverified.

Released fork provenance files remain exact package snapshots. Current upstream
submission status and diagnostic retention are supplemented in
`../ProserAuthor/docs/CANVAS_MAINTENANCE.md`; update packaged provenance and the
ledger together when releasing a new fork. Current deployment summaries are in
`../CANVAS_RELEASE_RECORD.md`. Operators retain exact production evidence privately.

## Revision campaign acceptance decision

The author selected a practical release gate for revision campaigns: automated
browser, keyboard, accessibility and exact recovery checks are required. Run
available actual screen-reader checks. Unavailable physical-device and actual
screen-reader certification remains explicitly incomplete and is nonblocking for
development and release. Preserve the earlier candidate-specific evidence and
its limits. This current direction supersedes earlier R2 prerequisite wording;
R6 performance certification remains deferred.
