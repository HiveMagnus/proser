# R2 mobile and accessibility acceptance

## Current author decision: practical release gate

Revision campaigns require automated browser, keyboard, accessibility and exact
recovery checks. Run available actual screen-reader checks. The author explicitly
made unavailable physical-device and screen-reader certification nonblocking for
development and release. Such certification remains incomplete until supported
by actual candidate-specific evidence; automation does not certify devices or
assistive technology. R6 remains deferred. Earlier instructions below record
their original acceptance scope and do not reinstate a device release blocker.

R2 is active: the user revoked the earlier mobile/accessibility deferral. R6
reference-profile performance certification remains deferred. This record defines
R2 completion without changing the shipped R1/R3/R4/R5/R7 evidence or claiming
physical-device success from emulation.

An earlier user direction resumed the available iPhone Mirroring tests and deferred
VoiceOver or anything requiring the user's interaction until later. Those checks
remain part of complete R2 certification, with unavailable certification
nonblocking under the current practical gate. Mirrored native input and actual
phone Safari observations must retain their own scope; they do not establish
direct finger, microphone dictation or screen-reader behavior.

## Candidate and production boundary

Candidate tests cover authenticated editing and reading, desktop keyboard
navigation, formatting and tracked changes, safe stale-tab recovery, and exact
receipt recovery. The mobile Chromium and WebKit profiles are emulations.
Orca checks and physical-device observations require a compatible environment
and separate candidate evidence. Interactive IAM password sign-in and
Microsoft Word application acceptance remain outside the tested release scope.

## Finish criteria

R2 is complete only after the exact candidate passes every required row:

| Area                   | Required evidence                                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real phone editing     | Record physical model, OS/browser versions and input method. Edit Canvas continuity and semantic modes through real keyboard/touch; verify correct Unicode, styles, stable paragraph/run/table/cell/image identities, neighboring objects and canonical hashes after save/reload.               |
| Keyboard and viewport  | Verify software-keyboard appearance/dismissal, orientation, resize, scrolling, focus restoration and caret visibility without changing the target. Distinguish physical device checks from simulated viewport geometry.                                                                         |
| IME and dictation      | Real OS composition, cancellation and dictation commit exactly once to the original target. Check Unicode graphemes, soft/paragraph breaks, table cells and following typing. Injected browser events or a multiline `beforeinput` fixture alone do not certify OS IME or microphone dictation. |
| Touch selection        | Real successful selection, drag, cancellation, lost capture and mode switching preserve content and selection. Touch during composition cannot move its edit into another cell. Preserve ordinary mouse behavior.                                                                               |
| Assistive technology   | Use an actual screen reader to navigate headings/lists/tables/images, edit and format text, hear status/errors, switch modes and retain canonical selection/undo identity. Record generated speech and interaction evidence; axe or an accessibility-tree dump alone is insufficient.           |
| Recovery and ownership | Lost acknowledgements, backgrounding, offline return, navigation/reload, logout/account switch, local journal failure and stale revisions preserve exact owned drafts/receipts. A current edit is called Saved only after durable acknowledgement; unknown provider effects are not replayed.   |
| Reading                | `/m/read` preserves saved semantic features, exact scene/layout references and authenticated ownership. Typography affects display only; reading emits no document mutation and retains at most three scene bodies.                                                                             |
| Release                | Root/component gates, fork/contract checks, authenticated disposable acceptance, native Author deployment, installed revision/digests and live preservation pass. Retain receipts and tombstone fixture books with their history.                                                               |

Preserve `/m`, `/m/studio`, `/m/read` and the desktop override throughout. Factory
owns revision-safe mutations; Author uses relative `/api/*` proxy requests. Run
DB-backed tests only against explicitly isolated PostgreSQL/Redis and disposable
fixtures. Word-specific and normal IAM password-login acceptance remain separate.

## Reproduce supported checks

Use the pinned Node `24.22.3`, independent Factory npm and Author pnpm `12.16.1`
installs. Native mobile fixtures run with `npm run test:canvas-mobile`; the ordinary
Canvas compatibility corpus runs with `npm run test:canvas`.

The default authenticated application gate is
`node scripts/run-document-release-workspace-smoke.mjs`. It includes the seven reusable R2 checks in
`scripts/test-r2-authenticated-workspace.mjs`, two Quick Draft checks and four
normal Book catalog/first-scene checks in `scripts/test-r2-book-catalog.mjs`. Point it explicitly at a fresh
synthetic `proser_canvas_release_*` PostgreSQL database on loopback port `55441`
and isolated Redis on `56441`, with the pinned compiled candidate and publication
font manifest. The runner owns local Factory/Author services and disposable
fixtures; it preserves receipts and tombstones fixture books. Lost-acknowledgement
coverage aborts only the response after observing Factory commit, then reloads
and recovers the exact original receipt while asserting one mutation POST.
`PROSER_RELEASE_R2_WORKSPACE_ONLY=true` selects the focused seven-check fixture for
iteration; `PROSER_RELEASE_R2_BOOK_CATALOG_ONLY=true` selects the four catalog
checks. Neither replaces the default full release gate.

The actual Orca harness is `scripts/test-r2-orca-session.py`, using an isolated
X11/DBus/AT-SPI session and extracted dependencies under ignored
`output/playwright/r2/orca/runtime`. `scripts/test-r2-orca-prepare.py` records
package digests without installing global desktop packages. Choose a new unique
output path for each run; never overwrite a retained receipt or change the user's
active desktop accessibility settings.

Apple's supported physical Safari route uses the connected Mac's `safaridriver`
and `platformName: iOS`. Device Web Inspector and Remote Automation must be enabled
before creating an isolated automation session. [Apple setup requirements](https://developer.apple.com/documentation/safari-developer-tools/ios-enabling-webdriver),
[isolated WebDriver sessions](https://developer.apple.com/documentation/safari-developer-tools/webdriver/).
An automation screenshot or keyboard command does not prove VoiceOver or dictation;
[Apple's VoiceOver test service](https://developer.apple.com/documentation/xcuiautomation/xcuivoiceoverservice)
requires the compatible test environment. Do not change permissions or provisioning
to bypass a failed precondition.

## Completion record still required

Use a newly named disposable acceptance book on the exact candidate. Record
physical touch and typing, software keyboard and viewport recovery, scene and
paragraph identity, actual VoiceOver speech, and OS IME and dictation. Preserve
the resulting receipts privately. The practical release gate continues to apply
while physical-device or screen-reader certification is unavailable.
