# Candidate-specific Canvas native transition

This is the explicit native path for the first document-authority release. The
normal additive classifier remains unchanged and rejects this transition. User
authorization to ship the Canvas release permits its concrete reviewed deployment;
the proof does not invent a new approval, grant HTTP/model mutation authority or
turn an isolated rehearsal into production success.

`deploy/document-authority/reviewed-schema.json` pins all thirteen document-era SQL
migrations, the PostgreSQL migration lock bytes and the separate enforcement SQL.
The conservative classifier also rejects the trace-analysis unique indexes before
reaching schema21; the reviewed closure therefore covers every new migration.
Previously installed SQL cannot be rewritten. Unknown migration files, changed
pins, another provider, a dirty candidate or a different installed base fail.

The metadata-only schema21 aligns the three named browser foreign keys, source
cutover uniqueness and three timestamp defaults. It accepts only known metadata;
no manuscript/history row is rewritten and Prisma's destructive diff is never
executed. The enforcement script installs with `enabled=false`. Its triggers and
functions require this review, not an additive classification.

## Private proof and acceptance

Use a clean committed candidate and its exact full Git SHA. Run the final
synthetic rehearsal with explicit `127.0.0.1:55441/postgres`, then separately
restore the production dump into a protected `proser_canvas_*` database. Never
run Jest, editorial evaluation, fixture cleanup or providers against real books.
Run archive-inclusive backfill twice and validate selected assets from preserved
owned bytes before initializing heads. Compare original IDs and every original
column, including timestamps and null/empty distinctions. Retain legacy snapshots,
hashes and receipts unchanged, with appended native bridge mappings.

For selected images, registration may add verified digest/dimensions/type metadata
only through `backfillSelectedArtwork`. Compare every other original image column
unchanged; reconstruct only `config_json` from the exact appended audit's
`oldConfigJson` for the original-row comparison. Record the audit ID, asset ID,
original/current config hashes and equal preserved-original/audit-original hashes.
This is an explicit metadata augmentation, not a claim that the physical image row
was unchanged. Verify every original image's actual immutable bytes independently.

Compare all current table counts/hashes after a candidate dump, first restore,
and a dump/second restore. Require empty Prisma diff after Prisma migrations on fresh and production-backed
clones, then install the separately reviewed enforcement SQL and require its exact
hash. Its deliberately separate guard table is not managed by Prisma; never
execute the generated DROP TABLE diff after installing enforcement. Require
exact migration count22. Original production rows
must remain preserved independently of newly appended bridge/audit rows. All
records stay owner-only outside Git. The machine generator is
`scripts/rehearse-document-preservation.mjs`; supply explicit `--isolated-postgres`,
`--original-dump`, `--asset-manifest` and `--record-dir` arguments. The asset manifest
contains each original `{assetId,url,path,sha256}`. It creates only newly named
local clones, invokes the built document service without providers, compares all
original rows, and retains both candidate dumps/restores. A temporary
`--allow-dirty-isolated-diagnostic` run records `dirtyWorktree:true` and is rejected
by the native proof verifier; it never authorizes production.

The native proof JSON has:

- `schemaVersion:1`, `kind:"reviewed-document-native-release"`;
- exact `candidateRevision`, `installedRevision`, `schemaSha256` and
  `enforcementSqlSha256`, `host:"proser"`, `database:"proser"`;
- explicit `reviewedBy`, `authorization:"user-authorized-canvas-release"`,
  `holdServices:true`, `activateAuthority:false`;
- `rollbackPolicy:"document-compatible-only-after-activation"` and exact
  `compatibleRollbackRevision`. The pre-transition binary is not a compatible
  rollback after structured writes begin; retain a complete candidate checkpoint
  and use forward repair until another compatible release exists;
- `syntheticRehearsal`, `productionRestore` and `originalDump`, each an absolute
  owner-only regular-file `{path,sha256}` binding. Their parent directories are0700.

The synthetic evidence is the exact clean candidate's
`rehearse-document-enforcement.mjs` receipt. Production evidence has
`schemaVersion:1`, `kind:"isolated-production-preservation-v2"`, exact candidate,
`dirtyWorktree:false`, `productionMutation:false`, isolated `database`,
`migrationCount:22`, exact enforcement/dump hashes, `backfillPasses:2`, identical
nonempty `backfillHeadsBeforeSecond`/`backfillHeadsAfterSecond`, and
`originalRowScope:"all-original-ids-and-columns"`. Its
`originalRowsBefore`/`originalRowsAfter` contain identical `{count,sha256}` summaries
for all original tables/IDs/columns. Its `candidateRows`, `firstRestoreRows` and
`secondRestoreRows` are identical full candidate table summaries. `schemaDiff` is
exactly `-- This is an empty migration.` and `assetBytes` binds every original
image's owner-only `{path,sha256}` file.

