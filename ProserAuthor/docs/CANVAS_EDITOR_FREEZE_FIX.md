# Canvas selection freeze hotfix

The initial Canvas release could become unresponsive when the author selected
text. Playwright reproduced this on a disposable book: double-clicking the first
word timed out, and a subsequent page evaluation could not complete.

The passage workspace created a fresh page-layout object on each selection
render. Canvas treated its identity as a changed layout and reconstructed the
editor. Restoring the selection emitted another selection event, causing the
same cycle. Header/footer and front/back matter editors had the same layout
allocation pattern.

The workspaces now memoize their derived page settings. The React Canvas adapter
also compares the effective layout, named styles, and displayed stories by their
canonical values. Equivalent save acknowledgements retain the native instance,
selection, and active input composition. Actual page, style, story, mode, and
window changes still update the editor; body content continues through the
separate controlled-document synchronization path.

The regression suite covers selection/status renders, equivalent acknowledgements
during composition, changed page dimensions, and changed style/story data. The
authenticated Playwright release suite additionally double-clicks actual Canvas
text, verifies a usable anchored selection, types into it, checks exact saved
text and Canvas identity, reloads, and applies native formatting. Its prior
semantic-mode editing checks and bounded-loading checks remain intact.

Use isolated PostgreSQL `127.0.0.1:55441/proser_canvas_release_*` and Redis
`127.0.0.1:56441` for the root gates and authenticated browser runner. Never run
database-backed tests against production manuscripts. Browser evidence belongs
under ignored `output/playwright/` directories; sessions and credentials remain
private and are removed after testing.

This is an Author-only hotfix. Deploy through the native Author script with
release ID `canvas-freeze-20261006`; its retained code checkpoint and `REVISION`
record the exact installed commit. Factory authority, stored manuscripts,
authentication configuration, and provider connections require no change.
R2 device/accessibility and R6 reference-profile certification remain deferred.

Validation on October 6 passed all root format, lint, type, test, build and audit
gates: Factory 902 tests; Author 353 web, 90 editor, 206 contract and 14 core tests;
both production audits reported zero vulnerabilities. The expanded authenticated
Playwright runner passed all nine checks against a fresh synthetic database,
including native selection, exact typing/save, preserved Canvas identity through
acknowledgement, reload and formatting. Its writing surfaces made no full-scene
document reads; the largest passage response was 11,375 bytes. The disposable
book was tombstoned, with its operation history retained.
