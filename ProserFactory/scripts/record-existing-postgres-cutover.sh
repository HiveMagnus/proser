#!/usr/bin/env bash
# Explicit one-time operator command for receipting an already-imported target.
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[A-Za-z0-9._:-]{8,200}$ ]]; then
  echo "usage: $0 <maintenance-window-operation-id>" >&2
  exit 2
fi

OPERATION_ID="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SQLITE_PATH="${SQLITE_DATABASE_PATH:-$REPO_DIR/data/proser.db}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CHECKPOINT_DIR="$REPO_DIR/checkpoints/cutover-$TIMESTAMP"
CHECKPOINT_PATH="$CHECKPOINT_DIR/proser-before-receipt.dump"
REPORT_PATH="$CHECKPOINT_DIR/source-target-report.json"
EVIDENCE_PATH="$REPO_DIR/state/sqlite-to-postgres-cutover-evidence.json"

if systemctl is-active --quiet proser-factory || systemctl is-active --quiet proser-worker; then
  echo "Refusing to record cutover outside a quiesced maintenance window." >&2
  exit 1
fi
if [[ ! -f "$SQLITE_PATH" ]]; then
  echo "SQLite source not found: $SQLITE_PATH" >&2
  exit 1
fi

install -d -m 0700 "$CHECKPOINT_DIR" "$REPO_DIR/state"
docker exec proser-postgres pg_dump -U proser -d proser -Fc > "$CHECKPOINT_PATH"
chmod 0600 "$CHECKPOINT_PATH"

SQLITE_SHA256="$(sha256sum "$SQLITE_PATH" | awk '{print $1}')"
POSTGRES_SHA256="$(sha256sum "$CHECKPOINT_PATH" | awk '{print $1}')"

cd "$REPO_DIR"
SQLITE_DATABASE_PATH="$SQLITE_PATH" CUTOVER_REPORT_ONLY=1 \
  npx tsx scripts/migrate-sqlite-to-postgres.ts > "$REPORT_PATH"
chmod 0600 "$REPORT_PATH"
SOURCE_REPORT_SHA256="$(node -e \
  "const f=require('fs');const r=JSON.parse(f.readFileSync(process.argv[1]));process.stdout.write(r.source.reportHash)" \
  "$REPORT_PATH")"

SQLITE_DATABASE_PATH="$SQLITE_PATH" \
POSTGRES_CHECKPOINT_PATH="$CHECKPOINT_PATH" \
SQLITE_SOURCE_SHA256="$SQLITE_SHA256" \
POSTGRES_CHECKPOINT_SHA256="$POSTGRES_SHA256" \
EXPECTED_SOURCE_REPORT_SHA256="$SOURCE_REPORT_SHA256" \
CUTOVER_OPERATION_ID="$OPERATION_ID" \
MIGRATION_EVIDENCE_PATH="$EVIDENCE_PATH" \
VERIFY_EXISTING_TARGET=1 \
  npx tsx scripts/migrate-sqlite-to-postgres.ts

echo "Cutover receipt recorded for operation $OPERATION_ID"
echo "Checkpoint: $CHECKPOINT_PATH"
echo "Signed evidence: $EVIDENCE_PATH"
