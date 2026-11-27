# Continuous integration

`Verify Proser` runs on every branch/tag push, pull request, and manual dispatch.
Working branches need no PR to receive validation. Superseded runs on the same
ref are cancelled. No workflow-level path filters leave checks pending.

`Changes and documentation` tests the CI policy, compares the complete change
range and publishes the selected/omitted suites and reason in its job summary.
The six existing job names remain unchanged. `CI acceptance` requires successful
classification and every selected suite to succeed. Failed, cancelled, missing
or unexpectedly skipped selected jobs fail acceptance. Intentionally unselected
jobs report skipped. Use `CI acceptance` as the aggregate verification check
when configuring branch protection. The public repository requires the
separate `Gitleaks` check for changes to main.

## Events and affected suites

| Event or change                                                                                                               | Suites                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Regular author-facing Markdown only                                                                                           | Documentation formatting, tables and generated API validation                |
| Main code push, release tag without compatible evidence                                                                       | All six                                                                      |
| Manual dispatch                                                                                                               | All six; `performance` separately opts into deferred certification           |
| Development push or PR: `ProserFactory/src/cli/`                                                                              | Factory                                                                      |
| Development push or PR: other Factory `src/` implementation                                                                   | Factory, contracts/Canvas, document-tools, authenticated Chromium and WebKit |
| Development push or PR: Author `apps/web/src/` implementation                                                                 | Author, contracts/Canvas, authenticated Chromium and WebKit                  |
| Development push or PR: `document-tools/`                                                                                     | document-tools, contracts/Canvas                                             |
| Shared contracts, Author packages, Factory document model, root tools, CI, locks, manifests, prompts, fixtures, unknown paths | All six                                                                      |
| Multiple components                                                                                                           | Union of affected suites                                                     |
| Missing comparison, new branch, empty/unsupported diff, special file modes                                                    | All six                                                                      |
| Tag with exact compatible successful full main validation                                                                     | Reuse that run; retain classification and acceptance checks                  |

The map is deliberately small: configuration, deployment scripts, vendored codec,
workspace/tooling changes and unrecognized paths retain full validation. Files
whose paths contain `prompt` or `fixture`, and package manifests/lockfiles inside
otherwise selective trees, also select all suites. Factory `src/documents/` and
all Author packages select all six because of the shared document contract.
The explicit CLI leaf has no browser importers; runtime Factory changes retain
both authenticated browser checks. Author application changes retain both
browser checks and Canvas acceptance. Browser assertions and repetitions have
not been reduced.

Pushes compare the supplied before/after commits, including multi-commit and
force pushes. PRs compare the head with its merge base against the target SHA.
Rename detection is disabled so both old and new paths contribute; deletions
count too. NUL-delimited Git records preserve unusual filenames. Unavailable
history and ambiguous input retain all suites. If classification fails, each
heavy job defaults to running; acceptance still fails on classification failure.

To force full validation, choose **Actions → Verify Proser → Run workflow** on the
wanted ref, or run `gh workflow run verify.yml --ref BRANCH_OR_TAG`. Manual
dispatch always selects all six, including documentation changes, and never
reuses prior validation. Set `performance=true` only when explicitly requesting
the deferred performance certification. Ordinary main code pushes also run all
six. The existing documentation-only exception on main is preserved.

## Documentation changes

Only regular, non-executable Markdown at the repository/component roots or under
`docs/`, `ProserFactory/docs/` and `ProserAuthor/docs/` qualifies. The job runs
pinned Prettier, table checks, Factory frozen installation, Prisma generation and
generated API validation. Deleted documents have no content to format.
It starts no database, browser, application build or document-tools container.
MDX, symlinks, executable Markdown, native runbooks under component
`deploy/` directories, source/vendored/skill Markdown and mixed
code/documentation changes retain full validation.

## Release tags and exact validation reuse

For tag pushes, a small, bounded lookup can reuse a **completed,
successful main push** at the exact `GITHUB_SHA` in this repository and workflow
path. Exact commit identity binds the workflow, Node/package-manager pins,
locks, fixtures and tracked configuration. Push inputs are identical; manual
performance runs and PR merge builds are excluded. All six original job names,
`Changes and documentation`, and `CI acceptance` must each occur exactly once
and be completed/successful in the latest attempt. This also excludes historical
workflow versions without the new gate and documentation/partial runs.
The reused URL is retained in the summary. The container release workflow
still runs its own image checks before publishing.

