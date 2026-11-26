# ProserAuthor

**AI-powered novel-writing workbench** — plan, draft, and polish long-form fiction with structured AI assistance across both desktop and phone-first mobile flows.

ProserAuthor pins Next.js 16.4.2, including the October 2026 security fixes.
The October 31 dependency pass also pins Zod 4.6.7, Vitest 4.1.12 and patched
transitive HTTP/glob parsers. Full development and production audits are included
in the root `npm run audit`; see [the security record](../docs/SECURITY_2026_10_31.md).

ProserAuthor is the authenticated web shell for ProserFactory. The manuscript, codex, notes, prose generation, trace state, local quality review, compare-card preferences, and the dedicated phone shell all flow through the Next.js app into ProserFactory.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      apps/web                           │
│             Next.js 16 · App Router · React 19          │
│   Desktop shell + dedicated /m mobile shell · Canvas   │
│             shadcn/ui · Tailwind CSS v4                 │
├─────────────────────────────────────────────────────────┤
│             ProserFactory (sibling service)             │
│    Authoring system of record · traces · generation     │
│    Qwen on inference-host:8000 · Forge images on inference-host:7861       │
└─────────────────────────────────────────────────────────┘
```

### Author workspace layout

| Path                     | Description                                                                      |
| ------------------------ | -------------------------------------------------------------------------------- |
| `apps/web`               | Next.js 16 front-end (desktop shell, `/m` mobile shell, NextAuth, Canvas editor) |
| `packages/contracts`     | Factory-derived document contract and browser schemas                            |
| `packages/canvas-engine` | Integration fixtures for the shared canvas-word engine                           |
| `packages/editor`        | Canvas adapter, semantic editing, and revision-safe bounded operations           |
| `deploy/`                | Systemd service files for the production web shell                               |

The Editorial folio at `/editorial` provides launch, terminal progress,
revision evidence, original wins, skipped proposals, before/after comparisons,
profiles, and Quality Lab results. `/m/editorial` is the compact mobile launch.

Plot Studio's Plot Threads tab and `/m/plot` provide persisted story questions,
saved scene evidence, cited payoff review, and approved before/after revisions.
The manuscript editor can attach its acknowledged text selection directly.
See [Plot Threads workflow and recovery](docs/PLOT_THREADS.md).

The manuscript workspace keeps book, scope navigation and save status above a
compact formatting toolbar. Typography, emphasis and alignment show the current
selection; paragraph layout and tables are under **More formatting**. Search,
page setup and the tabbed review panel open on demand. The shared toolbar also
formats selections in accessible editing mode. See
[writing controls](docs/CANVAS_WRITING_CONTROLS.md) for behavior and verification.

---

## Getting started

Install the complete application with the [root quick start](../README.md#quick-start).
For web development, use [the development guide](docs/DEVELOPMENT.md) to start
against a reachable Factory. It covers Node `24.22.3`, pnpm `12.16.1`, workspace
builds, `apps/web/.env.local`, and sign-in configuration.

## Development

```bash
pnpm dev          # Start active workspace apps in watch mode
pnpm build        # Production build
pnpm test         # Run all tests (Vitest)
pnpm lint         # Lint all packages
pnpm typecheck    # TypeScript type-check
pnpm format       # Format supported source and Markdown with Prettier
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full development setup guide.

---

## Mobile Mode

The phone shell under `/m` uses the same structured authority and operation
contracts as desktop.

- `Home` resumes an owned book/scene or creates a revision-safe `Quick Draft`.
- `Studio` loads bounded scene/chapter/book passages, Canvas continuity mode,
  semantic editing, tracked proposals and document recovery.
- `Read` renders saved, revision-bound semantic content in bounded windows;
  reading typography never changes the manuscript.
- Phone routing preserves the `proser-view=desktop` escape hatch.
- Mobile preferences and operation journals are scoped to the authenticated user;
  account changes invalidate visible state.

See [docs/MOBILE.md](docs/MOBILE.md) for the full route, state, and testing reference.

---

## Authoring Flow

- Browser requests stay on relative `/api/*` routes inside `apps/web`.
- The Next.js proxy fails closed without an active NextAuth session, except for the explicit public `GET /api/readiness` probe. It signs a backend JWT for authenticated authoring requests and never relays Factory cookies, authentication challenges, or redirects.
- ProserFactory owns books, structure, scenes, codex, notes, prose traces, background workflows, review findings, publication packages, and preference storage.
- Active mobile writing uses the same revision-guarded document operations,
  proposal/review and receipt endpoints as desktop. Retained prose APIs are
  compatibility consumers, not a separate mobile writing authority.
