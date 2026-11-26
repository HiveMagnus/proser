# Structured document authority

The Canvas modernization is under implementation. `DOCUMENT_AUTHORITY_ENABLED`
defaults to false. Keep it false in production until every writer, mobile flow,
publication path and deployment/recovery gate in `docs/CANVAS_MODERNIZATION.md` passes.

## Implemented foundation

Workflow inference uses `DocumentWorkflowEffect` receipts with immutable source
manifests, frozen requests, retained checksummed results and provenance. Recover
the exact receipt before considering another provider call. Unknown/running
outcomes block replay, including a different-key attempt under the same run.
Independent candidates may run concurrently only under the same live lease.
Cancellation and lost leases suppress application and retain late returned bytes.
Owned receipt lists have stable cursors; request/result inspection is paged.

Selected draft application now atomically commits document bytes, revision bridge,
selection artifact, task completion, scene memory and saved trace binding. Exact
receipt recovery does not duplicate memory. Checkpoint approvals carry complete
source book/scene references and hashes; changing only formatting or layout also
requires reconciliation and a fresh approval. Workflow automated acceptance has
separate resolution audit provenance and retains existing quality/release gates.

Multi-scene commits can transfer unchanged anchored review records without
restamping attribution. Targets and record identities must move together; partial
or duplicate transfers and stale scopes roll back the entire operation.

With authority active, readiness requires the installed enforcement candidate and
rehearsal checksums, supported/backfilled schema, complete immutable search indexes,
selected-artwork digest evidence, writable asset/artifact storage,
Chromium and `PUBLICATION_FONT_MANIFEST`. That absolute JSON manifest uses
`schemaVersion: 1` and `fonts` entries with `name`, `version`, absolute `path`,
`sha256` and absolute `licensePath`. Readiness verifies exact font bytes and retained
licenses. It never installs fonts or activates database enforcement. Checks cache
for at most thirty seconds; public output contains bounded readiness states.

The legacy Markdown bundle importer now preserves exact original bytes and a
reviewable conversion/report before committing an append operation. It creates
fresh hierarchy identities and retains all existing prose, structure, codex,
review and revision history. Manuscript emphasis, strong emphasis, strikethrough
and code spans become native text styles. Links, HTML, image references and tables
stay as text. Boundary whitespace and heading mapping and the supported codex
frontmatter fields are disclosed in the conversion report. Commit
requires explicit consent to the exact report checksum and source book,
structure and canon revisions. Originals survive failed conversion and remain
available only to their owner, including after the book is tombstoned.

The CLI utility requires `--user-id` and `--book-id`. Its default is preview:
`npx tsx scripts/import-legacy-bundle.ts --user-id ID --book-id ID --source-root DIRECTORY` prints recovery
IDs, the mapping, report hash and expected scope revisions. Retain those values.
To commit, pass `--apply --preview-id UUID --operation-id UUID`,
`--expected-book-revision UUID --expected-structure-revision UUID
--expected-canon-revision UUID --consent-report SHA256`. Retry exactly those
arguments after a lost acknowledgement; do not fetch a newer revision for that
operation. `--read-preview --preview-id UUID` reads the preserved report.
`PROSER_IMPORT_SOURCE_ROOT` selects the source directory. Originals include exact
file bytes in a bounded JSON bundle; the importer rejects source symlinks that
escape the selected directory. It never creates placeholder accounts or deletes
an existing book.

Factory exposes original upload/download, preview and commit endpoints under
`/api/books/:bookId/import-originals` and `/import-previews`. Original uploads use
`application/octet-stream` and a UUID path, with a 32 MiB limit; binary download
checks size and checksum and remains authenticated through Author's relative
proxy. These endpoints support the explicit legacy bundle, single Markdown or
plain-text manuscripts (`?format=markdown|plain-text` on upload) and bounded DOCX conversion.
DOCX previews retain namespaced paragraph/character style definitions and display
labels, complete supported bodies and owned header/footer documents. Import graph
attestation compares them with the retained conversion and preserves existing
owned style definitions. Full corpus and workspace acceptance remain required;
the legacy bundle conversion does not establish DOCX fidelity.

