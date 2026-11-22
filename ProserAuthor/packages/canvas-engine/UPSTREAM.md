# Maintained Canvas source

MIT source from `Hufe921/canvas-editor`, synchronized through commit
`71aa0996c2d4c827ec5d86d9acee80eb0a3f98a4` as maintained version
`1.0.5-proser.2`. Published 1.0.5 has base commit
`f8435acb98badcc831174055e9001d42fe51bb0f`; the source pin also includes merged
PR 1492, which is not yet verified in a published upstream package.
The upstream license is retained. Runtime has no third-party package dependencies.
Build tooling is development-only. Proser application code lives outside this fork.

The complete runtime source delta from the original 1.0.4 base
`9af964c2f920da1fcc7d541fae4ab781fcd3bf02` is integrated, including incremental
row computation, per-control background properties, disabled-history allocation,
caret toggles, issue 1489's selection anchor/table-crossing/scroll fixes and opt-in
table identities. The patch entries below retain their original development bases;
they describe the local differences carried onto the current source pin. Caret
underline inheritance, paragraph geometry and canonical identity/history rules
remain local. Current build tooling follows upstream TypeScript 6/Vite/Vitest pins.

Version `1.0.5-proser.2` refreshes Vite, Vitest and the CSS injection helper.
The build manifest reads the package version directly. Runtime editor sources
and upstream source snapshots retain their previous behavior and provenance.

## Patch 1: serialized object identity

Retain element, table row and cell IDs only when the caller requests
`getValue({ extraPickAttrs: ['id'] })`; default serialization and internal
clipboard data strip them so pasted objects receive fresh identities. Extra cell
attributes cannot overwrite recursively serialized `value`. Application saves
explicitly opt in; paragraph/run identity remains extension metadata and Canvas
positions are never persistence identities.

