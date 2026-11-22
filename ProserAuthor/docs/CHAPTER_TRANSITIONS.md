# Chapter transition review

Choose a manuscript on `/editorial`, or on Home before opening `/m/editorial`.
Both Editorial routes share the same owned transition panel and honor an owned
`bookId` deep link. The Chapter transitions panel starts with
its first three adjacent chapter pairs (or all pairs when fewer than four chapters
exist). Factory follows active act, chapter and scene order, including chapter
numbers that restart within an act. Empty chapters and empty edge scenes remain
visible; the panel never substitutes an earlier populated scene.

Each pair shows saved final text: up to 1,800 Unicode code points from the actual
ending and 1,800 from the actual opening. Truncation is disclosed on its respective
side. Both excerpts come from one immutable book manifest, with exact scene
revision IDs and hashes. Unsaved editor drafts are excluded.

**Review and offer a small revision** freezes both boundaries in an owned document
discussion. The provider reviews continuity, momentum and the reason to keep
reading, and proposes one edit to the opening paragraph. Its source must be exact;
the edit budget is 600 removed/inserted characters, with no paragraph restructuring.
Before/after is displayed as a suggestion. Use the manuscript's saved discussions
and guarded tracked-edit flow when choosing to apply it. Any intervening book
revision invalidates transition proposal revalidation/application.

Long opening paragraphs use their first complete sentence as the small revision
target, retaining the full paragraph identity and context. Targets above 1,200
UTF-16 characters, protected content or pending review changes require manuscript
review first. Missing boundaries prevent review.
The excerpt review makes no claim about unshown chapter interiors.

Factory-retained reviews also load on another browser through bounded owned
discussion/proposal history; loading them never dispatches inference.

The authenticated user/book/chapter-scoped IndexedDB journal reserves the exact
discussion and proposal requests before dispatch, including concurrent-tab
protection. **Recover saved review** uses GET only. If Factory explicitly reports
no record, **Resume exact saved request** reuses the original IDs. Unknown provider
outcomes remain retained and do not enable another review. A completed result can
be followed by **Prepare a fresh review**; the original Factory discussion,
provider result and receipts remain in history. Changing accounts remounts the
panel and reads only that identity's journal.

Verification covers canonical order, literal terminal Unicode text, ownership,
empty boundaries, source freezing, predecessor-change rejection, exact recovery,
storage failure and account isolation. Browser evidence remains separate from
physical-device and screen-reader certification.

Run the focused real-browser proof after the build, using a fresh disposable
`proser_canvas_transition_release_*` database on PostgreSQL55441, Redis56441
and the licensed publication-font manifest:

```bash
DATABASE_URL='<fresh synthetic PostgreSQL55441 URL>' \
REDIS_URL='redis://127.0.0.1:56441/15' \
PUBLICATION_FONT_MANIFEST='<absolute licensed-font manifest>' \
PROSER_RELEASE_SMOKE_OUTPUT='<new private evidence directory>' \
node scripts/run-chapter-transition-release-smoke.mjs
```

This gate uses an explicitly seeded provider result to verify the real UI,
Factory-owned frozen context, concurrent-tab journal reservation, lost-response
GET recovery, before/after, literal ending glyphs and 390px layout. It does not
claim inference quality. It tombstones its disposable book and retains history.
Actual provider results require a separate manuscript-bound proof.
