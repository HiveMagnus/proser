#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

AGENT_HOST=""
AGENT_SSH_HOST=""
FACTORY_HOST="proser"
FACTORY_ENV="/opt/proser-factory/.env"
FACTORY_SERVICE="proser-factory"
SSH_PORT="22"
SSH_USER=""
SSH_IDENTITY_FILE=""
SSH_KNOWN_HOSTS_FILE=""
SUDO_PASSWORD=""
IDENTITY_ID=""
PROSER_USERNAME=""
OWNER_GITHUB_ID=""
PROSER_EMAIL=""
PROSER_BASE_URL=""
PROSER_CA_FILE=""
GATEWAY_SERVICE="hermes-gateway.service"
REMOTE_PLUGIN_DIR=""
RESTART_FACTORY="1"
RESTART_GATEWAY="1"

usage() {
  cat <<'USAGE'
Provision a per-host Proser identity for a Hermes Agent plugin.

The script:
  1. Adds the identity to ProserFactory's HERMES_AGENT_ALLOWED_GITHUB_IDS.
  2. Reads the dedicated HERMES_AGENT_AUTH_SECRET from the Factory host.
  3. Deploys/configures the Hermes Proser plugin on the target agent host.
  4. Enrolls the identity with a remote Proser list_books call.
  5. Restarts the target Hermes gateway.

Required:
  --agent-host HOST              Logical agent host name, e.g. agent-host.

Defaults:
  SSH user/key/pins are read from PROSER_USER, PROSER_SSH_KEY, and
  PROSER_SSH_KNOWN_HOSTS in .env. PROSER_SUDO_PASSWORD is used only over stdin
  for the Factory host's privileged env/service operations.
  Proser URL is read from PUBLIC_BASE_URL in .env.
  Identity is service:hermes-agent:<agent-host>.
  Username is hermes-agent-<agent-host>.

Options:
  --agent-ssh-host HOST          SSH host for the agent. Default: --agent-host.
  --factory-host HOST            Factory SSH host. Default: proser.
  --factory-env PATH             Factory .env path. Default: /opt/proser-factory/.env.
  --factory-service NAME         Factory systemd service. Default: proser-factory.
  --user USER                    SSH user. Default: PROSER_USER.
  --identity-file PATH           SSH private key. Default: PROSER_SSH_KEY.
  --known-hosts-file PATH        Pinned known_hosts file. Default: PROSER_SSH_KNOWN_HOSTS.
  --port PORT                    SSH port for both hosts. Default: 22.
  --identity-id ID               Proser githubId/sub for this agent.
  --proser-username USERNAME     Proser username for this agent.
  --owner-github-id ID           Existing author identity the agent acts for.
  --proser-email EMAIL           Optional Proser email.
  --proser-base-url URL          ProserFactory URL reachable from the agent.
  --proser-ca-file PATH          Local CA file to upload. If omitted, tries the Factory TLS_CA_FILE.
  --gateway-service NAME         Target user service. Default: hermes-gateway.service.
  --remote-plugin-dir PATH       Target plugin path. Default: ~/.hermes/plugins/proser-api.
  --no-restart-factory           Update Factory env but do not restart Factory.
  --no-restart-gateway           Deploy plugin but do not restart target gateway.

Example:
  scripts/provision-hermes-agent-identity.sh --agent-host agent-host
USAGE
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-host) AGENT_HOST="${2:-}"; shift 2 ;;
    --agent-ssh-host) AGENT_SSH_HOST="${2:-}"; shift 2 ;;
    --factory-host) FACTORY_HOST="${2:-}"; shift 2 ;;
    --factory-env) FACTORY_ENV="${2:-}"; shift 2 ;;
    --factory-service) FACTORY_SERVICE="${2:-}"; shift 2 ;;
    --user) SSH_USER="${2:-}"; shift 2 ;;
    --identity-file) SSH_IDENTITY_FILE="${2:-}"; shift 2 ;;
    --known-hosts-file) SSH_KNOWN_HOSTS_FILE="${2:-}"; shift 2 ;;
    --port) SSH_PORT="${2:-}"; shift 2 ;;
    --identity-id) IDENTITY_ID="${2:-}"; shift 2 ;;
    --proser-username) PROSER_USERNAME="${2:-}"; shift 2 ;;
    --owner-github-id) OWNER_GITHUB_ID="${2:-}"; shift 2 ;;
    --proser-email) PROSER_EMAIL="${2:-}"; shift 2 ;;
    --proser-base-url) PROSER_BASE_URL="${2:-}"; shift 2 ;;
    --proser-ca-file) PROSER_CA_FILE="${2:-}"; shift 2 ;;
    --gateway-service) GATEWAY_SERVICE="${2:-}"; shift 2 ;;
    --remote-plugin-dir) REMOTE_PLUGIN_DIR="${2:-}"; shift 2 ;;
    --no-restart-factory) RESTART_FACTORY="0"; shift ;;
    --no-restart-gateway) RESTART_GATEWAY="0"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n "$AGENT_HOST" ]] || die "--agent-host is required"
