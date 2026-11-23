# Reviewed document authority enforcement

`deploy/document-authority/enforcement.sql` is a candidate-specific PostgreSQL
change. It is **outside** the additive compatibility subset. The existing
migration classifier still rejects its functions, triggers and constraints.
Do not copy it into an allegedly additive migration, relax the classifier or
activate authority through an ordinary code rollback.

Installing the SQL leaves its singleton activation state disabled. It does not
activate production or authorize replacing an existing production database.
The reviewed compatibility release first deploys the additive Prisma tables and
all consumers with `DOCUMENT_AUTHORITY_ENABLED=false` through the native Factory
schema-changing deployment path. Factory and Author remain independently deployed.

## What the guard verifies

The document service admits its book through transaction-local
`proser.document_book` after its existing ownership/resource/workflow fences.
Stale application code lacks that admission and cannot update book/hierarchy,
canon or prose projections. New-book insertion must have a complete immutable
head before commit. Hierarchy removal requires retained tombstones.

Deferred checks compare the final scene prose/count/identity with its head's
immutable scene revision, including tracked changes, tables and Unicode. Head
checks compare changed lightweight references from the old/new manifests;
ordinary one-scene saves do not project unchanged manuscript bodies. References
must belong to the head's book. Initial creation and complete restoration check
their changed memberships. The runtime service additionally validates canonical
schemas, hashes, ownership, assets and mutation preconditions.

Revision, mapping, original/import-preview, receipt, audit and publication-artifact rows
reject updates/deletes after activation. Provider-effect status may change, while
admitted requests and already known output remain immutable. Referenced asset
identities cannot be deleted or change URL/ownership/digest; supplementary source
availability metadata can still change. Active image deletion retains physical
bytes because multiple asset IDs may share one content-addressed file.

The database owner and privileged filesystem operators can change enforcement,
SQL functions, role privileges or files. These guards defend against stale
application writers; they are not a substitute for restricting production role
ownership and write access. Artifact/asset reads verify retained checksums. The
separately reviewed production procedure must retain the effective role grants
and deployment records alongside the rehearsal evidence.

## Isolated executable rehearsal

The tool accepts only an explicitly supplied fixture PostgreSQL endpoint. It
allocates new `proser_canvas_enforce_*` databases, deploys immutable migrations,
runs enforcement/history fixtures, verifies classifier rejection, retains a
styled Unicode/null/empty manuscript, repeats backfill, and proves two dump /
restore cycles including IDs, hashes, migration ledger and trigger definitions.
It leaves those disposable databases and private evidence for inspection.

Run from Factory using the documented isolated PostgreSQL/Redis containers:

```bash
node scripts/rehearse-document-enforcement.mjs \
  --isolated-postgres "$PROSER_ISOLATED_ADMIN_URL" \
  --record-dir /absolute/private/rehearsal-directory
```

The administrative URL must explicitly address `127.0.0.1:55441/postgres`.
`PROSER_ISOLATED_ADMIN_URL` is a task-specific variable, not the ambient runtime
`DATABASE_URL`. The tool refuses production endpoints and cannot install or
activate production enforcement. Its record contains SQL/dump SHA256 values and
the exact checkout revision. A dirty checkout is marked accordingly and never
counts as approval of a committed release candidate.

## Candidate-specific production procedure

Before installation, retain a review record naming the exact committed Factory
candidate, SQL SHA256, backup SHA256, production-backup migration/backfill
rehearsal, second restore, compatibility checkpoints and authority activation
criteria. The isolated fixture rehearsal above supplements the restored
production-backup rehearsal; it does not replace it.

Use the native deployment's Redis persistence preflight, admission fencing,
exact-operation drain/recovery, stopped API/worker, private checkpoint and
validated PostgreSQL dump. Apply the exact SQL to the isolated restored candidate
first, with `ON_ERROR_STOP` and one transaction, and repeat the preservation and
restore checks. Review every unsupported legacy conversion before activation.
Retain the SQL checksum and results in the candidate-specific release record.

Only that separately reviewed procedure may install the identical SQL on the
fenced production candidate and set `proser_document_enforcement.enabled=true`,
`candidate_sha`, `rehearsal_sha256` and `activated_at` together. Enable the Factory
flag only after final writer/backfill verification. Readiness checks the installed
candidate/rehearsal identity; deploy compatible Author and prove authenticated
disposable editing/publication canaries before reopening admissions.