Both `documents:backfill -- --apply` and `db:backfill:scene-wc -- --apply` now
verify already initialized books and reject drift. Preview is the default.
Word-count maintenance invokes document authority; it never updates a projection
independently. Factory lint runs `documents:writers`, an AST source restriction
covering runtime and operator files. Direct prose/count writes are confined to
`documents/service.ts`; its compatibility helpers refuse activation bypass.
This restriction does not replace the separately reviewed database enforcement
guard required before production activation.

Saved generation feedback is deferred until its exact immutable scene revision is
committed. `DocumentTraceAnalysis` retains that source, prompt targets and provider
outcome; pending, running, completed, failed, cancelled and unknown outcomes are
distinct. A provider operation with an unknown outcome is never automatically
repeated. Complete source paragraphs are supplied with stable target identities
and UTF-16/grapheme boundaries; unmatched targets stay explicitly unbound.

Read `/api/books/:bookId/document-traces?sceneId=:sceneId` for findings and compare
target states, and `/document-analysis-operations/:operationId` for recovery.
Cancel that analysis through its `/cancel` endpoint. Revalidate a compare target
through `/document-traces/:traceId/compare-cards/:cardId/revalidate` after saving.
The existing scene `/prose/preferences` endpoint accepts top-level operation,
book/scene revisions and a validation ID for application. Existing editorial
verification still applies; choice/action/audit/receipt and pending tracked edits
commit together. Resolving changes and approving publication remain separate.
Legacy unbound feedback cannot mutate a structured scene by matching quotations.

Author journals exact compare requests before dispatch, scopes recovery to the
authenticated identity/book/scene/schema, and retains them for thirty days.
Competing tabs cannot overwrite an unacknowledged request; stale acknowledgements
cannot delete a newer request. Receipt recovery precedes an explicit exact retry.
This is a tested integration foundation; complete anchor lineage, analysis context
disclosure/model-capacity checks, quality/workflow parity and browser acceptance
remain required by the full migration ledger.

`src/documents/model.ts` and `src/documents/scope-model.ts` are the source of the schema-1 application and catalog contracts.
`npm run documents:sync` at the repository root generates Author's contracts-package copy; the
contract check prevents divergence. Canvas indices, selection and zoom are not
content authority.

The new tables preserve immutable scene documents, immutable book manifests,
explicit heads, separate immutable structure/canon/layout scopes, and idempotent commit receipts. A commit checks ownership and the
book/scoped revision, locks the book, validates content/assets, writes revisions
and `Scene.prose`/word count in one transaction, and acknowledges after commit.
The prose column is a compatibility projection of the final document view.
Legacy projection drift is rejected rather than overwritten. Workflow calls
must retain their live lease and cannot mutate another workflow's book.

Structured routes are inactive while the feature flag is false. The capability
route advertises this; Author retains the existing editor during the compatibility
release. Do not activate the flag merely because the new unit tests pass.

## Revision-aware compatibility commands

Structure revisions retain `selectedImageAsset` beside each book/act/chapter/scene
`selectedImageId`: owned ID, SHA256, media type, byte count, alternative text and
available intrinsic dimensions. New selections and complete restoration verify
local bytes. Removing a selection preserves historical references. API and
database guards prevent deleting referenced assets or changing immutable
registration. A numeric legacy ID alone cannot authorize complete restoration.

Before activation, `npx tsx scripts/backfill-selected-artwork.ts --book=ID` previews
registration from existing owned bytes. `--apply` preserves exact old metadata in
an audit, registers verified facts and, if necessary, creates a guarded new
structure revision without rewriting history. Application or database enforcement
activation blocks application. External URLs, malformed metadata, digest
mismatches and unsafe files fail. Rehearse it against the isolated production
backup before twice-running ordinary document backfill. Missing bytes and
unknown historical digests require explicit reconciliation.

`revision-gin-v1` search indexes are immutable derived records keyed by exact
scene revision/content hash and Unicode normalization version. Revision creation
inserts the index atomically. Queries capture one manifest, filter candidates in
PostgreSQL and load bounded matching index payloads rather than canonical bodies.
Source maps retain original Unicode and stable identities. Missing or corrupt
indexes return explicit 503. Owned recovery and historical backfill create or
verify derived rows without changing document heads. Readiness requires matching
indexes for live and retired head references. Final performance acceptance must
include the index writer cost.

