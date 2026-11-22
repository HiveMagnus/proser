# Canvas writing controls

The manuscript workspace prioritizes the page. Book and scene navigation,
durable save status, review projection and operation history sit above the editor.
Search, page setup and editorial tools open when requested. Review tabs preserve
their mounted state so switching tabs does not restart inference or discard work.
On smaller viewports the review panel becomes a closable drawer.

Scene scope uses scene navigation. Chapter scope uses an ordered chapter picker
and chapter arrows, including chapters with no saved scenes. The URL retains
`scope` and `chapterId` so reload and history restore the selected scope. Empty
chapters show their own empty state rather than another chapter's scene.
Unacknowledged work blocks navigation until saved or reconciled.

Adjacent selection previews contain bounded excerpts. A continuation notice
identifies text that ends inside a paragraph; **Next source excerpt** and
**Next destination excerpt** load the exact next server cursor. **Load source
scene end** reaches the terminal passage without fetching the complete scene.
These actions flush pending work first and preserve the loaded preview on failure.
Focus the excerpt box to scroll with arrows or Page Down. True scene endings and
omitted preceding text are labeled explicitly.

The shared native/semantic toolbar shows selection formatting, including mixed
values. Emphasis, font, size, color and highlight operate on the frozen canonical
selection. Heading, list, alignment, line spacing and paragraph layout apply to
complete selected paragraphs. Numeric fields commit validated values on Enter or
blur; typing an intermediate value does not replace the document. Font size uses
pixels and accepts 6–144 px. Advanced paragraph settings and table insertion are
under More formatting. Table insertion is unavailable while tracking, since Word
table-structure revisions are outside the supported exchange scope.

Original/markup views and composition disable mutations. Invalid selections
clear the formatting target rather than retaining an unrelated old selection.
Search fields and toolbar inputs keep their own keyboard undo; manuscript undo
remains bound to document operations. Accessible editing uses the same formatting
commands and canonical targets.

Highlight applies yellow or clears the selected highlight in one click; its
adjacent color picker chooses other colors. The narrow desktop shell keeps its
collapsed navigation rail in the layout so it cannot cover manuscript controls.
In the bounded workspace, Insert table commits a two-by-two table after the
selected body paragraph through Factory's placement-checked operation. It
preserves that paragraph's text and does not insert a local unsaved Canvas table.

The maintained Canvas core is `1.0.4-proser.3`, based on the original pinned
upstream `1.0.4`. Its generic caret fix makes the pending insertion style take
precedence over the preceding glyph when toggling bold, italic, underline and
strikeout. Exact rebuilt bytes, embedded dependencies and MIT notices are
recorded in Factory's dependency ledger and release SBOM. The DOCX codec is
unchanged.

## Release finish criteria

- Native Chromium control corpus passes, including heading/list selection,
  selected text and all 32 caret emphasis cases.
- Authenticated browser checks prove editing, formatting, save/reload and
  bounded navigation through Author's relative API proxy.
- Desktop and phone-width screenshots are inspected for overflow, usable
  controls and the page's position in the initial viewport.
- Root format, lint, typecheck, test, build and audit gates pass with database
  tests explicitly pointed at fresh isolated PostgreSQL and Redis.
- Native Author deployment verifies the installed revision and artifact digest;
  an authenticated disposable production canary saves, reloads and publishes.
  Existing manuscript data is not used for mutation testing.

R2 device/assistive-technology certification is active; the user deferred VoiceOver
and checks requiring their interaction until later. R6 performance certification
remains deferred. Microsoft Word-specific fidelity remains unverified. Follow the
root [R2 acceptance record](../../CANVAS_R2_ACCEPTANCE.md) for current evidence;
the preceding control corpus below retains its historical scope.

The release checks include 46 native Chromium acceptance checks and 32 actual
caret-formatting keyboard cases, plus 12 authenticated workspace checks. The
authenticated corpus verifies persisted typography, emphasis, heading/list
selection, paragraph spacing, colors, highlight, and two-by-two table insertion;
it also checks stale-tab reconciliation, save/reload, phone layout and bounded
300,000-word loading. Bounded correctness is not R6 performance certification.
