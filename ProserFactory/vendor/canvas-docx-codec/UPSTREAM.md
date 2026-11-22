# Maintained headless Canvas DOCX codec

MIT fork of `@hufe921/canvas-editor-plugin-docx` 1.0.0 at upstream commit
`4741a9f8885d57fde1704d39a7aa930aeadc51e6`. Current independent version is
`1.0.0-proser.5`. Original source and manifest are retained in `upstream/`;
its source lock and legally retained closure inventory are in `provenance/`.

The current upstream browser DOCX source is independently retained in
`upstream-current/` at plugin monorepo commit
`0e8a1b36c8e94061edc19ce05b93c12fbad03b34`, including merged optional-download
PR 45. `provenance/upstream-current.json` binds that snapshot to its exact source.
Original npm source, lock and license closure remain unchanged. Both snapshots
are provenance; the maintained headless runtime still returns bytes without a
browser download. Public headless proposal PR 46 remains open and is not claimed
as accepted upstream. This version refreshes provenance without changing the
neutral runtime exchange API or its behavior.

The runtime entry is `src/index.ts`, a headless rewrite of the exchange boundary.
It returns bytes and a neutral Word exchange document. Canvas UI commands,
browser downloads, application databases, authenticated attribution, book/scene
identity, hierarchy mapping, publication approval and network access are absent.
Applications supply verified image bytes and persist originals/review/receipts.

The archived browser plugin is not a runtime entry and is never bundled. The
new runtime uses bounded XML/ZIP parsers and a buffer ZIP writer; JSZip, Color
and the original docx JavaScript package are not linked into this fork release.
Their verified 26-package upstream closure and notices remain provenance
evidence, with JSZip's MIT alternative explicitly elected.

Version `1.0.0-proser.4` upgrades the maintained runtime to Zod 4.6.7 for
GHSA-mrhx-c7xc-m3w5. Original upstream snapshots and their historical dependency
inventories remain unchanged. Native exchange and rejection/fidelity corpora are
required for this dependency migration.

Version `1.0.0-proser.5` updates the compiler to TypeScript 6.0.3 and Node 24
types. The bounded XML/ZIP runtime dependencies and exchange behavior are
unchanged. Node module resolution is explicitly retained for this CommonJS build
with the TypeScript 6 deprecation acknowledgement.

## Patch registry