Adopted the merged behavior of
[PR 1492](https://github.com/Hufe921/canvas-editor/pull/1492), merge commit
`71aa0996c2d4c827ec5d86d9acee80eb0a3f98a4` (October 12, 2026), as
`1.0.4-proser.4`. This is a targeted source port against the retained 1.0.4 base,
not an upgrade to the upstream npm distribution. The ten upstream regression
cases are adapted for local text-glyph identities; native browser fixtures cover
synchronous/worker serialization, real clipboard repeated paste, undo/redo,
independent pasted-cell targeting and editor recreation. Proser's other patches
remain local and the MIT license is retained.

This earlier targeted port is retained in the full `1.0.5-proser.1` source sync.

## Patch 2: identity before history

Assign persistent generic element IDs during expansion and insertion, before
history captures them. The application adapter uses these as deterministic
fallbacks for new runs and paragraph fragments. IDs are excluded from input's
style-copy attributes. Fixtures cover repeated serialization, insertion,
paragraph splitting and undo/redo. Upstream status: not submitted; touch, paste
and the full compatibility corpus remain required before an upstream proposal.

## Patch 3: Unicode search boundaries

Map search UTF-16 and case-fold expansion offsets to runtime grapheme elements.
Reject partial grapheme matches, preserve text following the final table and use
the cursor-before-selection range convention. The Chromium fixture covers
repeated quotations, emoji/combining characters, table-cell ownership and search
navigation. Upstream status: not submitted. Base commit remains
`9af964c2f920da1fcc7d541fae4ab781fcd3bf02`.

## Patch 4: disable native history allocation

`historyMaxRecordCount: 0` opts out of cloning body/header/footer runtime elements
for native undo snapshots. Positive counts preserve upstream behavior. This
allows callers with an external operation journal to avoid a second authority
and duplicate per-keystroke memory/serialization work. Content-change events
continue to fire. The Chromium fixture checks insertion, native undo remaining
disabled and explicit restoration retaining canonical identity. Proser's scene
and atomic window journals are tested separately outside the fork. Upstream
status: merged October 7, 2026 in [PR 1488](https://github.com/Hufe921/canvas-editor/pull/1488). Original development base is
`9af964c2f920da1fcc7d541fae4ab781fcd3bf02`.

## Patch 5: coalesce externally owned glyph runs

During text serialization, differing runtime glyph IDs do not prevent merging
fragments with the same nonempty `externalId`. The first glyph ID is retained;
distinct external IDs, styles, traces and extension metadata remain distinct.
Unbound explicit IDs keep their original separation. This avoids exporting one
record per character for callers whose external IDs represent stable text runs.
Unit and native Chromium fixtures cover compact serialization, snapshot
isolation, formatting/trace boundaries, table identities, reopening and history.
Upstream status: not submitted. Base commit remains
`9af964c2f920da1fcc7d541fae4ab781fcd3bf02`.

## Patch 6: expanded runtime query for selection

Expose a cloned current-container element list to calculate transient render
ranges from external identities. The query mutates no editor state and returns
no application-specific schema. Persistence and selection revalidation remain
in the adapter outside the fork. Upstream status: not submitted. Base commit
remains `9af964c2f920da1fcc7d541fae4ab781fcd3bf02`.

## Patch 7: focus input within pointer activation

Focus the input agent synchronously during an editable canvas click on every
platform. Deferred cursor drawing previously left desktop clicks without an
active input target and dropped the first typed characters; iOS alone had a
synchronous click handler. The controlled React Chromium fixture clicks and
immediately types three repeated markers, then verifies every character and
exact original text after removing the insertion. This also keeps touch keyboard
activation inside a trusted event. Upstream status: not submitted. Base commit
remains `9af964c2f920da1fcc7d541fae4ab781fcd3bf02`.

## Patch 8: serialize compact snapshots and reuse basis font metrics

Coalesce shallow element records before cloning the complete serialized snapshot;
copy table row/cell arrays before conversion so runtime topology is untouched.
Only retained package attributes and application metadata enter the clone, with
snapshot mutation isolation preserved. Reuse basis glyph metrics by the computed
CSS font, avoiding repeated context save/font/restore work for every glyph. Core
unit fixtures cover nested table snapshots and independent font sizes; native
Chromium covers formatting, comments/review preservation, reopening and history.
The controlled React corpus also runs with optional four-times CPU throttling
and exports a CDP profile via `PROFILE_CANVAS=1`. Upstream status: not submitted.
Base commit remains `9af964c2f920da1fcc7d541fae4ab781fcd3bf02`.

## Patch 9: stable external bindings, native focus and touch selection

Expose an application-neutral command to bind freshly created glyph spans to
external run metadata without resetting content or submitting native history.
Validate all spans before mutating any, including table-cell containers and
grapheme-relative offsets. Keep paragraph sentinels separate while compacting
runs. Explicit focus commands now focus the input agent synchronously and retain
provided ranges. An opt-in touch selection command captures pointer drags on the
canvas without replacing normal page scrolling outside selection mode. Native
Chromium covers typing, paragraph split/join, mode switching, IME composition,
and CDP touch drag against canonical identities. Upstream status: not submitted.
Base commit remains `9af964c2f920da1fcc7d541fae4ab781fcd3bf02`.

## Patch 10: visual image fitting preserves serialized dimensions

Fit oversized inline images through row metrics instead of mutating their stored
width and height during layout. Image drawing and resize handles use the fitted
width and preserve aspect ratio; explicit resizing still changes dimensions.
The native Chromium fixture fits an oversized canonical inline image and checks
its exact serialized identities, dimensions and digest after layout. Upstream
status: not submitted. Base commit remains
`9af964c2f920da1fcc7d541fae4ab781fcd3bf02`.

## Patch 11: literal zero-width space preservation

Use U+0000 as the transient paragraph sentinel instead of U+200B. Proser's
canonical validator forbids NUL in saved text, so legitimate zero-width spaces
retain their exact content and UTF-16 offsets. Serialization translates only the
internal sentinel to a newline. Worker catalog/count implementations use the
same sentinel; text metrics treat it as zero-width and drawing never paints it.
The native Chromium fixture covers literal U+200B reopening, exact search and
selection, replacement input and undo after caret placement. The core unit
fixture separately checks sentinel serialization and literal text. Base commit:
`9af964c2f920da1fcc7d541fae4ab781fcd3bf02`; upstream status: not submitted.

## Patch 12: native hyperlink navigation and visual defaults

Guard popup anchors and native open actions before application serialization.
Reject active protocols and control-character obfuscation; allow HTTP(S), mailto
and relative web navigation with explicit opener/referrer protection. Hyperlink
painting now resolves inherited color and underline without mutating stored
formatting. Range reporting and underline commands use the same inherited rule.
Pure URI fixtures and native Chromium cover unsafe popup/action paths, safe
opener protection and exact serialization of links without explicit styling.
Base commit remains `9af964c2f920da1fcc7d541fae4ab781fcd3bf02`;
upstream status: not submitted.

## Patch 13: visible selection controls formatting toggles

Ignore internal paragraph sentinels when deciding bold, italic, underline and
strikeout toggles over selected visible content. Keep sentinels in the actual
formatting operation so insertion defaults stay consistent; selections containing
only blank paragraph markers retain their existing behavior. Pure fixtures cover
visible, mixed and blank-only selections. Native Chromium covers leading-marker
selection on inherited heading/character styles and explicit overrides. Base
commit remains `9af964c2f920da1fcc7d541fae4ab781fcd3bf02`;
upstream status: not submitted.

## Patch 14: generic paragraph geometry and pagination

Add optional paragraph layout/group metadata and distinguish soft line breaks.
Compute left/first-line insets during the existing glyph layout pass; keep before
spacing and collapsed adjacent margins outside painted row height. A separate
after-spacing field feeds body, table-cell, header/footer and cursor geometry.
Paginated layout honors explicit paragraph page breaks and keeps a short
paragraph with the next line when the pair fits on an empty page. Clipped
paragraph continuations suppress fictitious first/last paragraph spacing.
Pure row fixtures and native Chromium cover positive/hanging indentation, lists,
soft breaks, joined review groups, body/table/header/footer spacing, page breaks,
keep-next, source identity, typing and undo. Two actual rendered pages are
retained in the ignored acceptance output for visual inspection. No second glyph
layout pass or Proser business rules are added to the core. Base commit remains
`9af964c2f920da1fcc7d541fae4ab781fcd3bf02`; upstream status: not submitted.

## Patch 15: application-controlled document image loading

Expose a neutral optional image-source predicate. A supplied policy is checked
before document image, drag image, resizer and preview construction; cached and
history-restored images receive the same check. Restricted HTML paste parses in
an inert template, keeps image sources as data until element conversion, and
removes active/resource-bearing markup before connecting the clipboard DOM.
Nested table/list paste uses the same policy. A denied element is retained for
application validation and displays a placeholder without fetching its source.
Clipboard file images are checked before constructing a decoding image.
Runtime predicates are omitted from synchronous/asynchronous saved options;
serialized content cannot install or replace client policy. Proser owns the
asset/digest/relative-URL predicate outside the core. Pure policy tests and native
Chromium request interception cover direct insertion, history, raw HTML paste,
nested table images, srcset and CSS resources while an owned image still renders.
Base commit remains `9af964c2f920da1fcc7d541fae4ab781fcd3bf02`;
upstream status: not submitted.

## Patch 16: toggle the effective caret formatting

At a collapsed caret, explicit pending insertion formatting takes precedence over
its preceding glyph. Toggling bold, italic, underline or strikeout OFF then ON
inside already formatted text now restores the insertion style; the preceding
content stays unchanged. Underline retains the inherited hyperlink rule. The
native Chromium fixture covers all four properties, initially styled and plain
text, zero through three toggles, actual keyboard input and exact preservation
of the surrounding text. Base commit remains
`9af964c2f920da1fcc7d541fae4ab781fcd3bf02`; upstream status: merged October 7, 2026 in
[PR 1487](https://github.com/Hufe921/canvas-editor/pull/1487). The inherited
hyperlink underline rule remains local.
This patch is released as `1.0.4-proser.2`.

## Patch 17: keyboardless browser edit intentions and soft Enter

Handle cancelable `beforeinput` deletion and paragraph/line-break intentions
through the existing keyboard handlers. Software keyboards may supply these
intentions without a meaningful keydown. Composition and read-only guards remain
intact; application-owned history stays outside this mapping. Native keydown
defaults are cancelled to prevent the same edit reaching beforeinput twice.
Literal newlines in text/dictation data remain soft breaks. Shift+Enter now
marks a soft break and retains the heading/list container instead of splitting
its identity. Native Chromium and WebKit fixtures cover body/table-cell Unicode
edits, untouched neighboring cells/stories, complete native undo/redo, soft versus
paragraph breaks, heading/list identity and typing after cancelled composition.
The event mapping follows the browser intentions documented in the
[Input Events specification](https://www.w3.org/TR/input-events-2/).
Base commit remains `9af964c2f920da1fcc7d541fae4ab781fcd3bf02`;
upstream status: not submitted. Released as `1.0.4-proser.3`.

## Patch 18: touch selection cancellation preserves content

Opt-in touch selection extends a range even when a gesture starts inside existing
highlighted text. Ordinary mouse text drag/drop keeps its previous behavior.
Pointer cancellation, lost capture and disabling the mode release capture and
restore the initial range/insertion style without applying a drop, formatting
painter or focus action. Live composition fences touch selection so a neighboring
table cell cannot receive its text; starting composition aborts a retained gesture.
Destruction releases any retained pointer. Before the
fix, a real Chromium touch cancellation moved selected text to the drag target.
Native CDP touch fixtures now cover successful selection, cancellation and mode
disabling with exact content preservation, unchanged mouse drag behavior, and
trusted composition followed by a touch in a neighboring table cell.
Base commit remains `9af964c2f920da1fcc7d541fae4ab781fcd3bf02`;
upstream status: not submitted. Released as `1.0.4-proser.3`.

## Patch 19: cursor visibility respects the visual viewport

Intersect cursor scrolling bounds with the visual viewport, including nonzero
viewport offsets and inner scroll containers. A software keyboard can reduce the
visual viewport without changing the layout viewport. Native Chromium and WebKit
fixtures simulate that geometry and check that the caret remains visible while
its range/content remain intact. Application viewport event handling and IME
lifecycle stay outside this geometry calculation. Browser behavior is documented
in [Chrome's viewport resize guidance](https://developer.chrome.com/blog/viewport-resize-behavior).
These fixtures emulate devices; they do not certify physical iOS/Android input.
Base commit remains `9af964c2f920da1fcc7d541fae4ab781fcd3bf02`;
upstream status: not submitted. Released as `1.0.4-proser.3`.

## Patch 20: deferred cursor focus respects later user navigation

Capture the active element when cursor rendering requests deferred input focus.
The scheduled callback may focus only a connected agent while focus still belongs
to that captured element or the agent itself. A later toolbar/keyboard focus
change and destruction supersede the request. Before the fix, a native Chromium
fixture focused an external button between render and timer delivery; the timer
returned focus to Canvas. Chromium and WebKit fixtures now cover normal deferred
focus, intervening external focus and teardown without a detached focus attempt.
This patch amends the unreleased `1.0.4-proser.3` candidate; its earlier tarball and
fixture receipts remain historical evidence and do not certify the amended bytes.
Base commit remains `9af964c2f920da1fcc7d541fae4ab781fcd3bf02`;
upstream status: not submitted.

## Maintenance policy

Upgrade only to an exact upstream commit after document serialization, Unicode,
table identity, review, touch and performance regressions pass. Keep patches small
and propose generic changes upstream after their fixtures pass. Review monthly;
security advisories trigger immediate review. Upstream source keeps its original
formatting and is checked with its TypeScript build.