Only the latest exact-commit main push is inspected, with bounded API timeouts;
a newer failed/cancelled run cannot be hidden behind an older success. Pending,
failed, cancelled, missing, incompatible, truncated or inaccessible evidence
falls back to all six suites. There is no wait, cross-run lock, polling or
coordination service. The workflow token gains only Actions read access for
this lookup. Superseded-run cancellation is unchanged.

PR validation checks the merge context, while pushes protect branches without
PRs. Validation reuse is limited to the release-tag case above.

## Container releases

[Publish Proser image](../.github/workflows/publish-image.yml) handles
`vMAJOR.MINOR.PATCH` tags in `HiveMagnus/proser`. The tagged commit must
already be on main. The workflow waits for `Verify Proser` and `Gitleaks`
to pass on that exact tag and commit.

Before tagging, set the `version` in the root and `ProserFactory/package.json`
files to the release version; the workflow refuses a tag the packages do not
name. The image records the tag version in `/opt/proser/factory/VERSION`, and
Factory reports it from `/health`, `GET /api` and the Settings page.

It builds the image natively for `linux/amd64` on `ubuntu-24.04` and for
`linux/arm64` on `ubuntu-24.04-arm`. Each architecture checks image layers,
checks that the runtime image ships no package manager (the base image's npm,
npx, Corepack and Yarn are removed because nothing runs them), and scans
first-party application files for secrets, then starts a fresh Compose
stack. The smoke test covers local sign-in, saving and reopening a structured
draft, direct authenticated Factory API access, the reported version and a
healthy worker. The workflow then rehearses `scripts/backup-compose.sh` and
`scripts/restore-compose.sh` on a disposable project, and runs
`scripts/smoke-compose-upgrade.sh`: it starts the previous release image with
that release's Compose files, saves a book, applies the candidate's migrations
with the documented `migrate deploy`, starts the candidate, and checks the
document guards, every healthcheck, readiness, the version and the saved book.
Releases up to v1.0.7 exist only for `linux/amd64`, so the `linux/arm64`
upgrade test is skipped, with a note in the run summary, until the previous
release has an arm64 image.

When both architectures pass, each pushes a staging tag
(`MAJOR.MINOR.PATCH-amd64`, `MAJOR.MINOR.PATCH-arm64`), and the publish job
combines them into one multi-architecture manifest list at
`ghcr.io/hivemagnus/proser:MAJOR.MINOR.PATCH` and attests the manifest list
digest. Install from the version tag; the staging tags are build inputs. An
existing version tag cannot be overwritten by the workflow. A failed
architecture can be re-run; its staging tag is replaced until the version tag
exists.

Run the workflow manually (`gh workflow run publish-image.yml --ref main`) for
a dry run: it builds and tests both architectures at the selected commit, using
the version its packages declare, and publishes nothing.

