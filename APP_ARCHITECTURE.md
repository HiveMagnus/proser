# Proser application architecture

_Last verified against the source release: 2026-11-22_

## Repository layout

Proser is one Git repository with two independently deployable components:

| Project          | Responsibility                                                                                                         | Runtime                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ProserFactory/` | Authoring API, persistence, inference and image integration, durable workflows, CLI, workers, and Hermes plugin source | Express 5, Prisma 7 with PostgreSQL, BullMQ with Redis, llama.cpp-compatible inference, WebUI Forge |
| `ProserAuthor/`  | Authenticated desktop and mobile browser experience                                                                    | Next.js 16 App Router, Auth.js/NextAuth, React 19, Canvas/semantic editing, relative `/api/*` proxy |

ProserFactory is the authoring system of record. ProserAuthor stores browser/session state only and does not run an API, database, queue worker, or model connection.

Generated manuscript/codex exports at the workspace root and under `ProserFactory/data/exports/` are data artifacts, not project documentation or runtime source.

Plot Threads is a Factory-owned side-record workflow. Recovery finalizes retained
provider bytes without redispatch; cancellation after dispatch remains unknown.
Author journals recover the exact acknowledged thread and protect unsaved metadata
and review-assessment drafts. Thread metadata, immutable
saved excerpt proofs, review snapshots/provider outcomes, and idempotent mutation
receipts live in PostgreSQL. Writes use document ownership, book serialization,
and resource/workflow fences without advancing manuscript heads. Author presents
the shared desktop/mobile UI, selection capture, and account/book-scoped browser
recovery. Payoff revisions reuse document discussions and proposals with a
server-verified thread-review context and explicit tracked application. Automatic
memory extraction cannot overwrite author-managed threads.

## Runtime topology

```text
Browser
  -> ProserAuthor (:3000 locally, :443 in production)
     -> authenticated same-origin /api/* proxy
        -> ProserFactory (:3001)

Hermes Agent
  -> proser-api plugin with a short-lived service JWT
     -> ProserFactory (:3001)

ProserFactory API and worker
  -> Prisma/pg -> PostgreSQL on the internal Compose network
  -> BullMQ -> Redis on the internal Compose network -> worker
  -> OpenAI-compatible inference -> llama.cpp on inference-host:8000
  -> Stable Diffusion WebUI Forge -> inference-host:7861
```

Compose runs Author, Factory, and the worker from the same pinned application
image. Published ports are configured at the host boundary. Author serves the
operator-configured canonical HTTPS origin in production, and its proxy
contacts Factory on the Compose network. Direct Factory access is optional.

## ProserFactory

Primary entry points:

- `src/server.ts` creates the Express app, top-level health routes, TLS server, and `/api` mount.
- `src/api/index.ts` mounts books, codex, generation, private images, models, settings, prose traces, metrics, auth, workflow, and internal-admin routes.
- Factory bearer authentication is header-only. Native browser EventSource
  connects to Author’s same-origin proxy; JWTs never enter stream query
  strings. Built-in prompt recipes are internal authenticated resources.
- OpenAPI/Zod is the versioned public route contract. The checked-in generated
  reference includes path, authentication, JSON request fields, and
  shared-contract rate limits, and the root documentation gate rejects drift.
- `src/workers/index.ts` starts the durable workflow worker and live-prose judge worker.
- `src/cli/index.ts` provides bounded local commands for books, structure, codex, prose, review, revision, status, and export.
- `prisma/schema.prisma` is the persistence authority.
- Root `compose.yml` starts PostgreSQL and Redis on an internal network with
  durable volumes. The component PostgreSQL Compose file supports native
  development and legacy installations.
- `_proser_cutover_receipts` is the durable provider-cutover authority. Normal
  deploys do not infer cutover state from a filesystem manifest and cannot
  truncate a populated target. One-time signed evidence binds source,
  checkpoint, and full-content reports to a maintenance-window operation.
- Nova service-principal mutations cross a separate PostgreSQL shared-resource
  authority. The exact canonical multi-resource claim, monotonic fence rows,
  immutable operation journal, bounded provider result, and Ed25519 terminal
  evidence prevent operation-ID replay and stale response publication.
  Checkpoint-free Quality Review and Editorial Optimize admission binds the
  provider operation to one durable run in the same database
  transaction. The worker holds the shared authority lock, rechecks every claimed
  resource with its workflow lease, and atomically seals terminal evidence with
  final publication. Editorial benchmarks retain the synchronous fence boundary.
  Full Book and checkpoint-capable improvement workflows remain fail closed until
  continuation authority can transfer across later decisions. Redis-backed durable
  prose generation remains fail closed until its artifact and PostgreSQL evidence
  can share one atomic visibility boundary.
- Nova browser evidence uses four insert-only Factory tables for the pre-run
  binding, per-case evidence, terminal derivation, and one signed receipt.
  The trusted Playwright runner derives build, fixture, sorted cases, and retained
  evidence digests from its own execution. Database triggers reject updates,
  deletes, and truncation; the local signer reads a terminal run by ID and has no
  browser-facing route. Receipt publication is fd-anchored, atomic, and recoverable
  from the immutable signed row without re-signing.
- Expensive authenticated work uses shared Redis-backed per-user/per-book
  concurrency and daily budgets plus route payload and execution ceilings.
  Book ownership resolves before allocation, so caller-supplied IDs never name
  budget keys. Active capacity is held by renewable UUID leases in sorted sets;
  only the owning, unexpired lease can renew or release its slots, and timestamp
  cleanup recovers abandoned operations. At a route deadline renewal stops,
  capacity releases immediately, and a bounded response grace closes handlers
  that miss cancellation. Synchronous handlers consume the admission
  cancellation signal to fence later writes. Workflow routes bound only the
  request/queue-acceptance phase; durable worker execution retains its own
  leases and lifetime. Capacity allocation fails closed when Redis is unavailable.

### Durable workflows

`WorkflowRun` is the only background orchestration root. Six workflow types share the `book-workflow-v1` queue, task graph, events, heartbeat, retries, immutable manuscript revisions, and audit trail:

- `full_book`
- `quality_review`
- `improve_quality`
- `guided_improve`
- `editorial_optimize`
- `revision_campaign_analysis`

The first four preserve their checkpoint behavior. `editorial_optimize` is
checkpoint-free: its centralized policy skips risky, disputed, stale, or
unverifiable edits and still reaches a terminal result. Revision campaign analysis
produces immutable cited plans and preservation previews; prose application always
requires separate author approval through tracked document operations.

The retired Wizard, FactoryRun, NovelRun, and ReviewRun routes, tables, queues, workers, and Hermes tools must remain absent. Full Book creates visible Quality Review, Improve Quality, and verification child runs rather than maintaining separate orchestration systems.

Useful routes:

- Launch: `POST /api/workflows/{full-book|quality-review|improve-quality|guided-improve}`
- Observe/control: `/api/workflows/:runId/*`
- Reconnect: `GET /api/books/:bookId/workflows`
- Reviews/findings: `GET /api/books/:bookId/reviews`, `GET /api/books/:bookId/findings`
- Revision history: `GET /api/books/:bookId/revisions`
- Editorial: `POST /api/workflows/editorial-optimize`, `/api/editorial/*`
- Publication: `GET /api/workflows/:runId/publication`

Workflow launch requests require `Idempotency-Key`. A `202` response means the work was accepted; execution continues in `proser-worker` after the caller disconnects.

### Persistence and assets

The core hierarchy is `Book -> Act -> Chapter -> Scene`. Related records include codex entries, notes, private image assets, prose traces/actions, narrative memory, workflow runs/tasks/events/checkpoints/artifacts, immutable revisions, quality reviews/findings, ledgers, and publication manifests.

Image ownership is enforced from `ImageAsset`; generated files are never a public `/images/*` directory. Clients fetch owned bytes through `GET /api/images/:id/content` or the authenticated Author proxy.

### Authentication

- ProserAuthor signs 10-minute HS256 JWTs with `FACTORY_AUTH_SECRET`, issuer `proser-author`, and audience `proser-factory`.
- Hermes uses `HERMES_AGENT_AUTH_SECRET`, its configured service identity, issuer, and audience. Optional owner delegation is allowlisted and keeps the service actor in the audit trail.
- `POST /api/auth/sync-user` and `/api/admin/*` use `X-Internal-Secret` with `INTERNAL_API_SECRET`.
- Legacy browser-service secrets are accepted only when `ALLOW_LEGACY_AUTH_SECRETS=true`.

## ProserAuthor

`apps/web` is the only active app. The desktop routes and the phone-first `/m`, `/m/studio`, and `/m/read` routes share the same Factory backend.

`apps/web/src/app/api/[...path]/route.ts`:

- requires an Auth.js session for protected Factory operations;
- derives a stable provider-scoped user identity;
- signs the Author-to-Factory JWT;
- strips browser cookies and browser-provided authorization;
- applies endpoint-specific time and response-size limits;
- relays the Factory response without exposing the internal origin.

Retired `apps/api`, `apps/worker`, `proser-v2-api`, and `proser-v2-worker` paths must stay absent/inactive.

## Hermes integration

The source-controlled plugin is `ProserFactory/hermes/plugins/proser-api/`. It provides bounded utility tools and Workflow v1 launch/status/control/publication tools. Its four bundled skills are:

- `proser-authoring`
- `proser-workflows`
- `proser-book-reader`
- `proser-codex-entry-designer`

Hermes calls Factory directly; it does not automate through ProserAuthor. Whole-book and editorial work stays server-side, while status, checkpoint, and bounded read calls keep manuscript-sized payloads out of conversation context.

## Documentation map

- `README.md` — unified checkout, commands, and deployment entry point.
- `PROSER_API.md` — current remote API and workflow guide.
- `ProserFactory/README.md` — Factory setup, runtime, environment, and deploy overview.
- `ProserFactory/docs/WORKFLOW_V1.md` — workflow state, revision, and recovery contract.
- `ProserFactory/HERMES_AGENT_PLUGIN.md` — plugin tools, auth, deployment, and skills.
- `ProserFactory/CLI.md` — current local CLI commands.
- `ProserAuthor/README.md` and `ProserAuthor/docs/` — web-shell development, environment, mobile, API-proxy, and deployment behavior.

## Structured document transition

Factory now contains the schema-1 canonical document model, immutable scene/book
revisions, explicit heads and atomic save receipts. Author consumes generated
contracts from `packages/contracts`; `packages/editor` owns document controls
and adapters around `@hivemagnus/canvas-word-engine`. The former
`packages/canvas-engine` workspace retains integration fixtures and historical
provenance; runtime source is maintained in the shared public `canvas-word` repository. Unused
domain, inference, export, quality and design-system stubs have been retired.
The existing app UI components and Factory services retain those responsibilities.

Shared Canvas engine `1.2.0` preserves the six submitted editor contributions
and the earlier application compatibility patches. It retains object IDs only
when requested.
Author opts in when serializing document saves; default clipboard serialization
strips IDs so repeated paste creates distinct objects. Factory's canonical IDs,
revision preconditions and operation receipts remain the persistence authority.
Experimental incremental row layout remains disabled by default and preserves
Proser paragraph geometry through full-layout fallback. Factory imports the
shared headless `@hivemagnus/canvas-word-codec` `1.1.0` through its CommonJS
root entry. Both package versions and their distributions are recorded in Factory's
Canvas dependency ledger tracks the shipped packages and their public provenance.

Production runs with structured authority and enforcement active.
`DOCUMENT_AUTHORITY_ENABLED` defaults to false for an unprepared installation.
Activation requires the selected release's writer, preservation and operational
gates in [the release checklist](CANVAS_RELEASE_CHECKLIST.md). R2 mobile/accessibility
certification is now active after its earlier release deferral; R6 performance
certification remains deferred. The [R2 acceptance record](CANVAS_R2_ACCEPTANCE.md)
separates candidate changes, emulated browser checks, actual assistive technology
and pending physical-phone evidence. Author negotiates ordered-window/typed-operation
capability versions before loading a writer; runtime Canvas indexes never become
saved authority.

The browser retains only bounded passages and contiguous windows of at most three
scenes. Atomic changed-scope receipts carry immutable references and bounded
acknowledged passages, rather than complete manuscript bodies. Formatting lineage
checks exact paragraph coordinates, Unicode and protected objects. Complete undo
and rollback create new Factory revisions; they do not rewrite historical evidence.

Ordinary project creation keeps an authenticated intent and operation ID in
IndexedDB before dispatch. Details and deletion capture metadata and revision
preconditions from one immutable structure read when the dialog opens. Dialog
epochs prevent late preparation or acknowledgements from changing another target.
Recovery reads original receipts, including after an owned book is tombstoned.
Empty workspaces create their opening scene through the existing structured Quick
Draft transaction with the displayed revision preconditions.

The Canvas workspace does not introduce an Author database, API or inference
service. See [the delivery ledger](CANVAS_MODERNIZATION.md),
[Factory operations](ProserFactory/docs/STRUCTURED_DOCUMENTS.md) and the
[candidate-reviewed native transition](ProserFactory/docs/CANVAS_REVIEWED_NATIVE_RELEASE.md).

Chapter transition review remains Factory-owned: `/api/books/:bookId/chapter-transitions`
reads canonical immutable chapter boundaries. Author displays the first three pairs
and uses existing document discussions/proposals with a Factory-frozen transition
context, user-scoped recovery journal and strict book-revision application guard.

## Revision campaigns

Factory owns campaign settings, immutable source/plan versions and append-only
evidence/decision/verification records. `revision_campaign_analysis` uses the
existing WorkflowRun, BullMQ queue, outbox, leases and retained provider effects.
It scans canonical immutable scene ranges and synthesizes their summaries in
bounded groups, with Plot Thread and literal chapter-boundary evidence. Analysis
never changes prose. Campaign-bound document proposals require confirmed cited
protections, plan approval, exact source freshness and selected-candidate
verification before atomic tracked application. Resolved edits require downstream
re-review and a new approved plan. Author uses its existing same-origin proxy,
account/book-scoped journal, routing and session boundary. See the campaign guide
under Author docs for operational limits and acceptance.
