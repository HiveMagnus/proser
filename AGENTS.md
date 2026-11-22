# AGENTS.md — Proser

Proser is one Git repository with two independently deployable components:

- `ProserFactory/` is the authoring system of record: Express API, Prisma/PostgreSQL, BullMQ workers, inference and image integration, CLI, and Hermes plugin.
- `ProserAuthor/` is the authenticated Next.js desktop/mobile shell. Browser API requests remain relative `/api/*` calls through its same-origin proxy.

Read the component `AGENTS.md` before changing that subtree. Preserve the API/auth boundary: Author owns browser sessions and UI; Factory owns books, prose, workflows, images, queues, persistence, and model connections.

## Commands

Run cross-project checks from this root:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run audit
```

Component commands continue to run from `ProserFactory/` with npm and `ProserAuthor/` with pnpm. Do not introduce a shared dependency lockfile or move runtime services merely because the source now shares a repository.

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

See `CANVAS_RELEASE_RECORD.md` for the public release scope and
`CANVAS_NEXT_RELEASE_BACKLOG.md` for the remaining work. Preserve immutable
receipts, source data, and unique evidence. Keep installed-host receipts and
production diagnostics in private operator storage.

## Active acceptance scope

R1/R3/R4/R5/R7 are shipped. R2 mobile/accessibility certification remains
active and incomplete; follow `CANVAS_R2_ACCEPTANCE.md` for candidate-specific
evidence. The practical automated browser, keyboard, accessibility and recovery
gate governs revision campaign releases. Unavailable physical-device or actual
screen-reader certification does not block development or release. R6 performance
certification remains deferred. Preserve `/m`, `/m/studio`, `/m/read`, the desktop
override, canonical Factory authority, authenticated draft scope and exact receipt
recovery. Never report browser emulation or accessibility-tree checks as physical
device or actual screen-reader acceptance. Preserve historical release decisions.

## Revision campaign acceptance decision

The author selected a practical release gate for revision campaigns: automated
browser, keyboard, accessibility and exact recovery checks are required. Run
available actual screen-reader checks. Unavailable physical-device and actual
screen-reader certification remains explicitly incomplete and is nonblocking for
development and release. Preserve the earlier candidate-specific evidence and
its limits. This current direction supersedes earlier R2 prerequisite wording;
R6 performance certification remains deferred.
