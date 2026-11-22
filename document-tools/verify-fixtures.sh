#!/usr/bin/env bash
set -euo pipefail
renderer="$(dirname "$0")/render-docx.sh"
mkdir -p /output/pdf /output/text /output/pages /output/paragraphs
# This environment is for synthetic fixtures only. Conversion runs without
# network access; originals are mounted read-only by the caller.
dotnet /opt/validator/Validator.dll /fixtures/final.docx /fixtures/original.docx /fixtures/retain-review.docx > /output/ooxml-validation.jsonl
bash "$renderer" fixture-profile /output/pdf /fixtures/final.docx /fixtures/original.docx /fixtures/retain-review.docx
for mode in final original retain-review; do
  qpdf --check "/output/pdf/$mode.pdf" > "/output/pdf/$mode.validation.txt"
  pdfinfo "/output/pdf/$mode.pdf" > "/output/pdf/$mode.info.txt"
  pdftotext -layout "/output/pdf/$mode.pdf" "/output/text/$mode.txt"
  pdftoppm -scale-to 1400 -png -singlefile "/output/pdf/$mode.pdf" "/output/pages/$mode"
done
dotnet /opt/validator/Validator.dll /fixtures/paragraphs/final.docx /fixtures/paragraphs/original.docx /fixtures/paragraphs/retain-review.docx > /output/paragraphs/ooxml-validation.jsonl
bash "$renderer" fixture-profile /output/paragraphs /fixtures/paragraphs/final.docx /fixtures/paragraphs/original.docx /fixtures/paragraphs/retain-review.docx
for mode in final original retain-review; do
  qpdf --check "/output/paragraphs/$mode.pdf" > "/output/paragraphs/$mode.validation.txt"
  pdftotext -layout "/output/paragraphs/$mode.pdf" "/output/paragraphs/$mode.txt"
  pdftoppm -scale-to 1400 -png -singlefile "/output/paragraphs/$mode.pdf" "/output/paragraphs/$mode"
done
grep -Fq 'After first.' /output/paragraphs/final.txt
grep -Fq 'After second.' /output/paragraphs/final.txt
grep -Fq 'Before first.' /output/paragraphs/original.txt
grep -Fq 'Before second.' /output/paragraphs/original.txt
if grep -Fq 'Before' /output/paragraphs/final.txt; then exit 1; fi
if grep -Fq 'After' /output/paragraphs/original.txt; then exit 1; fi
# These checks catch wrong projection selection and missing stories/objects.
grep -Fq 'The tide grows.' /output/text/final.txt
grep -Fq 'The storm grows.' /output/text/original.txt
if grep -Fq 'storm' /output/text/final.txt; then exit 1; fi
if grep -Fq 'tide' /output/text/original.txt; then exit 1; fi
for mode in final original; do
  grep -Fq 'Fixture header' "/output/text/$mode.txt"
  grep -Fq 'Fixture footer' "/output/text/$mode.txt"
  grep -Fq 'Protected object' "/output/text/$mode.txt"
  grep -Fq 'First numbered item' "/output/text/$mode.txt"
done
{
  dotnet --version
  libreoffice --version
  qpdf --version
  dpkg-query -W libreoffice-writer poppler-utils qpdf epubcheck
  fc-match 'Liberation Serif'
  fc-match ':charset=1f600'
} > /output/tool-versions.txt
sha256sum /fixtures/*.docx /fixtures/paragraphs/*.docx /output/pdf/*.pdf /output/paragraphs/*.pdf > /output/checksums.txt
printf '%s\n' 'Fixture structure, projections, PDF integrity and extraction passed. Rendered pages require inspection; Word and import round trips remain unverified.'
