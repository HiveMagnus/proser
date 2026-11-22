# Canvas release finish criteria

Completed selected release: R1, R3, R4, R5 and R7 shipped from the backlog. The user
skipped R2 and R6 for that release. R2 is now active after its deferral was revoked;
R6 remains deferred. Current R2 criteria/evidence are in
[CANVAS_R2_ACCEPTANCE.md](CANVAS_R2_ACCEPTANCE.md). The earlier checkpoint's
stopping condition is historical; neither certification track is marked passed.

## Scope

- [x] Complete ordered bounded scene transport and authoritative operation receipts.
- [x] Integrate Canvas/semantic editing, formatting/tables/owned images, durable
      autosave/recovery, conflicts and complete revision undo.
- [x] Complete bounded chapter/book windows and atomic cross-scene history/editing.
- [x] Complete bounded AI draft/selection context, tracked proposals, cancellation
      and workflow verification/publication parity.
- [x] Verify supported native Word review/import fidelity and genuine immutable
      exports through the existing publication pipeline.
- [x] Prove all-writer ownership/CAS guards, complete restoration and release fences.

## Verification and production finish

- [x] Fresh frozen installs, generated types/API/fork provenance and root gates pass.
- [x] Authenticated isolated editor/recovery/conflict/review/export tests pass.
- [x] Candidate-specific current-schema/enforcement procedure reviewed; backup/backfill
      twice and second restore preserve IDs/content/originals/history/assets.
- [x] Fence/drain/recover exact operations without replaying unknown providers.
- [x] Deploy the selected supported stack, activate compatible authority/Canvas,
      verify runtime/digests, all three services, readiness/worker/proxy/assets.
- [x] Authenticated disposable editing/publication canaries and recovery drill pass;
      reconcile production preservation and remove replaced legacy paths.
- [x] Update operating docs, merge the tested release into main, commit/push and
      verify the installed and remote revisions.

## Historical deferral and current acceptance

R2's complete device/touch/screen-reader certification and R6's 50k/150k/300k
reference-profile performance acceptance were deferred for this completed release.
R2 is now active, with exact-candidate physical-device and assistive-technology
requirements in the R2 record; R6 remains deferred.
Preserve existing mobile routes and run basic compatibility checks. Keep bounded
loading/correctness checks needed by editor behavior. Report deferred criteria
honestly; do not label them passed. Exact Microsoft Word behavior remains unverified
until the user's separate Computer Use acceptance.
