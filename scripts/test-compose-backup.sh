#!/usr/bin/env bash
# Rehearse backup-compose.sh and restore-compose.sh against a disposable
# Compose project: write markers, back up, change them, restore, and check
# that the markers and readiness come back.
#   scripts/test-compose-backup.sh ghcr.io/hivemagnus/proser:<version>
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
image=${1:?Supply the application image to test}

temporary=$(mktemp -d)
project="proser-backup-test-$$"
env_file="$temporary/compose.env"
compose=(docker compose -p "$project" --env-file "$env_file" -f compose.yml -f compose.factory-api.yml)
cleanup() {
  if [[ -f "$env_file" ]]; then
    "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT

node scripts/init-compose-env.mjs "$env_file" >/dev/null
web=${PROSER_BACKUP_TEST_WEB_PORT:-15360}
factory=${PROSER_BACKUP_TEST_FACTORY_PORT:-15361}
printf 'PROSER_IMAGE=%s\nPROSER_WEB_PORT=%s\nPROSER_FACTORY_PORT=%s\nPROSER_ORIGIN=http://localhost:%s\n' \
  "$image" "$web" "$factory" "$web" >>"$env_file"
"${compose[@]}" up -d --no-build --wait --wait-timeout 180

psql() { "${compose[@]}" exec -T postgres psql -U proser -d proser -v ON_ERROR_STOP=1 -qtA "$@"; }
redis() { "${compose[@]}" exec -T redis redis-cli "$@"; }
factory_sh() { "${compose[@]}" exec -T factory sh -c "$1"; }
set_markers() {
  psql -c "CREATE TABLE IF NOT EXISTS backup_rehearsal(v text); TRUNCATE backup_rehearsal; INSERT INTO backup_rehearsal VALUES ('$1')"
  redis SET proser:backup-rehearsal "$1" >/dev/null
  factory_sh "printf %s '$1' > /opt/proser/factory/data/backup-rehearsal.txt"
}

set_markers before
backup_dir=$(scripts/backup-compose.sh -p "$project" --env-file "$env_file" \
  -f compose.yml -f compose.factory-api.yml -o "$temporary/backups")
[[ "$(redis GET proser:backup-rehearsal)" == before ]] # Redis restarted with its data
"${compose[@]}" ps --status running --services | grep -Fxq factory

set_markers after
factory_sh 'printf extra > /opt/proser/factory/public/images/after-backup.bin'

scripts/restore-compose.sh -p "$project" --env-file "$env_file" \
  -f compose.yml -f compose.factory-api.yml --yes "$backup_dir"

[[ "$(psql -c 'SELECT v FROM backup_rehearsal')" == before ]]
[[ "$(redis GET proser:backup-rehearsal)" == before ]]
[[ "$(factory_sh 'cat /opt/proser/factory/data/backup-rehearsal.txt')" == before ]]
! factory_sh 'test -e /opt/proser/factory/public/images/after-backup.bin'
curl -fsS "http://127.0.0.1:$factory/api/readiness" >/dev/null
curl -fsS "http://127.0.0.1:$web/api/readiness" >/dev/null
echo "Backup and restore rehearsal passed for $image"