Scene create/update/batch/reorder/delete, act/chapter create/update/delete,
structure-save/reorder, book metadata, and codex create/update/delete have an
active-authority branch through the document mutation service. They take
`documentPreconditions` containing an `operationId`, `expectedRevisionId`,
`expectedScopes` for every changed catalog, and `expectedSceneRevisionId` for
body edits. New-book creation takes a top-level `operationId`, creates its first
manifest/scopes/head atomically, and recovers the same creation receipt on retry.

`GET /api/books/document-capabilities` supports negotiation before creating the
first book. `GET /api/books/document-creation-operations/:operationId` recovers
only the authenticated creator's immutable initial book receipt, including its
book ID. It does not expose another catalog operation through that route.

`POST /api/books/:bookId/document-quick-drafts` takes schema version, operation ID,
source book/structure revisions, summary and outline. It reuses the active
Mobile Drafts chapter or appends the missing act/chapter and empty structured
scene in one transaction. It preserves existing bodies and hierarchy IDs.
`GET /api/books/:bookId/document-operations/:operationId` recovers its original
catalog receipt. A retry must reuse the original payload and revisions;
changing the operation intent conflicts rather than rebasing onto newer content.

Missing preconditions return 428; stale revisions return 412; ambiguous text
replacements and operation-key reuse return 409. Prose compatibility edits retain
unchanged runs/styles and fail when a replacement crosses protected objects,
paragraph boundaries or incompatible styles. Body and metadata edits use one
transaction. Responses identify acknowledged document revisions; exact operation
recovery returns the original receipt even after later changes.

With authority active, structure-save treats omitted IDs as explicit creation and
retains omitted existing entities. IDs are never inferred from an array position.
Act/chapter/scene deletion tombstones the hierarchy and preserves bodies/history.
Book deletion saves a restorable lifecycle revision; exact operation recovery and
complete restoration remain available to its owner. A book reset tombstones
structure and usage links, retaining revision and workflow
evidence; queued/running workflows must be paused or cancelled first. Every
successful document mutation commits its audit record with the revision and receipt.

Before acknowledging body/catalog changes, the service verifies the immutable head
checksum and refuses physical structure/canon or projection-count drift from
untracked writers. New manifests use the shared canonical hierarchy ordering;
historical hashes remain unchanged. Complete restoration verifies its selected
source checksum. These service guards supplement the separately reviewed database
enforcement migration; they do not establish that every legacy writer is migrated.

CLI `revise` resolves the CLI account (or an explicit local operator `--user-id`),
checks book/scene ownership, captures the document revision before inference, and
applies proposals as attributed pending changes. A concurrent formatting/layout
change rejects the resulting save even when plain text still matches. Failed
results retain their mutation operation ID for exact recovery.

CLI create, outline append, generation and codex creation also have authority
paths. Character generation captures its canonical source before inference and
commits a validated batch atomically. Invalid output creates no placeholders
when authority is active. This does **not** establish complete writer routing:
remaining browser/mobile/Hermes consumers, workflow provider recovery, canon-use
commands and historical legacy conversion still need migration.
Do not enable authority until those consumers and their acceptance gates pass.

## Recoverable scene generation

Scene regeneration, create-and-generate, saved prose batches and CLI generation
retain an immutable request intent before inference. The request includes source
book/scene/content hashes, frozen structure/canon and included/omitted codex IDs.
Provider output is persisted before application; an unknown transport outcome
cannot be replayed automatically. CLI `generate --scene-id ID --operation-id UUID`
recovers the original request rather than rebasing it onto newer revisions.
Changing the scene or RAG option conflicts with the retained command.

`GET /api/books/:bookId/document-inference-operations/:operationId` returns the
owned provider state, outcome and document application receipt. `POST` to its
`/cancel` child with an empty JSON body records cancellation, aborts the local
provider and lets other workers observe cancellation. Cancellation and application
serialize on the book lock: already committed work remains committed; late output
is retained but cannot be applied. A cancelled call without acknowledged output
still has an unknown provider outcome. Cancellation does not claim that an
external provider rolled back its work.

Full discussion/proposal integration, pre-inference context disclosure, revision
and outline/character provider journals, complete model provenance, workflow
effect recovery and post-commit memory integration remain required.

## Workflow/editorial revision references and fences

