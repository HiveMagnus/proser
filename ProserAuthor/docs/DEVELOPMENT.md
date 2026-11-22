# Development Setup Guide

Complete guide to setting up the active ProserAuthor web shell.

ProserAuthor is now the authenticated Next.js client for ProserFactory. The local development path should exercise `apps/web` and the shared packages; ProserFactory owns authoring APIs, persistence, workers, model routing, and image generation.

---

## Prerequisites

| Tool          | Version         | Installation                                                  |
| ------------- | --------------- | ------------------------------------------------------------- |
| Node.js       | >= 22.13        | [nodejs.org](https://nodejs.org/) or `nvm install 22`         |
| pnpm          | 12.16.1         | `corepack enable && corepack prepare pnpm@12.16.1 --activate` |
| ProserFactory | Running service | `FACTORY_URL`, production default `http://127.0.0.1:3001`     |

---

## 1. Clone And Install

```bash
git clone https://github.com/HiveMagnus/proser.git
cd proser
corepack pnpm --dir ProserAuthor install --frozen-lockfile
cd ProserAuthor
```

This installs the active web workspace and shared packages.

---

## 2. Environment Configuration

Copy the example environment file and adjust as needed:

```bash
cp .env.example .env
```

Key variables:

```env
FACTORY_URL=http://127.0.0.1:3001
PORT=3000
NEXTAUTH_URL=http://localhost:3000
```

See [ENVIRONMENT.md](ENVIRONMENT.md) for the full variable reference.

---

## 3. Start Development

```bash
pnpm --filter @cheftaco/proser-web dev
```

The web UI runs on `http://localhost:3000`. All browser API calls stay on relative `/api/*` routes and are proxied to `FACTORY_URL`.

---

## Mobile Development

ProserAuthor includes a dedicated phone shell under `/m`. Phone-class user agents are automatically redirected there unless the desktop override cookie is set.

```bash
pnpm --filter @cheftaco/proser-web test:e2e -- e2e/mobile-mode.spec.ts
```

---

## Quality Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
pnpm build
pnpm audit
pnpm audit --prod
```

The current quality toolchain uses ESLint 10, Prettier 3, Vitest 4, and
Turborepo 2. React hook linting enforces the Rules of Hooks and exhaustive
dependency checks; React Compiler lint rules are not enabled.

---

## Playwright E2E Tests

```bash
cd apps/web
npx playwright install
npx playwright test
npx playwright test e2e/mobile-mode.spec.ts

# Run against deployed server
PLAYWRIGHT_BASE_URL=https://proser.example.com \
  npx playwright test --project=smoke --project=factory-proxy
```

Playwright verifies HTTPS certificates by default. Set
`PLAYWRIGHT_IGNORE_HTTPS_ERRORS=true` only for an isolated fixture with a
self-signed test certificate. Use a synthetic imported book and explicitly set
`PLAYWRIGHT_IMPORT_FIXTURE_TITLE` for the imported-work regressions.

The default Playwright suite excludes retired API-only specs. Use ProserFactory tests for direct API contract coverage.

---

## Troubleshooting

### "Factory proxy unavailable"

- Verify `FACTORY_URL` points at the active ProserFactory service.
- Check `curl -k https://proser/api/readiness`.
- Check `journalctl -u proser-v2-web -n 100` on the ProserAuthor host.

### "Module not found" errors

- Run `pnpm install` to ensure all workspace links are resolved.
- Run `pnpm build` to build dependent packages.

### Retired API Or Worker Paths

`apps/api`, `apps/worker`, `proser-v2-api`, and `proser-v2-worker` are no longer active ProserAuthor runtime paths. Keep fixes and feature work on `apps/web`, shared packages, and ProserFactory.

## Structured workspace acceptance

The chapter/book writing window contains at most three contiguous scene bodies.
`use-document-window-session.ts` stages the complete multi-scene request in every
changed scene draft before dispatch, recovers its operation receipt and marks
all changed scopes saved only after Factory's durable atomic acknowledgement.
`document-window-session.test.tsx` exercises complete-block move/undo, interrupted
acknowledgement recovery, typing during save, stale commits and actor changes.
`semantic-operations.test.ts` covers Unicode graphemes, formatting-aware run
splits, comment lineage and protected review targets; `semantic-workspace.test.tsx`
checks focus retention and composition completion with DOM inputs.

These tests establish their named scenarios. They do not establish mobile touch,
screen-reader behavior, cross-surface selection restoration or publication layout.
Use the authenticated browser/performance corpus before enabling production
Canvas authority. Keep all seven migration phases in the root delivery ledger.
