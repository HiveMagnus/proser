#!/usr/bin/env bash
# scripts/deploy-to-proser.sh — Deploy ProserAuthor from dev machine to proser
# Run from the repo root on the dev machine.
#
# Usage:  bash scripts/deploy-to-proser.sh [--skip-build]
#
# What it does:
#   1. Builds the ProserAuthor web shell locally
#   2. Removes retired Author API/worker artifacts from the target
#   3. Rsyncs source and built web artifacts to proser:/opt/proser-v2/
#   4. Runs pnpm install on proser
#   5. Installs/restarts the web service and verifies retired units remain inactive
set -euo pipefail

MODE=deploy
RELEASE_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE=dry-run; shift ;;
    --release-id) RELEASE_ID="${2:-}"; shift 2 ;;
    --rollback) MODE=rollback; RELEASE_ID="${2:-}"; shift 2 ;;
    *) echo "Unknown release option: $1" >&2; exit 64 ;;
  esac
done
if [[ "$MODE" == rollback || -n "$RELEASE_ID" ]]; then
  [[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$ ]] || { echo "Unsafe release ID" >&2; exit 64; }
fi

REMOTE="proser"
REMOTE_DIR="/opt/proser-v2"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SUDO_PASS="${SUDO_PASS:-}"

log() { echo "[deploy] $*"; }

load_sudo_password() {
  if [ -n "$SUDO_PASS" ]; then
    return
  fi

  for env_file in "$REPO_DIR/.env.local" "$REPO_DIR/.env" "$REPO_DIR/../ProserFactory/.env.local" "$REPO_DIR/../ProserFactory/.env"; do
    if [ -f "$env_file" ]; then
      local value
      value="$(grep -E '^(SUDO_PASS|PROSER_SUDO_PASSWORD)=' "$env_file" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true)"
      if [ -n "$value" ]; then
        SUDO_PASS="$value"
        return
      fi
    fi
  done
}

_sudo() {
  local remote_command_q
  printf -v remote_command_q '%q' "$*"
  if [ -n "$SUDO_PASS" ]; then
    # Feed the credential over SSH stdin so it never appears in a local or
    # remote process argument list.
    printf '%s\n' "$SUDO_PASS" | ssh "$REMOTE" "sudo -S -p '' /bin/bash -c $remote_command_q" 2>/dev/null
  else
    ssh "$REMOTE" "sudo -n /bin/bash -c $remote_command_q"
  fi
}

cd "$REPO_DIR"
load_sudo_password
DEPLOY_REVISION="$(git rev-parse HEAD)"
RELEASE_ID="${RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)-${DEPLOY_REVISION:0:12}}"
CHECKPOINT="$REMOTE_DIR/checkpoints/$RELEASE_ID"

