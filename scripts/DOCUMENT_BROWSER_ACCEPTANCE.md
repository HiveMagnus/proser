# Authenticated document browser gates

Use pinned Node24.22.1, independent Factory npm and Author pnpm12.16.1 frozen
installs, the built candidate, and installed licensed publication fonts. Prepare a
**fresh synthetic** `proser_canvas_release_*` PostgreSQL database on
`127.0.0.1:55441`; deploy Factory migrations only into that database. Use isolated
Redis on `127.0.0.1:56441`. Never point this runner at production, a clone, or a
fixture retained from another gate. It owns loopback Factory3310/Author3320,
explicit ephemeral local authentication, and process teardown. Inference points
at an unavailable loopback endpoint. It rejects occupied service ports.

The ordinary command runs the complete Chromium application gate:

```bash
DATABASE_URL='<fresh synthetic PostgreSQL55441 URL>' \
REDIS_URL='redis://127.0.0.1:56441/15' \
PUBLICATION_FONT_MANIFEST='<absolute licensed-font manifest>' \
PROSER_RELEASE_SMOKE_OUTPUT='<new private evidence directory>' \
node scripts/run-document-release-workspace-smoke.mjs
```

That gate also exercises ordinary Dashboard project creation with a lost
acknowledgement, inline first-scene creation and native typing, stale project
details, and owned deletion receipt recovery after the book is tombstoned.
For focused iteration of those four checks, use
`PROSER_RELEASE_R2_BOOK_CATALOG_ONLY=true` with a fresh isolated database.
The mutation guard permits only the uniquely named fixture and its created scene;
recovery never repeats an uncertain creation or deletion.

For the focused two-check Quick Draft gate, add
`PROSER_RELEASE_R2_QUICK_DRAFT_ONLY=true`. Browser selection is explicit:
`PROSER_RELEASE_BROWSER=chromium` (default) or `PROSER_RELEASE_BROWSER=webkit`.
WebKit selection requires exactly one focused Quick Draft or workspace flag; it
cannot silently replace the broader Chromium corpus or select the catalog gate.
Conflicting focused flags fail before starting services. Install the pinned Playwright browser from
Factory, for example `npm --prefix ProserFactory exec -- playwright install --with-deps webkit`.
CI's independent `authenticated-quick-draft-webkit` job installs both browsers
because Factory's publication capabilities also use Chromium. It runs Quick
Draft2 and workspace7 sequentially against separate fresh databases and Redis
indexes, retaining both profiles. Frozen installs and the build are shared only
within that job; manuscript fixtures are never reused between the two gates.

The focused gate verifies portrait390×844, landscape844×390 and short390×390:
visible sheet bounds, associated labels,16px fields, scroll-reachable submission,
New Book center hit testing and actual pointer/click/focus targets, exactly one
new book/structured scene, and first native typing saved exactly once. WebKit uses
Playwright's iPhone13 touch emulation and real locator taps. Reports explicitly
identify its version and emulated user agent; these are separate from physical
iPhone Safari, VoiceOver, OS IME and dictation acceptance.

For the seven authenticated workspace checks, use a fresh database and
`PROSER_RELEASE_R2_WORKSPACE_ONLY=true` instead of the Quick Draft flag. The
same command supports Chromium or WebKit, without changing the default complete
Chromium27 gate. These checks cover header ownership, native keyboard Tab
navigation, Factory-owned undo/redo, semantic Unicode and table-cell persistence,
lost-save acknowledgement recovery without a second POST, and sanitized
read-only reading with identity-scoped typography preferences, and loaded-scene
offline draft recovery.

The complete Chromium gate also runs `test-manuscript-navigation.mjs` against its
own small disposable book. Two checks prove ordered chapter picking (including
an empty chapter), chapter arrows, URL/reload/history consistency, explicit
bounded excerpt continuation, exact terminal Unicode glyphs and keyboard
scrolling at 1440×1000 and 2048×744. These navigation controls make no content
writes or full-scene editing reads. Cleanup checks the owned Book ID and unique
title, then tombstones through the current revision preconditions. Browser and
screenshot success does not certify physical devices or screen readers.

The offline check disables network access in the actual loaded browser, types a
unique Unicode edit through the semantic textarea keyboard, verifies the visible
offline state, and reads the authenticated scene's retained IndexedDB draft. No
mutation is dispatched while offline. It retires the active page while still
offline, reconnects, reopens the saved scene and explicitly restores the exact
draft. This avoids racing legitimate live-page autosave with navigation. The
original operation commits once, durable acknowledgement removes its journal,
and complete scene/prose, unrelated styles, tables, review and layout are checked.

Workspace7 uses **mixed input**: locator mouse clicks and field fills, Playwright
keyboard events, and explicitly synthetic pointer/beforeinput/history events.
WebKit retains its mobile iPhone13 viewport and touch-capable browser profile,
but this suite does not certify real touch gestures, physical iPhone Safari,
OS IME, dictation or VoiceOver. The browser profile records this distinction;
Quick Draft's real locator taps remain a separate two-check gate.

For WebKit only, the checked-in browser launcher selects
`GIO_USE_NETWORK_MONITOR=netlink` **inside that browser child's environment**.
[GLib documents this diagnostic backend selection](https://docs.gtk.org/gio/overview.html#running-gio-applications);
it belongs in the test profile, never in production service or host settings.
The preflight asserts actual `navigator.onLine` transitions true→false→true via
supported `context.setOffline()` calls. It never replaces the JavaScript getter.
A failed preflight closes the browser and retains its profile failure. Retained
runs using this host's default monitor reported offline despite loopback API
success and correctly retained unsaved text; they remain failed, rather than
being relabelled as successful saves.

`evidence.json` and `browser-profile.json` retain checks, fixture identities,
canonical save hashes, browser/input/environment scope and preflight results.
Screenshots and logs remain private diagnostics. Mutation guards allow only the
uniquely named new fixture's creation/Quick Draft and its exact scene save path.
Cleanup tombstones created books using current manifest preconditions, including
on failure, and preserves revision/operation history. Unknown provider effects
are never replayed.

Static profile safety checks run with:

```bash
node --test scripts/document-release-browser.test.mjs
```

The separate native Canvas mobile corpus supports an explicit private diagnostic
directory: `node scripts/test-canvas-mobile-browser.mjs --output <directory>`.
It preserves an existing `result.json` by selecting a unique child directory,
records browser/version, active cases and crash/close/disconnect events, and writes
partial checks on failure. The three deferred-focus evaluations have a30-second
host-side failure budget; assertions are never retried or suppressed. CI enables
`DEBUG=pw:browser` only for this fixture step to retain native browser stderr/exit
details. These47 Chromium/WebKit checks retain their emulated/synthetic scope.
