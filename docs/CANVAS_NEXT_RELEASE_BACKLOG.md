# Canvas modernization: remaining backlog

## Current author decision: practical release gate

Revision campaigns require automated browser, keyboard, accessibility and exact
recovery checks. Run available actual screen-reader checks. The author explicitly
made unavailable physical-device and screen-reader certification nonblocking for
development and release. Such certification remains incomplete until supported
by actual candidate-specific evidence; automation does not certify devices or
assistive technology. R6 remains deferred. Earlier instructions below record
their original acceptance scope and do not reinstate a device release blocker.

R1/R3/R4/R5/R7 shipped through the native deployments on October 6, 2026.
The subsequent selection-freeze and writing-controls releases are deployed too.
See the [release record](CANVAS_RELEASE_RECORD.md) and
[mandatory outcome ledger](CANVAS_MODERNIZATION.md).

The user has reopened R2 mobile/accessibility certification and revoked its
previous deferral. R6 performance certification remains deferred. Track the exact
candidate and open physical-device requirements in
[the R2 acceptance record](CANVAS_R2_ACCEPTANCE.md). Shipped implementation and
historical release observations remain separate from current certification.
Revision campaigns retain owned review snapshots, tracked application and exact
receipt recovery. See the [campaign guide](../ProserAuthor/docs/REVISION_CAMPAIGNS.md)
and [release record](CANVAS_RELEASE_RECORD.md) for scope and certification limits.

## R2 — Active: mobile/accessibility certification

The user has resumed the available iPhone Mirroring checks and explicitly
deferred VoiceOver and any check requiring their interaction until later. This
includes microphone dictation, direct finger interaction, device orientation and
settings/login changes that need their help. Run available mirrored
editing, save/reload, navigation and preservation checks when accessible; unavailable
evidence remains incomplete for full R2 certification and does not block development
or release under the current practical gate.

Complete actual-device and assistive-technology acceptance on the exact candidate:

- Physical iPhone project and first-scene creation, Canvas and semantic
  save/reload, touch selection, software-keyboard/viewport behavior, orientation,
  real OS IME, microphone dictation and focus recovery. Preserve `/m`,
  `/m/studio`, `/m/read` and the desktop override.
- Refresh actual Orca checks and capture VoiceOver speech and interaction
  evidence when available. Exercise both editing modes, including images,
  tables, headings, protected objects and stable selection/undo identities.
- Physical interrupted saves, offline return, navigation/backgrounding,
  logout/account changes and exact operation recovery on the documented devices.
- Sanitized semantic reading preserves document features and never writes back.

Finish with recorded device, accessibility and recovery evidence on the exact
released candidate. Chromium/WebKit emulation covers the current revision. The
earlier Linux Orca semantic-fixture checks and October 14 campaign Axe and
real-model results retain their original scope.

### Earlier device and browser evidence

User-approved Computer Use accessed
the mirrored physical iPhone and authenticated Safari. Physical saved-text scene
and chapter navigation passed; ordinary project creation exposed a missing
operation-ID precondition. That bug and revision-safe project details/removal and
first-scene creation were fixed in Author the archived candidate, whose production
project-management and manuscript/publication canaries passed 4 and 13 checks.
The physical session exercised the preceding release and ended when the Mirroring
window disappeared. No physical book or body mutation was created, and no input
was replayed. WebDriver still needs device Web Inspector/Remote Automation.
VoiceOver, real device IME/dictation and candidate editing/recovery acceptance
remain open; old-production navigation does not mark R2 passed.

After Mirroring was reopened, screenshots were available but native click input
returned `noWindowsAvailable` before and after the supported window Raise action.
The session stopped without creating a fixture or editing a document. All 732
preexisting rows across 14 checked tables remained unchanged. The cached reader's
application version was not independently verified because reload was unavailable.
Physical input acceptance remains blocked; user-assisted checks stay deferred.

A separate keyboard path successfully focused Safari's address field and loaded
authenticated Proser. The New Project pointer action remained unavailable and a
Find shortcut returned Home, so no form was submitted. Keyboard navigation is
verified separately from still-incomplete editing; all 821 rows in its later
14-table baseline remained unchanged. The final 25/7 acceptance tooling passed
all six CI jobs; one failed low-level mobile-browser job passed a bounded rerun,
with the original closure failure retained and its cause unresolved.

The seven-check WebKit workspace gate covers
history, semantic preservation, interrupted saves, offline draft recovery and
reading. CI runs it and the two Quick Draft checks on separate fresh databases
and Redis indexes.
Mixed keyboard/mouse/synthetic workspace input remains distinct from the touch
emulation used for Quick Draft and from physical iPhone certification.

