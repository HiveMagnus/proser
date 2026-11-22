# Reviewed release admission and exact recovery

The release barrier is PostgreSQL authority, not an environment flag, header,
filesystem switch or user-provided operation token. Migration
`20261005220000_release_admission_fence` installs an **open** singleton and
additive admission/transition/binding evidence. This support does not close live
traffic, activate document enforcement or authorize a production release.

`deploy/document-authority/enforcement.sql` now protects immutable release facts
and restricts fence updates to the local, candidate-bound operator transaction.
Privileged database owners can change SQL or role privileges; retain and review
those grants. The conservative deployment classifier still rejects this SQL.

Migration `20261005230000_legacy_schema_alignment` is also **outside** the
additive subset. It aligns only three known browser-run foreign-key identities,
the existing unique source-cutover receipt index and three known timestamp
column defaults. It changes no manuscript/history rows. Unknown metadata fails
visibly. Do not rewrite earlier migrations, execute Prisma's destructive diff,
relax the classifier or label this candidate additive. The reviewed schema path
must rehearse the exact candidate on both a fresh database and an original
production-backup restore, prove empty Prisma diff, then prove a second restore.

## Admission and recovery behavior

All HTTP mutation methods close, including misleadingly mutating GET/HEAD book
exports. Factory authenticates ordinary mutations before recording an actor-bound
admission. Central canonical/new-book/asset transactions, fresh provider sends,
workflow starts/claims, queue outbox/recovery and generation creation/claims have
source guards. Read-only document/revision/receipt/original/proposal/artifact
reads remain owned and accessible. Authentication sync and the four narrow
read-grant refresh endpoints remain available. Owner-requested cancellation of
an exact validated existing UUID remains available; resume, apply, regeneration,
new imports and new renders remain closed. The release tool never cancels work.

Already accepted exact transactions/render completion may finish under their
original trusted admission, ordinary ownership/source CAS/resource/workflow
leases and publication gates. That admission does not authorize another provider
send after cutoff. Provider admissions are bound to their exact journal and
source revision/hash. Admission facts alone do not prove provider completion.
If an entire journaled effect has made zero provider dispatches, a refused send
can return to its original pending operation. Any earlier nested dispatch makes
the outcome uncertain and must retain exact unknown recovery. The tool never
replays provider requests, extends deadlines or promotes uncertain output.

The known BullMQ queues are `book-workflow-v1` and `live-prose-judge`. Queue
claims racing a closed fence move to delayed without consuming a delivery
attempt. Existing active workflows refused a fresh effect pause with retained
IDs/source/deadlines. The separate API-host generation supervisor stops both
claiming and expiry while closed. Release holds restore original pending and
absolute deadlines, and normal reopening may find a deadline already expired.

## Operator commands

Run from Factory with its pinned Node runtime and explicit intended database
and Redis configuration. `status`, `preview` and commands without `--apply`
are read-only. Keep records private (`--out` writes a new 0600 file; never
commit the file). No command defaults to closing admissions or deploying.

```bash
node_modules/.bin/tsx scripts/release-admissions.ts status --out /absolute/private/status.json
node_modules/.bin/tsx scripts/release-admissions.ts preview --out /absolute/private/preview.json
node_modules/.bin/tsx scripts/release-admissions.ts drain --max-ms 10000 --out /absolute/private/drain.json
```

Inventories have independent admission, binding, domain and Redis cursors:
`--cursor`, `--binding-cursor`, `--domain-cursors '{"operators":"UUID"}'` and
`--redis-cursor`. Complete every cursor page. Domain pages also retain cancelled
or failed provider-started records with no known result. Redis SCAN reads only
metadata, including retained failed operations, never requests/manuscripts;
repeat full scans after cutoff. SQL and Redis observation times are separate.
A stable page, empty active queue or known HTTP acknowledgement cannot settle an
unbound/unknown provider effect. Retain its exact ID, source, status and recovery
path in the reviewed handoff.

