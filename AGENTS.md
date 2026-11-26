# AGENTS.md — Proser

Proser ships one Compose application image with two runtime components.

- `ProserFactory/` is the authoring system of record: Express API, Prisma/PostgreSQL, BullMQ workers, inference and image integration, CLI, and Hermes plugin.
- `ProserAuthor/` is the authenticated Next.js desktop/mobile shell. Browser API requests remain relative `/api/*` calls through its same-origin proxy.

Read the component `AGENTS.md` before changing that subtree. Preserve the API/auth boundary: Author owns browser sessions and UI; Factory owns books, prose, workflows, images, queues, persistence, and model connections.

## Commands

Use Node `24.22.3` from `.nvmrc`. From the repository root, install the two
locked dependency trees and generate the Factory Prisma client.
[Author toolchain setup](ProserAuthor/docs/DEVELOPMENT.md)

```bash
npm --prefix ProserFactory ci
npm --prefix ProserFactory run db:generate
corepack pnpm --dir ProserAuthor install --frozen-lockfile
```

Run cross-project checks from the root.

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run audit
```

Run component commands with npm in `ProserFactory/` and pnpm in `ProserAuthor/`.
Keep each lockfile with its component. Full tests require the isolated
PostgreSQL and Redis fixtures in [CI and local validation](docs/CI.md#local-validation).
Documentation validation may use a placeholder `DATABASE_URL` because it
loads the Prisma adapter without connecting to a database.

## Documentation and deployment

The root Compose deployment uses one application image for Author, Factory and
its worker, with PostgreSQL and Redis on an internal network. Follow
`docs/COMPOSE.md` for first startup, provider configuration, and upgrades.
Use the Compose deployment for self-hosted installations. Keep production
environment files, TLS settings, and recovery evidence in private storage.

- Keep `README.md`, `APP_ARCHITECTURE.md`, and `PROSER_API.md` aligned with both components.
- Keep component-specific setup and operations in each component README and `docs/`.
- Use the reviewed Compose upgrade procedure for production. The component native scripts apply only to explicitly selected native installations.
- Never commit `.env` files, local databases, generated certificates, build output, or manuscript exports.

Start from the [installer README](README.md), [Factory API](PROSER_API.md), or
[Hermes setup](ProserFactory/HERMES_AGENT_PLUGIN.md) for the corresponding task.
Release builds use [the image publishing workflow](docs/CI.md#container-releases)
and must use the exact verified release commit. Run the scoped Gitleaks checks
before staging a release.

See `docs/CANVAS_RELEASE_RECORD.md` for the public release scope and
`docs/CANVAS_NEXT_RELEASE_BACKLOG.md` for the remaining work. Preserve immutable
receipts, source data, and unique evidence. Keep installed-host receipts and
production diagnostics in private operator storage.

## Active acceptance scope

R1/R3/R4/R5/R7 are shipped. R2 mobile/accessibility certification remains
active and incomplete, and R6 performance certification remains deferred.
Follow [R2 acceptance](docs/CANVAS_R2_ACCEPTANCE.md) for candidate-specific evidence.
Revision campaigns require automated browser, keyboard, accessibility and exact
recovery checks. Run available physical-device and actual screen-reader checks.
Record unavailable certification as incomplete and nonblocking. Preserve prior
evidence and its limits. Report emulation and accessibility-tree checks as such.

Preserve `/m`, `/m/studio`, `/m/read`, the desktop override, canonical Factory
authority, authenticated draft scope, and exact receipt recovery.
