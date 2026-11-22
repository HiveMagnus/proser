#!/usr/bin/env bash
# deploy/update.sh — Auto-update script for ProserAuthor (proser-v2)
# Called by cron (fallback) or webhook (immediate) to pull latest code and rebuild.
#
# Usage:  ./deploy/update.sh [--force]
#   --force   Skip the "is there anything new?" check and rebuild regardless.
#
# Logs output to deploy/update.log with timestamps.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG="$SCRIPT_DIR/update.log"
LOCK="/tmp/proser-v2-update.lock"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

# ── Locking (prevent concurrent runs) ──────────────────────────
if ! mkdir "$LOCK" 2>/dev/null; then
  log "SKIP: Another update is already running (lock: $LOCK)"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

cd "$REPO_DIR"
export PATH=/opt/proser-runtime/node-v24.22.1/bin:$PATH
if [[ ! -x /opt/proser-runtime/node-v24.22.1/bin/node ]] || [[ "$(node --version)" != v24.22.1 ]]; then
  log "ERROR: Install the pinned runtime through the native deployment before updating."
  exit 1
fi

# Validate the target before rebuilding/restarting.
source "$SCRIPT_DIR/canonical-origin.sh"
CANONICAL_URL="$(canonical_https_origin "$REPO_DIR/.env.web")"
CANONICAL_HOST="${CANONICAL_URL#https://}"

# ── Check for changes ──────────────────────────────────────────
git fetch origin main --quiet 2>>"$LOG"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [[ "$LOCAL" == "$REMOTE" && "${1:-}" != "--force" ]]; then
  log "OK: Already up to date ($LOCAL)"
  exit 0
fi

log "UPDATE: $LOCAL → $REMOTE"

# ── Pull & rebuild ─────────────────────────────────────────────
git pull origin main --ff-only 2>>"$LOG" || {
  log "ERROR: git pull failed (merge conflict?)"
  exit 1
}

pnpm install --frozen-lockfile 2>>"$LOG" || {
  log "ERROR: pnpm install failed"
  exit 1
}

pnpm --filter @cheftaco/proser-web... build 2>>"$LOG" || {
  log "ERROR: pnpm build failed"
  exit 1
}

# ── Restart services ───────────────────────────────────────────
if systemctl is-active --quiet proser-v2-web 2>/dev/null; then
  log "Restarting via systemd..."
  sudo systemctl restart proser-v2-web
else
  log "ERROR: proser-v2-web is not active; refusing to report a successful update."
  exit 1
fi

if ! curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
  --resolve "$CANONICAL_HOST:443:127.0.0.1" \
  "$CANONICAL_URL/api/readiness" 2>>"$LOG" \
  | grep -Eq '"(success|ok)":true'; then
  log "ERROR: Post-restart readiness check failed."
  sudo journalctl -u proser-v2-web -n 50 --no-pager >>"$LOG" 2>&1 || true
  exit 1
fi

NEW_REV=$(git rev-parse --short HEAD)
log "DONE: Updated to $NEW_REV successfully"