Close/reopen require `--apply`, exact operation/release UUIDs, expected fence
generation, clean candidate Git SHA, proof file and its SHA256. Reviewed proof
has `schemaVersion:1`, exact release/candidate/database, explicit reviewed actor
and allowed actions, enforcement SQL SHA256, compatible checkpoint revision,
backup/restore evidence SHA256 and installed fence-support proof. Production
proof requires the exact clean Git checkout; isolated proof is restricted to
`127.0.0.1:55441/proser_canvas_*`. Proof is never accepted from an HTTP request.

```bash
node_modules/.bin/tsx scripts/release-admissions.ts close --apply \
  --operation-id UUID --release-id UUID --expected-generation 0 \
  --candidate-sha FULL_SHA --proof-file /absolute/private/proof.json \
  --proof-sha SHA256 --out /absolute/private/close.json
```

Recover a lost acknowledgement with the **same** operation ID and exact request.
The immutable receipt contains the previous queue pause states. A failure
pausing Redis leaves the DB barrier closed; repeat that exact transition to
finish the idempotent pause. Reopening resumes only queues this release paused;
pre-existing pauses stay paused. An old close receipt recovered after a later
reopen does not pause queues again. Concurrent/operator queue intervention needs
explicit reconciliation; SQL and Redis are not one atomic transaction.

## Candidate-specific release handoff

The executable first-transition path is documented in
[Canvas reviewed native release](CANVAS_REVIEWED_NATIVE_RELEASE.md).
`deploy-to-proser.sh --document-release-proof /private/proof.json` verifies the
closed SQL closure and fresh private preservation evidence, then installs schema
and inactive enforcement with both services held stopped. It does not relax the
normal additive classifier or activate authority.

First install compatible fence support through the reviewed native schema path
with API/worker stopped, or use stopped services as the actual admission boundary
until installed support is proved. Never claim old deployed code is fenced by a
new local receipt. Preserve Redis preflight, native Factory/Author independence,
`/opt/proser-factory` and `/opt/proser-v2`.

For the reviewed candidate: close exact admissions, observe active work draining,
complete all inventory pages twice, and retain known held/unknown effects with
exact recovery paths. Rehearse preservation/backfill/enforcement/second restore,
prove candidate/renderer/fonts/client capabilities, and obtain the concrete
release approval required by the candidate-specific native procedure. This
implementation does not bypass the conservative migration classifier. Keep
writes fenced during replacement or backup restore. Reopen only the exact
reviewed installed compatible release after authenticated recovery/canary proof.
Post-backup revisions/artifacts need reconciliation before any database restore.

No live close, activation, schema change or deploy is evidence from isolated
fixtures. Microsoft Word behavior remains unverified until separate Word tests.

## Fenced maintenance

The same reviewed close proof may contain explicit maintenance entries with
`action`, Factory `userId` and at most 100 owned `bookIds`. Exact raw proof bytes,
SHA256, candidate, release and current generation must match the closed fence.
The only actions are `backfill-document-authority`, `register-selected-artwork`,
`recover-search-index` and `verify-document-bridge`. Artwork registration also
requires both application and SQL document enforcement to remain inactive.

```bash
node_modules/.bin/tsx scripts/release-admissions.ts maintenance --apply \
  --maintenance-action backfill-document-authority --user-id FACTORY_USER_ID \
  --book-ids BOOK_ID,ARCHIVED_BOOK_ID --operation-id UUID --release-id UUID \
  --expected-generation CLOSED_GENERATION --candidate-sha FULL_SHA \
  --proof-file /absolute/private/proof.json --proof-sha SHA256 \
  --out /absolute/private/maintenance.json
```

Maintenance mints an immutable action/book-scoped admission and completed
receipt. It cannot authorize a generic body/catalog transaction, new book,
provider dispatch, HTTP request or workflow. Ownership is checked for every
explicit active/archived book; archived lifecycle/IDs and exact null/empty
originals remain preserved. Only fixed operator methods can consume its context.
Changing scopes, proof bytes or generation fails before work. After a lost
acknowledgement, recover the same maintenance ID; the underlying backfill and
create-only index operations verify existing evidence idempotently. Partial or
unknown outcomes retain admissions and per-book revision bindings, and must not
be treated as complete before exact receipt/evidence recovery. No provider is
called by maintenance. Ordinary HTTP recovery reads and cancellation remain
available throughout.
