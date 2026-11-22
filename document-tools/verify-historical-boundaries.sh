#!/usr/bin/env bash
set -euo pipefail
fixtures=/fixtures/historical-boundaries
output=/output/historical-boundaries
mkdir -p "$output/libreoffice" "$output/chromium"
dotnet /opt/validator/Validator.dll "$fixtures/final.docx" "$fixtures/original.docx" "$fixtures/retain-review.docx" "$fixtures/accepted.docx" "$fixtures/rejected.docx" > "$output/ooxml-validation.jsonl"
bash /opt/render-docx.sh historical-boundaries "$output/libreoffice" "$fixtures/final.docx" "$fixtures/original.docx" "$fixtures/retain-review.docx" "$fixtures/accepted.docx" "$fixtures/rejected.docx"
for mode in final original retain-review accepted rejected; do
  java -jar /usr/share/java/epubcheck.jar "$fixtures/$mode.epub" > "$output/$mode.epubcheck.txt" 2>&1
  for renderer in libreoffice chromium; do
    source="$output/$renderer/$mode.pdf"
    if [[ "$renderer" == chromium ]]; then source="$fixtures/$mode.pdf"; fi
    qpdf --check "$source" > "$output/$renderer/$mode.validation.txt"
    pdftotext -layout "$source" "$output/$renderer/$mode.txt"
    pdftoppm -scale-to 1400 -png -singlefile "$source" "$output/$renderer/$mode"
  done
done
python3 - "$fixtures" "$output" <<'PY'
import json, pathlib, re, sys, zipfile
fixtures, output = map(pathlib.Path, sys.argv[1:])
source = json.loads((fixtures / 'source.json').read_text())
old = source['changes'][0]
assert old['historicalBoundarySource'] and old['resolutionHistory']
for evidence in json.loads((fixtures / 'evidence.json').read_text())['modes']:
    name = evidence['name']
    sidecar = json.loads((fixtures / (name + '.review.json')).read_text())
    assert sidecar['sections'][0]['changes'][0] == old
    with zipfile.ZipFile(fixtures / (name + '.docx')) as archive:
        xml = archive.read('word/document.xml').decode()
    assert 'Historical Word reviewer' not in xml and 'historicalBoundarySource' not in xml
    assert len(re.findall(r'<w:del\s', xml)) == (1 if name == 'retain-review' else 0)
    if name == 'retain-review': assert 'Current editor' in xml
    for renderer in ['libreoffice', 'chromium']:
        text = (output / renderer / (name + '.txt')).read_text()
        lines = [line for line in text.splitlines() if not re.fullmatch(r'\s*\d+\s*', line)]
        assert ''.join(''.join(lines).split()) == ''.join(evidence['text'].split()), (name, renderer, text)
print('Exact historical proof/history sidecars and current native revisions passed across five modes; both renderers preserve body text.')
PY
sha256sum "$fixtures"/*.docx "$fixtures"/*.epub "$fixtures"/*.pdf "$fixtures"/*.review.json "$output/libreoffice"/*.pdf > "$output/checksums.txt"
printf '%s\n' 'Historical re-edit native/sidecar structure, five EPUBs and ten PDFs pass. Inspect rendered pages; Microsoft Word remains unverified.'
