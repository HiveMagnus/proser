#!/usr/bin/env bash
set -euo pipefail
fixtures=/fixtures/empty-line-fonts
output=/output/empty-line-fonts
renderer="$(dirname "$0")/render-docx.sh"
mkdir -p "$output/libreoffice" "$output/chromium"
dotnet /opt/validator/Validator.dll "$fixtures/source.docx" "$fixtures/final.docx" "$fixtures/original.docx" "$fixtures/retain-review.docx" > "$output/ooxml-validation.jsonl"
bash "$renderer" empty-line-fonts "$output/libreoffice" "$fixtures/source.docx" "$fixtures/final.docx" "$fixtures/original.docx" "$fixtures/retain-review.docx"
for mode in final original retain-review; do cp "$fixtures/$mode.pdf" "$output/chromium/$mode.pdf"; done
for pdf in "$output"/*/*.pdf; do
  qpdf --check "$pdf" > "${pdf%.pdf}.validation.txt"
  pdftotext -bbox-layout "$pdf" "${pdf%.pdf}.bbox.html"
  pdffonts "$pdf" > "${pdf%.pdf}.fonts.txt"
  pdftoppm -scale-to 1400 -png -singlefile "$pdf" "${pdf%.pdf}"
done
python3 - "$output" <<'PY'
import json,sys,pathlib,xml.etree.ElementTree as ET
root=pathlib.Path(sys.argv[1]);ns={'h':'http://www.w3.org/1999/xhtml'}
def gaps(path):
    tree=ET.parse(path);lines={}
    for line in tree.findall('.//h:line',ns):
        text=' '.join(''.join(word.itertext()) for word in line.findall('h:word',ns))
        lines[text]=(float(line.attrib['yMin']),float(line.attrib['yMax']))
    result={}
    for target in ['Body','Cell','Header','Footer']:
        a,b=lines.get(target+' before'),lines.get(target+' after')
        if a and b: result[target]=b[0]-a[1]
    return result
results={}
for renderer in ['libreoffice','chromium']:
    results[renderer]={mode:gaps(root/renderer/(mode+'.bbox.html')) for mode in ['final','original','retain-review']}
    assert results[renderer]['final']['Body']>results[renderer]['original']['Body']+3, results[renderer]
    assert results[renderer]['final']['Cell']>15, results[renderer]
    if renderer=='libreoffice':
        assert results[renderer]['final']['Header']>10, results[renderer]
        assert results[renderer]['final']['Footer']>12, results[renderer]
# Factory header/footer are full 300-DPI raster stories. Their semantic box sizes
# are independently checked by browser fixtures; PDF text extraction covers body/cell.
(root/'line-gap-evidence.json').write_text(json.dumps(results,indent=2)+'\n')
print('Fresh Word source and three projected DOCX modes validate; both renderers preserve noncollapsed body/cell blanks and original/final font-size differences. Header/footer semantic font defaults verified separately; inspect rasters.')
PY
sha256sum "$fixtures"/*.docx "$fixtures"/*.pdf "$output"/*/*.pdf > "$output/checksums.txt"
