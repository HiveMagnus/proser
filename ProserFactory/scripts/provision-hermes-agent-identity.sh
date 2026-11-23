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
FACTORY_USER="proser-factory"
COMPOSE_FILES=()
COMPOSE_ENV_FILE=""
COMPOSE_FACTORY_SERVICE="factory"
COMPOSE_WORKER_SERVICE="worker"
CONTAINER_OWNER=""
REVOKE="0"

usage() {
  cat <<'USAGE'
Provision a per-host Proser identity for a Hermes Agent plugin.

The script:
  1. Generates a new signing secret for the identity on this machine and
     stores it on the Factory host, scoped to --owner-github-id when given.
     A native Factory keeps it in HERMES_AGENT_CREDENTIALS_FILE (created beside
     the Factory .env if unset). Compose layouts are described below. Each run
     replaces the identity's previous secret.
  2. Restarts Factory (or recreates its Compose services) to load it.
  3. Deploys/configures the Hermes Proser plugin on the target agent host with
     that secret. No other agent host can sign as this identity.
  4. Enrolls the identity with a remote Proser list_books call.
  5. Restarts the target Hermes gateway.

With --revoke, the script removes the identity's credential, restarts Factory
and stops: tokens from that agent host are refused from then on.

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
  --factory-user USER            User the Factory service runs as. Default: proser-factory.

Compose installations (instead of --factory-env/--factory-service/--factory-user):
  --compose-file PATH            Absolute path of a Compose file on the Factory host.
                                 Repeat for override files, in order. When the
                                 factory service reads an env_file, the secret goes
                                 in a file inside its secrets bind mount. Otherwise,
                                 as with the repository's compose.yml, it goes into
                                 HERMES_AGENT_CREDENTIALS in --compose-env-file.
  --compose-env-file PATH        Compose interpolation env file, e.g. .env.compose.
  --compose-factory-service NAME Factory service. Default: factory.
  --compose-worker-service NAME  Worker service restarted with Factory. Default:
                                 worker. Pass an empty value to skip it.
  --container-owner UID:GID      Owner of the credentials file. Default: the user
                                 the running factory container reports.
  --revoke                       Remove the identity's credential and stop.

Examples:
  scripts/provision-hermes-agent-identity.sh --agent-host agent-host
  scripts/provision-hermes-agent-identity.sh --agent-host agent-host \
    --compose-file /opt/proser-compose/compose.yml --owner-github-id iam:author
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
    --factory-user) FACTORY_USER="${2:-}"; shift 2 ;;
    --compose-file) COMPOSE_FILES+=("${2:-}"); shift 2 ;;
    --compose-env-file) COMPOSE_ENV_FILE="${2:-}"; shift 2 ;;
    --compose-factory-service) COMPOSE_FACTORY_SERVICE="${2:-}"; shift 2 ;;
    --compose-worker-service) COMPOSE_WORKER_SERVICE="${2:-}"; shift 2 ;;
    --container-owner) CONTAINER_OWNER="${2:-}"; shift 2 ;;
    --revoke) REVOKE="1"; shift ;;
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
identity_pattern='^[A-Za-z0-9:._@+-]{1,160}$'
[[ "$IDENTITY_ID" =~ $identity_pattern ]] || die "--identity-id may contain only letters, digits and :._@+-"
[[ -z "$OWNER_GITHUB_ID" || "$OWNER_GITHUB_ID" =~ $identity_pattern ]] || die "--owner-github-id may contain only letters, digits and :._@+-"
path_pattern='^/[A-Za-z0-9/._-]+$'
service_pattern='^[A-Za-z0-9_.-]{1,64}$'
if [[ ${#COMPOSE_FILES[@]} -gt 0 ]]; then
  for file in "${COMPOSE_FILES[@]}"; do
    [[ "$file" =~ $path_pattern ]] || die "--compose-file must be an absolute path without spaces or quotes"
  done
  [[ -z "$COMPOSE_ENV_FILE" || "$COMPOSE_ENV_FILE" =~ $path_pattern ]] || die "--compose-env-file must be an absolute path without spaces or quotes"
  [[ "$COMPOSE_FACTORY_SERVICE" =~ $service_pattern ]] || die "--compose-factory-service is not a valid service name"
  [[ -z "$COMPOSE_WORKER_SERVICE" || "$COMPOSE_WORKER_SERVICE" =~ $service_pattern ]] || die "--compose-worker-service is not a valid service name"
  [[ -z "$CONTAINER_OWNER" || "$CONTAINER_OWNER" =~ ^[0-9]{1,10}:[0-9]{1,10}$ ]] || die "--container-owner must be UID:GID"
else
  [[ "$FACTORY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "--factory-user is not a valid user name"
  [[ "$FACTORY_ENV" =~ $path_pattern ]] || die "--factory-env must be an absolute path without spaces or quotes"
fi

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

# The helper runs as root from an inline argument, so nothing is staged in a
# shared temporary directory. sudo -k always reads the password from stdin.
credential_helper="$(base64 -w0 "$SCRIPT_DIR/hermes-agent-credential.py")"
# stdin carries the sudo password, then the agent secret on its own marked
# line. Both stay out of argv and off disk on the Factory host.
run_credential_helper() {
  local args=("$@")
  {
    printf '%s\n' "$SUDO_PASSWORD"
    if [[ -n "${HERMES_SECRET_FILE:-}" && -s "$HERMES_SECRET_FILE" ]]; then
      printf 'PROSER_AGENT_SECRET=%s\n' "$(<"$HERMES_SECRET_FILE")"
    fi
  } | "${SSH_CMD[@]}" "${SSH_USER}@${FACTORY_HOST}" \
    "sudo -k -S -p '' python3 -I -c 'import base64,sys;exec(compile(base64.b64decode(sys.argv.pop(1)),\"hermes-agent-credential.py\",\"exec\"),{\"__name__\":\"__main__\"})' '$credential_helper' ${args[*]}"
}

compose_command() {
  local command="docker compose"
  [[ -n "$COMPOSE_ENV_FILE" ]] && command+=" --env-file '$COMPOSE_ENV_FILE'"
  local file
  for file in "${COMPOSE_FILES[@]}"; do command+=" -f '$file'"; done
  printf '%s' "$command"
}

restart_factory() {
  if [[ ${#COMPOSE_FILES[@]} -gt 0 ]]; then
    local services="'$COMPOSE_FACTORY_SERVICE'"
    [[ -n "$COMPOSE_WORKER_SERVICE" ]] && services+=" '$COMPOSE_WORKER_SERVICE'"
    if [[ "$RESTART_FACTORY" == "1" ]]; then
      printf 'Recreating Compose services %s on %s...\n' "$services" "$FACTORY_HOST"
      remote_sudo "$FACTORY_HOST" "$(compose_command) up -d --no-build --wait --wait-timeout 180 $services"
    else
      printf 'Recreate Compose services %s on %s to apply the change.\n' "$services" "$FACTORY_HOST"
    fi
    return
  fi
  if [[ "$RESTART_FACTORY" == "1" ]]; then
    printf 'Restarting Factory service %s on %s...\n' "$FACTORY_SERVICE" "$FACTORY_HOST"
    remote_sudo "$FACTORY_HOST" "systemctl restart '$FACTORY_SERVICE'"
    remote "$FACTORY_HOST" "systemctl is-active '$FACTORY_SERVICE'"
  else
    printf 'Restart Factory service %s on %s to apply the change.\n' "$FACTORY_SERVICE" "$FACTORY_HOST"
  fi
}

helper_args=("'$IDENTITY_ID'")
if [[ ${#COMPOSE_FILES[@]} -gt 0 ]]; then
  for file in "${COMPOSE_FILES[@]}"; do helper_args+=(--compose-file "'$file'"); done
  [[ -n "$COMPOSE_ENV_FILE" ]] && helper_args+=(--compose-env-file "'$COMPOSE_ENV_FILE'")
  helper_args+=(--factory-service "'$COMPOSE_FACTORY_SERVICE'")
  [[ -n "$CONTAINER_OWNER" ]] && helper_args+=(--container-owner "'$CONTAINER_OWNER'")
else
  helper_args+=(--env-file "'$FACTORY_ENV'" --factory-user "'$FACTORY_USER'")
fi

if [[ "$REVOKE" == "1" ]]; then
  printf 'Revoking the dedicated credential for %s on %s...\n' "$IDENTITY_ID" "$FACTORY_HOST"
  run_credential_helper revoke "${helper_args[@]}"
  restart_factory
  printf 'Revoked %s. Remove the plugin configuration from %s separately.\n' "$IDENTITY_ID" "$AGENT_SSH_HOST"
  exit 0
fi

[[ -n "$OWNER_GITHUB_ID" ]] && helper_args+=(--owner "'$OWNER_GITHUB_ID'")

printf 'Issuing a new signing secret for %s on %s...\n' "$IDENTITY_ID" "$FACTORY_HOST"
HERMES_SECRET_FILE="$tmpdir/proser-auth-secret"
(umask 077; python3 -c 'import secrets; print(secrets.token_urlsafe(48))' >"$HERMES_SECRET_FILE")
run_credential_helper provision "${helper_args[@]}"

restart_factory

ca_file="$PROSER_CA_FILE"
# Only a native Factory serves TLS from its own environment file.
if [[ -z "$ca_file" && ${#COMPOSE_FILES[@]} -eq 0 ]]; then
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
