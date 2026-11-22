#!/usr/bin/env bash
set -euo pipefail
renderer="$(dirname "$0")/render-docx.sh"
fixtures=/fixtures/native-comments
output=/output/native-comments
mkdir -p "$output"
dotnet /opt/validator/Validator.dll "$fixtures"/*.docx > "$output/ooxml-validation.jsonl"
bash "$renderer" native-comment-profile "$output" "$fixtures"/*.docx
for mode in final original retain-review; do
  qpdf --check "$output/$mode.pdf" > "$output/$mode.validation.txt"
  pdftotext -layout "$output/$mode.pdf" "$output/$mode.txt"
  pdftoppm -scale-to 1400 -png -singlefile "$output/$mode.pdf" "$output/$mode"
  grep -Fq 'Bold' "$output/$mode.txt"
  grep -Fq 'italic' "$output/$mode.txt"
  grep -Fq 'table tail' "$output/$mode.txt"
done
sha256sum "$fixtures"/*.docx "$output"/*.pdf > "$output/checksums.txt"
printf '%s\n' 'Classic comments: styled Unicode run range and table-cell paragraph range pass independent native structure/rendering checks. Inspect pages; Microsoft Word acceptance remains unverified.'
