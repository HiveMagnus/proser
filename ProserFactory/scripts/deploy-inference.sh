#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

: "${INFERENCE_HOST:?INFERENCE_HOST is required}"
: "${INFERENCE_USER:?INFERENCE_USER is required}"
: "${INFERENCE_SSH_KEY:?INFERENCE_SSH_KEY is required}"
: "${INFERENCE_SSH_HOST_KEY:?INFERENCE_SSH_HOST_KEY must contain the pinned known_hosts entry}"
: "${INFERENCE_API_KEY:?INFERENCE_API_KEY is required}"
if [[ ${#INFERENCE_API_KEY} -lt 32 ]]; then
  printf 'INFERENCE_API_KEY must contain at least 32 characters.\n' >&2
  exit 2
fi

SSH_HOST="${INFERENCE_HOST#http://}"
SSH_HOST="${SSH_HOST#https://}"
SSH_HOST="${SSH_HOST%%:*}"
KNOWN_HOSTS="$(mktemp)"
API_KEY_FILE="$(mktemp)"
printf '%s\n' "$INFERENCE_SSH_HOST_KEY" >"$KNOWN_HOSTS"
chmod 0600 "$KNOWN_HOSTS"
printf '%s\n' "$INFERENCE_API_KEY" >"$API_KEY_FILE"
chmod 0600 "$API_KEY_FILE"
SSH_OPTIONS=(
  -i "$INFERENCE_SSH_KEY"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o PasswordAuthentication=no
  -o KbdInteractiveAuthentication=no
  -o StrictHostKeyChecking=yes
  -o UpdateHostKeys=no
  -o GlobalKnownHostsFile=/dev/null
  -o "UserKnownHostsFile=$KNOWN_HOSTS"
)
SSH=(ssh "${SSH_OPTIONS[@]}" "$INFERENCE_USER@$SSH_HOST")
SCP=(scp "${SSH_OPTIONS[@]}")
TEMPLATE="$ROOT_DIR/deploy/inference/qwen3.6-proser-v1/chat_template.jinja"
UNIT="${INFERENCE_UNIT_FILE:-$ROOT_DIR/deploy/inference/llama-qwen3.6.service}"
[[ -f "$UNIT" ]] || { printf 'Reviewed inference unit file is required.\n' >&2; exit 2; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ACTIVATED=0

cleanup() {
  local status=$?
  trap - EXIT
  rm -f "$KNOWN_HOSTS"
  shred -u "$API_KEY_FILE" 2>/dev/null || rm -f "$API_KEY_FILE"
  "${SSH[@]}" rm -f -- \
    "/tmp/proser-chat-template.$STAMP.jinja" \
    "/tmp/llama-qwen3.6.$STAMP.service" \
    "/tmp/proser-inference-api-keys.$STAMP" >/dev/null 2>&1 || true
  if [[ "$ACTIVATED" == 1 ]]; then
    printf 'Deployment gate failed after activation; restoring the previous inference release.\n' >&2
    if ! "${SSH[@]}" sudo -n /usr/local/sbin/proser-inference-deploy-sudo rollback "$STAMP"; then
      printf 'CRITICAL: automatic inference rollback failed for %s.\n' "$STAMP" >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

"${SCP[@]}" "$TEMPLATE" "$INFERENCE_USER@$SSH_HOST:/tmp/proser-chat-template.$STAMP.jinja"
"${SCP[@]}" "$UNIT" "$INFERENCE_USER@$SSH_HOST:/tmp/llama-qwen3.6.$STAMP.service"
"${SCP[@]}" "$API_KEY_FILE" "$INFERENCE_USER@$SSH_HOST:/tmp/proser-inference-api-keys.$STAMP"
if ! "${SSH[@]}" sudo -n /usr/local/sbin/proser-inference-deploy-sudo activate "$STAMP"; then
  "${SSH[@]}" sudo -n /usr/local/sbin/proser-inference-deploy-sudo rollback "$STAMP" >/dev/null 2>&1 || true
  "${SSH[@]}" rm -f -- \
    "/tmp/proser-chat-template.$STAMP.jinja" \
    "/tmp/llama-qwen3.6.$STAMP.service" \
    "/tmp/proser-inference-api-keys.$STAMP"
  exit 1
fi
ACTIVATED=1

for _ in $(seq 1 120); do
  if printf 'header = "Authorization: Bearer %s"\n' "$INFERENCE_API_KEY" | curl --config - -fsS --max-time 2 "$INFERENCE_HOST/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! printf 'header = "Authorization: Bearer %s"\n' "$INFERENCE_API_KEY" | curl --config - -fsS --max-time 5 "$INFERENCE_HOST/health" >/dev/null; then
  printf 'Inference health check failed.\n' >&2
  exit 1
fi
UNAUTH_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
  -H 'Content-Type: application/json' --data-binary '{}' \
  "$INFERENCE_HOST/v1/chat/completions")"
[[ "$UNAUTH_STATUS" == 401 ]]
LOCAL_SHA="$(sha256sum "$TEMPLATE" | awk '{print $1}')"
REMOTE_SHA="$("${SSH[@]}" sha256sum /opt/llama.cpp/templates/qwen3.6-proser-v1/chat_template.jinja | awk '{print $1}')"
[[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]
"${SSH[@]}" systemctl --no-pager --full status llama-qwen3.6.service | tail -n 20
"${SSH[@]}" sudo -n /usr/local/sbin/proser-inference-deploy-sudo finalize "$STAMP"
ACTIVATED=0
printf 'Deployed inference profile with template sha256 %s\n' "$LOCAL_SHA"
