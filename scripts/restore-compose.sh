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
  --allow-image-mismatch  Restore although PROSER_IMAGE differs from the backup's image
  -h, --help            Show this help
USAGE
}

env_file=.env.compose
project=
files=()
assume_yes=false
start=true
allow_image_mismatch=false
backup=
while (($#)); do
  case "$1" in
    --env-file) env_file=${2:?--env-file needs a value}; shift 2 ;;
    -f | --file) files+=("${2:?--file needs a value}"); shift 2 ;;
    -p | --project-name) project=${2:?--project-name needs a value}; shift 2 ;;
    --yes) assume_yes=true; shift ;;
    --no-start) start=false; shift ;;
    --allow-image-mismatch) allow_image_mismatch=true; shift ;;
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
  echo "PROSER_IMAGE is $configured_image but the backup was taken with $recorded_image." >&2
  if [[ "$allow_image_mismatch" != true ]]; then
    echo "Set PROSER_IMAGE to the recorded image and restore again, then follow the upgrade" >&2
    echo "procedure, or pass --allow-image-mismatch if you have checked the schemas agree." >&2
    exit 1
  fi
  echo "Continuing because --allow-image-mismatch was given." >&2
fi
if [[ -f "$backup/env.compose" ]] && ! cmp -s "$backup/env.compose" "$env_file"; then
  echo "Note: $env_file differs from the backup's env.compose. It is not replaced." >&2
fi

if [[ "$assume_yes" != true ]]; then
  echo "This replaces the database, Redis data and Factory files of the selected Compose project." >&2
  read -r -p "Type restore to continue: " answer
  [[ "$answer" == restore ]] || { echo "Cancelled." >&2; exit 1; }
fi

stamp=$(date -u +%Y%m%d%H%M%S)
staging_db="proser_restore_$stamp"
previous_db="proser_previous_$stamp"

"${compose[@]}" up -d --no-deps --wait postgres >&2
echo "Checking that the dump can be read" >&2
"${compose[@]}" exec -T postgres pg_restore --list <"$backup/postgres.dump" >/dev/null || {
  echo "pg_restore cannot read postgres.dump; nothing was changed." >&2
  exit 1
}

echo "Stopping the application and Redis" >&2
"${compose[@]}" stop author factory worker redis >&2

psql() { "${compose[@]}" exec -T postgres psql -U proser -d postgres -v ON_ERROR_STOP=1 -q "$@" >&2; }

# Everything is staged first: the dump goes into a separate database and each
# archive into a staging directory on its own volume. The installation's data
# is replaced only after all of it has been staged, so a damaged backup or a
# full disk leaves the current data in place.
# shellcheck disable=SC2016 # expanded by the container shell
files_script='
set -eu
mode=$1; stage=$2; shift 2
case "$mode" in
stage)
  rm -rf "$stage"; mkdir "$stage"
  if ! tar -C "$stage" -xf -; then rm -rf "$stage"; exit 1; fi
  while [ "$#" -gt 0 ]; do [ -d "$stage/$1" ] || { echo "The archive has no $1." >&2; rm -rf "$stage"; exit 1; }; shift; done ;;
discard) rm -rf "$stage" ;;
swap)
  while [ "$#" -gt 1 ]; do
    live=$1; new=$stage/$2; old=$live/.proser-previous; shift 2
    rm -rf "$old"; mkdir "$old"
    find "$live" -mindepth 1 -maxdepth 1 ! -name .proser-previous ! -name .proser-restore -exec mv {} "$old"/ \;
    if ! cp -a "$new"/. "$live"/; then
      find "$live" -mindepth 1 -maxdepth 1 ! -name .proser-previous ! -name .proser-restore -exec rm -rf {} +
      find "$old" -mindepth 1 -maxdepth 1 -exec mv {} "$live"/ \;
      rmdir "$old"; exit 1
    fi
    rm -rf "$old"
  done
  rm -rf "$stage" ;;
esac
'
redis_files() { "${compose[@]}" run --rm --no-deps -T --entrypoint sh redis -c "$files_script" files "$@"; }
factory_files() { "${compose[@]}" run --rm --no-deps -T --entrypoint sh factory -c "$files_script" files "$@"; }
redis_stage=/data/.proser-restore
factory_stage=/opt/proser/factory/data/.proser-restore
discard_staged() {
  psql -c "DROP DATABASE IF EXISTS $staging_db" || true
  redis_files discard "$redis_stage" </dev/null || true
  factory_files discard "$factory_stage" </dev/null || true
  echo "$1 The installation's data is unchanged; the application is stopped." >&2
  exit 1
}

echo "Restoring PostgreSQL into $staging_db" >&2
psql -c "CREATE DATABASE $staging_db OWNER proser"
"${compose[@]}" exec -T postgres pg_restore -U proser -d "$staging_db" --exit-on-error --single-transaction \
  <"$backup/postgres.dump" || discard_staged "The database restore failed."
echo "Staging Redis data and Factory files" >&2
redis_files stage "$redis_stage" . <"$backup/redis-data.tar" || discard_staged "The Redis archive could not be extracted."
factory_files stage "$factory_stage" data public/images <"$backup/factory-files.tar" ||
  discard_staged "The Factory archive could not be extracted."

echo "Replacing the database, Redis data and Factory files" >&2
psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'proser' AND pid <> pg_backend_pid()" \
  -c "ALTER DATABASE proser RENAME TO $previous_db" \
  -c "ALTER DATABASE $staging_db RENAME TO proser"
echo "The previous database is kept as $previous_db." >&2
redis_files swap "$redis_stage" /data . </dev/null
factory_files swap "$factory_stage" /opt/proser/factory/public/images public/images \
  /opt/proser/factory/data data </dev/null

if [[ "$start" == true ]]; then
  echo "Starting the stack" >&2
  "${compose[@]}" up -d --no-build --wait >&2
  echo "Restore complete. Check readiness and sign in before reopening to writers." >&2
  echo "Then remove the previous database: docker compose exec postgres dropdb -U proser $previous_db" >&2
else
  echo "Restore complete. The application is stopped; start it with docker compose up -d --no-build --wait." >&2
fi
