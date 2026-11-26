#!/usr/bin/env bash
# Back up a Proser Compose installation to a dated directory:
#   postgres.dump     PostgreSQL custom-format dump (pg_dump -Fc)
#   redis-data.tar    the Redis data directory (AOF and RDB), copied while Redis is stopped
#   factory-files.tar Factory data and images volumes
#   env.compose       a copy of the Compose environment file (contains secrets)
#   backup.txt        image, revision and creation time; SHA256SUMS covers every file
#
# Author, Factory, the worker and Redis are stopped while the backup runs so the
# snapshot is consistent, then the services that were running are started again.
# PostgreSQL keeps running (and is started if needed) for pg_dump.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/backup-compose.sh [options]

  --env-file FILE       Compose environment file (default: .env.compose)
  -f, --file FILE       Compose file; repeat for several (default: COMPOSE_FILE from the env file)
  -p, --project-name N  Compose project name (default: Compose's own default)
  -o, --output DIR      Directory that receives the dated backup (default: backups)
  -h, --help            Show this help
USAGE
}

env_file=.env.compose
output=backups
project=
files=()
while (($#)); do
  case "$1" in
    --env-file) env_file=${2:?--env-file needs a value}; shift 2 ;;
    -f | --file) files+=("${2:?--file needs a value}"); shift 2 ;;
    -p | --project-name) project=${2:?--project-name needs a value}; shift 2 ;;
    -o | --output) output=${2:?--output needs a value}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[[ -f "$env_file" ]] || { echo "Environment file not found: $env_file" >&2; exit 1; }
env_file=$(realpath -- "$env_file")
mkdir -p -- "$output"
output=$(realpath -- "$output")
resolved_files=()
for file in ${files[@]+"${files[@]}"}; do resolved_files+=(-f "$(realpath -- "$file")"); done
cd "$(dirname "$0")/.."
umask 077

compose=(docker compose --env-file "$env_file")
[[ -n "$project" ]] && compose+=(-p "$project")
compose+=(${resolved_files[@]+"${resolved_files[@]}"})

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="$output/proser-$stamp"
mkdir -- "$dest"

mapfile -t running < <("${compose[@]}" ps --status running --services)
is_running() { printf '%s\n' "${running[@]}" | grep -Fxq -- "$1"; }

writers=()
for service in author factory worker redis; do
  if is_running "$service"; then writers+=("$service"); fi
done
postgres_started=false

restore_services() {
  local status=$?
  if ((${#writers[@]})); then
    echo "Starting ${writers[*]}" >&2
    "${compose[@]}" start "${writers[@]}" >&2 || status=1
  fi
  if [[ "$postgres_started" == true ]]; then
    "${compose[@]}" stop postgres >&2 || status=1
  fi
  if ((status != 0)); then
    echo "Backup failed; incomplete files remain in $dest" >&2
  fi
  exit "$status"
}
trap restore_services EXIT

# Record the running application image before stopping anything.
factory_container=$("${compose[@]}" ps -aq factory 2>/dev/null | head -n 1 || true)
image_reference=unknown
image_id=unknown
if [[ -n "$factory_container" ]]; then
  image_reference=$(docker inspect --format '{{.Config.Image}}' "$factory_container")
  image_id=$(docker inspect --format '{{.Image}}' "$factory_container")
fi

if ((${#writers[@]})); then
  echo "Stopping ${writers[*]} for a consistent snapshot" >&2
  "${compose[@]}" stop "${writers[@]}" >&2
fi

if ! is_running postgres; then
  "${compose[@]}" up -d --no-deps --wait postgres >&2
  postgres_started=true
fi

echo "Dumping PostgreSQL" >&2
"${compose[@]}" exec -T postgres pg_dump -U proser -d proser -Fc >"$dest/postgres.dump"

echo "Copying Redis data" >&2
"${compose[@]}" run --rm --no-deps -T --entrypoint tar redis -C /data -cf - . >"$dest/redis-data.tar"

echo "Copying Factory data and images" >&2
"${compose[@]}" run --rm --no-deps -T --entrypoint tar factory \
  -C /opt/proser/factory -cf - data public/images >"$dest/factory-files.tar"

cp -- "$env_file" "$dest/env.compose"
chmod 600 "$dest/env.compose"

{
  echo "created=$stamp"
  echo "image=$image_reference"
  echo "image_id=$image_id"
  echo "revision=$(sed -n 's/^PROSER_REVISION=//p' "$env_file" | tail -n 1)"
} >"$dest/backup.txt"

(cd "$dest" && sha256sum postgres.dump redis-data.tar factory-files.tar env.compose backup.txt >SHA256SUMS)

echo "Backup written to $dest" >&2
echo "env.compose holds the installation's secrets: store the backup privately." >&2
echo "$dest"
