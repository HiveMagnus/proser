# Canvas modernization delivery ledger

The selected R1/R3/R4/R5/R7 modernization release is deployed. Structured
Factory authority and database enforcement are active; Author uses bounded
Canvas and semantic editing. Tiptap, plain-text writing conversions and misleading
exporters are retired. Subsequent Author releases repaired native selection
freezes and formatting controls.

The [public release record](CANVAS_RELEASE_RECORD.md) describes the shipped scope.
The [backlog](CANVAS_NEXT_RELEASE_BACKLOG.md) tracks remaining work.

## Mandatory outcomes

Mandatory scope continues to include all-writer routing, complete workspaces,
AI/import/publication integration, performance testing and production transition.
The user has reopened R2 device/accessibility certification; its earlier deferral
applied to the selected release. R6 performance certification remains deferred.
Neither scoped browser evidence nor release hygiene completes R2 or the separate
Microsoft Word acceptance. Current R2 criteria and evidence are in
[CANVAS_R2_ACCEPTANCE.md](CANVAS_R2_ACCEPTANCE.md).

| Required area                  | Delivered outcome                                                                                                                                                                                                                                    | Remaining acceptance                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| All writers                    | Desktop/mobile, structural editing, generation, compare cards, editorial/workflows, CLI/Hermes, imports and backfills use structured authority, revision guards and resource fences. Complete restoration and database enforcement passed rehearsal. | Maintain writer inventory and stale-write regressions when adding consumers.                                 |
| Complete workspaces            | Desktop, scene/chapter/book windows, semantic editing, basic mobile routes, stable selections, typed operations, scope undo, autosave/recovery and explicit conflicts are delivered.                                                                 | R2 is active: actual-device, touch, IME/dictation and screen-reader certification remains open.              |
| AI integration                 | Durable discussion/proposals, disclosed bounded context, exact identity/text/style/object targeting, tracked application, cancellation/recovery and authorized workflow/Quality Lab integration are delivered.                                       | Preserve independent quality/publication approval and unknown-effect recovery gates.                         |
| Import/publication integration | Originals and loss consent, bounded safe conversion, supported native review, genuine immutable formats, ownership, fidelity reports and independent structural/rendering checks are delivered.                                                      | Microsoft Word-specific acceptance remains unverified.                                                       |
| Performance                    | Bounded transport and large-manuscript preservation/correctness checks pass, including a 300,000-word single-paragraph fixture.                                                                                                                      | R6: six reference-profile 50k/150k/300k performance runs remain deferred.                                    |
| Production transition          | Runtime/security/provenance, readiness, idempotent backfill, two restores, reviewed enforcement, admission/recovery, authenticated canaries and source retirement are delivered.                                                                     | Continue candidate-specific release/recovery gates. Real IAM password-login verification remains unrecorded. |

## Defined finish criteria still open

- **R2:** actual desktop/mobile devices and assistive technology pass editing,
  selection, protected-object preservation, IME/dictation, orientation/keyboard,
  focus and interrupted-operation recovery checks on the exact candidate.
- **R6:** desktop/mobile 50k/150k/300k profiles meet usable editing within three
  seconds, warm navigation within one second and typing p95 below 50 ms desktop /
  100 ms mobile. Retain memory, fetched bytes/scopes, save latency, layout stalls
  and publication duration with preservation evidence.
- **Microsoft Word:** use actual Word to verify supported native revisions,
  comments, formatting and accept/reject round trips. LibreOffice and native XML
  success do not certify Word behavior.
- **IAM login:** record the normal Magnus IAM login path. Existing release
  canaries prove encrypted sessions, proxy authentication and ownership using
  disposable signed fixture sessions.

R2 is active after the user revoked its deferral. R6 remains deferred. The earlier
selected release activated with both tracks deferred; that historical decision
is preserved. Current R2 cannot be certified until its physical-device,
assistive-technology and recovery criteria pass. Do not reopen the old editor
against active structured data.

## Maintenance

Keep exact fork pins, rebuilt distributions, embedded-dependency SBOMs and notices.
Propose generic fixes upstream after independent fixture validation; upstream
acceptance does not control local releases. Review upstream monthly, security
advisories continuously and the full compatibility corpus before changing pins.
See [Canvas maintenance](ProserAuthor/docs/CANVAS_MAINTENANCE.md).

Retain immutable originals, receipts, historical hashes, uncertain provider
outcomes and production checkpoints. Temporary diagnostics can be pruned only
once release evidence is retained and no active process uses them. Cleanup never
changes databases, manuscript assets, publication history or operation journals.