- ProserAuthor does not depend on ProserTrainer; all authoring requests stay within the Author -> Factory boundary.
- Desktop `Book Factory` exposes retained launch keys in a Pending Operations center for safe reconciliation or intentional abandonment, serializes status polling with capped jittered backoff, treats version `0` as authoritative, pauses while hidden or offline, and rediscovers durable parent/child runs after reconnect. Prose generation creates a durable operation by authenticated idempotent JSON POST, then subscribes through a manuscript-free operation cursor URL. Session receipts distinguish creating, watching, detached, unresolved, completed, failed, and cancelled work. Reload recovery uses an exact-key lookup that includes recent terminal operations, verifies completed artifacts by SHA-256 into the Completed Generation inbox, and preserves failed or cancelled outcomes until dismissed. Explicit supersession cancels a late receipt; navigation, unmount, and stop-watching retain it as detached background work. Reconciliation pauses while hidden or offline, uses capped jittered backoff, and coordinates tabs with a browser lock and `BroadcastChannel`. “Stop tracking” leaves Factory work running, while “Cancel generation” requests a terminal server cancellation. Provisional output is bounded and committed only after metadata and SHA-256 verification. Validated SSE and publication downloads stream through the proxy without whole-response buffering.

---

## Testing

```bash
pnpm test                        # Active workspace unit/integration tests
pnpm --filter @hivemagnus/proser-web test   # Web tests only

# Playwright E2E against a live deployment
cd apps/web && PLAYWRIGHT_BASE_URL=https://proser.example.com pnpm exec playwright test --project=smoke --project=factory-proxy

# Authenticated mobile projects (use a disposable login)
cd apps/web && pnpm exec playwright test --project=mobile-chrome --project=mobile-safari
```

