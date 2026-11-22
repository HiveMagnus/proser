#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
image=${1:?Supply the application image to test}
revision=${2:?Supply the expected Git revision}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' | grep -Fx "$revision"

temporary=$(mktemp -d)
project="proser-image-smoke-$$"
compose=(docker compose -p "$project" --env-file "$temporary/compose.env" -f compose.yml -f compose.factory-api.yml)
cleanup() {
  if [[ -f "$temporary/compose.env" ]]; then
    "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT
node scripts/init-compose-env.mjs "$temporary/compose.env"
web=${PROSER_SMOKE_WEB_PORT:-15350}
factory=${PROSER_SMOKE_FACTORY_PORT:-15351}
printf 'PROSER_IMAGE=%s\nPROSER_WEB_PORT=%s\nPROSER_FACTORY_PORT=%s\nPROSER_ORIGIN=http://localhost:%s\n' "$image" "$web" "$factory" "$web" >> "$temporary/compose.env"
"${compose[@]}" up -d --no-build --wait --wait-timeout 180
"${compose[@]}" exec -T author node - <<'JS'
const assert = require('node:assert/strict');
const preview = require('./.next/prerender-manifest.json').preview;
assert(JSON.stringify(preview) === JSON.stringify(require('./.next/server/preview-props.json')));
for (const key of Object.values(preview)) assert(new Set(key).size > 1);
const { encryptionKey } = require('./.next/server/server-reference-manifest.json');
assert(Buffer.from(encryptionKey, 'base64').some(byte => byte !== 0));
JS
node scripts/smoke-compose-image.mjs "$temporary/compose.env"
