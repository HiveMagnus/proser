#!/usr/bin/env bash
# Restore a backup made by scripts/backup-compose.sh into a Proser Compose
# installation. This REPLACES the PostgreSQL database, the Redis data and the
# Factory data and images volumes of the selected Compose project.
#
# Use the image recorded in the backup's backup.txt (PROSER_IMAGE), so the
# database schema and the application agree. The environment file is not
# replaced; compare it with the backup's env.compose if secrets have changed.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/restore-compose.sh [options] BACKUP_DIR

  --env-file FILE       Compose environment file (default: .env.compose)
  -f, --file FILE       Compose file; repeat for several (default: COMPOSE_FILE from the env file)
  -p, --project-name N  Compose project name (default: Compose's own default)
  --yes                 Do not ask for confirmation
  --no-start            Leave the application stopped after restoring
  -h, --help            Show this help
USAGE
}

env_file=.env.compose
project=
files=()
assume_yes=false
start=true
backup=
while (($#)); do
  case "$1" in
    --env-file) env_file=${2:?--env-file needs a value}; shift 2 ;;
    -f | --file) files+=("${2:?--file needs a value}"); shift 2 ;;
    -p | --project-name) project=${2:?--project-name needs a value}; shift 2 ;;
    --yes) assume_yes=true; shift ;;
    --no-start) start=false; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; exit 2 ;;
    *) [[ -z "$backup" ]] || { usage >&2; exit 2; }; backup=$1; shift ;;
  esac
done
[[ -n "$backup" ]] || { usage >&2; exit 2; }
[[ -d "$backup" ]] || { echo "Backup directory not found: $backup" >&2; exit 1; }
[[ -f "$env_file" ]] || { echo "Environment file not found: $env_file" >&2; exit 1; }
backup=$(realpath -- "$backup")
env_file=$(realpath -- "$env_file")
resolved_files=()
for file in ${files[@]+"${files[@]}"}; do resolved_files+=(-f "$(realpath -- "$file")"); done
cd "$(dirname "$0")/.."
umask 077

for name in postgres.dump redis-data.tar factory-files.tar backup.txt SHA256SUMS; do
  [[ -f "$backup/$name" ]] || { echo "Backup is missing $name" >&2; exit 1; }
done
echo "Verifying backup checksums" >&2
(cd "$backup" && sha256sum --quiet -c SHA256SUMS) || {
  echo "Backup checksums do not match; refusing to restore." >&2
  exit 1
}

compose=(docker compose --env-file "$env_file")
[[ -n "$project" ]] && compose+=(-p "$project")
compose+=(${resolved_files[@]+"${resolved_files[@]}"})

recorded_image=$(sed -n 's/^image=//p' "$backup/backup.txt")
configured_image=$(sed -n 's/^PROSER_IMAGE=//p' "$env_file" | tail -n 1)
echo "Backup: $(sed -n 's/^created=//p' "$backup/backup.txt"), image ${recorded_image:-unknown}" >&2
if [[ -n "$recorded_image" && "$recorded_image" != unknown && -n "$configured_image" && "$recorded_image" != "$configured_image" ]]; then
  echo "Warning: PROSER_IMAGE is $configured_image but the backup was taken with $recorded_image." >&2
  echo "Restore with the recorded image, then follow the upgrade procedure." >&2
fi
if [[ -f "$backup/env.compose" ]] && ! cmp -s "$backup/env.compose" "$env_file"; then
  echo "Note: $env_file differs from the backup's env.compose. It is not replaced." >&2
fi

if [[ "$assume_yes" != true ]]; then
  echo "This replaces the database, Redis data and Factory files of the selected Compose project." >&2
  read -r -p "Type restore to continue: " answer
  [[ "$answer" == restore ]] || { echo "Cancelled." >&2; exit 1; }
fi

echo "Stopping the application and Redis" >&2
"${compose[@]}" stop author factory worker redis >&2
"${compose[@]}" up -d --no-deps --wait postgres >&2

echo "Restoring PostgreSQL" >&2
"${compose[@]}" exec -T postgres psql -U proser -d postgres -v ON_ERROR_STOP=1 -q \
  -c 'DROP DATABASE IF EXISTS proser WITH (FORCE)' \
  -c 'CREATE DATABASE proser OWNER proser' >&2
"${compose[@]}" exec -T postgres pg_restore -U proser -d proser --exit-on-error --single-transaction \
  <"$backup/postgres.dump"

echo "Restoring Redis data" >&2
"${compose[@]}" run --rm --no-deps -T --entrypoint sh redis -c \
  'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -C /data -xf -' \
  <"$backup/redis-data.tar"

echo "Restoring Factory data and images" >&2
# shellcheck disable=SC2016 # expanded by the container shell
"${compose[@]}" run --rm --no-deps -T --entrypoint sh factory -c \
  'for dir in /opt/proser/factory/data /opt/proser/factory/public/images; do find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; done && tar -C /opt/proser/factory -xf -' \
  <"$backup/factory-files.tar"

if [[ "$start" == true ]]; then
  echo "Starting the stack" >&2
  "${compose[@]}" up -d --no-build --wait >&2
  echo "Restore complete. Check readiness and sign in before reopening to writers." >&2
else
  echo "Restore complete. The application is stopped; start it with docker compose up -d --no-build --wait." >&2
fi
