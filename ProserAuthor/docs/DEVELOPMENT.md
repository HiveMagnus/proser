# Develop ProserAuthor

For the full application use the [root Compose guide](../../docs/COMPOSE.md).
This guide runs Author from source against an existing Factory API. Install Node
`24.22.3` from `.nvmrc` and use Corepack to run the pinned pnpm `12.16.1`.
If Corepack is missing, install the version used by CI with
`npm install --global corepack@0.36.0`.

## Set up the web workspace

From the repository root:

```bash
corepack pnpm --dir ProserAuthor install --frozen-lockfile
cd ProserAuthor
corepack pnpm --filter '@hivemagnus/proser-web^...' build
(umask 077; set -o noclobber; cat .env.example > apps/web/.env.local)
```

Keep any existing `apps/web/.env.local`. Populate the following values for a
local test account.

| Setting                                      | Development value                                                    |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `FACTORY_URL`                                | Reachable Factory origin, for example `http://127.0.0.1:3001`        |
| `AUTH_URL`                                   | `http://localhost:3000`, matching the URL you open                   |
| `NEXTAUTH_SECRET`                            | A random secret for this web workspace                               |
| `FACTORY_AUTH_SECRET`                        | The signing secret from the Factory installation this workspace uses |
| `LOCAL_AUTH_ENABLED`                         | `true` for local sign-in                                             |
| `LOCAL_AUTH_USERNAME`, `LOCAL_AUTH_PASSWORD` | A disposable development account and password                        |

If you use Factory from the combined Compose installation, prepare its
[environment and image](../../docs/COMPOSE.md#first-run), then start Factory,
the worker, and their dependencies so port 3000 is available for your local web process.
Run this from the repository root.

```bash
docker compose --env-file .env.compose -f compose.yml -f compose.factory-api.yml up -d --no-build --wait factory worker
```

Run this from `ProserAuthor/` and open `http://localhost:3000`.

```bash
corepack pnpm --filter @hivemagnus/proser-web dev
```

[`ENVIRONMENT.md`](ENVIRONMENT.md) covers auth options. If the Factory proxy is
unavailable, check `FACTORY_URL`, Factory `/api/readiness`, and the matched
signing secret. Rebuild the shared packages if the application cannot load their
`dist` exports. Phone-class user agents enter `/m` through `apps/web/src/proxy.ts`.

## Quality checks

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm format:check
corepack pnpm build
corepack pnpm audit
```

## Playwright E2E

Run from `apps/web/` against an isolated installation with a disposable login
and a reachable Factory. Set `PLAYWRIGHT_IAM_USERNAME` and
`PLAYWRIGHT_IAM_PASSWORD` in the terminal for authenticated projects. Set
`PLAYWRIGHT_BASE_URL` to an alternate Author origin when targeting an existing
installation. Omit it to let Playwright start the local development server.

```bash
corepack pnpm exec playwright install chromium webkit
corepack pnpm exec playwright test --project=smoke --project=factory-proxy
corepack pnpm exec playwright test --project=mobile-chrome --project=mobile-safari
```

Use `PLAYWRIGHT_IGNORE_HTTPS_ERRORS=true` only for an isolated self-signed
fixture. Set `PLAYWRIGHT_IMPORT_FIXTURE_TITLE` to a synthetic imported book for
imported-manuscript tests. Session state is written to ignored `e2e/.auth/`.

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