After structured writes begin, roll back only to a document-compatible release.
Keep enforcement armed. Do not disable it to make old application code writable.
A database restore keeps writes fenced and reconciles post-backup revisions,
artifacts and uncertain operations first. Preserve unknown provider outcomes;
never infer that an interrupted request is safe to repeat.

## Import original deletion

Import originals and previews never change. Since the change that added
`proser_document_import_evidence`, the service may delete an original inside its
admitted document transaction when no preview references it and no audit
record shows a committed import from it. It may delete a preview when no
committed import came from it. Legacy bundle commits audit `originalId` and
`previewId`; DOCX commits audit them under `importSource`. A native installation
whose guards predate this change keeps refusing every deletion until operators
apply the new SQL through the candidate-specific procedure above. Compose
installations upgrade the guards on start from the known earlier SQL digest.

## Legacy conversion operations

`backfill-document-history.ts` previews a single owned legacy revision and
requires exact report-hash consent before creating immutable reading mappings.
Original snapshots, original hashes and the current head stay unchanged.
Recovered scene/canon evidence is distinguished from retained hierarchy
scaffolding and unrecorded layout/review/metadata. Incomplete historical mappings
cannot automatically restore native documents or serve as workflow rollback
sources. Lost formatting or null/empty distinctions are not invented.

```bash
npx tsx scripts/backfill-document-history.ts \
  --user-id USER --book-id BOOK --revision-id REVISION
npx tsx scripts/backfill-document-history.ts \
  --user-id USER --book-id BOOK --revision-id REVISION \
  --apply --consent-report REPORT_SHA256
```

`backfill-legacy-html.ts` preserves immutable original bytes before parsing,
previews bounded supported headings/runs/styles/lists/tables/hyperlinks, reports
active content and external image references, and requires exact consent before
revision-bound conversion. It never fetches external resources. Malformed,
merged/ambiguous containers and unknown semantics fail visibly. Existing
canonical review, formatting or protected objects require reconciliation instead
of full-body replacement.

```bash
npx tsx scripts/backfill-legacy-html.ts \
  --user-id USER --book-id BOOK --scene-id SCENE
npx tsx scripts/backfill-legacy-html.ts \
  --user-id USER --book-id BOOK --apply --preview-id PREVIEW \
  --operation-id OPERATION --expected-book-revision REVISION \
  --consent-report REPORT_SHA256
```

CLI `revise`, `outline` and `characters` accept stable `--operation-id` values.
Their typed requests freeze the owned canonical source before inference and
retain known output before guarded application. Retry the same command with its
original operation ID to recover its original result/receipt; changed commands
conflict. `document:operation BOOK OPERATION` inspects metadata. Use
`--view request|result --offset N --limit N` for bounded evidence pages, or
`--cancel` to suppress uncommitted application. Running/unknown effects are never
replayed automatically. Book/hierarchy/canon and formatting races preserve the
newer revision and retain the unapplied result for explicit reconciliation.

Hermes plugin 4.4 keeps `proser_generate` revision action names and negotiates
owned book capabilities before inference. Active callers first create/disclose an
owned document discussion and supply `documentPreview` with its discussion and
proposal-operation UUIDs. The response is a typed revision-bound proposal.
Arbitrary legacy text fails before inference. The bundled authoring manual
explains saved/draft context disclosure, revalidation, tracked application and
exact receipt recovery. Proposal inference retains the Nova shared-GPU/resource
reservation; reading and applying a known proposal do not claim inference.


## Revision-bound reads and comment review

With authority active, the book detail, list and structure endpoints return
canonical hierarchy metadata and word counts from one captured immutable
manifest. Book detail defaults to metadata; `includeProse=1` explicitly adds
exact final prose, limited to 8 MiB. Scene compatibility reads preserve their
prose default and accept `includeProse=0` for metadata. A chapter or single-scene
read decodes only its requested immutable bodies. Every scene identifies its
source book revision, scene revision and canonical hash; old manifests never mix
newer mutable projection columns. Tombstones retain stable identities and source
references, and visible totals exclude them. Hermes `book_map` uses metadata
unless prose excerpts were requested; `get_book` requests compatibility prose by
default and accepts an explicit query override.

Scene and front/back/header/footer story comments keep exact canonical anchors.
When a target changes or disappears, the save preserves a stale/orphaned range
and source proof rather than searching for an identical quotation. Scene proofs
bind an owned immutable scene revision. Layout-story proofs bind the owned layout
scope hash, revision and stable story ID. Source verification groups proofs and
loads one historical scope at a time, retaining no manuscript-sized history
cache. Zero-offset drawing comments bind the immutable inline image identity.

