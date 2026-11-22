#!/usr/bin/env bash
set -euo pipefail
renderer="$(dirname "$0")/render-docx.sh"
fixtures=/fixtures/owned-stories
output=/output/owned-stories
mkdir -p "$output/libreoffice" "$output/chromium"
dotnet /opt/validator/Validator.dll "$fixtures/final.docx" "$fixtures/original.docx" "$fixtures/retain-review.docx" > "$output/ooxml-validation.jsonl"
bash "$renderer" owned-story-profile "$output/libreoffice" "$fixtures/final.docx" "$fixtures/original.docx" "$fixtures/retain-review.docx"
dpkg-query -W epubcheck > "$output/epubcheck-version.txt" 2>&1
for mode in final original retain-review; do
  java -jar /usr/share/java/epubcheck.jar "$fixtures/$mode.epub" > "$output/$mode.epubcheck.txt" 2>&1
  cp "$fixtures/$mode.pdf" "$output/chromium/$mode.pdf"
  for renderer in libreoffice chromium; do
    qpdf --check "$output/$renderer/$mode.pdf" > "$output/$renderer/$mode.validation.txt"
    pdfinfo "$output/$renderer/$mode.pdf" > "$output/$renderer/$mode.info.txt"
    pdftotext -layout "$output/$renderer/$mode.pdf" "$output/$renderer/$mode.txt"
    pdftoppm -scale-to 1400 -png -singlefile "$output/$renderer/$mode.pdf" "$output/$renderer/$mode"
    pdftoppm -scale-to 1400 -singlefile "$output/$renderer/$mode.pdf" "$output/$renderer/$mode"
    grep -Fq 'Body remains semantic' "$output/$renderer/$mode.txt"
  done
done
python3 /opt/verify-story-rasters.py "$output"/*/*.ppm > "$output/raster-validation.jsonl"
# Native Word text stays selectable; Chromium renders complete rich margin stories
# as verified 300-DPI graphics, so their text is checked in the semantic HTML.
grep -Fq 'New header' "$output/libreoffice/final.txt"
grep -Fq 'New footer' "$output/libreoffice/final.txt"
grep -Fq 'Old header' "$output/libreoffice/original.txt"
grep -Fq 'Old footer' "$output/libreoffice/original.txt"
if grep -Fq 'Old header' "$output/libreoffice/final.txt"; then exit 1; fi
if grep -Fq 'New header' "$output/libreoffice/original.txt"; then exit 1; fi
grep -Fq 'Blue header square' "$fixtures/final.html"
grep -Fq 'Story reviewer: Cell comment' "$fixtures/retain-review.html"
grep -Fq 'header-source' "$fixtures/review.json"
{
  dotnet --version
  libreoffice --version
  qpdf --version
  dpkg-query -W libreoffice-writer poppler-utils qpdf
} > "$output/tool-versions.txt"
sha256sum "$fixtures"/*.docx "$fixtures"/*.epub "$fixtures"/*.pdf "$output"/*/*.pdf > "$output/checksums.txt"
printf '%s\n' 'Owned table stories: three valid DOCX packages and six independently checked PDFs. Inspect rendered pages for rich story fidelity; native Word header/footer comments are unsupported, preserved in sidecars and semantic markup.'