AGENT_SSH_HOST="${AGENT_SSH_HOST:-$AGENT_HOST}"

SSH_USER="${SSH_USER:-$(read_env_value "$REPO_DIR/.env" PROSER_USER)}"
SSH_IDENTITY_FILE="${SSH_IDENTITY_FILE:-$(read_env_value "$REPO_DIR/.env" PROSER_SSH_KEY)}"
SSH_KNOWN_HOSTS_FILE="${SSH_KNOWN_HOSTS_FILE:-$(read_env_value "$REPO_DIR/.env" PROSER_SSH_KNOWN_HOSTS)}"
SUDO_PASSWORD="$(read_env_value "$REPO_DIR/.env" PROSER_SUDO_PASSWORD)"
PROSER_BASE_URL="${PROSER_BASE_URL:-$(read_env_value "$REPO_DIR/.env" PUBLIC_BASE_URL)}"

[[ -n "$SSH_USER" ]] || die "SSH user is required. Set PROSER_USER or pass --user."
[[ -f "$SSH_IDENTITY_FILE" ]] || die "SSH key is required. Set PROSER_SSH_KEY or pass --identity-file."
[[ -f "$SSH_KNOWN_HOSTS_FILE" ]] || die "Pinned hosts are required. Set PROSER_SSH_KNOWN_HOSTS or pass --known-hosts-file."
[[ -n "$SUDO_PASSWORD" ]] || die "PROSER_SUDO_PASSWORD is required for Factory privileged operations."
[[ -n "$PROSER_BASE_URL" ]] || die "Proser URL is required. Set PUBLIC_BASE_URL or pass --proser-base-url."

safe_agent="${AGENT_HOST//[!A-Za-z0-9_.-]/-}"
IDENTITY_ID="${IDENTITY_ID:-service:hermes-agent:${safe_agent}}"
PROSER_USERNAME="${PROSER_USERNAME:-hermes-agent-${safe_agent}}"

SSH_OPTS=(
  -p "$SSH_PORT"
  -i "$SSH_IDENTITY_FILE"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o PasswordAuthentication=no
  -o KbdInteractiveAuthentication=no
  -o StrictHostKeyChecking=yes
  -o UpdateHostKeys=no
  -o GlobalKnownHostsFile=/dev/null
  -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS_FILE"
)
SCP_OPTS=(
  -P "$SSH_PORT"
  -i "$SSH_IDENTITY_FILE"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o PasswordAuthentication=no
  -o KbdInteractiveAuthentication=no
  -o StrictHostKeyChecking=yes
  -o UpdateHostKeys=no
  -o GlobalKnownHostsFile=/dev/null
  -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS_FILE"
)
SSH_CMD=(ssh "${SSH_OPTS[@]}")
SCP_CMD=(scp "${SCP_OPTS[@]}")

remote() {
  local host="$1"
  shift
  "${SSH_CMD[@]}" "${SSH_USER}@${host}" "$@"
}

remote_sudo() {
  local host="$1"
  shift
  printf '%s\n' "$SUDO_PASSWORD" | "${SSH_CMD[@]}" "${SSH_USER}@${host}" "sudo -S -p '' $*"
}

