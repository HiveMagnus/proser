# Isolated document tools

This testing image contains a read-only independent OOXML validator built with
Open XML SDK 3.5.1 (MIT), LibreOffice, Poppler, QPDF and EPUBCheck. The .NET base
is pinned by registry digest; NuGet's exact dependency hashes are retained in
`validator/packages.lock.json`. Fonts come directly from the upstream Liberation 2.1.5 and DejaVu 2.37 distributions; archive hashes and license locations are retained in `font-pins.json`. Tool/package versions are recorded with each
fixture run. These tools are development checks, not Factory runtime services.

After `npm run build`, create synthetic fixtures with
`node scripts/create-document-fixtures.mjs /tmp/proser-document-fixtures`.
Build with `docker build -t proser-document-tools:canvas-foundation document-tools`
(use `DOCKER_BUILDKIT=0` where Buildx is unavailable). Mount the fixture directory
read-only at `/fixtures` and a separate empty output directory at `/output`, then
run `/bin/bash /opt/verify-fixtures.sh` with `--network none`, bounded CPU/memory
and process limits. Never mount personal manuscripts or production state.

Inspect `/output/pages/*.png` and `/output/paragraphs/*.png`. Successful XML validation and PDF checks do not
establish import round-trip fidelity or exact Microsoft Word behavior. The
current corpus covers runs, revisions, classic comments, tables, repeated image
references, lists, headers/footers, page geometry and projection choice, plus
whole-paragraph insertion/deletion review fixtures. The separate
`ProserFactory/scripts/native-paragraph-fixtures.mjs` corpus covers native
paragraph split/join/property revisions in original/final/markup views. Validate
all nine DOCX packages with the same independent validator, render them through
LibreOffice, inspect pages and retain tool versions/checksums. Complex layouts,
the full exchange corpus and production acceptance remain required work.

`ProserFactory/scripts/owned-story-fixtures.ts` generates full owned header/footer
paragraph/table/image/review graphs in native DOCX, Chromium PDF, semantic HTML and
review sidecars. Set `PUBLICATION_FONT_MANIFEST` to a checksum-verified installation
from `install-publication-fonts.mjs`; run the source fixture from Factory with an
explicit isolated database URL (no database reads/writes occur in this renderer).
Mount these fixtures at `/fixtures/owned-stories` and run `/opt/verify-owned-stories.sh`.
All three DOCX modes must pass SDK validation; six PDF files must pass QPDF and
body/source text checks. Inspect both renderers’ pages for glyphs, images, tables,
review markup, margins and counters. Word ignores header/footer comments; they remain
in explicit sidecars and Proser semantic markup, with a specific fidelity report.

The owned-story verifier also decodes bounded Poppler PPM rasters with Python stdlib
and requires visible blue inline-image pixels in both margins for every mode/renderer,
plus final red-format pixels. Native LibreOffice markup may use reviewer colors. These
checks catch missing drawing/rendering failures; manual full-page inspection remains
part of acceptance. The range-limit corpus rejects more than 32767 native Word comment
ranges before serialization, including point comments across merged scopes.


Source renderer fixtures retain `<mode>.renderer.json` alongside PDF bytes. These
records contain Chromium version, verified installed fonts, substitutions and
actual CDP PostScript face usage for body/story text. The declared coverage checks
all computed typography groups and code points, with representative original
nodes; it does not establish full shaping fidelity or inspect browser margin
counter pseudo-nodes. Missing Unicode glyph coverage and unpinned fallback reject
publication visibly instead of completing a PDF with silent missing glyphs.


`large-paragraph-publication-fixtures.ts OUTPUT [PARAGRAPHS]` exports 300000
synthetic words, securely reimports exact DOCX text and retains DOCX/PDF timings
and actual font usage. CI separately checks a giant single paragraph through
SDK and Factory PDF extraction, then a conventional 600-paragraph manuscript
through SDK, LibreOffice and Factory with complete 300000-word extraction.
Run `verify-large-paragraph.sh large-paragraph` manually for the bounded
LibreOffice giant-paragraph stress profile; it requires new PDF bytes and never
interprets command exit zero alone as success. This stress result remains
separate from conventional-manuscript acceptance and Microsoft Word behavior.

All standard LibreOffice checks use `render-docx.sh`: a fresh output directory
and temporary profile per invocation, retained command logs/checksums and a
mandatory newly generated PDF for every source. A timed-out process may leave
output locks; reused files cannot establish a later conversion. Unit fixtures
verify that exit zero without a new PDF rejects even if an old valid PDF exists.


`empty-line-font-fixtures.ts` retains a theme/docDefaults Word source with blank
body, named table-cell, header and footer paragraphs. The three projected modes
include an empty-run font-size revision. `verify-empty-line-fonts.sh` validates
all four native packages and checks measured noncollapsed line gaps and original/
final size changes in seven fresh LibreOffice/Factory PDFs. Inspect the retained
rasters; this fixture establishes tested typography behavior for the inactive
checkpoint and does not establish exact Microsoft Word rendering.

`historical-boundary-publication-fixtures.ts` and `verify-historical-boundaries.sh`
exercise a resolved imported split followed by a current join, including replaced
old paragraph identity, accepted/rejected current decisions and all three export
modes. Detached historical marks remain in exact Proser sidecars; only the current
pending mark appears in native XML. Standalone scene EPUBs must retain a valid
navigation entry even without a chapter-start section.

The actual LibreOffice DOCX-save corpus is distinct from DOCX-to-PDF rendering.
`ProserFactory/scripts/verify-libreoffice-roundtrips.ts FIXTURES RETURNED OUTPUT`
checks exact final/original body/story text, native revision kinds/attribution/dates
and classic comment source ranges, then rebuilds seven converted packages for an
independent SDK check. The retained LibreOffice7.4 source packages contain schema
and font-association defects; their validation failures remain explicit. A returned
empty-run formatting source with duplicate property sets and a misplaced revision
fails conversion instead of silently losing review. Originals must remain preserved.
This corpus does not establish exact Microsoft Word or cross-application typography.
See `release-r4-r5-evidence.json` for isolated release evidence and its limits.