Native structured revisions also create immutable `ManuscriptRevision` compatibility
records with the same revision ID. Their snapshots contain only the canonical
manifest reference and projection, avoiding a full-manuscript rewrite on each edit.
Mappings identify those native references explicitly. Workflow admission reads
existing native references without an implicit write; an admitted shared-resource
claim has not yet begun execution. Historical legacy records,
hashes and snapshots stay unchanged; missing historical conversion mappings fail
visibly rather than selecting a newer source.

Workflow/editorial source materialization reads the exact immutable scene, structure
and canon references. Compatibility editorial application checks exact source text
and revision identities, records attributed changes, and recovers the same operation
receipt. With authority active, passage application requires its supplied offsets to
match exactly; it does not relocate a target by quotation search. Complete restoration
requires an expected head; superseded automated rollback preserves newer work.

Authenticated Factory requests establish an internal mutation context. The document
service checks that actor, resource scope, live workflow lease, cancellation and
retained shared-resource fences inside the transaction. It holds fence rows through
commit and checks authority again before acknowledgement. Detached workflows use
their persisted execution context rather than the initiating HTTP request lifetime.

## Backfill and recovery

Run `npm run documents:backfill` from Factory for a preview. `-- --apply` performs
an explicit, idempotent backfill. Fence all manuscript writes first. Repeated
backfill verifies body/projection and catalog hashes and rejects legacy drift.
It does not silently activate an older canonical head over later legacy writes. Original
prose, including null/empty distinctions and whitespace, stays in immutable
initial scene revisions. Existing manuscript-revision snapshots are untouched.

The current converter preserves raw text; legacy HTML classification/conversion,
historical revision mappings and complete writer activation are still
release blockers. Converted manifests restore body, structure, canon links, layout,
review state and immutable assets together. Newer entities become tombstones;
restoration retains their immutable documents and stable identities. SQL null and
JSON null in scene metadata remain distinct. Do not interpret this initial converter as completed migration.

Rehearse the new migration and backfill on an isolated restored database. Follow
the native deployment's Redis preflight, immutable earlier migration checks,
validated PostgreSQL backup, disposable migration and second-restore proofs.
No database restore may discard post-backup writes. After authority activation,
only document-compatible code can be rolled back into service.

## Package validation and DOCX

The owned headless exporter generates genuine OOXML, text insertions/deletions,
run property revisions, classic comments, rectangular tables, verified PNG/JPEG
images, basic page settings, headers and footers. It has no browser download or
network side effects. Unsupported image conversion, undefined named styles and disjoint/cross-story comment ranges fail visibly.

ZIP validation checks declared and actual expansion limits, paths, duplicates,
encryption, sizes, CRCs, XML and internal relationship targets. DTD/entity input
is rejected. A streaming preflight enforces XML depth/node/attribute limits before DOM allocation; invalid UTF-8 is rejected. External relationships are never fetched.

Native package tests and the independent Open XML SDK validator establish structural behavior for the synthetic corpus. The corpus includes reviewed whole-paragraph replacement with insertion/deletion paragraph marks and exact original/final projections. LibreOffice rendering/PDF checks and page inspection cover those fixtures only. Paragraph split/join and property revisions, import mapping, the full exchange corpus, unified publication jobs/history and Microsoft Word acceptance remain unfinished. See `document-tools/README.md` and the delivery ledger.

## Local verification

Use a disposable database and Redis; never point the full test suite at personal
manuscripts. The implementation fixture uses PostgreSQL on `127.0.0.1:55441` and
Redis on `127.0.0.1:56441`. These containers are separate from the existing local
Proser database and production services.

Run Factory typecheck, lint, smoke and database-backed document tests; run the
root `test:canvas` browser fixture for real Canvas serialization/reopening.
The full root/component gates and the complete acceptance ledger are required
before release.

## Revision-bound publication and DOCX import checkpoint

`documents/publication.ts` admits an owned publication job using an operation UUID
and expected book revision. Its immutable source manifest survives later edits.
Local rendering has a bounded lease; pending/failed jobs can explicitly resume the
same source, and cancellation prevents completion. Bytes, checksums, options,
source references, renderer/font versions and validation provenance persist in one
transaction before `completed`. Completed artifacts remain readable after newer
edits and have no deletion API. Author uses Factory capabilities and retained job
history rather than assumed format availability.

