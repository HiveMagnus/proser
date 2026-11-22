#!/usr/bin/env bash
set -euo pipefail
renderer="$(dirname "$0")/render-docx.sh"
mkdir -p /output/native-paragraphs
# Caller supplies only synthetic packages and mounts originals read-only.
dotnet /opt/validator/Validator.dll /fixtures/native-paragraphs/*.docx > /output/native-paragraphs/ooxml-validation.jsonl
bash "$renderer" native-paragraph-profile /output/native-paragraphs /fixtures/native-paragraphs/*.docx
for file in /output/native-paragraphs/*.pdf; do
  qpdf --check "$file" > "$file.validation.txt"
  pdftotext -layout "$file" "$file.txt"
  pdftoppm -scale-to 1400 -png -singlefile "$file" "${file%.pdf}"
done
# Projection must join exactly the revised boundary, without losing either side.
grep -Fq 'Left paragraph.Right paragraph.' /output/native-paragraphs/paragraphJoin-final.pdf.txt
grep -Fq 'Left paragraph.Right paragraph.' /output/native-paragraphs/paragraphSplit-original.pdf.txt
for file in /output/native-paragraphs/*.pdf.txt; do
  grep -Fq 'Left paragraph.' "$file"
  grep -Fq 'Right paragraph.' "$file"
done
{
  dotnet --version
  libreoffice --version
  qpdf --version
  dpkg-query -W libreoffice-writer poppler-utils qpdf epubcheck
} > /output/native-paragraphs/tool-versions.txt
sha256sum /fixtures/native-paragraphs/*.docx /output/native-paragraphs/*.pdf > /output/native-paragraphs/checksums.txt
