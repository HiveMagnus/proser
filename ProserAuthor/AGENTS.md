# AGENTS.md — ProserAuthor

## Runtime boundary

ProserAuthor is the authenticated Next.js web shell for ProserFactory. It owns browser UI, NextAuth sessions, mobile routing, and the same-origin API proxy. ProserFactory owns authoring data, models, images, background work, and storage.

Do not add an Author API, database, worker, model connection, or public image-serving path. Browser API calls remain relative `/api/*` requests and flow through `apps/web/src/app/api/[...path]/route.ts`.

## Active layout

- `apps/web` — Next.js 16 App Router application, desktop and `/m` mobile shells, NextAuth, API proxy, Vitest, and Playwright. The bounded Canvas workspace is gated by compatible Factory document activation; inactive authority is visibly unavailable. Tiptap has been retired.
  The manuscript route delegates capability selection to `components/editor/manuscript-entry.tsx`; do not reintroduce legacy prose conversion or full-scene writing surfaces. Structured navigation/context/session modules must retain revision and authenticated-user scope. Workspace/mobile preferences and operation journals reveal only the same authenticated identity's records.
- `packages/contracts` and `packages/editor` — Factory-derived document contracts and owned editing controls around the exact shared `@hivemagnus/canvas-word-engine` dependency. `packages/canvas-engine` contains integration fixtures and historical notices only; maintain runtime changes in `ChefTaco/canvas-word`. Retired domain/inference/export/quality/design-system stubs must stay absent; those responsibilities belong to Factory or the app's existing UI components.
- `scripts/deploy-to-proser.sh` — legacy native workstation-to-host deployment.
- `deploy/update.sh` and `deploy/proser-v2-web.service` — host-side update and systemd service.
- `Dockerfile` and `docker-compose.yml` — local/staging web-shell container path.

The retired `apps/api`, `apps/worker`, `proser-v2-api`, and `proser-v2-worker` paths must stay absent/inactive.

## Security invariants

- Production authentication uses Oathweave OIDC. `IAM_CORE_URL` marks an Oathweave installation and turns local credentials off.
- Oathweave OIDC (`OATHWEAVE_OIDC_*`) uses authorization code with S256 PKCE and a nonce, and verifies the ID-token signature. Factory keys those accounts on `oathweaveSubject` and links a first OIDC sign-in to the existing `iam:<username>` account. Author never takes or relays an Oathweave password; do not reintroduce a password relay. See `../docs/OATHWEAVE_OIDC.md`.
- Local credentials exist only when `LOCAL_AUTH_ENABLED=true` and both `LOCAL_AUTH_USERNAME` and `LOCAL_AUTH_PASSWORD` are explicitly set.
- `NEXTAUTH_SECRET` protects the web session. `FACTORY_AUTH_SECRET` is a separate shared secret used only for short-lived Author-to-Factory JWTs.
- Backend JWTs use issuer `proser-author` and audience `proser-factory` by default. Keep these aligned with Factory validation.
- Do not forward browser cookies or browser-supplied authorization headers to Factory.
- Image content is loaded through authenticated `/api/images/:id/content` URLs, never direct `/images/*` or internal Factory origins.
- Production auth callbacks use the configured canonical HTTPS origin through both `NEXTAUTH_URL` and `AUTH_URL`.
- Keep deployment environment and certificate keys in owner-only host files. Avoid putting production environment files into the application image.

## Conventions

- Run Author commands from `ProserAuthor/` with pnpm, or use the matching root wrapper script.
- Native deployment installs and verifies the root runtime helper at
  `/opt/proser-runtime/node-v24.22.3`; systemd and host updates use that exact Node.
  Host updates must fail before pulling code if the pinned runtime is absent.
- Web imports use `@/*` for `apps/web/src/*`.
- Shared packages use TypeScript and package-local Vitest suites.
- Inference host/model settings shown in Author are read-only; operators configure them in ProserFactory.
- Preserve the mobile `/m`, `/m/studio`, and `/m/read` route behavior and the `proser-view` desktop override.
- Findings/compare choices use `document-review.tsx` and Factory-bound targets.
  Flush/revalidate before tracked application, persist the exact request in the
  user/book/scene-scoped review journal before dispatch, and recover its original
  receipt before offering an explicit retry. Account changes must remount review
  state; never apply returned prose by searching for a quotation.
- Update README and the relevant file under `docs/` whenever runtime, environment, test, or deploy behavior changes.

## Required checks

Use the pinned Node and pnpm versions from the [development guide](docs/DEVELOPMENT.md).
For the full installer, use the repository-root Compose configuration.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm audit --prod
for script in scripts/deploy-to-proser.sh deploy/update.sh deploy/proser-tailscale-cert-renew; do
  bash -n "$script"
done
```

Playwright local runs require explicit credentials:

```bash
PLAYWRIGHT_IAM_USERNAME=playwright-local \
PLAYWRIGHT_IAM_PASSWORD='<test-only-password>' \
AUTH_SECRET='<test-session-secret>' \
FACTORY_AUTH_SECRET='<test-factory-secret>' \
pnpm --filter @hivemagnus/proser-web exec playwright test
```

## Deployment finish bar

Production uses the [root Compose stack](../docs/COMPOSE.md). Verify the
installed Author and Factory image revision and leave PostgreSQL and Redis
internal. The native script below applies only to a selected native host.

A deployment is successful only when:

- `--dry-run` builds and inspects the installed revision without changing the
  service; `--release-id ID` keeps an owner-only code checkpoint and verifies
  the built web artifact digest after sync. `--rollback ID` restores the exact
  checkpoint only while that candidate revision is installed, then checks
  readiness. It does not restore or modify Factory data. An incompatible checkpoint
  requires an explicit disabled document schema/enforcement response; active or
  unavailable authority blocks restoring the old editor before any service stop.

- the Author container is healthy and retired Author API/worker units are inactive;
- unauthenticated `/` redirects to the canonical FQDN sign-in flow;
- `/api/readiness`, `/api/models/status`, and `/api/images/health` succeed through the web proxy;
- an authenticated disposable authoring canary saves, reloads, recovers and publishes through the proxy; retain its audit/operation history and tombstone its book;
- the working tree contains only the intended changes before the final commit.

## Selected Canvas release

R1/R3/R4/R5/R7 shipped against the root release checklist. R2 device and
assistive-technology certification remains active and incomplete. Follow
`../docs/CANVAS_R2_ACCEPTANCE.md` for exact candidate and evidence boundaries. The
practical automated browser, keyboard, accessibility and recovery gate governs
revision campaign releases; unavailable physical-device or actual screen-reader
certification is nonblocking. R6 performance certification remains deferred;
bounded-loading correctness still applies. Emulated mobile profiles, DOM/axe
checks and generated speech evidence must retain their distinct limits. Keep
all-writer, workspace, AI/import/publication, performance and production items
visible in the modernization ledger.

Use the current root release record for the public release scope. Keep exact
operator receipts in private storage. Keep fork maintenance and diagnostic
retention instructions in `docs/CANVAS_MAINTENANCE.md`. Never prune originals,
uncertain operations or production checkpoints as temporary files.

## Revision campaign acceptance decision

The author selected a practical release gate for revision campaigns: automated
browser, keyboard, accessibility and exact recovery checks are required. Run
available actual screen-reader checks. Unavailable physical-device and actual
screen-reader certification remains explicitly incomplete and is nonblocking for
development and release. Preserve the earlier candidate-specific evidence and
its limits. This current direction supersedes earlier R2 prerequisite wording;
R6 performance certification remains deferred.
