# ProserFactory

Factory owns the Express API, PostgreSQL data, Redis-backed workflows, and
text and image integrations. [Install the complete application](../README.md#quick-start)
with Docker Compose, or use the native development steps below to work on Factory.
Agents connect through [the Factory API](../PROSER_API.md) or
[Hermes](HERMES_AGENT_PLUGIN.md). The [CLI](CLI.md) is a local operator tool.

Factory remains CommonJS with an owned TypeScript 6 compiler build and its own npm
lockfile; database authority and public API contracts are unchanged.
Native deployment installs and verifies the exact Playwright Chromium renderer as
the configured Factory service user before restarting traffic. The host must have
make, g++ and Python 3 for native npm modules (Ubuntu: build-essential and
python3); deployment checks these prerequisites before stopping either service.
Prisma CLI is installed as a runtime dependency; native release commands use the
installed exact CLI without implicit npm downloads.

## API documentation

Factory builds with its owned TypeScript compiler pipeline in `scripts/build.mjs`.
It rewrites only `@/` module specifiers during JavaScript/declaration emission,
preserving manuscript strings and compiler source maps. `npm run test:build`
checks static/dynamic loading, declaration imports and failure without emission.
Run `npm audit` to check the current Factory lockfile. The October 31 security
update moved schema validation to Zod 4.6.7 and patched request parsing, query
encoding, URI handling, telemetry and browser dependencies.
Jest uses the locally patched MIT `vendor/deepmerge` package because upstream has
no prototype-poisoning fix. `npm run test:build` verifies the patch and its
installed resolution. See [the security record](../docs/SECURITY_2026_10_31.md).

- Human route guide: [`../PROSER_API.md`](../PROSER_API.md)
- Checked-in generated contract: [`../PROSER_API.generated.md`](../PROSER_API.generated.md)
- Generated OpenAPI UI: `GET /api/docs`
- Generated OpenAPI JSON: `GET /api/docs.json`
- Hermes plugin guide: [`HERMES_AGENT_PLUGIN.md`](HERMES_AGENT_PLUGIN.md)
- Nova Playwright runner and signed receipt guide: [`docs/NOVA_BROWSER_RUN_RECEIPTS.md`](docs/NOVA_BROWSER_RUN_RECEIPTS.md)

`npm run docs:generate` rebuilds the versioned reference from the OpenAPI/Zod
route contracts, and the root documentation gate rejects stale output.
Hermes starts durable work with small workflow-specific calls and then reads
status or makes checkpoint decisions; it never submits manuscript-sized
artifacts.

Factory accepts bearer JWTs only through the `Authorization` header. Prompt
templates are classified as internal and require authentication; built-in
template names use strict allowlists rather than filesystem lookup.

Plot Threads is available under `/api/books/:bookId/plot-threads` when structured
document authority is active. Its additive migration extends existing extracted
threads and introduces retained evidence, review, and mutation receipts. Review
inference uses `SceneProseService`, bounded prompts, release admission, and exact
operation recovery. Author management protects a thread from extractor updates.
Recovery can validate retained provider bytes after an interruption. Cancellation
after dispatch remains unknown and does not authorize another call against the
same frozen evidence; pending source rejections retain terminal receipts.
The root Compose initializer applies the schema before Factory starts. In a
split deployment, update Factory before Author.
[Plot Threads guide](../ProserAuthor/docs/PLOT_THREADS.md)

For a non-loopback production inference provider, set `INFERENCE_API_KEY`.
Factory sends it as a bearer credential on inference requests. Keep it in the
deployment's private environment.

Native releases use the validated installed `REVISION` file for both health
metadata and worker heartbeat revision checks. Historical `GIT_COMMIT` or
`COMMIT_SHA` environment labels cannot override it; environments without a native
release file retain the configured-label fallback.

## Multi-workflow Book Factory v1

`WorkflowRun` is the durable orchestration root. It provides a shared task graph,
heartbeat, events, bounded retries, revision snapshots, and pause/resume/cancel
controls. The launch routes are:

- `POST /api/workflows/full-book` builds architecture, codex, style bible, budgets, scene contracts, prose, editorial child runs, verification, and a validated publication package.
- `POST /api/workflows/quality-review` performs immutable, read-only scene, chapter, act, and book analysis against an exact manuscript revision.
- `POST /api/workflows/improve-quality` consumes selected stored findings and transactionally records implementation and verification.
- `POST /api/workflows/guided-improve` applies an author instruction under the same safe-edit and checkpoint policy.
- `POST /api/workflows/editorial-optimize` runs a checkpoint-free autonomous
  editorial pass, retaining the original whenever evidence is insufficient.
- `POST /api/books/:bookId/revision-campaigns/:campaignId/analyses` launches
  bounded campaign planning, candidate previews, or post-edit re-review.

For workflow clients:

- Workflow creation requires an `Idempotency-Key` header. Reuse the same key for retries; the book, run, root task, initial review row, and enqueue outbox entry commit atomically.
- `GET /api/books/:bookId/workflows` rediscovers durable top-level runs with their nested editorial children after an agent or browser reconnects.
- `GET /api/books/:bookId/findings` returns at most 200 findings per page and supports `state`, `model`, `severity`, and `scope` filters. Each item includes its review metadata, replacing per-review browser fan-out.
- Workflow status contains bounded active-checkpoint summaries and resource-version counters. `GET /api/workflows/:runId/checkpoints/:checkpointId?offset=...` reads an explicitly requested proposal in pages of at most 32 KiB.
- Generation is created with authenticated `POST /api/generate/operations`, JSON, and an `Idempotency-Key`; the durable receipt is returned before inference begins. The browser then subscribes with a manuscript-free `GET /api/generate/operations/:operationId/stream?cursor=...`. Redis shares byte-bounded replay across instances, while `GET /api/generate/operations/:operationId/artifact` retains the authoritative completed artifact independently. Owner-scoped reconciliation and cancellation routes recover uncertain creates and abort server inference.
- Admission enforces per-user/global active-operation limits, a shared inference concurrency ceiling, per-operation output bytes, and replay bytes. Pending queue intervals, renewable running-worker leases, and absolute operation lifetime use independent deadlines; a lease release starts a fresh pending interval capped by the absolute lifetime. Claiming atomically terminalizes expired queue heads, recovers expired running leases before checking concurrency, and records recovery counts and latency. Every worker replay frame is fenced by running status, lease owner, lease and lifetime deadlines, and cancellation state. Terminal state and its replay event are committed by one fenced Redis transition, and completed artifacts are promoted from provisional storage only in that transition. Initial expired cursors return HTTP 409 before SSE headers; only expiration after a stream begins uses `replay_error`.
- Expensive HTTP-route capacity resolves book ownership before admission and
  uses only that canonical book ID. Active per-user/per-book slots are
  renewable UUID leases in Redis sorted sets; timestamp pruning recovers
  abandoned requests, expired leases cannot renew themselves, and release
  removes only the caller's lease. Synchronous exports, artifact creation,
  rollback, reset, and benchmarks consume the request cancellation signal and
  fence subsequent writes. Deadlines stop renewal and release capacity before
  a bounded cancellation grace closes a noncompliant response. Workflow-launch
  deadlines cover durable queue acceptance only; worker execution continues
  under the separate workflow lease and lifetime contract.

`POST /api/auth/diagnostics/rate-limit` requires `X-Internal-Secret` and runs a
deterministic limiter probe in a disposable diagnostic namespace. Deployment
smoke uses it instead of spending a generation route's real user budget.

Full Book pauses at architecture, sample prose, developmental plan, high-impact editorial decisions, and final release. It continues after the initiating agent disconnects. Quality findings are never overwritten across models; each records its model, rubric, source revision, evidence, recommendation, implementation metadata, verification, waiver, and staleness.

Drafting, sample selection, budgets, task dependencies and reviews follow active
act/chapter/scene order, including when chapter numbers restart in each act or
the author reorders the hierarchy. A sample checkpoint requires the actual
opening chapter's committed prose. Continuing an existing outline initializes
the new run's planning artifacts and reader promise before drafting. Native
draft requests retain the preceding scene's exact committed ending and revision
with the frozen provider request; book-wide instructions remain creative
requirements rather than literal phrases required in every scene.

The release state becomes `publishable_candidate` only when complete prose, reconciled length, fresh hierarchical review, severity, narrative-ledger, and export gates pass. Human final approval changes it to `release_approved`. Workflow status responses include an authoritative `terminal` Boolean and monotonic `statusVersion`, advanced exactly once by a database trigger for every row mutation, so clients do not duplicate the state machine. Publication output includes validated Markdown, EPUB, DOCX, HTML, metadata JSON, and a cover specification with hashes and authenticated downloads.

The retired FactoryRun, Wizard, NovelRun, and ReviewRun orchestration routes, tables, workers, queues, tools, and compatibility layers are intentionally absent.

See [`docs/WORKFLOW_V1.md`](docs/WORKFLOW_V1.md) for the state model and operator contract.
Editorial guides are in `docs/EDITORIAL_ENGINE.md`,
`docs/EDITORIAL_PASSES.md`, `docs/EDITORIAL_PROFILES.md`,
`docs/QUALITY_LAB.md`, and `docs/EDITORIAL_OPERATIONS.md`.

## Mobile authoring support

The ProserAuthor mobile shell uses the same Factory APIs as desktop plus one dedicated revision endpoint for command-driven editing on phone:

- `POST /api/generate/prose/command-revise`

This endpoint accepts:

- `bookId`
- `sceneId?`
- `originalText`
- `instruction`
- `scope: "scene" | "paragraph"`
- `sceneOutline?`

It routes through `SceneProseService.reviewProse` so mobile revisions reuse the same review stack and model-selection logic as the rest of the prose pipeline.

## Native development

Start from `ProserFactory/` with Node `24.22.3`, Docker, and a C/C++ build
toolchain with Python 3 for native npm dependencies. Use loopback ports and a
disposable database for development.

```bash
npm ci
npm run db:generate
(umask 077; set -o noclobber; cat .env.example > .env)
```

Keep any existing `.env`. Set the application secrets and optional provider
settings below. Match `FACTORY_AUTH_SECRET` with Author when testing the web proxy.
Use the root Compose stack for a fresh database with structured authority active.

For a new native development database, generate a unique password once and
keep it with the database volume. Put the generated PostgreSQL settings in
the ignored `.env.database` file.

```bash
(
  umask 077
  set -o noclobber
  proser_db_password="$(openssl rand -hex 32)"
  printf 'POSTGRES_PASSWORD=%s\nDATABASE_URL=postgresql://proser:%s@127.0.0.1:5432/proser\n' "$proser_db_password" "$proser_db_password" > .env.database
)
docker compose --env-file .env.database -f docker-compose.postgres.yml up -d --wait
set -a
. ./.env.database
set +a
npm run db:deploy
```

Start Redis on a free loopback port or point `REDIS_URL` at your isolated Redis
service. For a fresh local instance:

```bash
docker run --rm -d --name proser-dev-redis -p 127.0.0.1:6379:6379 redis:7.4-alpine
```

Start the API in the terminal with the exported database settings. In a second
terminal, load the same `.env.database` and start the worker when `USE_BULLMQ=true`.

```bash
npm run dev
```

```bash
set -a
. ./.env.database
set +a
npm run build
npm run worker
```

## Environment variables

Required:

- DATABASE_URL: PostgreSQL connection URL
- POSTGRES_PASSWORD: Password for the native development PostgreSQL container. The root stack uses `PROSER_DB_PASSWORD`.
- DATABASE_POOL_SIZE: Per-process pool ceiling (default: 20, bounded to 2..100)
- FACTORY_AUTH_SECRET: Dedicated ProserAuthor-to-Factory JWT signing secret. Tokens require `iss=proser-author` and `aud=proser-factory`.
- INTERNAL_API_SECRET: Secret for internal administrative endpoints.

Inference defaults:

- INFERENCE_BACKEND: Active inference backend label (default: llamacpp)
- INFERENCE_HOST: URL to the OpenAI-compatible inference endpoint (default: http://127.0.0.1:8000)
- INFERENCE_API_KEY: bearer credential required for any non-loopback production inference endpoint
- OLLAMA_BASE_URL: Compatibility alias for the inference endpoint (default: http://127.0.0.1:8000)
- OLLAMA_MODEL: Compatibility alias for the served model name (default: qwen3.6-35b)

Optional:

- MAX_CONTEXT_TOKENS: Model context window exposed to validation caps (default: 150000)
- RAG_TOKEN_BUDGET: Default retrieval/context budget for prose generation (default: 120000)
- RAG_MAX_CHUNKS: Maximum chunks retrieved by the RAG orchestrator (default: 240)
- AI_MAX_CONCURRENT: Maximum concurrent requests to the shared inference host (default: 8)
- VLLM_BASE_URL / VLLM_MODEL: Legacy compatibility aliases for the same inference backend
- INFERENCE_USER / INFERENCE_SSH_KEY / INFERENCE_SSH_HOST_KEY: scoped key deployment identity and pinned OpenSSH host-key line used by `scripts/deploy-inference.sh`; these are separate from the HTTP `INFERENCE_API_KEY`
- INFERENCE_ADMIN_HOST_ALLOWLIST: Exact comma-separated URLs permitted for internal model probes and global setting changes. The configured backend is always permitted.

Generation tuning:

- AI_RECIPE_VERSION: Version string for prompt recipes (default: 2025-08-29)
- AI_CACHE_ENABLED: Enable DB-backed prompt cache (default: true)
- AI_CACHE_TTL_SEC: Cache TTL in seconds (default: 604800)
- AI_CAPTURE_REASONING_ENABLED: Preserve provider reasoning and token usage in server-side debug metadata/logs only (default: false)
- AI_TEMP_BEATS: Temperature for beats brainstorming (default: 0.9)
- AI_TEMP_PROSE: Temperature override for prose generation (default: 0.7)
- AI_TEMP_REPAIR: Temperature for repair/micro-review (default: 0.4)
- AI_TIMEOUT_BEATS_MS: Timeout for beats generation in milliseconds (default: 20000)
- AI_TIMEOUT_PROSE_MS: Timeout for prose generation in milliseconds (default: 30000)
- PUBLICATION_DIR: Root for immutable publication packages (default: `data/publications`)
- WEBUI_FORGE_URL: Stable Diffusion WebUI Forge endpoint for image generation (default: http://127.0.0.1:7861)
- FORGE_MODEL: Forge checkpoint used by default (`qwen-image-2.1`)
- FORGE_SAMPLER / FORGE_SCHEDULER / FORGE_STEPS: default render settings (`Euler`, `Simple`, `5`)

The optional `docker-compose.observability.yml` stack publishes OTLP,
Prometheus, and Jaeger ports on `127.0.0.1` only because those development
endpoints do not provide application authentication.

Example additional `.env.local` settings. Keep the database credentials saved above and generate separate application secrets.

```
DATABASE_POOL_SIZE=20
INFERENCE_BACKEND=llamacpp
INFERENCE_HOST=http://127.0.0.1:8000
OLLAMA_BASE_URL=http://127.0.0.1:8000
OLLAMA_MODEL=qwen3.6-35b
MAX_CONTEXT_TOKENS=150000
RAG_TOKEN_BUDGET=120000
RAG_MAX_CHUNKS=240
AI_MAX_CONCURRENT=8
WEBUI_FORGE_URL=http://127.0.0.1:7861
FORGE_MODEL=qwen_image_2.1_bf16.safetensors
FORGE_SAMPLER=Euler
FORGE_SCHEDULER=Simple
FORGE_STEPS=5
AI_RECIPE_VERSION=2025-08-29
AI_CACHE_ENABLED=true
AI_CACHE_TTL_SEC=604800
AI_CAPTURE_REASONING_ENABLED=false
AI_TEMP_BEATS=0.9
AI_TEMP_PROSE=0.6
AI_TEMP_REPAIR=0.4
AI_TIMEOUT_BEATS_MS=20000
AI_TIMEOUT_PROSE_MS=30000
FACTORY_STALL_THRESHOLD=3
INFERENCE_ADMIN_HOST_ALLOWLIST=http://127.0.0.1:8000
```

`scripts/migrate-sqlite-to-postgres.ts` is the one-time migration bridge for
existing installations. It validates SQLite integrity and foreign keys, copies
all current-schema tables in one PostgreSQL transaction, resets serial
sequences, re-enables normal replication checks, verifies target relationships,
and compares deterministic full-row and primary-key hashes, nullable counts,
and numeric aggregates before commit. Completion is recorded in
`_proser_cutover_receipts` and as HMAC-signed, mode-0600 deployment evidence.

Normal deployment never imports into or replaces a populated target. A missing
legacy filesystem manifest cannot authorize database changes. To receipt an
already verified cutover, quiesce both Factory services and run the explicit
one-time operator flow:

```bash
bash scripts/deploy-to-proser.sh \
  --record-existing-cutover <maintenance-window-operation-id>
```

That command binds the receipt to the SQLite source SHA-256, a pre-operation
PostgreSQL `pg_dump` SHA-256, and the expected source/target row-digest report.
Any mismatch fails closed. Later deploys require the PostgreSQL receipt and
create fresh custom-format checkpoints without consulting the old JSON
manifest. Checkpoint directories are root-only mode `0700`; dumps and their
checksums are mode `0600` because authoring data is confidential.

If the host-managed HMAC key is lost while the receipt and evidence remain
intact, the only supported recovery is an explicit quiesced re-attestation:

```bash
bash scripts/deploy-to-proser.sh \
  --rotate-cutover-evidence-key <maintenance-window-operation-id>
```

That path still requires the evidence file and database receipt to agree, the
original SQLite SHA-256 and embedded source report to verify, and current
PostgreSQL relationship/read checks to pass. It archives the prior mode-0600
evidence before transactionally installing the new signature. Normal deploys
never rotate or ignore a failed evidence signature.

Factory deployment also fails before service interruption unless Redis accepts
an expiring write, completes a forced background snapshot with zero consecutive
failures, and accepts another write. This catches `MISCONF` persistence failures
that a successful `PING` or health read cannot detect. If it fails, preserve the
current RDB first, then inspect `INFO persistence`, `CONFIG GET dir`, the Redis
service working directory, and its systemd writable-path/supervision settings.
The configured `dir` must resolve to the protected Redis data directory rather
than `/`; after correcting it, restart Redis and rerun the deployment preflight.

`NEXTAUTH_SECRET` and `AUTH_SECRET` are accepted only when `ALLOW_LEGACY_AUTH_SECRETS=true`, with a high-severity migration warning. Factory resolves accounts only by the signed provider identity. Matching an unknown identity to an existing account by username or email handle is disabled; set `ALLOW_LEGACY_IDENTITY_RECONCILIATION=true` only for a supervised migration after an identity format change, then remove it. Hermes tokens remain isolated behind `HERMES_AGENT_AUTH_SECRET`; they require the configured identity, issuer, and `HERMES_AGENT_AUDIENCE` (default `proser-factory`). Optional author delegation requires both `PROSER_OWNER_GITHUB_ID` on the agent and the same identity in Factory's `HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS`; the service actor remains recorded on workflow events.

Authenticated model inspection (`GET /api/models` and `/api/models/status`) is pinned to the configured backend. Nova capability grants receive readiness and model capability data without the private backend address. Arbitrary probes and global mutations are available only under `/api/admin/models/*` with `X-Internal-Secret` and the host allowlist. Public `/api/readiness` returns only bounded component states.

The backend uses the OpenAI-compatible `/v1/chat/completions` endpoint exposed by llama.cpp for all AI generation (including streaming). Legacy `OLLAMA_*` and `VLLM_*` env vars are still accepted as compatibility aliases.

## CLI (Command-Line Interface)

The backend includes `proser-cli`, a yargs-based interface for bounded local book, structure, codex, prose, review, revision, status, and export operations.

### Examples

```bash
# Create a book, then build selected parts explicitly
npm run cli -- create "A geomancer discovers the earth remembers every war" --genre dark-fantasy
npm run cli -- outline <bookId>
npm run cli -- characters <bookId>

# Generate prose for every scene in an existing book
npm run cli -- generate <bookId>

# Generate (or re-generate) a single scene
npm run cli -- generate <bookId> --scene-id <sceneId>

# Get help on any command
npm run cli -- --help
```

### Key Commands

| Command                   | Description                            |
| ------------------------- | -------------------------------------- |
| `generate <bookId>`       | Generate prose for all scenes          |
| `outline <bookId>`        | (Re)generate chapter outline           |
| `characters <bookId>`     | Generate character codex entries       |
| `review <bookId>`         | Run bounded local quality skills       |
| `revise <bookId>`         | Apply a bounded AI scene revision      |
| `export <bookId>`         | Export to markdown / epub / html / txt |
| `codex:list`, `codex:add` | Inspect or create codex entries        |
| `list`                    | Show all books                         |
| `status <bookId>`         | Show book progress                     |

Global flags available on all commands: `--model`, `--temperature`, `--inference-host`, `-h/--help`, `-v/--version`.

The retired `pipeline` and `resume` commands are absent. Use Workflow v1 for durable whole-book or editorial work. See **[CLI.md](CLI.md)** for complete options and **[CLI_SUMMARY.md](CLI_SUMMARY.md)** for the source layout.

## Testing

Inference-host changes have a repeatable tool, JSON, thinking, and concurrency benchmark:

```bash
npm run benchmark:inference -- --iterations=5
```

See `docs/INFERENCE_OPTIMIZATION.md` for the selected inference-host profile, task-specific sampling policy, promotion gates, and measured results.

Use the [isolated PostgreSQL and Redis fixtures](../docs/CI.md#local-validation)
for the full Jest suite. The smoke and CLI suites use mocks.

```
npm test
npm run test:smoke
npm run test:cli
npm run lint
npm run typecheck
npm run build
```

## Deployment

Use the [root Compose guide](../docs/COMPOSE.md) for the combined installation.
Factory and the worker run from the pinned Proser image. For a legacy native
installation, `bash scripts/deploy-to-proser.sh` verifies Redis persistence,
applies reviewed migrations, and validates both systemd services. Retired
webhook and cron updaters remain unsupported.

## TLS / HTTPS

The backend supports native TLS. Set these env vars to enable HTTPS:

```dotenv
TLS_ENABLED=true
TLS_CERT_FILE=../certs/server.crt
TLS_KEY_FILE=../certs/server.key
TLS_CA_FILE=../certs/ca.crt          # optional, for self-signed chains
NODE_EXTRA_CA_CERTS=../certs/ca.crt  # trust the CA for outbound calls
```

Generate development certificates:

```bash
bash ../ProserAuthor/scripts/generate-certs.sh ../ProserAuthor/certs
```

When `TLS_ENABLED=true`, the server uses `https.createServer()` instead of
`app.listen()`. Update `PUBLIC_BASE_URL` and `FRONTEND_URL` to `https://`
accordingly. When disabled (default), the server runs plain HTTP as before.

Notes for contributors:

- Tests include teardown that closes database, Redis, BullMQ, and worker connections to avoid open handles. Shared BullMQ shutdown lives in `src/queues/connection.ts`.
- Retry and timeout semantics are centralized in `withRetry` (`src/lib/resilience.ts`). Prefer calling `withRetry((signal) => ai.generate(..., signal), attempts, onRetry, { timeoutMs, jitter })` rather than wiring `AbortController` manually.

### Nova delegated authoring

The Hermes `proser-api` plugin recognizes an installed Nova coordinator and
records application operations in its durable request journal. It adds bounded
checkpoint evidence, delegated finalization, authenticated downloads, and
native external-image imports. Nova may make routine author/editorial decisions
within the requested work; existing revision and publication gates still apply.

`PROSER_SERVICE_PRINCIPALS_JSON` configures dedicated hashed `pnv_` credentials,
the shared owner GitHub identity, read/write/publish scopes, allowed callers and
expiry. Each call also carries the trusted Nova caller and request ID. The
credential authenticates transport only: Factory additionally verifies an exact
Ed25519-signed mission grant from `PROSER_NOVA_GRANTS_FILE` using
`PROSER_NOVA_GRANT_PUBLIC_KEY_FILE`. See
[`docs/NOVA_PROVIDER_GRANTS.md`](docs/NOVA_PROVIDER_GRANTS.md) for the signed
fields, resource ownership, revocation, migration and activation contract.
Ardent Nova may register a short-lived, task-bound provider-status grant
through `capabilities-read`, or a separate single-book `books.read` grant
through `books-read`. Both require the dedicated principal's `grant:register`
scope and the existing signed private registry. The book route does not
extend the Hermes delegated authoring or mutation grant path.
Ardent Nova may separately register a short-lived `workflow-publish` grant
for one exact workflow UUID. That grant permits only final-release checkpoint
approval, status, publication metadata, and exact operation recovery under a
`content:publish` principal and `external_publish` fence. A finalize HTTP 202
is not a published package; require the owner's later `release_approved`
workflow and publication record before reporting publication or delivery.
If approval completes after that grant expires, a separate signed
`workflow-read` grant permits only status and publication metadata reads for
the same workflow; it cannot repeat finalization or fetch artifact bytes.
Nova writes additionally require the complete central fence claim. Factory
journals the exact operation, advances all fences atomically, rechecks them
before response publication, and returns signed terminal result/evidence. Exact
recovery is `GET /api/shared-resource-operations/:operationId`. Checkpoint-free
Quality Review and Editorial Optimize admission and each durable run are
transactionally bound; the worker holds and
rechecks the same authority through final manuscript publication, where the
signed result is sealed. Bounded editorial benchmarks use the synchronous fence.
Full Book and checkpoint-capable improvement launches remain signed `no_effect`
until continuation authority can transfer across later decisions. Redis-backed
durable prose-operation launches remain signed `no_effect` until
their artifact and PostgreSQL evidence share an atomic visibility boundary. These credentials cannot delete content or
change administrative settings.

Nova browser evaluation evidence uses the separate insert-only `BrowserRun`
journal. A trusted runner precommits the exact request/evaluation/package,
service target, runner, fixture, and sorted cases before browser contact; case
results and terminal state are append-only. The local exporter accepts only a
terminal run ID and derives the complete Nova v1 Ed25519 receipt from retained
state. See [`docs/NOVA_BROWSER_RUN_RECEIPTS.md`](docs/NOVA_BROWSER_RUN_RECEIPTS.md).

`POST /api/images/import` verifies bounded raster bytes and SHA-256, records
source revision, provenance, license and visibility in the normal book image
library, and supports digest-checked replacement. Other linked consumers are
flagged as outdated. `GET /api/books/:bookId/creative-package` downloads an
illustrated Markdown package with image bytes and a delivery manifest. Existing
publication artifacts remain snapshots. For an external integration, configure an authenticated HTTPS ingress to the Factory API.

## Canvas document transition

Use Node 24.22.3. Structured authority and enforcement are active in production.
New installations default to inactive authority until their reviewed release gates
and preservation rehearsal pass. See
[structured document operations](docs/STRUCTURED_DOCUMENTS.md) for backfill,
revision contracts, validation and current limitations. Root checks verify the
generated Author document contract. The deployed transition and later Author
releases are recorded in [the release record](../CANVAS_RELEASE_RECORD.md).

The maintained MIT Word exchange codec is the exact registry dependency
`@hivemagnus/canvas-word-codec` from [canvas-word](https://github.com/ChefTaco/canvas-word). `npm run build`
verifies the installed distribution before compiling Factory; `npm run codec:test` covers the generic
headless exchange surface. Application adapters retain ownership, hierarchy,
originals, revision-safe imports and immutable artifacts outside the fork.
[Dependency provenance](docs/canvas-dependencies.json) links the exact rebuilt
release evidence, CycloneDX SBOM and original/runtime/embedded notices.

Native deployments install the pinned codec and checksum-pinned licensed
Liberation/DejaVu distributions from `config/publication-font-pins.json`. The
Liberation URL uses `?download=1`; the archive SHA256 remains unchanged. Privileged
Prisma release checks disable the Jiti filesystem cache so subsequent user-owned
`npm ci` can replace dependencies without root-owned cache directories. The
service's verified font manifest is
`/opt/proser-factory/publication-fonts/manifest.json`. Independent OOXML and
LibreOffice fixtures are evidence of those implementations; Microsoft Word
acceptance remains unverified.

## Canvas release operations

The maintained DOCX codec is `1.0.0-proser.3`. Factory consumes its headless
byte/document API; current upstream browser source is retained separately in
`vendor/canvas-docx-codec/upstream-current/` at `0e8a1b36`, alongside immutable
original source and license provenance. See the root Canvas release record and
Author's maintenance record for synchronization and deployed acceptance.

The user-selected release implements R1, R3, R4, R5 and R7.
[The release checklist](../CANVAS_RELEASE_CHECKLIST.md) defines the finish line;
R2 device/accessibility certification remains open and R6 reference-profile
performance certification is deferred.

The reviewed native schema transition requires the exact clean candidate's SQL
pins, frozen gates, isolated synthetic enforcement rehearsal, a protected fresh
production-backup clone, two idempotent backfills and two complete restores.
[The native release procedure](docs/CANVAS_REVIEWED_NATIVE_RELEASE.md) retains
Redis persistence checks and stops both services before replacing bytes. Its
`--document-release-proof` path installs schema and inactive enforcement and then
holds both services stopped for explicit guarded activation. A held installation
is not an operational release. Never resume pre-document code after activation.

Chapter transition review uses `GET /api/books/:bookId/chapter-transitions` and
the existing document discussion/proposal routes. It freezes both adjacent saved
boundaries from one manifest, limits the opening revision to 600 changed characters,
and rejects application after any book revision change. No schema migration or
new inference endpoint is required.

Image generation now targets Qwen Image 2.1 on `http://127.0.0.1:7861`, active Qwen Image 2.1 checkpoint, using Euler/Simple, 32 steps and CFG 2.5. Transparent output uses the native RGBA prompt and preserves PNG alpha; historical outputs remain unchanged.

The model family setting follows Nova’s active checkpoint, including `qwen_image_2.1_int8_convrot.safetensors`. Sampling defaults are unchanged by the precision switch; new generation receipts record the selected filename.

## Revision campaigns

Factory owns whole-book campaign analysis and verification through the existing
WorkflowRun/BullMQ worker. Apply the additive migration with native deployment;
keep the original campaign/source/provider/decision receipts. A scan may
propose edits within its own passage. Factory retains suggestions aimed at
disclosed neighboring edges in the scan receipt for audit. The optional
`REVISION_CAMPAIGN_MAX_INFERENCE_TOKENS` sets a finite conservative token budget
(default 2,000,000). Oversized or missing context is reported rather than hidden.
See [the campaign guide](../ProserAuthor/docs/REVISION_CAMPAIGNS.md).

### Shared Canvas dependency maintenance

Factory pins the public `@hivemagnus/canvas-word-codec` package at 1.1.0 and
uses its established root API. `npm run codec:build` verifies the installed package; `npm run codec:test` applies
the retained synthetic regression corpus. Codec source and package releases are
maintained in `canvas-word`. The former vendor directory retains fixtures and
historical upstream snapshots/notices. Author likewise consumes the shared
engine. Regenerate the installed-package release ledger after changing either
pin. Retain third-party provenance for earlier dependency distributions.