Verify anonymous pulls and the attestation before advertising a release.
GHCR package visibility is configured separately from repository visibility.
The GitHub release notes record the version and digest that installers should
use. [Proser releases](https://github.com/HiveMagnus/proser/releases)

## Caches and builds

Every npm-consuming heavy job caches `~/.npm`. Keys include Ubuntu 24, OS,
architecture, the exact Node pin (including its bundled npm), Factory lock and
nested codec locks. The classifier caches npm only after selecting documentation
validation, which actually installs dependencies. Code/reuse paths cannot save a
log-only entry before the heavy jobs populate the shared download cache. The
`npm-v2` namespace bypasses the earlier empty entry. Author-consuming jobs locate pnpm's actual store after
activating Corepack 0.36.0 / pnpm 12.16.1, then cache it by OS, architecture,
Node, manager versions, lock, workspace configuration and patches. No
`node_modules`, test results, generated clients or manuscript artifacts are
cached. Frozen installs, Prisma generation, migrations, browser/system
dependencies, builds and tests run regardless of cache hits. Cache misses use
the same installation steps.

Document-tools uses pinned Docker Buildx/build actions, the GitHub cache API v2
backend and `mode=max` so intermediate apt/font/.NET layers can be reused.
BuildKit validates Dockerfile/context/base-image inputs; the cache scope separates
Ubuntu/architecture and cache format. `load: true` supplies the same local image
to the existing network-isolated validators; no image is published. Cache export
failure is nonfatal because it affects only future acceleration. Build and
validation failures remain fatal. Cache export/import and image loading introduce
transfer/storage costs that need hosted follow-up; the maximum-layer cache can
be large.

Browser caching is deferred. Historical browser installation includes required
OS dependencies and downloads; those costs cannot be separated from the step
metadata. Playwright also cautions that restore can cost as much as download and
Linux system dependencies are not cacheable. See the
[Playwright CI guidance](https://playwright.dev/docs/ci#caching-browsers).

Cross-job build artifacts and Next/Turbo result caches are deferred. The two
browser jobs rebuild roughly the same source but have separate environment,
database and acceptance profiles. Transfer time, artifact size and build-time
configuration equivalence have not been established. Keeping fresh builds avoids
sharing potentially incompatible output. See
[Docker's cache backend guidance](https://docs.docker.com/build/ci/github-actions/cache/)
for the layer cache mechanism.

## Local validation

`npm run test:ci` covers real-Git docs/component decisions, shared/unknown paths,
renames/deletions, force/multi-commit pushes, PR merge bases, new branches,
unavailable history, manual full selection, exact evidence reuse and fail-closed
acceptance. Root tests include this suite. Run
`actionlint` from the repository root for workflow edits. See the
[root checks](../AGENTS.md#commands) and the
[isolated Factory test setup](../ProserFactory/README.md#testing) for database
ports and the publication-font manifest.

## Historical CI measurements

Local verification on October 31, 2026 (Node 24.22.1):

| Check                                      | Local result                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI regression tests                        | 20 passed, including real tag CLI reuse/fallback and manual full selection                                                                          |
| Workflow validation                        | actionlint 1.7.12 passed; whitespace/diff checks passed                                                                                             |
| Root formatting, lint, typecheck and build | Passed; Author lint/typecheck/build also executed with Turbo cache bypassed                                                                         |
| Root `npm test`                            | Passed; Factory 143 suites / 954 tests; Author separately rerun without Turbo cache: 850 tests                                                      |
| Additional Factory checks                  | Codec 36, smoke 129, CLI 42 tests passed; worker heartbeat checks passed                                                                            |
| Contracts/runtime                          | Generated contracts/API, exact fork ledger, 5 runtime-helper and 9 document/browser/isolation tests passed                                          |
| Canvas/browser                             | Canvas checks passed; Chromium and WebKit mobile checks retained all 3 repetitions per browser                                                      |
| Authenticated integration                  | Chromium 27 checks, WebKit workspace 7, WebKit Quick Draft 2 passed                                                                                 |
| Document-tools                             | All existing fixture/native/story/comment/style/theme/WebP/large-manuscript/empty-line/historical validators passed against the locally built image |
| Cold dependencies                          | Empty npm cache and pnpm store installs passed in a separate archived checkout; frozen locks unchanged                                              |
| Dependency audits                          | Factory failed: 15 vulnerabilities (7 moderate, 8 high); Author failed: 1 high (`zod`); dependency files unchanged                                  |

The first WebKit Quick Draft run completed its two functional checks but failed
on a browser access-control error for the session endpoint. An isolated rerun
with a fresh database and the same assertions passed. The local wrapper needed
an explicit fixture `DATABASE_URL` and pnpm on PATH.

Local Docker Buildx 0.38.1 history measured a **62s cold build**, **4.9s same-builder
warm build**, and **14.0s on a separate clean builder importing the exported local
cache**. The cache occupied approximately **682 MiB**. The cold run explicitly
used a missing cache path and still built/loaded successfully. Export took about
1.4s cold and 1.8s on the clean restored builder; the restored image load/export
step took 2.5s. These measurements use local disk cache transport and an existing
local Docker daemon; they do not measure GitHub cache upload/download or hosted
runner startup. No dependency warm/cold speedup is inferred from install success.

## Secret scanning

The **Gitleaks** workflow runs on pushes, pull requests, and merge queues.
It installs a pinned tool with verified checksums and scans the full candidate
history with redacted findings. Match exceptions are limited to reviewed
fixture values in their specific source files.

Enable the same checks locally:

```bash
bash scripts/install-gitleaks.sh
git config core.hooksPath .githooks
bash scripts/test-gitleaks.sh
bash scripts/gitleaks.sh --history
```

The pre-commit hook scans the exact staged tree. The pre-push hook scans
outgoing history. Keep private environment files, manuscript exports, and
runtime data outside the Git index and published build context.
