# AGENTS.md — proser-factory

Express 5 API server + BullMQ workers. Prisma/PostgreSQL for persistence, Redis for queues/pub-sub, and a configured OpenAI-compatible inference endpoint.

The Factory now also backs ProserAuthor's phone-first mobile shell, including command-driven prose revision for scene-wide or paragraph-scoped edits.

## Setup and operations

Use the [root Compose guide](../docs/COMPOSE.md) for a complete installation.
For source work, use Node `24.22.1`, run `npm ci` and `npm run db:generate`,
and follow [native development](README.md#native-development) for PostgreSQL,
Redis, and environment setup. `npm run dev` starts the API. Start the worker
separately when exercising durable workflows.

Verify the database schema, durable Redis state, installed revision, and
readiness before reopening traffic. The [native deployment guide](deploy/README.md)
and [reviewed native release runbook](docs/CANVAS_REVIEWED_NATIVE_RELEASE.md)
cover the Redis persistence preflight, additive migration and restore rehearsal,
code-only rollback, and private release records. Reconcile writes made after
cutover before restoring any database snapshot.

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

## Prisma Driver Adapter

Prisma v7 uses the **client** engine type with `@prisma/adapter-pg`
(`PrismaPg`). The adapter is initialised in `src/lib/database/index.ts` with
the required PostgreSQL `DATABASE_URL`; `DATABASE_POOL_SIZE` sets the bounded
per-process pool.

## Code Conventions

### Nova grants and fencing

Follow [Nova provider grants](docs/NOVA_PROVIDER_GRANTS.md) and
[release admission fencing](docs/RELEASE_ADMISSION_FENCE.md). Bind read grants
and mutations to the exact owned resource and operation. Preserve the
distinction between status access, workflow finalization, and artifact bytes.
Recover unknown outcomes by operation ID and require terminal evidence before
reporting publication complete.

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