`originalRowNormalizations` is empty unless selected-image metadata was registered.
Each allowed entry is `{table:"images",column:"config_json",assetId,auditId,
originalValueSha256,auditOriginalValueSha256,registeredValueSha256}`. The original
value hashes must match. No other column, table, lifecycle or content normalization
is permitted. The operator must inspect the actual retained audit/bytes behind
these machine-generated facts; proof JSON is not a substitute for rehearsal.

## Deployment and activation sequence

1. Read the concrete clean candidate proof, verify every evidence digest and
   review the exact retained operations and rollback policy. Run
   `python3 scripts/check-document-release-proof.py --proof-file /private/proof.json
--base-sha INSTALLED_FULL_SHA --candidate-sha CANDIDATE_FULL_SHA`.
2. Fence admissions using installed compatible release support, or stop the API
   and worker as the actual admission boundary when old code lacks that support.
   Drain/inspect every bounded inventory cursor twice. Preserve exact unknown
   provider operations without replay, forced cancellation or invented completion.
   Record already paused queues and recovery paths. Old code is not fenced by a
   new local receipt.
3. Run the native Factory script with `--document-release-proof /private/proof.json`.
   The script retains Redis persistence preflight, exact component checkpoint,
   stopped API/worker, pre-migration dump and independent restore drill. It verifies
   the clean candidate/base proof, installs dependencies/runtime/fonts, migrates
   schema and installs reviewed inactive enforcement. It retains the exact private
   proof in the checkpoint and leaves **both services stopped** with a durable
   `held-for-document-activation` release record. This is a staged installation,
   not a successful operational release.
4. With writes still fenced, register verified selected assets, run the final
   archive-inclusive backfill twice and reconcile originals, IDs, hashes, history,
   asset bytes and source receipts against the stopped-service backup. Recover
   exact maintenance receipts rather than replaying unknown effects. Install the
   compatible Author independently; retain `/opt/proser-factory`, `/opt/proser-v2`
   and the native service identities.
5. Explicitly activate the candidate-bound SQL guard and application capability;
   prove supported schema/index/storage/renderer/fonts, then start the reviewed
   API/worker and require fresh worker/readiness receipts. Keep the release fence
   closed until controlled authenticated editing/publication and recovery canaries
   pass and installed revisions/digests match. Reopen only the exact reviewed
   release and only queues this release paused.
6. Reconcile post-release original preservation and disposable canary cleanup,
   document the installed and remote commits and complete the release record.
   After structured writes begin, use only document-compatible code rollback or
   complete revision restoration. A database restore needs continued fencing and
   reconciliation/export of all post-backup revisions/artifacts.

R2 device/screen-reader certification and R6 performance certification are deferred
by the user; existing mobile compatibility remains required. Microsoft Word
behavior remains unverified. Native Word XML and LibreOffice evidence do not prove
exact Microsoft Word layout or acceptance.

## Controlled checks while admissions remain closed

The installed legacy release has no database admission support. Stop the old
API and worker as the actual cutoff, then run the content-free
`scripts/inspect-installed-release.mjs` with the installed Factory environment.
It reads PostgreSQL in a read-only transaction and Redis directly, never queue
constructors, expiry/recovery helpers or provider dispatch. Complete every SQL
cursor and Redis SCAN cursor twice after cutoff. Retain both sets of private
metadata digests, queue pause states, original legacy export checksums and exact
unknown provider operation IDs. A cancelled operation is not proof that a
provider effect was absent; never replay it to settle the inventory.

After the native script stages schema 22 and inactive enforcement with services
stopped, the release operator seeds one disposable identity named exactly
`release-fixture:release-canary-UUID` and an owned initialized book through the
built document service. Ordinary traffic remains stopped. The Book should have
a small editable scene; no original user, book, asset or identity is reused.
Prepare the exact close/reopen admission proof for this installed candidate,
database and release. Mint immediately before closing admissions, after long
build/rehearsal work has finished:

```bash
node scripts/release-canary.mjs --apply \
  --admission-id UUID --user-id DISPOSABLE_USER_ID --book-id DISPOSABLE_BOOK_ID \
  --expires-at ISO_UTC_WITHIN_20_MINUTES \
  --proof-file /private/admission-proof.json --proof-sha EXACT_PROOF_SHA \
  --out /private/release-canary/grant.json
```

