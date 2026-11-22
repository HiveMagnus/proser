#!/usr/bin/env bash
set -euo pipefail
profile=${1:?Supply a profile label}
output=${2:?Supply an absolute isolated output directory}
shift 2
[[ "$profile" =~ ^[a-zA-Z0-9_-]+$ && "$output" == /* && "$#" -gt 0 ]] || exit 2
mkdir -p "$output"
current=$(mktemp -d "$output/conversion.XXXXXXXX")
profile_dir=$(mktemp -d "/tmp/proser-$profile.XXXXXXXX")
trap 'rm -rf "$profile_dir"' EXIT
for source in "$@"; do [[ "$source" == /*.docx && -f "$source" ]] || exit 2; done
set +e
timeout --kill-after=10s 600s libreoffice "-env:UserInstallation=file://$profile_dir" --headless --convert-to pdf --outdir "$current" "$@" > "$current/render.log" 2>&1
render_status=$?
set -e
printf '{"commandStatus":%d,"timeoutSeconds":600}\n' "$render_status" > "$current/render-status.json"
cat "$current/render.log"
[[ "$render_status" -eq 0 ]] || exit 1
for source in "$@"; do
  name=$(basename "$source" .docx)
  if [[ ! -s "$current/$name.pdf" ]]; then
    printf 'No new PDF for %s; previous output cannot prove this conversion.\n' "$name" >&2
    exit 1
  fi
done
sha256sum "$@" "$current"/*.pdf > "$current/checksums.txt"
for source in "$@"; do name=$(basename "$source" .docx); cp "$current/$name.pdf" "$output/$name.pdf"; done
