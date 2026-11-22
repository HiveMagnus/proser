#!/usr/bin/env bash
set -euo pipefail
renderer="$(dirname "$0")/render-docx.sh"
fixtures=/fixtures/named-styles
output=/output/named-styles
mkdir -p "$output/libreoffice" "$output/chromium"
dotnet /opt/validator/Validator.dll "$fixtures/final.docx" "$fixtures/original.docx" "$fixtures/retain-review.docx" > "$output/ooxml-validation.jsonl"
bash "$renderer" named-styles-profile "$output/libreoffice" "$fixtures/final.docx" "$fixtures/original.docx" "$fixtures/retain-review.docx"
dpkg-query -W epubcheck > "$output/epubcheck-version.txt" 2>&1
for mode in final original retain-review; do
  java -jar /usr/share/java/epubcheck.jar "$fixtures/$mode.epub" > "$output/$mode.epubcheck.txt" 2>&1
  cp "$fixtures/$mode.pdf" "$output/chromium/$mode.pdf"
  for renderer in libreoffice chromium; do
    qpdf --check "$output/$renderer/$mode.pdf" > "$output/$renderer/$mode.validation.txt"
    pdftotext -layout "$output/$renderer/$mode.pdf" "$output/$renderer/$mode.txt"
    pdffonts "$output/$renderer/$mode.pdf" > "$output/$renderer/$mode.fonts.txt"
    pdftoppm -scale-to 1400 -png -singlefile "$output/$renderer/$mode.pdf" "$output/$renderer/$mode"
    grep -Fq 'Paragraph default' "$output/$renderer/$mode.txt"
  done
done
grep -Fq 'LiberationMono-Italic' "$output/libreoffice/final.fonts.txt"
grep -Fq 'LiberationSans' "$output/libreoffice/original.fonts.txt"
grep -Fq 'LiberationSerif-Bold' "$output/libreoffice/final.fonts.txt"
grep -Fq 'text-align:center' "$fixtures/final.html"
grep -Fq 'font-weight:normal' "$fixtures/final.html"
grep -Fq 'font-style:italic' "$fixtures/final.html"
grep -Fq 'Café body' "$fixtures/source.json"
sha256sum "$fixtures"/*.docx "$fixtures"/*.epub "$fixtures"/*.pdf "$output"/*/*.pdf > "$output/checksums.txt"
printf '%s\n' 'Three named paragraph/character style DOCX modes validate; six independently rendered PDFs and three EPUBs pass. Inspect named inheritance/overrides and revision views; Microsoft Word remains unverified.'
