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

restore=(scripts/restore-compose.sh -p "$project" --env-file "$env_file" -f compose.yml -f compose.factory-api.yml --yes)
damaged() { # damaged NAME EDIT: a copy of the backup with EDIT applied and fresh checksums
  rm -rf "${temporary:?}/$1"
  cp -a "$backup_dir" "$temporary/$1"
  (cd "$temporary/$1" && eval "$2" && sha256sum postgres.dump redis-data.tar factory-files.tar env.compose backup.txt >SHA256SUMS)
}
unchanged() {
  [[ "$(psql -c 'SELECT v FROM backup_rehearsal')" == after ]]
  [[ "$(factory_sh 'cat /opt/proser/factory/data/backup-rehearsal.txt')" == after ]]
}

# An unreadable dump is refused before anything is stopped or changed.
damaged truncated 'head -c 100 postgres.dump >dump && mv dump postgres.dump'
if "${restore[@]}" "$temporary/truncated"; then echo "Restored a truncated dump" >&2; exit 1; fi
unchanged
"${compose[@]}" ps --status running --services | grep -Fxq factory

# A backup taken with another image is refused unless explicitly allowed.
damaged other-image 'sed -i "s|^image=.*|image=ghcr.io/hivemagnus/proser:0.0.1|" backup.txt'
if "${restore[@]}" "$temporary/other-image"; then echo "Restored a backup from another image" >&2; exit 1; fi
unchanged

# A damaged file archive fails without replacing the current files.
damaged bad-files 'printf "%01024d" 7 | dd of=factory-files.tar bs=1024 count=1 conv=notrunc 2>/dev/null'
if "${restore[@]}" --no-start "$temporary/bad-files"; then echo "Restored a damaged file archive" >&2; exit 1; fi
[[ "$(psql -c 'SELECT v FROM backup_rehearsal')" == after ]]
[[ "$("${compose[@]}" run --rm --no-deps -T --entrypoint cat factory /opt/proser/factory/data/backup-rehearsal.txt)" == after ]]
"${compose[@]}" run --rm --no-deps -T --entrypoint sh factory -c 'test ! -e /opt/proser/factory/data/.proser-restore'
[[ "$("${compose[@]}" exec -T postgres psql -U proser -d postgres -qtA -c "SELECT count(*) FROM pg_database WHERE datname LIKE 'proser_restore_%'")" == 0 ]]

"${restore[@]}" "$backup_dir"

[[ "$(psql -c 'SELECT v FROM backup_rehearsal')" == before ]]
[[ "$(redis GET proser:backup-rehearsal)" == before ]]
[[ "$(factory_sh 'cat /opt/proser/factory/data/backup-rehearsal.txt')" == before ]]
if factory_sh 'test -e /opt/proser/factory/public/images/after-backup.bin'; then
  echo "Restore kept a file written after the backup" >&2
  exit 1
fi
for leftover in /opt/proser/factory/data/.proser-restore /opt/proser/factory/data/.proser-previous /opt/proser/factory/public/images/.proser-previous; do
  if factory_sh "test -e $leftover"; then echo "Restore left $leftover behind" >&2; exit 1; fi
done
databases=$("${compose[@]}" exec -T postgres psql -U proser -d postgres -qtA -c "SELECT datname FROM pg_database WHERE datname LIKE 'proser_%' ORDER BY 1")
grep -q '^proser_previous_' <<<"$databases" || { echo "The previous database was not kept" >&2; exit 1; }
if grep -q '^proser_restore_' <<<"$databases"; then echo "A staging database was left behind" >&2; exit 1; fi
curl -fsS "http://127.0.0.1:$factory/api/readiness" >/dev/null
curl -fsS "http://127.0.0.1:$web/api/readiness" >/dev/null
echo "Backup and restore rehearsal passed for $image"