Read retained state at `.../scenes/:sceneId/document-comments` or
`.../layout-stories/:storyId/document-comments`. Review `/:commentId/revalidate`
against expected book and scene/layout revisions. Reattachment requires explicit
current identities and grapheme spans. `/:commentId/resolve` additionally requires
a retained operation UUID and action `resolved`, `reopened` or `reanchored`.
Authenticated resolution history preserves the previous anchors/proofs. A lost
acknowledgement recovers the same document receipt; stale revisions fail 412.
Unresolved comments and pending changes block removing a complete story. These
review actions remain separate from proposal application and publication approval.

Ordinary manual typing can continue the authenticated author's own pending manual
insertions while preserving their change ID, timestamp and attribution. Pending
AI/workflow/import insertions and all pending deletions remain protected from
silent text or formatting replacement. Additional inserted identities must be
fresh and linked to the same owned manual change record.


Global manuscript search uses `/api/books/:bookId/document-search`, a pinned
manifest cursor and per-scene immutable hashes. Pages retain original Unicode,
whitespace and exact UTF-16/anchor evidence, using full Unicode 16.0 case folding
and NFC only for matching. At most eight scenes/four MiB are decoded per page and
at most 100 hits are returned. A cursor remains on its original manifest after a
newer save, explicitly reporting `stale`; changing owner/book/query conflicts.
The UI must recheck the loaded scene revision before selecting a returned hit.

The durable index advertises `index: revision-gin-v1`. Each scene revision and
its compact final projection/identity map commit atomically; unchanged scenes
reuse immutable entries. PostgreSQL GIN postings filter candidate scenes using
Unicode-normalized search text, then exact substring matching and grapheme
boundaries validate results. Posting arrays are capped at 65,536 distinct grams;
high-entropy overflow remains correct through exact database substring filtering.
Search loads no canonical scene bodies. No-match searches load no projection
payloads. Missing indexes never cause a scan fallback or incomplete success:
`DOCUMENT_SEARCH_INDEX_INCOMPLETE` is a recoverable 503, and invalid historical
evidence is preserved with `DOCUMENT_SEARCH_INDEX_INVALID`.

Before activation, backfill every historical revision using
`node_modules/.bin/tsx scripts/backfill-document-search-index.ts --user-id ID
--book-id ID --apply`; follow each `nextAfter` with `--after UUID` until complete,
and repeat to verify create-only idempotency. Without `--apply` it reports missing
entries. The owned POST `/api/books/:bookId/document-search-index/recover` accepts
`{after?,limit?}` (default eight, maximum 32) and provides the same bounded
recovery. These derived operations never change heads or invoke providers;
retrying after a lost acknowledgement verifies the winning immutable entry.
All existing source/hash/normalization disagreements fail visibly and remain
untouched. Active readiness independently requires current manifest coverage.
The separately reviewed enforcement SQL preserves index rows and checks changed
scene index text against the canonical SQL projection; it remains outside the
additive deployment classifier. Performance acceptance on reference devices
remains a release gate. Hermes requires both native search and index capability
markers and never downloads full active prose as a fallback.

Unicode data and Unicode-3.0 notices are retained under `vendor/unicode`, with
exact upstream source/license checksums in `sources.json`. The generated
application mapping compiles into `dist`; runtime search never reads vendor
files. Include the notice with application releases, outside both Canvas forks.


Each tracked change now retains server-owned `resolutionHistory`. A pending
accept/reject appends the authenticated actor/name, timestamp, operation UUID,
original book revision/manifest hash and exact scene or layout-story source.
Original author, creation time and imported attribution remain unchanged.
The document transaction also writes one individual audit action; legacy
`resolution`, `decision`, `workflowRunId` and source/output revision fields remain
available, with the complete event under `reviewResolution`.

Clients cannot supply, remove or rewrite history, flip a resolved decision, or
edit its pending target while accepting/rejecting. Target text, properties,
paragraph and table-cell identities must match the supported `resolveChange`
outcome; formatting rejection may restore only its recorded prior properties.
Unrelated edits may commit atomically. Workspace review flushes typing before
creating the separate decision operation. Lost acknowledgements recover the
original receipt and do not append another event or audit action.

Authorized workflows can create and resolve edits atomically, recording
`phase: created-and-resolved` and the exact workflow run. Ordinary direct
paragraph split/join creation records a distinct structural-creation audit,
without inventing an accept decision. Trusted imported resolved state is marked
as imported state, not authenticated local review. Exact owned scene/layout/book
restoration preserves the selected revision's complete history; it is the only
way to restore an earlier pending state. Old immutable history is never rewritten.
Factory keeps these events in publication review sidecars, stripping them from
the neutral Word AST; untrusted imported sidecars never create Factory authority.