The pipeline writes genuine DOCX, EPUB 3, Chromium PDF, sanitized self-contained
HTML, supported Markdown, text and canonical JSON. DOCX section merging rebases
relationships, media, styles, numbering and native review/comment identifiers.
EPUB includes a review sidecar in retain-review mode; Markdown offers a separate
owned sidecar download. Final/original exports do not resolve manuscript changes.
Workflow publication, CLI export, the legacy manual export controller, and Markdown
artifact compatibility reads use this pipeline when structured authority is active.
Existing publication approval and workflow gates still apply to releases.

Install the exact upstream licensed fonts before rendering:

```bash
node scripts/install-publication-fonts.mjs /absolute/release/fonts
export PUBLICATION_FONT_MANIFEST=/absolute/release/fonts/manifest.json
```

The installer verifies the Liberation 2.1.5 and DejaVu 2.37 distribution checksums
from `config/publication-font-pins.json`, preserves licenses, and records each font
file digest. PDF embeds only verified font bytes and records requested-font
substitutions. Missing Chromium or a valid font manifest makes PDF unavailable.
The independent fixture generator is `scripts/publication-fixtures.ts`; invoke it
with an explicit isolated database and an absolute disposable output directory.

DOCX imports preserve exact original bytes before ZIP/XML preflight and conversion.
Preview exposes proposed heading chapters, canonical paragraphs/runs/tables/images,
imported insertions/deletions/run formatting changes/comments, and identified
losses. Commit requires the exact report digest, operation UUID and saved
book/structure/canon/layout revisions, appends new hierarchy IDs, and retains originals
and consent audit. Trusted source proof stamps the authenticated importer while
preserving imported author labels and original review timestamps. Unsupported
fields, complex layouts, cross-section/chapter comments and threaded
comments are disclosed; merged/irregular tables and alternative-content parts fail
conversion when safe preservation is unavailable. No external image is fetched.
These limitations remain delivery work, not completed Word scope.

This checkpoint's isolated evidence: 34 Factory focused tests and five Author UI
checks passed; all three multichapter DOCX modes passed OpenXML SDK structural
validation; retain-review EPUB passed EPUBCheck with no errors or warnings;
LibreOffice rendered all modes and QPDF accepted its final PDF. Two rendered pages
were inspected for chapter headers, font/style preservation, numbering and margins.
The full image/table/revision exchange corpus, large-manuscript publication timings,
restart/import draft recovery and Microsoft Word behavior remain unverified. Production activation remains disabled.

### Maintained codec and native paragraph checkpoint

Factory now consumes the independently versioned MIT headless codec fork from
`@hivemagnus/canvas-word-codec` from the shared `canvas-word` repository. Generic import/export returns neutral documents and
bytes; ownership, authenticated attribution, hierarchy allocation, originals,
consent, storage and publication authority stay in Factory. It retains exact
upstream source/tarball provenance, the 26-entry original closure and its notices
with JSZip's MIT alternative elected. The original browser bundle is excluded
from the rebuilt runtime. Actual runtime dependencies and embedded compiler/core
helpers are recorded in the exact release CycloneDX 1.6 SBOM. Core SVG icons and
MIT glyph source are inventoried; external font/raster distributions are separate.

The standalone corpus now covers paragraph property snapshots (`w:pPrChange`),
paragraph split/join marks, whole-paragraph revisions, logical original/final
views, table-cell boundaries, cursor comments, native page breaks, section
layouts/stories and positioned inline PNG/JPEG assets. Factory publication
projects logical paragraphs and original paragraph styles without rewriting
physical identities. Imports preserve each mapped section's layout and create
owned immutable references for inline assets in paragraphs, cells and stories.
The original is retained before conversion, and explicit report consent remains
a commit precondition. Cross-section/chapter comments are reported until their
complete scope model is delivered; they are never silently relocated.

This checkpoint passed 23 standalone codec tests and 31 isolated Factory
import/publication tests, including a durable owned-image import commit. Nine
paragraph-property/split/join DOCX fixtures passed OpenXML SDK 3.5.1 validation,
LibreOffice 7.4.7.2 rendering and QPDF 11.3.0 checks. The paragraph-format final
page was inspected for alignment, numbering, margins and clipping. A packed
codec installed with frozen `npm ci --omit=dev` exported/reimported a fixture
without a compiler. These are bounded fixture results; they do not establish
complete layout, Microsoft Word or production acceptance. Production remains
inactive.