if [[ "$MODE" != dry-run ]]; then
  CANONICAL_URL="$(_sudo "$(cat "$REPO_DIR/deploy/canonical-origin.sh"); canonical_https_origin '$REMOTE_DIR/.env.web'")"
  CANONICAL_HOST="${CANONICAL_URL#https://}"
  WEB_SERVICE_USER="${PROSER_AUTHOR_SERVICE_USER:-$(ssh "$REMOTE" "systemctl show -p User --value proser-v2-web")}"
  if [[ ! "$WEB_SERVICE_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ || "$WEB_SERVICE_USER" == root ]]; then
    log "ERROR: Configure a non-root Author service account before deployment."
    exit 1
  fi
fi

if [[ "$MODE" == rollback ]]; then
  _sudo "set -eu
test -f '$CHECKPOINT/code.tar.gz' && test -f '$CHECKPOINT/code.tar.gz.sha256'
cd '$CHECKPOINT' && sha256sum -c code.tar.gz.sha256
test \"\$(cat '$REMOTE_DIR/REVISION')\" = \"\$(cat '$CHECKPOINT/candidate-revision')\"
test -s '$CHECKPOINT/previous-revision'
compatible=\$(tar -xOf '$CHECKPOINT/code.tar.gz' ./DOCUMENT_CONTRACT 2>/dev/null || true)
if [ \"\$compatible\" != structured-document-v1 ]; then
  curl --silent --show-error --fail --max-time 10 http://127.0.0.1:3001/api/readiness | /opt/proser-runtime/node-v24.22.3/bin/node '$REMOTE_DIR/scripts/check-document-rollback.mjs'
fi
systemctl stop proser-v2-web
stage=\$(mktemp -d /tmp/proser-author-rollback.XXXXXX)
trap 'rm -rf -- \"\$stage\"' EXIT
tar -xzf '$CHECKPOINT/code.tar.gz' -C \"\$stage\"
rsync -a --delete --exclude='node_modules' --exclude='.env' --exclude='.env.*' --exclude='data/' --exclude='certs/' --exclude='checkpoints/' --exclude='.auth/' --exclude='test-results/' --exclude='playwright-report/' \"\$stage/\" '$REMOTE_DIR/'
cd '$REMOTE_DIR'
export PATH=/opt/proser-runtime/node-v24.22.3/bin:\$PATH
CI=true corepack pnpm install --frozen-lockfile >/dev/null
sed 's/^User=.*/User=$WEB_SERVICE_USER/' deploy/proser-v2-web.service > /etc/systemd/system/proser-v2-web.service
systemctl daemon-reload
systemctl restart proser-v2-web
systemctl is-active --quiet proser-v2-web"
  ssh "$REMOTE" "curl --fail --silent --show-error --max-time 20 --resolve $CANONICAL_HOST:443:127.0.0.1 $CANONICAL_URL/api/readiness" >/dev/null
  echo "Rolled back ProserAuthor $RELEASE_ID to $(ssh "$REMOTE" "cat '$REMOTE_DIR/REVISION'")"
  printf '{"releaseId":"%s","status":"rolled-back","installedRevision":"%s","databaseState":"unchanged"}\n' "$RELEASE_ID" "$(ssh "$REMOTE" "cat '$REMOTE_DIR/REVISION'")"
  exit 0
fi
if [[ "$MODE" == dry-run ]]; then
  corepack pnpm --filter @cheftaco/proser-web... build
  ssh "$REMOTE" "test -f '$REMOTE_DIR/REVISION' && systemctl is-active --quiet proser-v2-web && cat '$REMOTE_DIR/REVISION'"
  echo "Dry-run passed for ProserAuthor $DEPLOY_REVISION"
  printf '{"status":"ready","revision":"%s"}\n' "$DEPLOY_REVISION"
  exit 0
fi

_sudo "set -eu
test ! -e '$CHECKPOINT'
install -d -m 0700 '$REMOTE_DIR/checkpoints' '$CHECKPOINT'
cd '$REMOTE_DIR'
tar -czf '$CHECKPOINT/code.tar.gz' --exclude='./node_modules' --exclude='./.env' --exclude='./.env.*' --exclude='./data' --exclude='./certs' --exclude='./checkpoints' --exclude='./apps/web/e2e/.auth' --exclude='test-results' --exclude='playwright-report' .
cd '$CHECKPOINT' && sha256sum code.tar.gz > code.tar.gz.sha256
printf '%s\n' '$DEPLOY_REVISION' > candidate-revision
cp '$REMOTE_DIR/REVISION' previous-revision
chmod 0600 code.tar.gz code.tar.gz.sha256 candidate-revision previous-revision"

# ── 1. Build ───────────────────────────────────────────────────
if [[ "${1:-}" != "--skip-build" ]]; then
  log "Building ProserAuthor web shell..."
  corepack pnpm --filter @cheftaco/proser-web... build
  log "Build complete."
else
  log "Skipping build (--skip-build)."
fi

# Verify builds exist
[[ -d apps/web/.next ]] || { log "ERROR: apps/web/.next not found."; exit 1; }
ARTIFACT_SHA="$(cd "$REPO_DIR" && find apps/web/.next -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"

# ── 2. Remove retired runtime paths ───────────────────────────
log "Removing retired ProserAuthor API/worker artifacts..."
_sudo "systemctl disable --now proser-v2-api proser-v2-worker || true"
_sudo "rm -rf -- '$REMOTE_DIR/apps/api' '$REMOTE_DIR/apps/worker'"
_sudo "rm -f -- '$REMOTE_DIR/.env.api' '$REMOTE_DIR/.env.worker'"

# ── 3. Rsync to proser ────────────────────────────────────────
log "Syncing files to $REMOTE:$REMOTE_DIR ..."

rsync -az --delete \
  --exclude 'node_modules' \
  --exclude '.turbo' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'data/' \
  --exclude 'certs/' \
  --exclude '.auth/' \
  --exclude 'test-results/' \
  --exclude 'playwright-report/' \
  --exclude '/checkpoints/' \
  --exclude '/apps/api/' \
  --exclude '/apps/worker/' \
  "$REPO_DIR/" \
  "$REMOTE:$REMOTE_DIR/"

log "Files synced."
REMOTE_ARTIFACT_SHA="$(ssh "$REMOTE" "cd '$REMOTE_DIR' && find apps/web/.next -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print \$1}'")"
[[ "$REMOTE_ARTIFACT_SHA" == "$ARTIFACT_SHA" ]] || { log "ERROR: deployed web artifact digest differs from local build."; exit 1; }
ssh "$REMOTE" "printf '%s\n' '$DEPLOY_REVISION' > '$REMOTE_DIR/REVISION'"
ssh "$REMOTE" "printf '%s\n' structured-document-v1 > '$REMOTE_DIR/DOCUMENT_CONTRACT'"

if ! ssh "$REMOTE" "test -f '$REMOTE_DIR/.env.web'"; then
  log "ERROR: protected host-local $REMOTE_DIR/.env.web is missing."
  exit 1
fi
_sudo "chown '$WEB_SERVICE_USER:$WEB_SERVICE_USER' '$REMOTE_DIR/.env.web' && chmod 0600 '$REMOTE_DIR/.env.web'"
if ! ssh "$REMOTE" "test \"\$(stat -c '%a' '$REMOTE_DIR/.env.web')\" = 600"; then
  log "ERROR: $REMOTE_DIR/.env.web is not mode 0600."
  exit 1
fi

# ── 4. Install web dependencies on proser ─────────────────────
log "Installing web dependencies on proser..."
rsync -az "$REPO_DIR/../scripts/install-node-runtime.py" "$REMOTE:$REMOTE_DIR/scripts/install-node-runtime.py"
_sudo "python3 '$REMOTE_DIR/scripts/install-node-runtime.py'"
ssh "$REMOTE" "set -o pipefail; export PATH=/opt/proser-runtime/node-v24.22.3/bin:\$PATH; cd $REMOTE_DIR && CI=true corepack pnpm install --frozen-lockfile 2>&1 | tail -5"

# ── 5. Install systemd service ────────────────────────────────
log "Installing web systemd service..."
scp "$REPO_DIR/deploy/proser-v2-web.service" "$REMOTE:/tmp/proser-v2-web.service"
_sudo "sed 's/^User=.*/User=$WEB_SERVICE_USER/' /tmp/proser-v2-web.service > /etc/systemd/system/proser-v2-web.service && rm /tmp/proser-v2-web.service"
_sudo "systemctl daemon-reload"
_sudo "systemctl enable proser-v2-web"

# ── 6. Restart web service ───────────────────────────────────
log "Restarting web service..."
_sudo "systemctl restart proser-v2-web"

# ── 7. Verify service is up ──────────────────────────────────
log "Waiting for services to come up..."
sleep 3
if ! ssh "$REMOTE" "systemctl is-active --quiet proser-v2-web"; then
  log "ERROR: proser-v2-web is not active after restart."
  ssh "$REMOTE" "journalctl -u proser-v2-web -n 50 --no-pager" || true
  exit 1
fi
log "Web service running."

if ! ssh "$REMOTE" "! systemctl is-active --quiet proser-v2-api && ! systemctl is-active --quiet proser-v2-worker"; then
  log "ERROR: a retired ProserAuthor API/worker unit is still active."
  exit 1
fi
if ! ssh "$REMOTE" "test ! -e '$REMOTE_DIR/apps/api' && test ! -e '$REMOTE_DIR/apps/worker'"; then
  log "ERROR: retired ProserAuthor API/worker artifacts remain on the target."
  exit 1
fi

# ── 8. Smoke test ────────────────────────────────────────────
log "Running smoke test..."
if ssh "$REMOTE" "curl --fail --silent --show-error --connect-timeout 5 --max-time 20 --resolve $CANONICAL_HOST:443:127.0.0.1 $CANONICAL_URL/api/readiness 2>/dev/null | grep -Eq '\"(success|ok)\":true'"; then
  log "Smoke test passed — ProserAuthor web proxy reaches ProserFactory."
else
  log "ERROR: Readiness smoke failed."
  ssh "$REMOTE" "journalctl -u proser-v2-web -n 50 --no-pager" || true
  exit 1
fi

if ! curl -fsSI --connect-timeout 5 --max-time 20 "$CANONICAL_URL/" | grep -Eiq '^location: .*\/auth\/signin'; then
  log "ERROR: canonical unauthenticated redirect did not target the sign-in flow."
  exit 1
fi
for editorial_path in /editorial /editorial/profiles /editorial/quality-lab /m/editorial; do
  if ! curl -fsSI --connect-timeout 5 --max-time 20 "$CANONICAL_URL$editorial_path" | grep -Eiq '^location: .*\/auth\/signin'; then
    log "ERROR: $editorial_path is not present behind the authenticated shell."
    exit 1
  fi
done
if ! curl -fsS --connect-timeout 5 --max-time 20 "$CANONICAL_URL/api/readiness" | grep -Eq '"(success|ok)":true'; then
  log "ERROR: canonical Factory proxy readiness check failed."
  exit 1
fi

DEPLOYED_REVISION="$(ssh "$REMOTE" "cat '$REMOTE_DIR/REVISION'")"
if [[ "$DEPLOYED_REVISION" != "$DEPLOY_REVISION" ]]; then
  log "ERROR: deployed revision $DEPLOYED_REVISION does not match local revision $DEPLOY_REVISION."
  exit 1
fi
log "Verified deployed revision: $DEPLOYED_REVISION"

log "Deploy complete."
BACKUP_SHA="$(_sudo "sha256sum '$CHECKPOINT/code.tar.gz'" | awk '{print $1}')"
printf '{"releaseId":"%s","status":"deployed","revision":"%s","installedRevision":"%s","artifactSha256":"%s","backup":"%s","backupSha256":"%s","health":"passed","functionalFlows":["canonical-auth-redirect-and-factory-readiness"],"rollbackCommand":"bash ProserAuthor/scripts/deploy-to-proser.sh --rollback %s"}\n' "$RELEASE_ID" "$DEPLOY_REVISION" "$DEPLOYED_REVISION" "$ARTIFACT_SHA" "$CHECKPOINT/code.tar.gz" "$BACKUP_SHA" "$RELEASE_ID"
