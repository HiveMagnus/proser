#!/usr/bin/env bash
# Upgrade a disposable Compose installation from a previous release image to a
# candidate image with the documented procedure, and check that it comes back:
#   scripts/smoke-compose-upgrade.sh <previous-tag> <previous-image> <candidate-image>
# The previous release starts with that release's Compose files (read from its
# Git tag), saves a synthetic book, and is stopped. The candidate's migrations
# are applied with `migrate deploy`, the stack starts on the candidate image,
# and the script checks the document guards, every healthcheck, readiness, the
# reported version and the saved book.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
previous_tag=${1:?Supply the previous release tag, for example v1.0.7}
previous=${2:?Supply the previous release image}
candidate=${3:?Supply the candidate image}
[[ "$previous_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]

temporary=$(mktemp -d)
project="proser-upgrade-smoke-$$"
env_file="$temporary/compose.env"
web=${PROSER_UPGRADE_SMOKE_WEB_PORT:-15370}
factory=${PROSER_UPGRADE_SMOKE_FACTORY_PORT:-15371}
git show "$previous_tag:compose.yml" >"$temporary/compose.yml"
git show "$previous_tag:compose.factory-api.yml" >"$temporary/compose.factory-api.yml"
before=(docker compose -p "$project" --env-file "$env_file" --project-directory . -f "$temporary/compose.yml" -f "$temporary/compose.factory-api.yml")
after=(docker compose -p "$project" --env-file "$env_file" -f compose.yml -f compose.factory-api.yml)
cleanup() {
  if [[ -f "$env_file" ]]; then
    "${after[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT

node scripts/init-compose-env.mjs "$env_file" >/dev/null
printf 'PROSER_WEB_PORT=%s\nPROSER_FACTORY_PORT=%s\nPROSER_ORIGIN=http://localhost:%s\n' \
  "$web" "$factory" "$web" >>"$env_file"
set_image() {
  grep -v '^PROSER_IMAGE=' "$env_file" >"$env_file.next" || true
  printf 'PROSER_IMAGE=%s\n' "$1" >>"$env_file.next"
  mv -- "$env_file.next" "$env_file"
}

set_image "$previous"
"${before[@]}" up -d --no-build --wait --wait-timeout 180
node scripts/smoke-compose-image.mjs "$env_file" --record "$temporary/book.json"
"${before[@]}" stop author factory worker

# The documented upgrade: switch the image, apply migrations, start.
set_image "$candidate"
"${after[@]}" run --rm --no-deps initialize node node_modules/prisma/build/index.js migrate deploy
"${after[@]}" up -d --no-build --wait --wait-timeout 180

expected_guards=$(docker run --rm --network none --entrypoint sha256sum "$candidate" \
  /opt/proser/factory/deploy/document-authority/enforcement.sql | cut -d' ' -f1)
installed_guards=$("${after[@]}" exec -T postgres psql -U proser -d proser -qtA \
  -c 'SELECT enforcement_sha256 FROM proser_compose.bootstrap WHERE singleton')
if [[ "$installed_guards" != "$expected_guards" ]]; then
  echo "The upgraded database runs document guards $installed_guards, not $expected_guards" >&2
  exit 1
fi
for service in author factory worker; do
  health=$("${after[@]}" ps --format '{{.Health}}' "$service")
  if [[ "$health" != healthy ]]; then
    echo "$service is $health after the upgrade" >&2
    exit 1
  fi
done
curl -fsS "http://127.0.0.1:$factory/api/readiness" >/dev/null
curl -fsS "http://127.0.0.1:$web/api/readiness" >/dev/null
expected_version=$(docker image inspect "$candidate" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
if [[ -n "$expected_version" && "$expected_version" != "<no value>" ]]; then
  curl -fsS "http://127.0.0.1:$factory/health" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).version;if(v!==process.argv[1]){console.error("Factory reports "+v+", expected "+process.argv[1]);process.exit(1)}})' "$expected_version"
fi
node scripts/smoke-compose-image.mjs "$env_file" --verify "$temporary/book.json"
echo "Upgrade from $previous_tag to $candidate passed"
