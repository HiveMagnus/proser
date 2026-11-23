#!/usr/bin/env bash
# scripts/deploy-to-proser.sh — Deploy ProserFactory from dev machine to proser
# Run from the repo root on the development machine.
#
# Usage:  bash scripts/deploy-to-proser.sh [--skip-build] [--record-existing-cutover <operation-id>] [--rotate-cutover-evidence-key <operation-id>]
#
# What it does:
#   1. Builds the project locally with the owned TypeScript compiler pipeline
#   2. Rsyncs dist/, prisma/, package.json, package-lock.json, deploy/ to proser:/opt/proser-factory/
#   3. Runs npm ci --omit=dev & prisma generate on proser
#   4. Installs the systemd units, restarts both services, and verifies the exact revision
set -euo pipefail

SKIP_BUILD=0
DRY_RUN=0
CUTOVER_OPERATION_ID=""
CUTOVER_KEY_ROTATION_ID=""
DOCUMENT_RELEASE_PROOF=""
DOCUMENT_RELEASE_PROOF_SHA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --document-release-proof)
      shift
      if [[ $# -eq 0 || "$1" != /* || ! -f "$1" || -L "$1" ]]; then
        echo "--document-release-proof requires an absolute owner-only reviewed proof file" >&2
        exit 2
      fi
      DOCUMENT_RELEASE_PROOF="$1"
      ;;
    --record-existing-cutover)
      shift
      if [[ $# -eq 0 || ! "$1" =~ ^[A-Za-z0-9._:-]{8,200}$ ]]; then
        echo "--record-existing-cutover requires a maintenance-window operation ID" >&2
        exit 2
      fi
      CUTOVER_OPERATION_ID="$1"
      ;;
    --rotate-cutover-evidence-key)
      shift
      if [[ $# -eq 0 || ! "$1" =~ ^[A-Za-z0-9._:-]{8,200}$ ]]; then
        echo "--rotate-cutover-evidence-key requires a maintenance-window operation ID" >&2
        exit 2
      fi
      CUTOVER_KEY_ROTATION_ID="$1"
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

REMOTE="proser"
REMOTE_DIR="/opt/proser-factory"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
read_env_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      gsub(/^'\''|'\''$/, "", value)
      print value
      exit
    }
  ' "$file"
}

if [[ -z "${PROSER_SUDO_PASSWORD:-}" ]]; then
  PROSER_SUDO_PASSWORD="$(read_env_value "$REPO_DIR/.env.local" PROSER_SUDO_PASSWORD)"
fi
if [[ -z "${PROSER_SUDO_PASSWORD:-}" ]]; then
  PROSER_SUDO_PASSWORD="$(read_env_value "$REPO_DIR/.env" PROSER_SUDO_PASSWORD)"
fi
SUDO_PASS="${PROSER_SUDO_PASSWORD:-${SUDO_PASS:-}}"

log() { echo "[deploy] $*"; }

_sudo() {
  local remote_command_q
  printf -v remote_command_q '%q' "$*"
  if [ -n "$SUDO_PASS" ]; then
    # Feed the credential over SSH stdin so it never appears in a local or
    # remote process argument list. The complete command runs under one root
    # shell, so a compound command cannot silently drop privilege after `&&`.
    printf '%s\n' "$SUDO_PASS" | ssh "$REMOTE" "sudo -S -p '' /bin/sh -c $remote_command_q"
  else
    ssh "$REMOTE" "sudo -n /bin/sh -c $remote_command_q"
  fi
}

cd "$REPO_DIR"
DEPLOY_REVISION="$(git rev-parse HEAD)"
if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
  log "ERROR: Factory native release requires a clean pinned checkout."
  exit 1
fi
SERVICE_USER="$(ssh "$REMOTE" "systemctl show -p User --value proser-factory 2>/dev/null" | tr -d '\r\n')"
if [[ -z "$SERVICE_USER" ]]; then
  log "ERROR: proser-factory has no configured systemd service user."
  exit 1
fi
if [[ ! "$SERVICE_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ || "$SERVICE_USER" == root ]]; then
  log "ERROR: proser-factory has an unsafe systemd service user."
  exit 1
fi
WORKER_SERVICE_USER="$(ssh "$REMOTE" "systemctl show -p User --value proser-worker")"
if [[ "$WORKER_SERVICE_USER" != "$SERVICE_USER" ]]; then
  log "ERROR: Factory and its worker must share the existing data owner."
  exit 1
fi
INSTALLED_REVISION="$(ssh "$REMOTE" "test -f '$REMOTE_DIR/REVISION' && cat '$REMOTE_DIR/REVISION'")"
if ! ssh "$REMOTE" "command -v make >/dev/null && command -v g++ >/dev/null && command -v python3 >/dev/null"; then
  log "ERROR: native npm modules require make, g++ and Python 3 on the host before deployment."
  exit 1
fi
echo ">>> Checking migration compatibility against installed revision $INSTALLED_REVISION..."
if [[ -z "$DOCUMENT_RELEASE_PROOF" ]]; then
  python3 scripts/check-migration-compatibility.py --base-sha "$INSTALLED_REVISION" --candidate-sha "$DEPLOY_REVISION"
else
  log "Checking the explicit candidate-specific document transition; the additive classifier remains unchanged."
  python3 scripts/check-document-release-proof.py --proof-file "$DOCUMENT_RELEASE_PROOF" --base-sha "$INSTALLED_REVISION" --candidate-sha "$DEPLOY_REVISION"
  DOCUMENT_RELEASE_PROOF_SHA="$(sha256sum "$DOCUMENT_RELEASE_PROOF" | cut -d ' ' -f 1)"
fi
_sudo "sh -c 'cd $REMOTE_DIR && JITI_FS_CACHE=false node node_modules/prisma/build/index.js migrate status >/dev/null'"
if [[ "$DRY_RUN" == 1 ]]; then
  npm run typecheck
  npm run test:smoke
  npm run build
  ssh "$REMOTE" "systemctl is-active --quiet proser-factory && systemctl is-active --quiet proser-worker"
  printf '{"status":"ready","revision":"%s","installedRevision":"%s","databaseState":"unchanged"}\n' "$DEPLOY_REVISION" "$INSTALLED_REVISION"
  exit 0
fi
DEPLOY_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CHECKPOINT_DIR="$REMOTE_DIR/checkpoints/$DEPLOY_TIMESTAMP"
RECORD_DIR="${PROSER_MIGRATION_RECORD_DIR:-$HOME/.local/state/proser-factory-migrations}"
mkdir -p -m 0700 "$RECORD_DIR"
RECORD_FILE="$RECORD_DIR/$DEPLOY_TIMESTAMP.json"

write_release_record() {
  local status="$1" installed="$2"
  PROSER_RELEASE_STATUS="$status" PROSER_RELEASE_INSTALLED="$installed" \
  PROSER_RELEASE_CANDIDATE="$DEPLOY_REVISION" PROSER_RELEASE_STAGE="$DEPLOY_STAGE" \
  PROSER_RELEASE_MIGRATION="$MIGRATION_STATE" PROSER_RELEASE_DUMP="$DB_DUMP_STATE" \
  PROSER_RELEASE_CHECKPOINT="$CHECKPOINT_DIR" PROSER_RELEASE_FENCED="$SERVICES_STOPPED" \
  PROSER_RELEASE_RECORD="$RECORD_FILE" python3 - <<'PY'
import json
import os
from pathlib import Path

keys = {'status': 'STATUS', 'installedRevision': 'INSTALLED', 'candidateRevision': 'CANDIDATE',
        'stage': 'STAGE', 'migrationState': 'MIGRATION', 'databaseDump': 'DUMP',
        'checkpoint': 'CHECKPOINT', 'servicesFenced': 'FENCED'}
record = {name: os.environ['PROSER_RELEASE_' + key] for name, key in keys.items()}
record['servicesFenced'] = record['servicesFenced'] == '1'
target = Path(os.environ['PROSER_RELEASE_RECORD'])
temporary = target.with_name(target.name + '.' + str(os.getpid()) + '.tmp')
with temporary.open('x') as output:
    os.chmod(temporary, 0o600)
    json.dump(record, output, sort_keys=True)
    output.write('\n')
    output.flush()
    os.fsync(output.fileno())
os.replace(temporary, target)
PY
}

# Keep the exact previous component bytes before rsync replaces them. This
# checkpoint and the pre-migration dump below form one rollback boundary.
log "Checkpointing the installed Factory component before sync..."
_sudo "install -d -m 0700 -o root -g root '$REMOTE_DIR/checkpoints' '$CHECKPOINT_DIR'"
_sudo "sh -ec 'cd $REMOTE_DIR && set --; for support in vendor config publication-fonts; do if [ -e \"\$support\" ]; then test -d \"\$support\" && test ! -L \"\$support\" || exit 1; set -- \"\$@\" \"\$support\"; fi; done; tar -czf \"$CHECKPOINT_DIR/component-before.tar.gz\" dist prisma deploy evaluation scripts src/lib/migration package.json package-lock.json prisma.config.ts docker-compose.postgres.yml REVISION \"\$@\" && sha256sum \"$CHECKPOINT_DIR/component-before.tar.gz\" > \"$CHECKPOINT_DIR/component-before.tar.gz.sha256\" && chmod 0600 \"$CHECKPOINT_DIR/component-before.tar.gz\" \"$CHECKPOINT_DIR/component-before.tar.gz.sha256\"'"

SERVICES_STOPPED=0
RELEASE_MUTATED=0
DEPLOY_STAGE="before sync"
MIGRATION_STATE="not started"
DB_DUMP_STATE="not created"
release_exit() {
  local result=$?
  if [[ "$result" != 0 ]]; then
    if [[ "$RELEASE_MUTATED" == "1" ]]; then
      # A changed binary or a partially applied migration must not accept work.
      _sudo "systemctl stop proser-factory proser-worker" || true
      log "Factory API and worker remain stopped for code/database reconciliation."
    elif [[ "$SERVICES_STOPPED" == "1" ]]; then
      log "No release bytes changed; restarting the prior Factory services..."
      _sudo "systemctl restart proser-factory proser-worker" || true
    fi
    local installed_revision
    installed_revision="$(ssh "$REMOTE" "cat '$REMOTE_DIR/REVISION' 2>/dev/null" || true)"
    log "DEPLOY FAILED at $DEPLOY_STAGE (exit $result). Installed REVISION: ${installed_revision:-unavailable}; candidate: $DEPLOY_REVISION."
    log "Migration state: $MIGRATION_STATE. Pre-migration database dump: $DB_DUMP_STATE."
    log "Recovery checkpoint: $CHECKPOINT_DIR/component-before.tar.gz (digest: .sha256); database dump: $CHECKPOINT_DIR/proser-before.dump (digest: .sha256)."
    log "Inspect exact code, Prisma migration state, and any writes since the checkpoint. A restarted candidate may have accepted work before the failed probe. Restore the prior component only together with a compatible database; retain this dump and the failed release record."
    log "Do not reopen traffic until a verified recovery or forward repair has passed readiness and the functional smoke."
    write_release_record held "${installed_revision:-unavailable}" || true
    log "Durable release state: $RECORD_FILE"
  fi
}
trap release_exit EXIT

# ── 1. Build ───────────────────────────────────────────────────
if [[ "$SKIP_BUILD" != "1" ]]; then
  log "Building project..."
  npm run build
  log "Build complete."
else
  log "Skipping build (--skip-build)."
fi

# Verify dist exists
if [[ ! -f dist/index.js ]]; then
  log "ERROR: dist/index.js not found. Run without --skip-build."
  exit 1
fi
if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
  log "ERROR: Factory build changed source after pinning the release."
  exit 1
fi

log "Verifying Redis persistence before stopping Factory traffic..."
ssh "$REMOTE" "cd '$REMOTE_DIR' && node dist/lib/redis/persistencePreflight.js"
log "Stopping Factory API and worker before replacing release bytes..."
_sudo "systemctl stop proser-factory proser-worker"
SERVICES_STOPPED=1

# ── 2. Rsync to proser ────────────────────────────────────────
log "Syncing files to $REMOTE:$REMOTE_DIR ..."
DEPLOY_STAGE="component sync"
RELEASE_MUTATED=1

# Sync dist (the compiled JS)
rsync -az --delete \
  dist/ \
  "$REMOTE:$REMOTE_DIR/dist/"

# The shared codec is installed from the exact registry dependency and integrity
# in package-lock.json. Remaining vendor entries are independent runtime inputs.
ssh "$REMOTE" "mkdir -p '$REMOTE_DIR/vendor' '$REMOTE_DIR/config'"
rsync -az --delete --exclude=node_modules vendor/deepmerge/ "$REMOTE:$REMOTE_DIR/vendor/deepmerge/"
rsync -az --delete vendor/unicode/ "$REMOTE:$REMOTE_DIR/vendor/unicode/"
rsync -az config/publication-font-pins.json "$REMOTE:$REMOTE_DIR/config/"
rsync -az scripts/install-publication-fonts.mjs scripts/install-publication-browser.mjs "$REMOTE:$REMOTE_DIR/scripts/"

# Sync prisma schema + migrations
rsync -az --delete \
  prisma/ \
  "$REMOTE:$REMOTE_DIR/prisma/"

# Quality Lab fixtures are runtime inputs used by readiness and benchmarks.
rsync -az --delete \
  evaluation/ \
  "$REMOTE:$REMOTE_DIR/evaluation/"

# Sync package files, Compose authority, migration bridge, and deploy scripts.
rsync -az \
  package.json package-lock.json prisma.config.ts docker-compose.postgres.yml \
  "$REMOTE:$REMOTE_DIR/"

rsync -az \
  scripts/migrate-sqlite-to-postgres.ts scripts/record-existing-postgres-cutover.sh scripts/smoke-deployed.mjs scripts/smoke-document-authority.mjs scripts/release-canary.mjs scripts/drill-prisma-migration.mjs \
  "$REMOTE:$REMOTE_DIR/scripts/"

ssh "$REMOTE" "mkdir -p '$REMOTE_DIR/src/lib/migration'"
rsync -az \
  src/lib/migration/cutoverReport.ts \
  "$REMOTE:$REMOTE_DIR/src/lib/migration/"

rsync -az --delete \
  deploy/ \
  "$REMOTE:$REMOTE_DIR/deploy/"

ssh "$REMOTE" "printf '%s\n' '$DEPLOY_REVISION' > '$REMOTE_DIR/REVISION'"

log "Files synced."

# ── 3. Install deps & generate prisma client on proser ─────────
log "Installing dependencies on proser..."
DEPLOY_STAGE="dependency install"
rsync -az "$REPO_DIR/../scripts/install-node-runtime.py" "$REMOTE:$REMOTE_DIR/scripts/install-node-runtime.py"
_sudo "python3 '$REMOTE_DIR/scripts/install-node-runtime.py'"
NODE_RUNTIME="/opt/proser-runtime/node-v24.22.1/bin"
ssh "$REMOTE" "set -o pipefail; export PATH='$NODE_RUNTIME':\$PATH; cd $REMOTE_DIR && npm ci --omit=dev 2>&1 | tail -20"

log "Installing checksum-pinned licensed publication fonts..."
_sudo "'$NODE_RUNTIME/node' '$REMOTE_DIR/scripts/install-publication-fonts.mjs' '$REMOTE_DIR/publication-fonts'"

log "Generating Prisma client..."
ssh "$REMOTE" "export PATH='$NODE_RUNTIME':\$PATH; cd $REMOTE_DIR && node node_modules/prisma/build/index.js generate 2>&1 | tail -3"

log "Installing and verifying the pinned publication browser as $SERVICE_USER..."
DEPLOY_STAGE="publication browser install"
_sudo "env PATH='$NODE_RUNTIME':/usr/local/bin:/usr/bin:/bin '$NODE_RUNTIME/node' '$REMOTE_DIR/scripts/install-publication-browser.mjs' --service-user '$SERVICE_USER'"
log "Ensuring data directory is writable by service user ($SERVICE_USER)..."
_sudo "mkdir -p '$REMOTE_DIR/data'"
_sudo "chown -R '$SERVICE_USER:$SERVICE_USER' '$REMOTE_DIR/data'"
log "Ensuring the host-local production metrics credential exists..."
_sudo "python3 '$REMOTE_DIR/deploy/ensure-metrics-token.py' '$REMOTE_DIR/.env'"
log "Ensuring the host-local PostgreSQL credential and connection URL exist..."
_sudo "python3 '$REMOTE_DIR/deploy/ensure-postgres-env.py' '$REMOTE_DIR/.env'"
if ssh "$REMOTE" "test -e '$REMOTE_DIR/.env.local'"; then
  if ! ssh "$REMOTE" "test -f '$REMOTE_DIR/.env.local' && test ! -L '$REMOTE_DIR/.env.local'"; then
    log "ERROR: $REMOTE_DIR/.env.local must be a regular non-symlink file."
    exit 1
  fi
  _sudo "python3 '$REMOTE_DIR/deploy/ensure-postgres-env.py' '$REMOTE_DIR/.env.local' '$REMOTE_DIR/.env'"
  _sudo "chown '$SERVICE_USER:$SERVICE_USER' '$REMOTE_DIR/.env.local' && chmod 0600 '$REMOTE_DIR/.env.local'"
fi
log "Verifying the dedicated Author-to-Factory signing credential..."
_sudo "python3 '$REMOTE_DIR/deploy/ensure-shared-factory-auth.py' '$REMOTE_DIR/.env' '/opt/proser-v2/.env.web'"

INFERENCE_API_KEY="$(read_env_value "$REPO_DIR/.env.local" INFERENCE_API_KEY)"
if [[ -z "$INFERENCE_API_KEY" ]]; then
  INFERENCE_API_KEY="$(read_env_value "$REPO_DIR/.env" INFERENCE_API_KEY)"
fi
if [[ ${#INFERENCE_API_KEY} -lt 32 ]]; then
  log "ERROR: INFERENCE_API_KEY must contain at least 32 characters."
  exit 1
fi
INFERENCE_API_KEY_SHA256="$(printf '%s' "$INFERENCE_API_KEY" | sha256sum | awk '{print $1}')"
log "Verifying the private inference credential before interrupting services..."
_sudo "python3 '$REMOTE_DIR/deploy/verify-private-env.py' '$REMOTE_DIR/.env' INFERENCE_API_KEY '$INFERENCE_API_KEY_SHA256'"
unset INFERENCE_API_KEY INFERENCE_API_KEY_SHA256

_sudo "install -d -m 0750 '$REMOTE_DIR/state'"

log "Starting Compose PostgreSQL..."
_sudo "sh -c 'cd $REMOTE_DIR && docker compose --env-file .env -f docker-compose.postgres.yml up -d --wait'"

log "Creating a pre-migration PostgreSQL checkpoint..."
DEPLOY_STAGE="pre-migration database checkpoint"
_sudo "sh -c 'docker exec proser-postgres pg_dump -U proser -d proser -Fc > \"$CHECKPOINT_DIR/proser-before.dump\"'"
_sudo "sh -c 'sha256sum \"$CHECKPOINT_DIR/proser-before.dump\" > \"$CHECKPOINT_DIR/proser-before.dump.sha256\"'"
_sudo "chmod 0600 '$CHECKPOINT_DIR/proser-before.dump' '$CHECKPOINT_DIR/proser-before.dump.sha256'"
DB_DUMP_STATE="created at $CHECKPOINT_DIR/proser-before.dump"

log "Rehearsing candidate migrations and database recovery on a disposable PostgreSQL database..."
DEPLOY_STAGE="pre-migration database recovery drill"
_sudo "sh -c 'export PATH=$NODE_RUNTIME:\$PATH; cd $REMOTE_DIR && JITI_FS_CACHE=false node scripts/drill-prisma-migration.mjs $CHECKPOINT_DIR proser_recovery_${DEPLOY_TIMESTAMP}'"
log "Pre-migration PostgreSQL restore drill passed."

log "Running PostgreSQL Prisma migrations..."
DEPLOY_STAGE="Prisma migration"
MIGRATION_STATE="running or partially applied"
_sudo "sh -c 'export PATH=$NODE_RUNTIME:\$PATH; cd $REMOTE_DIR && JITI_FS_CACHE=false node node_modules/prisma/build/index.js migrate deploy'"
MIGRATION_STATE="Prisma migrate deploy succeeded"
DEPLOY_STAGE="post-migration setup"
if [[ -n "$DOCUMENT_RELEASE_PROOF" ]]; then
  log "Installing the reviewed enforcement SQL with activation remaining disabled..."
  DEPLOY_STAGE="reviewed inactive document enforcement"
  [[ "$(sha256sum "$DOCUMENT_RELEASE_PROOF" | cut -d ' ' -f 1)" == "$DOCUMENT_RELEASE_PROOF_SHA" ]] || { log "Reviewed proof bytes changed during release."; exit 1; }
  ENFORCEMENT_EXISTS="$(_sudo "docker exec proser-postgres psql -U proser -d proser -tA -v ON_ERROR_STOP=1 -c \"SELECT to_regclass('proser_document_enforcement')\"")"
  if [[ -n "$ENFORCEMENT_EXISTS" ]]; then
    _sudo "sh -ec 'test \"\$(docker exec proser-postgres psql -U proser -d proser -tA -v ON_ERROR_STOP=1 -c \"SELECT enabled FROM proser_document_enforcement WHERE singleton\")\" = f'"
  fi
  _sudo "sh -ec 'docker exec -i proser-postgres psql -U proser -d proser -v ON_ERROR_STOP=1 < $REMOTE_DIR/deploy/document-authority/enforcement.sql'"
  _sudo "sh -ec 'test \"\$(docker exec proser-postgres psql -U proser -d proser -tA -v ON_ERROR_STOP=1 -c \"SELECT enabled FROM proser_document_enforcement WHERE singleton\")\" = f'"
  # Retain the exact reviewed bytes in the component's private checkpoint.
  REMOTE_PROOF_TEMP="$(ssh "$REMOTE" "mktemp /tmp/proser-document-proof.XXXXXXXX")"
  [[ "$REMOTE_PROOF_TEMP" =~ ^/tmp/proser-document-proof\.[A-Za-z0-9]+$ ]] || exit 1
  scp "$DOCUMENT_RELEASE_PROOF" "$REMOTE:$REMOTE_PROOF_TEMP" >/dev/null
  _sudo "install -m 0600 '$REMOTE_PROOF_TEMP' '$CHECKPOINT_DIR/document-release-proof.json' && rm -f '$REMOTE_PROOF_TEMP'"
fi

if [[ -n "$CUTOVER_OPERATION_ID" ]]; then
  log "Running the explicit one-time existing-cutover receipt command..."
  _sudo "sh -c 'cd $REMOTE_DIR && scripts/record-existing-postgres-cutover.sh \"$CUTOVER_OPERATION_ID\"'"
fi

if ssh "$REMOTE" "test -f '$REMOTE_DIR/data/proser.db'"; then
  if [[ -n "$CUTOVER_KEY_ROTATION_ID" ]]; then
    log "Re-attesting the existing cutover evidence with the current host key..."
    _sudo "sh -c 'export PATH=$NODE_RUNTIME:\$PATH; cd $REMOTE_DIR && CUTOVER_KEY_ROTATION_ID=\"$CUTOVER_KEY_ROTATION_ID\" SQLITE_DATABASE_PATH=data/proser.db MIGRATION_EVIDENCE_PATH=state/sqlite-to-postgres-cutover-evidence.json npx tsx scripts/migrate-sqlite-to-postgres.ts'"
  fi
  log "Checking the PostgreSQL cutover receipt (normal deploys never replace populated data)..."
  _sudo "sh -c 'export PATH=$NODE_RUNTIME:\$PATH; cd $REMOTE_DIR && SQLITE_DATABASE_PATH=data/proser.db MIGRATION_EVIDENCE_PATH=state/sqlite-to-postgres-cutover-evidence.json npx tsx scripts/migrate-sqlite-to-postgres.ts'"
fi

# Sync only non-secret runtime knobs that define the active inference/image topology.
# Secrets and host-specific auth values stay managed in the remote .env.
log "Syncing non-secret runtime environment settings..."
runtime_env_updates=()
for key in \
  INFERENCE_BACKEND \
  INFERENCE_HOST \
  OLLAMA_BASE_URL \
  OLLAMA_MODEL \
  VLLM_BASE_URL \
  VLLM_MODEL \
  MAX_CONTEXT_TOKENS \
  RAG_TOKEN_BUDGET \
  RAG_MAX_CHUNKS \
  FEEDBACK_MAX_CHARS \
  AI_MAX_CONCURRENT \
  GENERATION_MAX_ACTIVE_PER_USER \
  GENERATION_MAX_ACTIVE_GLOBAL \
  GENERATION_MAX_CONCURRENT \
  GENERATION_OPERATION_MAX_BYTES \
  GENERATION_REPLAY_MAX_BYTES \
  GENERATION_REPLAY_LIMIT \
  GENERATION_REPLAY_TTL_MS \
  GENERATION_OPERATION_MAX_PENDING_MS \
  GENERATION_OPERATION_LEASE_MS \
  GENERATION_OPERATION_MAX_LIFETIME_MS \
  GENERATION_OPERATION_TTL_SECONDS \
  EDITORIAL_MAX_ACTIVE_PER_USER \
  EDITORIAL_MAX_ACTIVE_GLOBAL \
  EDITORIAL_MAX_PROPOSALS \
  EDITORIAL_MAX_CANDIDATES_PER_PROPOSAL \
  EDITORIAL_MAX_CHANGED_PERCENT_SCENE \
  EDITORIAL_MAX_CHANGED_PERCENT_TOTAL \
  EDITORIAL_MAX_JUDGE_ESCALATIONS \
  EDITORIAL_MAX_INFERENCE_TOKENS \
  EDITORIAL_MIN_CONFIDENCE \
  EDITORIAL_MIN_PREFERENCE_MARGIN \
  EDITORIAL_REFERENCE_OVERLAP_THRESHOLD \
  EDITORIAL_LIVE_BENCHMARK_TIMEOUT_MS \
  WEBUI_FORGE_URL \
  FORGE_MODEL \
  FORGE_SAMPLER \
  FORGE_SCHEDULER \
  FORGE_STEPS
do
  value="$(read_env_value "$REPO_DIR/.env.local" "$key")"
  if [[ -z "$value" ]]; then
    value="$(read_env_value "$REPO_DIR/.env" "$key")"
  fi
  if [[ -n "$value" ]]; then
    runtime_env_updates+=("$key=$value")
  fi
done

if [[ "${#runtime_env_updates[@]}" -gt 0 ]]; then
  helper="$(mktemp)"
  remote_helper="/tmp/proser-upsert-runtime-env.py"
  cat > "$helper" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
updates = {}
for item in sys.argv[2:]:
    key, _, value = item.partition("=")
    if key:
        updates[key] = value

lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
seen = set()
next_lines = []

for line in lines:
    if "=" not in line or line.lstrip().startswith("#"):
        next_lines.append(line)
        continue
    key = line.split("=", 1)[0].strip()
    if key in updates:
        if key not in seen:
            next_lines.append(f"{key}={updates[key]}")
            seen.add(key)
        continue
    next_lines.append(line)

for key, value in updates.items():
    if key not in seen:
        next_lines.append(f"{key}={value}")

env_path.write_text("\n".join(next_lines).rstrip() + "\n", encoding="utf-8")
PY
  scp "$helper" "$REMOTE:$remote_helper" >/dev/null
  ssh "$REMOTE" "chmod 0644 '$remote_helper'"
  updates_q=""
  for update in "${runtime_env_updates[@]}"; do
    printf -v quoted '%q' "$update"
    updates_q+=" $quoted"
  done
  _sudo "python3 '$remote_helper' '$REMOTE_DIR/.env'$updates_q && mkdir -p '$REMOTE_DIR/data'"
  if [[ -n "${SERVICE_USER:-}" ]]; then
    _sudo "runuser -u '$SERVICE_USER' -- python3 '$remote_helper' '$REMOTE_DIR/data/ollama-settings.env'$updates_q"
  else
    _sudo "python3 '$remote_helper' '$REMOTE_DIR/data/ollama-settings.env'$updates_q"
  fi
  _sudo "rm -f '$remote_helper'"
  if ssh "$REMOTE" "[ -f '$REMOTE_DIR/.env.local' ] && [ ! -L '$REMOTE_DIR/.env.local' ]"; then
    scp "$helper" "$REMOTE:$remote_helper" >/dev/null
    ssh "$REMOTE" "chmod 0644 '$remote_helper'"
    _sudo "python3 '$remote_helper' '$REMOTE_DIR/.env.local'$updates_q && chown '$SERVICE_USER:$SERVICE_USER' '$REMOTE_DIR/.env.local' && chmod 0600 '$REMOTE_DIR/.env.local' && rm -f '$remote_helper'"
  fi
  rm -f "$helper"
else
  log "No runtime env settings found locally to sync."
fi

# ── 4. Restart service ────────────────────────────────────────
log "Installing systemd units..."
_sudo "sed 's/^User=.*/User=$SERVICE_USER/' '$REMOTE_DIR/deploy/proser-factory.service' > /etc/systemd/system/proser-factory.service"
_sudo "sed 's/^User=.*/User=$SERVICE_USER/' '$REMOTE_DIR/deploy/proser-worker.service' > /etc/systemd/system/proser-worker.service"
if ssh "$REMOTE" "systemctl list-unit-files proser-webhook.service --no-legend 2>/dev/null | grep -q proser-webhook"; then
  log "Retiring legacy proser-webhook service..."
  _sudo "systemctl disable --now proser-webhook.service"
fi
_sudo "rm -f /etc/systemd/system/proser-webhook.service"
_sudo "systemctl daemon-reload"

if [[ -n "$DOCUMENT_RELEASE_PROOF" ]]; then
  DEPLOY_STAGE="reviewed schema installed; held for explicit document activation"
  DEPLOYED_REVISION="$(ssh "$REMOTE" "cat '$REMOTE_DIR/REVISION'")"
  [[ "$DEPLOYED_REVISION" == "$DEPLOY_REVISION" ]] || exit 1
  _sudo "systemctl stop proser-factory proser-worker"
  write_release_record held-for-document-activation "$DEPLOYED_REVISION"
  log "Reviewed schema/enforcement support installed; both services remain stopped."
  log "Complete exact operation reconciliation, preservation/backfill, compatible Author installation, activation and canaries before reopening. Record: $RECORD_FILE"
  trap - EXIT
  exit 0
fi

log "Restarting proser-factory services..."
DEPLOY_STAGE="service restart"
_sudo "systemctl restart proser-factory proser-worker"

# ── 5. Verify service is up ───────────────────────────────────
log "Waiting for services to come up..."
DEPLOY_STAGE="post-migration health probe"
services_ready=0
for _ in $(seq 1 60); do
  if ssh "$REMOTE" "systemctl is-active --quiet proser-factory && systemctl is-active --quiet proser-worker"; then
    services_ready=1
    break
  fi
  sleep 1
done
if [[ "$services_ready" != 1 ]]; then
  log "ERROR: Factory services did not become active within 60 seconds."
  ssh "$REMOTE" "systemctl --no-pager --full status proser-factory proser-worker" || true
  exit 1
fi

http_ready=0
for _ in $(seq 1 60); do
  if ssh "$REMOTE" "curl -fsS --max-time 2 http://127.0.0.1:3001/health >/dev/null"; then
    http_ready=1
    break
  fi
  sleep 1
done
if [[ "$http_ready" != 1 ]]; then
  log "ERROR: Factory loopback health did not become ready within 60 seconds."
  exit 1
fi

# ── 6. Smoke test ─────────────────────────────────────────────
log "Running deployed smoke tests..."
DEPLOY_STAGE="post-migration functional smoke"
if _sudo "sh -c 'cd $REMOTE_DIR && node scripts/smoke-deployed.mjs http://127.0.0.1:3001'"; then
  log "Smoke tests passed."
else
  log "ERROR: Smoke tests FAILED — deployment may be broken!"
  exit 1
fi

DEPLOYED_REVISION="$(ssh "$REMOTE" "cat '$REMOTE_DIR/REVISION'")"
if [[ "$DEPLOYED_REVISION" != "$DEPLOY_REVISION" ]]; then
  log "ERROR: deployed revision $DEPLOYED_REVISION does not match local revision $DEPLOY_REVISION"
  exit 1
fi
log "Verified deployed revision: $DEPLOYED_REVISION"

log "Deploy complete."
SERVICES_STOPPED=0
DEPLOY_STAGE="accepted after functional smoke"
write_release_record accepted "$DEPLOYED_REVISION"
log "Durable release state: $RECORD_FILE"
trap - EXIT