Build both forks, generate `docs/canvas-release-evidence.json` and
`docs/canvas-release-sbom.json` using `scripts/generate-canvas-release-ledger.mjs`,
and repeat with `--check`. Evidence binds exact tarball integrity, source/emitted
file hashes, final bundled module closure and all retained notices. Regenerate
after any source/build/notice change. Native deployment checkpoints existing
vendor/config/fonts and syncs the built codec before runtime frozen install;
checksum-pinned upstream font archives and their licenses remain part of the
release. No production activation follows merely from packaging these bytes.

The publication job summary now exposes bounded fidelity losses and actual font
substitutions to Publish Center beside artifact downloads; source/provenance
retention remains immutable. Native DOCX precision rounds fractional pixel font
sizes to Word half-points with an explicit report. Detached comments preserve
source anchors/history in sidecars and visible markup notes; they never acquire
guessed native Word ranges. Rich print header/footer stories render sanitized
complete owned paragraph/table/image documents through self-contained 300-DPI PNG margin graphics
with verified embedded fonts, while page counters remain live print counters.
All three Chromium fixture modes passed QPDF/text extraction; the first final
page was inspected for header/footer placement, glyphs, fonts and numbering.

A LibreOffice native-paragraph re-export preserved paragraph-property/split/join
records and imported author/time, but the independent validator rejected its
charset attributes, list-level alignment and property ordering. The importer now
reports those unrepresented/invalid source properties before consent; raw
original bytes and the permanent report remain available. Its logical indentation
attribute mapping preserves the complete supported before/after property values.
LibreOffice round-trip structural success is therefore unverified, alongside
Microsoft Word acceptance. Factory-generated native packages passed validation.

### Owned header/footer authority and rendering evidence

`BookLayoutSnapshot.headerFooterStories` stores book/chapter-owned canonical documents,
including tables, images and review records. Corresponding layout fragments are empty
read-only compatibility fields. Imports retain complete story graphs in immutable previews,
then allocate owned story IDs and attest the separated body/story graphs against the original
conversion before stamping authenticated imported provenance. Historical fragments stay exact;
explicit upgrade commits create new layout revisions.

The synthetic `scripts/owned-story-fixtures.ts` corpus validates all three native DOCX modes
with Open XML SDK and checks six PDFs from LibreOffice and Chromium. Rendered final/markup
pages were inspected: two-cell tables, blue inline PNGs, bold/color/italic/underline,
review markup and page counters are visible without clipping. Chromium margin stories use
300-DPI graphics; body text stays semantic. Oversized stories fail visibly before artifact completion.

Word ignores header/footer comment anchors, per [Microsoft’s specification](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/64b95366-980f-4c75-9519-b745345ded9a).
Canonical story comments remain available in Proser, semantic HTML/PDF markup and immutable
review sidecars, with a specific publication fidelity report. Native body/table-cell classic
comments remain supported. Unsupported source ranges appear in the import fidelity report
before consent. No valid package or LibreOffice result establishes exact Microsoft Word behavior.

Compatibility Markdown artifact creation under active authority requires an operation UUID
and exact expected manifest revision. Hermes negotiates capabilities, forwards those
preconditions and recovers its original publication job after a lost acknowledgement.
Its UUID artifact bytes and history remain readable after newer edits; active deletion
returns an immutability conflict. JSON original/final exports project text, formatting
and logical paragraph boundaries without accepting changes in the saved manuscript.
Authenticated review-resolution history stays in Factory provenance/sidecars; the neutral
codec receives only exchange metadata and resolved review status.

Native DOCX comment ranges are capped at Word’s documented 32767 aggregate limit
across merged scenes, including point comments. Oversize retain-review requests fail
visibly before serialization; final/original projections remain available and disclose
that native review was omitted. Independent Poppler pixel fixtures verify visible inline
images in both margin stories and final color formatting in all six renderer outputs.

### Named styles and selected cover publication

Book-owned paragraph/character style IDs retain exact Unicode display labels, inherited
formatting and explicit run overrides. DOCX imports namespace safe IDs against original
bytes, preserve definitions in immutable previews and attest the merged style graph before
commit. The generated Author contract uses the same pure effective-style resolver. Native
Word styles and formatting revision references retain their names and properties. Three
named-style modes passed OpenXML SDK 3.5.1 and EPUBCheck 4.2.6; six LibreOffice/Chromium PDFs
passed QPDF/font/text checks. Final/original rendered pages were inspected for centered
paragraph inheritance, red italic Mono versus original blue Sans, explicit nonbold runs,
Unicode glyphs and bold paragraph defaults. Microsoft Word remains unverified.

