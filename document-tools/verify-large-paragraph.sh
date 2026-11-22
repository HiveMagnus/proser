#!/usr/bin/env bash
set -euo pipefail
fixture_name=${1:-large-paragraph}
mode=${2:-independent}
case "$fixture_name" in large-paragraph|large-manuscript) ;; *) exit 2 ;; esac
case "$mode" in independent|factory-only) ;; *) exit 2 ;; esac
fixtures=/fixtures/$fixture_name
output=/output/$fixture_name
mkdir -p "$output/libreoffice" "$output/chromium"
dotnet /opt/validator/Validator.dll "$fixtures/large.docx" > "$output/ooxml-validation.jsonl"
cp "$fixtures/large.pdf" "$output/chromium/large.pdf"
renderers=(chromium)
if [[ "$mode" == independent ]]; then
  set +e
  timeout --kill-after=10s 600s libreoffice -env:UserInstallation=file:///tmp/proser-large-paragraph-profile --headless --convert-to pdf --outdir "$output/libreoffice" "$fixtures/large.docx" > "$output/libreoffice-render.log" 2>&1
  command_status=$?
  set -e
  artifact_present=false
  [[ -s "$output/libreoffice/large.pdf" ]] && artifact_present=true
  printf '{"renderer":"LibreOffice","commandStatus":%d,"artifactPresent":%s,"timeoutSeconds":600}\n' "$command_status" "$artifact_present" > "$output/libreoffice-render.json"
  if [[ "$command_status" -ne 0 || "$artifact_present" != true ]]; then
    cat "$output/libreoffice-render.log" >&2
    printf 'LibreOffice rendering did not pass; commandStatus=%s, artifactPresent=%s. Source and Factory proof are retained.\n' "$command_status" "$artifact_present" >&2
    exit 1
  fi
  renderers+=(libreoffice)
else
  printf '{"renderer":"LibreOffice","status":"not-requested","coverage":"separate giant-paragraph stress corpus; this job checks SDK and Factory output only"}\n' > "$output/libreoffice-render.json"
fi
for renderer in "${renderers[@]}"; do
  qpdf --check "$output/$renderer/large.pdf" > "$output/$renderer/large.validation.txt"
  pdfinfo "$output/$renderer/large.pdf" > "$output/$renderer/large.info.txt"
  pdftotext -layout "$output/$renderer/large.pdf" "$output/$renderer/large.txt"
  pdffonts "$output/$renderer/large.pdf" > "$output/$renderer/large.fonts.txt"
  pdftoppm -f 1 -l 1 -scale-to 1400 -png -singlefile "$output/$renderer/large.pdf" "$output/$renderer/first"
done
python3 - "$output" "${renderers[@]}" <<'PY'
import re, sys, pathlib
root=pathlib.Path(sys.argv[1])
for renderer in sys.argv[2:]:
    tokens=re.findall(r'\S+', (root/renderer/'large.txt').read_text())
    words=[token for token in tokens if not token.isdigit()]
    assert len(words)==300000, (renderer, len(words))
    assert all(word=='word' for word in words), renderer
print('Every source word is preserved in checked PDF extraction(s): '+', '.join(sys.argv[2:]))
PY
sha256sum "$fixtures"/large.docx "$fixtures"/large.pdf "$output"/*/*.pdf > "$output/checksums.txt"
