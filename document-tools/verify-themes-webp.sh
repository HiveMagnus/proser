#!/usr/bin/env bash
set -euo pipefail
renderer="$(dirname "$0")/render-docx.sh"
fixtures=/fixtures
output=/output/theme-webp
mkdir -p "$output/themes" "$output/webp" "$output/chromium"
dotnet /opt/validator/Validator.dll "$fixtures/word-themes/source.docx" "$fixtures/word-themes/final.docx" "$fixtures/word-themes/original.docx" "$fixtures/word-themes/retain-review.docx" "$fixtures/webp/final.docx" > "$output/ooxml-validation.jsonl"
bash "$renderer" theme-profile "$output/themes" "$fixtures/word-themes/source.docx" "$fixtures/word-themes/final.docx" "$fixtures/word-themes/original.docx" "$fixtures/word-themes/retain-review.docx"
bash "$renderer" webp-profile "$output/webp" "$fixtures/webp/final.docx"
for mode in final original retain-review; do
  java -jar /usr/share/java/epubcheck.jar "$fixtures/word-themes/$mode.epub" > "$output/$mode.epubcheck.txt" 2>&1
  cp "$fixtures/word-themes/$mode.pdf" "$output/chromium/theme-$mode.pdf"
done
cp "$fixtures/webp/final.pdf" "$output/chromium/webp.pdf"
for pdf in "$output"/*/*.pdf; do
  qpdf --check "$pdf" > "${pdf%.pdf}.validation.txt"
  pdftotext -layout "$pdf" "${pdf%.pdf}.txt"
  pdffonts "$pdf" > "${pdf%.pdf}.fonts.txt"
  pdftoppm -scale-to 1400 -png -singlefile "$pdf" "${pdf%.pdf}"
done
grep -Fq 'LiberationMono' "$output/themes/source.fonts.txt"
grep -Fq 'LiberationMono' "$output/themes/final.fonts.txt"
grep -Fq 'Theme defaults' "$output/themes/final.txt"
grep -Fq 'Verified WebP body image' "$output/webp/final.txt"
grep -Fq 'THEME_FONT_ASSOCIATION' "$fixtures/word-themes/conversion.json"
grep -Fq 'THEME_COLOR_TRANSFORM_CACHED' "$fixtures/word-themes/conversion.json"
grep -Fq 'chromium-static-webp-to-png' "$fixtures/webp/derivation.json"
sha256sum "$fixtures/word-themes"/*.docx "$fixtures/webp"/*.docx "$fixtures/webp/original.webp" "$output"/*/*.pdf > "$output/checksums.txt"
printf '%s\n' 'Theme source and converted packages plus derived-PNG DOCX validate; three EPUBs and nine independent PDFs pass. Inspect rendered theme colors and WebP image; dynamic associations/transform precision remain disclosed, Microsoft Word unverified.'