Saved/print-book presets include the book cover from its exact manifested structural asset
reference. EPUB declares the cover-image and landmark. Submission-manuscript omits it with
an explicit fidelity message. Reselection after job admission cannot change that source.
Publication verifies actual bounded PNG/JPEG/static WebP headers and selected intrinsic
metadata as well as ownership and byte digests; historical malformed images fail visibly.
Chapter/scene selected artwork remains structural evidence, not implicit body insertion.

### Theme snapshots and WebP-derived Word images

The codec resolves validated internal Word theme Latin fonts and document defaults into
explicit font/color values. Source RGB caches retain tint/shade snapshots; transforms
without a cache are marked as approximate before consent. Dynamic theme associations,
separate script font slots, used table styles and flattened paragraph parent-style links
are reported. Character parent-style links round-trip through native `w:basedOn`; imported
named paragraph references retain direct overrides without copying inherited properties
into each block. These guarantees follow the supported explicit properties; they do not
claim a complete editable Word theme/paragraph-style graph. See Microsoft's
[basedOn](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.basedon?view=openxml-3.0.1)
and [theme color behavior](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/8229a077-7fc8-4fba-96cc-c77b6a4fc768).

Factory derives bounded static WebP images into PNG only for DOCX export through pinned
Chromium. Source bytes/references never change. Artifacts record both digests, dimensions,
method and renderer version; fidelity explicitly identifies the derivative. Tests compare
exact decoded pixels and verify immutable owned-source bytes. Fractional named font sizes
now disclose native half-point rounding. Unavailable PDF font families use reported pinned
substitutes, including inherited styles. Rich blank margin stories no longer stall raster
rendering. This batch passed 26 standalone codec tests and 58 isolated Factory tests.
Source/converted theme and WebP fixtures passed five SDK3.5.1 packages, three
EPUBCheck4.2.6 packages and nine independently checked PDFs; rendered source/body color,
font and image pages were inspected. Exact Microsoft Word behavior remains unverified.

### Bounded scene passages

`GET /api/books/:bookId/scenes/:sceneId/document-passages` pins the current or
requested immutable book manifest and returns final-view paragraph/table-cell
slices. Query `paragraph` and `offset` identify a revision-bound cursor; offsets
are UTF-16 and must be grapheme boundaries. Responses are limited to 32,768
characters, 64 paragraphs and 256 KiB including source/review metadata. Each
visible run carries its complete immutable run hash and the returned source span.
The response never embeds complete source paragraphs or table neighbours.

`POST` to the same path applies up to 32 qualified single-run text replacements
through the document service, using the exact book revision, scene revision,
window hash and operation UUID. Factory derives complete changed documents,
authenticates manual tracked attribution, validates assets/styles/review state,
and stores a sparse receipt with scene references and the committed passage.
Recover that operation through the existing owned operation endpoint after a lost
acknowledgement. Repeating the identical request returns its original receipt;
changed UUID payloads and stale heads reject. No browser upload of the entire
scene is required.

`POST .../document-passages/restore` restores a complete owned immutable scene
revision through Factory using exact current book/scene/window preconditions.
It creates a new revision, checks complete restoration evidence, and returns
`{ restoredFromRevisionId, passage }` with sparse changed scene references.
The browser does not fetch or upload the complete historical body. Identical
operation recovery returns the original restoration receipt; a superseded head
rejects before restoring.

This initial operation contract does not yet cover formatting, paragraph
structure or protected-object edits. Passage responses explicitly report omitted
block objects/comments; clients must disclose these limits and cannot treat a
slice as a complete scene. Complete workspace integration and single-giant-scene
browser performance remain migration requirements.

### Publication glyph proof and secure large-paragraph exchange

PDF publication now inspects Chromium’s actual PostScript faces through
`CSS.getPlatformFontsForNode`. It records installed font versions/digests and
inspected face usage for body and each owned header/footer story. Coverage is
explicit: every computed typography group and its complete unique-code-point
probe, plus an original representative source node per group. This is bounded
face/character-coverage evidence, not proof of exact shaping or Microsoft Word
layout. Margin counter nodes are not exposed by this inspection; their declared
font stack remains pinned and is identified separately in provenance.