| Patch | Rationale | Fixture | Upstream status |
| --- | --- | --- | --- |
| application-controlled-headless-codec | Replace editor-bound export/import and automatic download with a neutral byte/document API; applications own all effects. | test/headless.test.cjs generic import/export without DOM, database or network | Local; full scope corpus required before submission |
| bounded-package-conversion | CRC, bounded decompression/XML, relationship validation, no remote image fetching, inert active content. | test/headless.test.cjs unsafe XML; Factory malformed ZIP/import tests | Local; not submitted |
| native-review-exchange | Map insertion/deletion, run property revisions and classic anchored comments rather than canvas visual traces. | Factory documentDocxImports/documentPublications; independent OpenXML/LibreOffice fixtures | Local; not submitted |
| native-paragraph-review | Preserve `w:pPrChange` and paragraph-mark insertion/deletion in original/final/markup views; keep physical block identity while projecting logical paragraphs. | test/native-paragraphs.test.cjs paragraph properties, split/join, table cells and whole paragraph changes; Factory semantic projection tests | Local; not submitted |
| positioned-assets-and-sections | Preserve inline raster drawings in run order across body, table cells and stories; expose neutral section ranges and layout documents while applications own hierarchy mapping. Preserve cursor comments and standalone page breaks. | test/headless.test.cjs inline/cursor/break fixtures; test/native-paragraphs.test.cjs section layouts; Factory owned inline import commit and semantic packages | Local; not submitted |
| owned-layout-stories | Accept neutral full header/footer documents; retain tables, inline images and native text/property revisions with part identity isolation. Word header/footer comment ranges are explicitly unsupported rather than invalidly emitted. | test/headless.test.cjs full story graphs; Factory retained import graph and attributed story review; scripts/owned-story-fixtures.ts independent SDK/LibreOffice/Chromium | Local; not submitted |
| native-comment-range-limit | Reject aggregate classic ranges beyond Word’s 32767 limit, including point anchors across merged scenes. Final/original projections omit native review without mutating input. | test/headless.test.cjs 34000 point ranges in 34 documents | Local; not submitted |
| complete-story-preflight | Detect unsupported features and missing/invalid source review dates across all Word XML parts, including header/footer stories. Preserve raw source and disclose epoch sentinel when a source timestamp is unknown. | test/headless.test.cjs header-only footnote and unknown-date fixtures | Local; not submitted |
| named-style-exchange | Preserve named paragraph and character definitions, Unicode display labels, direct overrides and property-revision style references; reject undefined/cyclic inheritance. Expose source definitions independently of application-owned namespacing. | test/headless.test.cjs named paragraph/character styles; Factory named-style import proof and scripts/named-style-fixtures.ts independent SDK/LibreOffice/Chromium/EPUBCheck | Local; not submitted |
| application-owned-section-titles | Allow applications to suppress automatically inserted headings while retaining section boundaries, so owned covers/templates control content. | Factory source-bound cover and generated chapter-title publication fixtures | Local; not submitted |
| theme-defaults-and-style-graphs | Resolve validated internal Latin theme fonts, document defaults and RGB snapshots; preserve native character basedOn graphs. Report flattened paragraph inheritance, dynamic theme associations, unsupported transforms/multiscript slots and used table styles before conversion consent. | test/themes.test.cjs; Factory retained theme preview consent; scripts/word-theme-fixtures.ts independent SDK/LibreOffice/Chromium/EPUBCheck | Local; not submitted |
| conditional-layout-fidelity | Detect bidirectional/vertical/frame layouts, multi-column sections and first/even story variants before conversion consent; select the default story independently of XML reference order. Original parts remain application-preserved. | test/themes.test.cjs conditional header order and exact Unicode source fixture | Local; not submitted |
| owned-story-empty-line-typography | Preserve per-story default fonts and sizes without overriding named/direct properties; initialize imported stories from resolved source defaults and retain paragraph-mark/empty-run font properties and native formatting snapshots. | test/themes.test.cjs theme defaults/body/cell/header/footer blanks; test/native-paragraphs.test.cjs empty formatting revision; Factory browser boxes and independent empty-line source/LibreOffice/Chromium fixtures | Local; not submitted |
| explicit-source-page-counters | Import PAGE numbering only when present; a Word source without a PAGE field must not acquire generated counters. | test/themes.test.cjs absent/present PAGE; independent empty-line source without counters | Local; not submitted |
| generated-page-counter-alignment | Center only the generated PAGE field paragraph to match the application’s default bottom-center counter position; retain explicitly aligned owned footer paragraphs. | test/native-paragraphs.test.cjs owned right footer/generated centered field; independent rich-story LibreOffice page inspection | Local; not submitted |
| bounded-export-compression | Store entries whose measured level-9 DEFLATE expansion would exceed 190:1, preserving the unchanged 200:1 secure import limit for all packages. Ordinary compressed entries and EPUB’s uncompressed first mimetype entry retain their package semantics. | test/headless.test.cjs exact 300000-word single-paragraph reimport and malicious external expansion rejection; Factory publication corpus | Local; not submitted |
| source-identifier-and-table-fidelity | Report missing/duplicate native property-revision IDs and unsupported source table alignment before conversion consent; retain original XML while independent canonical records and rebuilt OOXML receive valid unique identities. | test/headless.test.cjs source collision/alignment fixture; retained LibreOffice DOCX-save source/converted round trips | Local; not submitted |
| page-field-cache-and-ambiguous-review | Map supported complex footer PAGE fields to canonical counters without retaining a cached result as authored story text; handle split instructions and disclose unsupported positions. Reject duplicate run property sets or misplaced formatting revisions where exact review preservation is ambiguous. | test/headless.test.cjs cached/split PAGE and ambiguous native run properties; actual LibreOffice DOCX-save corpus | Local; not submitted |
| independent-runtime-provenance | Verify exact upstream archive/integrity and retain original 26-entry closure licenses while declaring actual rebuilt dependency closure. | build/release manifest and SBOM generation | Local; not submitted |

## Maintenance

Review upstream monthly and advisories continuously. Preserve base commit,
patch rationale, exact fixture coverage and upstream status for every change.
Upgrade pins only after the full compatibility corpus passes. A locally
released version does not imply upstream acceptance. Native paragraph properties, split/join marks and whole-paragraph insert/delete are
covered by the standalone native corpus. Full independent compatibility corpus and
Microsoft Word acceptance remain unverified.

Microsoft specifies that Word ignores comment anchors under headers/footers:
https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/64b95366-980f-4c75-9519-b745345ded9a .
The codec rejects exporting such native ranges; imports preserve their safe source
graph and report the limitation. Applications retain comments in explicit sidecars.