Set the test credentials as described in [Playwright E2E](docs/DEVELOPMENT.md#playwright-e2e).

Author and its browser regression fixtures both pin
`@hivemagnus/canvas-word-engine` 1.2.2.

The root `npm run test:canvas-mobile -- --repeat 3` builds and serves a production
fixture for native Chromium/WebKit input checks. Each repetition uses fresh
browsers, includes 60 rapid focused editor replacements, and checks real inline
worker URLs and errors. It fails on the first failure and does not retry cases.
Caret visibility waits for the actual viewport bounds with a three-second limit.
Receipts retain fixture asset hashes and browser lifecycle diagnostics in ignored
`output/playwright/r2-native-core/`. These checks use emulated mobile profiles.

All standalone Canvas runners share `scripts/canvas-browser-fixture.mjs` for
production compilation, inline worker validation, asset hashes, and exclusive
diagnostic directories. `npm run test:canvas-fixtures` verifies dynamic journal
entry exports, concurrent receipt preservation, cleanup failures, and the Orca
component loader in headless Chromium. It is included in root tests and CI;
the loader check does not exercise Orca speech or establish R2 certification.
The desktop runner writes each run's screenshots, optional CPU profile, and
terminal receipt under `output/playwright/canvas-native/` (override with
`PROSER_CANVAS_BROWSER_OUTPUT`).

---

## Deployment

Use the [root Compose stack](../docs/COMPOSE.md) for a new installation. The
[Author deployment guide](docs/DEPLOYMENT.md) describes HTTPS, readiness, and
existing split or native installations.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

First-party code is covered by the repository’s [Apache-2.0 license](../LICENSE).

## Canvas document release

Dashboard creation uses an authenticated, durable operation intent and requires
compatible Factory authority before dispatch. Project details and deletion retain
the exact structure revision loaded when their dialogs open; changing books or
accounts invalidates pending dialog preparation. Recovery reads the original
receipt, and a stale form requires explicit reconciliation. Empty books offer an
inline opening-scene form using the same structured Quick Draft transaction.
The root [browser acceptance guide](../scripts/DOCUMENT_BROWSER_ACCEPTANCE.md)
documents ordinary project creation, scene creation, interrupted saves and
revision-safe deletion, plus the separate WebKit touch CI gate.

Author enables the owned Canvas workspace when Factory advertises compatible
active document authority through the authenticated same-origin proxy. Inactive
or incompatible authority displays an explicit unavailable state. Tiptap and its
plain-text conversion surface have been removed.

Desktop and `/m/studio` use revision-qualified bounded passages. Scene, chapter
and book navigation keep at most three adjacent scene windows; large paragraphs
and table cells are sliced without loading the complete manuscript. Canvas and
semantic editing share Factory source identities, typed operations and undo.
Formatting, tables, authenticated images, paragraph boundaries, tracked review,
comments and layout-story controls preserve protected content.

Chapter scope shows an ordered chapter picker and previous/next chapter controls,
including empty chapters. Scope and chapter identities persist in the route for
reload and history. Adjacent scene previews identify continued excerpts and true
scene endings; next-excerpt controls follow bounded server cursors, and the
preview supports keyboard scrolling. Pending work must save or reconcile before
changing chapters or loading another excerpt.

Autosave journals the exact request before dispatch and shows Saved only after a
durable Factory acknowledgement. Recoverable records are scoped by authenticated
identity, book, source revisions and schema version, retained for 30 days, and
hidden on logout or account changes. Interrupted operations recover the original
receipt before retrying; stale drafts require explicit comparison/reconciliation.
Prepared AI draft intents retain their original operation IDs across restarts.
Scene and adjacent-scope undo restores complete revisions through guarded Factory
operations. Browser-history and route navigation retain unacknowledged edits.

Discussion, proposals, findings and compare cards use complete disclosed blocks
and stable targets. Exact source revalidation precedes tracked application.
Front/back matter and header/footer stories use their own layout authority and
persisted discussion records. Factory owns inference, cancellation, originals,
review attribution, import fidelity and immutable publication artifacts. Author
never searches quotations to relocate changed targets.

`/m`, `/m/studio`, `/m/read` and the desktop override remain available. The reader
renders revision-bound semantic content and never writes. Its bounded scene
windows remain separate from the writing surface's passage transport.

The selected release includes R1/R3/R4/R5/R7. The user has reopened real-device,
touch and screen-reader certification (R2); its
[current acceptance record](../docs/CANVAS_R2_ACCEPTANCE.md) identifies the candidate
and remaining physical-device checks. Performance certification (R6) remains
deferred; bounded-loading correctness is required. Exact Microsoft Word behavior
remains unverified. See the
[release checklist](../docs/CANVAS_RELEASE_CHECKLIST.md),
[backlog](../docs/CANVAS_NEXT_RELEASE_BACKLOG.md) and
[modernization ledger](../docs/CANVAS_MODERNIZATION.md).

Operator-only `scripts/create-release-canary-session.mjs` creates a short-lived,
standard encrypted session for a disposable release fixture using the installed
private session secret. For an HTTPS deployment, set `PROSER_AUTHOR_ORIGIN`
to the exact configured Author origin. It changes no authentication configuration and does not
prove Magnus IAM password login. Its output remains private and uncommitted.

Native Author releases retain a `DOCUMENT_CONTRACT` marker in code checkpoints.
Rollback to an older editor requires Factory to explicitly report both document
schema and enforcement disabled. Active or unknown authority refuses that
rollback before stopping the web service. After activation, retain and use only
a document-compatible release or forward repair.

The [Canvas selection freeze hotfix](docs/CANVAS_EDITOR_FREEZE_FIX.md) documents
stable editor lifecycle handling and the native selection/typing browser
regression. Equivalent save acknowledgements preserve the active Canvas and
input composition; real presentation changes still update it.

The subsequent [writing-controls release](docs/CANVAS_WRITING_CONTROLS.md)
repairs formatting and Factory-owned table insertion and reorganizes the workspace.
[Canvas maintenance](docs/CANVAS_MAINTENANCE.md) tracks upstream proposals,
remaining certification and safe diagnostic retention.

Maintained core `1.0.5-proser.2` follows upstream source through `71aa0996`,
including issue 1489's selection fixes and PR 1492's opt-in table identity
serialization. Author explicitly requests IDs for saved document snapshots;
clipboard serialization generates fresh IDs on paste. This targeted source port
retains local patches on the current upstream base; upstream npm publication is tracked
separately in the maintenance record.

Experimental incremental row computation keeps upstream's default of disabled;
Proser paragraph geometry falls back to full layout when that option is enabled.

The Editorial page includes the first three chapter transitions from one manuscript,
with actual saved endings/openings and proposal-only before/after review. See
[Chapter transition review](docs/CHAPTER_TRANSITIONS.md) for source bounds, exact
request recovery and tracked application through the manuscript.

## Revision campaigns

Editorial links to the shared desktop/mobile campaign workflow. Browser calls
remain authenticated relative `/api/*` requests to Factory. The campaign journal
is scoped to author and book and preserves exact requests for recovery. Running
plans refresh in the background while keyboard focus stays on the current
control. See
[the campaign guide](docs/REVISION_CAMPAIGNS.md) for approval, protected facts/voice,
consequence previews, tracked edits and required post-edit re-review.
In the manuscript's Markup view, authors can accept or reject tracked changes
and recover the original receipt if the response is interrupted.