The font’s bounded sfnt name/cmap metadata verifies each reported face and
required character. Missing glyphs or system/unpinned fallback fail with a visible
422, retain the source and leave an owned recoverable failed publication job.
Verification is capped at 4096 typography groups, 65536 distinct code points per
group and one million points across probes; exceeding these limits returns 413.
Pinned emoji/combining faces, unavailable CJK, malformed font metadata, bounded
verification and durable job recovery have dedicated acceptance fixtures.
Owned story defaults now use the story’s canonical font and size, with disclosed
substitution; chapter/book settings continue to own page geometry.

ZIP export measures level-9 compressed entry size and stores any entry exceeding
190:1 expansion. Secure import still rejects all packages exceeding its original
200:1 limit; no trusted-source bypass is used for reimport. A 300000-word single
paragraph (1.5 MiB of exact prose) exports and securely reimports unchanged; an
independently compressed external expansion bomb still fails preflight.


The final publication-focused checkpoint passes 67 tests across eight Factory
suites, 33 standalone maintained-codec tests, and eight Publish page tests.
Factory typecheck/lint/build and the exact rebuilt fork ledger check pass.
The production-omit-dev codec tarball installs without a compiler, securely
reimports 300000 exact words and has no runtime npm advisories. The release
SBOM retains 39 components and 13 dependency nodes, including original embedded
closure evidence; every emitted/source file and exact distribution digest is
inventoried. These are local checkpoints, not production activation evidence.

Independent conventional-manuscript evidence uses 300000 words in 600 paragraphs
and verifies every extracted source word in LibreOffice and Factory PDFs,
with valid native OOXML and secure exact reimport. Factory timings on this
local profile were approximately 365 ms DOCX, 150 ms reimport and 1950 ms PDF.
A distinct 300000-word single-paragraph stress case passed Factory PDF extraction
and SDK/secure DOCX import; its initial LibreOffice 2-GiB-profile render attempts
exceeded 120 seconds. Stale locks from killed conversions were identified and
retained; clean 8-GiB-profile rendering then passed in 141 seconds with no OOM events.
The earlier centered-counter candidate (before the empty-line typography
codec checkpoint) also passed a clean 2-GiB/2-CPU profile
within 600 seconds (about 141 seconds, 278769664-byte memory peak), including
exact 300000-word extraction from both renderers and inspected first/final pages.
The Factory PDF had 333 pages and LibreOffice had 340; renderer pagination
differences remain explicit, without a Microsoft Word fidelity claim. No Microsoft Word
limit is inferred from these LibreOffice results.

Generated PAGE-only footer paragraphs now center the counter consistently with
Factory’s print template. Explicit owned footer paragraph alignment remains
unchanged. Bidirectional/vertical/frame layouts, multi-column sections and
first/even story variants have specific conversion losses before consent; default
stories are selected independently of source relationship order.


The retained inactive checkpoint also fixes owned-story and empty-line defaults.
Theme/docDefaults initialize imported header/footer canonical layout; native
exports retain each owned story’s font/size defaults with named/direct overrides.
Empty paragraph marks and empty runs retain font properties and native formatting
revision snapshots. Original/final HTML line boxes resolve the same paragraph and
character style chains. Word input without PAGE fields no longer gains counters.
An independent source plus three projected DOCX modes passed SDK validation;
seven LibreOffice/Factory PDFs passed QPDF, measured noncollapsed body/cell line
gaps and original/final size differences. Rendered source/final/original pages
were inspected. This source checkpoint is inactive and is not production
activation or exact Microsoft Word acceptance evidence. Prior giant-paragraph
checks remain bound to their historical source/package hashes.


Checkpoint coverage stabilization uses fixed browser script sources for story
measurement and bitmap decode; Node Istanbul counters must not be serialized
into Chromium. The four affected import/publication/font/image suites pass
51 tests with coverage enabled, global thresholds intact and open-handle
detection clean. A metadata-bounded VP8 frame rejected by Chromium verifies
that image conversion cannot publish a replacement after decoder failure.
The earlier eight-suite 67-test run predates this additional regression.