tmpdir="$(mktemp -d)"
cleanup() {
  if [[ -n "${HERMES_SECRET_FILE:-}" && -f "$HERMES_SECRET_FILE" ]]; then
    shred -u -- "$HERMES_SECRET_FILE" 2>/dev/null || rm -f -- "$HERMES_SECRET_FILE"
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT

printf 'Adding %s to Factory Hermes identity allowlist on %s...\n' "$IDENTITY_ID" "$FACTORY_HOST"
allowlist_helper="$tmpdir/provision-hermes-allowlist.py"
cat > "$allowlist_helper" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
identity = sys.argv[2]
owner = sys.argv[3]
if not path.exists():
    raise SystemExit(f"Factory env not found: {path}")

lines = path.read_text().splitlines()

def split_ids(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]

values: dict[str, str] = {}
for line in lines:
    if not line or line.lstrip().startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    values[key.strip()] = value.strip().strip('"').strip("'")

ids: list[str] = []
primary = values.get("HERMES_AGENT_GITHUB_ID", "service:hermes-agent")
for item in [primary, *split_ids(values.get("HERMES_AGENT_ALLOWED_GITHUB_IDS", "")), identity]:
    if item and item not in ids:
        ids.append(item)

new_line = "HERMES_AGENT_ALLOWED_GITHUB_IDS=" + ",".join(ids)
owners = split_ids(values.get("HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS", ""))
if owner and owner not in owners:
    owners.append(owner)
owner_line = "HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS=" + ",".join(owners)
updated = False
owner_updated = False
out: list[str] = []
for line in lines:
    if line.startswith("HERMES_AGENT_ALLOWED_GITHUB_IDS="):
        out.append(new_line)
        updated = True
    elif owner and line.startswith("HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS="):
        out.append(owner_line)
        owner_updated = True
    else:
        out.append(line)

if not updated:
    if out and out[-1].strip():
        out.append("")
    out.append(new_line)
if owner and not owner_updated:
    out.append(owner_line)

path.write_text("\n".join(out) + "\n")
print(f"allowlist_count={len(ids)}")
PY
remote_allowlist_helper="/tmp/provision-hermes-allowlist.py"
"${SCP_CMD[@]}" "$allowlist_helper" "${SSH_USER}@${FACTORY_HOST}:${remote_allowlist_helper}"
remote_sudo "$FACTORY_HOST" "python3 '$remote_allowlist_helper' '$FACTORY_ENV' '$IDENTITY_ID' '$OWNER_GITHUB_ID'"
remote "$FACTORY_HOST" "rm -f '$remote_allowlist_helper'"

if [[ "$RESTART_FACTORY" == "1" ]]; then
  printf 'Restarting Factory service %s on %s...\n' "$FACTORY_SERVICE" "$FACTORY_HOST"
  remote_sudo "$FACTORY_HOST" "systemctl restart '$FACTORY_SERVICE'"
  remote "$FACTORY_HOST" "systemctl is-active '$FACTORY_SERVICE'"
fi

printf 'Reading dedicated Hermes signing secret from Factory host...\n'
HERMES_SECRET="$(remote "$FACTORY_HOST" "awk -F= '\$1 == \"HERMES_AGENT_AUTH_SECRET\" { value = substr(\$0, index(\$0, \"=\") + 1); gsub(/^[[:space:]]+|[[:space:]]+$/, \"\", value); gsub(/^\"|\"$/, \"\", value); gsub(/^'\''|'\''$/, \"\", value); print value; exit }' '$FACTORY_ENV'")"
[[ -n "$HERMES_SECRET" ]] || die "HERMES_AGENT_AUTH_SECRET is missing from $FACTORY_HOST:$FACTORY_ENV"
HERMES_SECRET_FILE="$tmpdir/proser-auth-secret"
printf '%s\n' "$HERMES_SECRET" >"$HERMES_SECRET_FILE"
chmod 0600 "$HERMES_SECRET_FILE"
unset HERMES_SECRET

ca_file="$PROSER_CA_FILE"
if [[ -z "$ca_file" ]]; then
  tls_ca="$(remote "$FACTORY_HOST" "awk -F= '\$1 == \"TLS_CA_FILE\" { value = substr(\$0, index(\$0, \"=\") + 1); gsub(/^[[:space:]]+|[[:space:]]+$/, \"\", value); gsub(/^\"|\"$/, \"\", value); gsub(/^'\''|'\''$/, \"\", value); print value; exit }' '$FACTORY_ENV'")"
  if [[ -n "$tls_ca" ]]; then
    if [[ "$tls_ca" = /* ]]; then
      remote_ca="$tls_ca"
    else
      remote_env_dir="$(dirname "$FACTORY_ENV")"
      remote_ca="$remote_env_dir/$tls_ca"
    fi
    ca_file="$tmpdir/proser-ca.crt"
    printf 'Fetching Factory CA certificate from %s:%s...\n' "$FACTORY_HOST" "$remote_ca"
    "${SCP_CMD[@]}" "${SSH_USER}@${FACTORY_HOST}:${remote_ca}" "$ca_file"
  fi
fi

deploy_args=(
  --host "$AGENT_SSH_HOST"
  --user "$SSH_USER"
  --identity-file "$SSH_IDENTITY_FILE"
  --known-hosts-file "$SSH_KNOWN_HOSTS_FILE"
  --proser-base-url "$PROSER_BASE_URL"
  --proser-auth-secret-file "$HERMES_SECRET_FILE"
  --proser-github-id "$IDENTITY_ID"
  --proser-username "$PROSER_USERNAME"
  --token-issuer hermes-agent
)

if [[ -n "$OWNER_GITHUB_ID" ]]; then
  deploy_args+=(--proser-owner-github-id "$OWNER_GITHUB_ID")
fi

if [[ -n "$PROSER_EMAIL" ]]; then
  deploy_args+=(--proser-email "$PROSER_EMAIL")
fi
if [[ -n "$REMOTE_PLUGIN_DIR" ]]; then
  deploy_args+=(--remote-plugin-dir "$REMOTE_PLUGIN_DIR")
fi
if [[ -n "$ca_file" ]]; then
  deploy_args+=(--proser-ca-file "$ca_file")
fi
if [[ "$RESTART_GATEWAY" == "1" ]]; then
  deploy_args+=(--restart-service "$GATEWAY_SERVICE")
fi

printf 'Deploying plugin identity %s to %s...\n' "$IDENTITY_ID" "$AGENT_SSH_HOST"
"$SCRIPT_DIR/deploy-hermes-proser-plugin-ubuntu24.sh" "${deploy_args[@]}"

printf 'Provisioned %s on %s as %s.\n' "$IDENTITY_ID" "$AGENT_SSH_HOST" "$PROSER_USERNAME"