Named style IDs are owned by the captured immutable layout scope. Scene bodies,
new/imported bodies, tables, review formatting records and owned layout stories
must reference defined styles; legacy `Normal` and `Heading1`–`Heading6` remain
valid builtins. Explicit style properties override inherited defaults. All
character inheritance paths, including currently unused definitions, reject
undefined parents, cycles and depth beyond 32 before a commit. Invalid graphs
return `DOCUMENT_STYLE_INVALID` (409) and leave the head, scopes, bodies, receipts
and projections unchanged. Removing or renaming definitions checks every current
manifest reference, including retained scene identities, one immutable body at
a time. Atomic definition/body renames validate their complete resulting graph.
Historical revisions retain their original definitions; they are never rewritten.
Complete restoration validates selected bodies/stories against the selected
layout before restoring that exact graph. Body-only restoration must remain
compatible with the current owned styles. Typed AI previews/trace targets bind
layout hashes, and operator/workflow applications bind the complete book revision;
changing inherited effective formatting makes those old sources stale even when
plain text and body revision IDs have not changed. Unsaved discussion context
also validates its named references against the owned captured layout.

Preservation backfills enumerate **all** owned books using `deletedAt: {}`,
including archived books and their retained scene/canon tombstones. The local
operator calls `initialize(...,{includeDeleted:true,source:'operator-backfill'})`;
HTTP/request and workflow contexts cannot enable this option, and ordinary reads
or initialization continue to hide archived books. `ensureRevisionBridge` offers
the same explicit local mode for preserved archived ancestry. These operations
never revive a book, remove a tombstone, replace identities or expose editing.
Two backfills verify existing heads, exact original prose (including SQL null
versus empty), lifecycle, structure/canon snapshots and native bridge mappings.
Complete restoration creates a new revision with the selected archived lifecycle;
its compatibility prose is the canonical string projection, while exact original
null/empty distinctions remain permanently in immutable backfill source records.

AI/editorial target revalidation also qualifies the stable scene through its
original immutable Book → Act → Chapter → Scene membership. Historical discussions
and trace snapshots retain their original bytes; Factory reads their saved book
manifest and owned structure/layout references instead of inventing new fields.
Moving unchanged text to another chapter/act is stale even when scene document and
whole layout-scope hashes match. Resolved chapter/book typography, header/footer
stories and section heading inputs remain bound. Revalidation and application both
check this evidence; a validation created by an older implementation cannot bypass
the application check. Trace findings become explicitly stale rather than relocating.
Unrelated edits within the same qualified target still use the existing exact run,
formatting, protected-object and grapheme checks. No revalidation invokes inference.

Release admission receipts/bindings and operator-only fence transitions are now
included in the separate reviewed SQL. See [release admission and exact recovery](RELEASE_ADMISSION_FENCE.md) for independent queue/supervisor holds, candidate-specific
proof and the separately reviewed legacy schema alignment migration.


Resolved paragraph split/join marks can be edited again without deleting their
old review records. The server appends `historicalBoundarySource` only when a
resolved mark loses its active physical adjacency/marker. It binds the owned
immutable Book/Scene or layout-story revision, original document/change hashes
and exact paragraph/container target hash. Old IDs, imported/local attribution,
status and resolution history remain unchanged; no accept/reject event is
invented. Pending marks retain exact adjacency, container, style and object
protections. Fabricated, dropped, foreign or changed historical proof is rejected
in the guarded transaction. The fresh active marker alone renders the current
boundary. Complete restoration retains the selected historical proof.

Cross-scene edits use bounded qualified passage endpoints. Moving whole blocks,
splitting at an exact grapheme caret, and joining exact adjacent scene boundaries
load complete owned revisions only inside Factory and commit both affected scopes
atomically. Stable objects and complete review/comment records transfer unchanged.
Receipts contain bounded refreshed passages and revision references, never full
scene documents. Drained scenes retain a fresh deterministic empty paragraph/run
so typing remains usable. Unsupported partial review transfer is visible.

Operation undo restores the complete affected scene set against its captured book
manifest. Restoring a former source scene alone after a move is rejected when its
old identities remain in an unaffected live scene. Both canonical commit and
catalog paths check this against one immutable body at a time. Paired restoration
checks its final identity set; structure/layout or unrelated scene-head changes
require explicit reconciliation rather than a guessed inverse. Lost acknowledgments
recover the exact original operation receipt before another operation is attempted.