## R6 — Deferred: performance certification

Measure 50k/150k/300k manuscripts on documented desktop/mobile profiles, including
giant scenes/paragraphs, review histories and object-heavy documents.

Require usable editing within three seconds, warm navigation within one second,
and typing p95 below 50 ms desktop / 100 ms mobile. Record fetched bytes/scopes,
memory, save latency, layout stalls and publication duration alongside exact
preservation and rendered-page inspection. Run all six profiles against the exact
candidate; historical stress results and bounded correctness checks do not certify
later source performance.

## Separate verification

- **Microsoft Word:** Computer Use acceptance of supported native insertion,
  deletion, paragraph/formatting revisions, classic comments, attribution and
  accept/reject round trips. LibreOffice/XML success remains independent evidence.
- **IAM login:** record the normal Magnus IAM login path; release fixtures prove
  session/proxy behavior and ownership but do not verify password login.

## Current upstream status

Checked upstream GitHub and npm on November 21, 2026.

- Table identity [PR 1492](https://github.com/Hufe921/canvas-editor/pull/1492)
  merged as `71aa0996c2d4c827ec5d86d9acee80eb0a3f98a4`.
  Upstream npm `@hufe921/canvas-editor` 1.2.0 has git head
  `9c4cfae7519ec9bddb069794577e732b2d4f25dd`, which
  [descends from the merge](https://github.com/Hufe921/canvas-editor/compare/71aa0996c2d4c827ec5d86d9acee80eb0a3f98a4...9c4cfae7519ec9bddb069794577e732b2d4f25dd).
- Optional DOCX download [PR 45](https://github.com/Hufe921/canvas-editor-plugin/pull/45)
  merged as `0e8a1b36c8e94061edc19ce05b93c12fbad03b34`.
  Upstream npm `@hufe921/canvas-editor-plugin-docx` 1.0.0 has git head
  `4741a9f8885d57fde1704d39a7aa930aeadc51e6`, which
  [predates the merge](https://github.com/Hufe921/canvas-editor-plugin/compare/4741a9f8885d57fde1704d39a7aa930aeadc51e6...0e8a1b36c8e94061edc19ce05b93c12fbad03b34).
  Publication of the merged behavior in that upstream package remains open.
- Headless Word exchange [PR 46](https://github.com/Hufe921/canvas-editor-plugin/pull/46)
  closed without merging on November 18. Proser uses the shared
  `@hivemagnus/canvas-word-engine` 1.2.2 (published from `ChefTaco/canvas-word`
  commit `47a7b3dcfa79d38e489e171ee36f359ede9c2d8d`) and
  `@hivemagnus/canvas-word-codec` 1.1.0 (commit
  `8116514eb8d5b536ca639f30d9f0101f1394e251`).

### Earlier maintenance releases

The hygiene release deployed Sharp 0.35.5 and interrupted-save recovery.
The October 12 catch-up deployed maintained core `1.0.5-proser.1`
and codec `1.0.0-proser.3`. Its 12 Factory and 17 Author checks passed,
and the preservation comparison verified 1,591 existing rows across 14
tables. The earlier identity release adopted PR 1492 behavior as
`1.0.4-proser.4`. Keep those results attributed to their releases. See the
[release record](CANVAS_RELEASE_RECORD.md) and
[maintenance record](../ProserAuthor/docs/CANVAS_MAINTENANCE.md).

## Ongoing maintenance

- Keep generic core/codec fixes separately reviewable and propose them upstream.
  Track checked upstream commits, fixture coverage and actual submission status
  in [the maintenance record](../ProserAuthor/docs/CANVAS_MAINTENANCE.md).
- Review upstream monthly and advisories continuously. Change package pins only
  after the compatibility corpus passes; retain exact license/SBOM provenance.
- Keep current release status separate from archived checkpoint observations.
- Retain release evidence before pruning temporary diagnostics. Preserve originals,
  uncertain operations, artifact history and production checkpoints.

## Completed release scope

R1 delivers structured single-scene writing and all-writer guards; R3 delivers
bounded chapter/book windows, adjacent edits and scope history; R4 delivers
AI/editorial/workflow integration; R5 delivers safe imports and genuine publication;
R7 delivers the reviewed production transition, preservation/recovery and retirement
of obsolete surfaces. Their release conditions are checked in
[CANVAS_RELEASE_CHECKLIST.md](CANVAS_RELEASE_CHECKLIST.md).