The wrapper checks installed `REVISION`, exact private proof bytes and reviewed
enforcement SQL. Its immutable admission binds the user, book, initial revision,
candidate, proof, fence generation and deadline. Repeat the same arguments to
recover a lost mint acknowledgement; do not mint another grant after fencing.
Record this exact admission in the release evidence. Close the release with the
same candidate/proof before starting the reviewed services. Install only a copy
of the grant under a directory owned by Factory's service user (`service-account`),
with directory 0700 and file 0600. Configure the server-only
`PROSER_RELEASE_CANARY_FILE` reference temporarily through the service's local
release environment. The original operator proof/grant remains private.

Ordinary authentication validates the caller before using this grant. No header,
body, browser cookie claim or public endpoint supplies admission authority.
Only the exact owned document/review/restoration operations, local publication,
and final fixture tombstone are eligible. Book creation, workflows, AI/image
providers, foreign identities and other books remain fenced. Publication may
render only a job already bound to this same grant and exact source revision and
hash. Expiry, reopening, another fence generation, another candidate/proof, or a
changed/private-file violation invalidates the grant. Reads and exact recovery
continue under their normal ownership policies.

Run the installed Factory smoke with the operator's private fixture reference:

```bash
SMOKE_DOCUMENT_CANARY_FILE=/private/release-canary/grant.json \
SMOKE_EVIDENCE_OUT=/private/release-canary/factory-http-evidence.json \
node scripts/smoke-deployed.mjs http://127.0.0.1:3001
```

This branch uses sparse text and tracked formatting operations, durable receipt
recovery, stale-write rejection, genuine DOCX publication, checksum-verified
bytes, and cross-user document/artifact denial. It dispatches no provider effect
and preserves the disposable book for the Author browser check. Author may use
an operator-signed short-lived standard Auth.js fixture session with provider
`release-fixture` and username `release-canary-UUID`, mapping to the same exact
Factory identity. This proves production session/proxy validation and document
ownership, not an IAM password login. Existing IAM configuration and accounts
remain unchanged.

Complete the Author authenticated browser check, then tombstone the exact
fixture Book with a fresh operation UUID and its current Book/structure
preconditions while the grant remains valid. Preserve fixture users, originals,
revisions, audit rows, publication bytes and receipts; never call reset or delete
users. Reopen only the reviewed release, remove the temporary server reference
and grant copy, and retain the private operator evidence. The normal unfenced
native smoke negotiates document capabilities, creates its own disposable book,
uses the same structured checks and tombstones it while preserving its history.

## Installed consumer compatibility

Factory's CLI is the installed `dist/cli` of the candidate; the host has no
separate global `proser` binary to update. The legacy Hermes plugins on Nova and
agent-host remain independently staged installations. Update their source bytes
only at the reviewed release step, preserving environment, enablement and
runtime state (`--skip-env --no-enable --no-enroll`); do not restart an unrelated
agent or enable agent-host's currently disabled Proser plugin.

Nova's active Ardent adapter is separate from the legacy Python plugin. Its
Book reader consumes metadata/counts, and its Markdown artifact reader requires
the historical 64-hex content address with `artifactId === sha256`. The Factory
compatibility wrapper retains this address, while canonical publication APIs
use exact artifact UUIDs. Existing original Markdown manifests/bytes remain
checksum-verified owned immutable history after activation and subsequent
edits. If multiple canonical revisions share bytes, a checksum alias cannot
select provenance: it returns 409 and the exact canonical UUID is required.
Stateless generation-operation and workflow-finalize consumers retain their
existing tool names, resource fences and exact unknown-effect recovery. A parser
check using genuine isolated Factory responses does not prove live mission or
read-grant authorization; record these limits explicitly.

## Verified installed prerequisites

The 2026-10-06 release uses schema22, active reviewed enforcement and Node24.21.0.
The font installer requires `lbzip2` (or a tested compatible bzip decompressor)
before extracting the pinned DejaVu archive. Install the package-pinned Playwright
Chromium and its OS dependencies as operational prerequisites. The shared browser
path is `/opt/proser-factory/playwright-browsers`, installed for `service-account`; both
services retain `PLAYWRIGHT_BROWSERS_PATH`, `PUBLICATION_FONT_MANIFEST` and exact
`GIT_COMMIT` bindings. Use a service-owned log directory and enable API queue
readiness with `USE_BULLMQ=true` when the worker is configured.

A temporary grant requires traverse permission through its ancestor directory,
plus its owner-only service-user directory/file. At this release the ancestor
was root:swarmlord0750 and the grant directory/file swarmlord0700/0600. Remove
the grant reference and file after exact reopening, then verify runtime processes
and readiness. Preserve original env bytes privately.

The Author rollback guard refuses a checkpoint without its structured-document
contract when Factory authority is active or unknown. The first old-editor
checkpoint was tested and refused before any web-service stop. See the root
[release record](../../CANVAS_RELEASE_RECORD.md) for current production state.
