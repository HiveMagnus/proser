#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
umask 077
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
docker image save -o "$temporary/image.tar" "${1:?Supply the application image to check}"
python3 scripts/check-release-image.py "$temporary/image.tar" "$temporary/text"
bash scripts/install-gitleaks.sh
binary="${XDG_CACHE_HOME:-$HOME/.cache}/hivemagnus-tools/gitleaks/8.30.1/gitleaks"
for layer in "$temporary/text/"*; do
  (cd "$layer"; "$binary" dir --config "$root/.gitleaks.toml" --gitleaks-ignore-path /dev/null \
    --redact=100 --ignore-gitleaks-allow --no-banner --no-color --log-level=warn .)
done
