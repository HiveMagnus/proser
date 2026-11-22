#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="proser-api"
REMOTE_PLUGIN_DIR="~/.hermes/plugins/${PLUGIN_NAME}"
SSH_PORT="22"
SSH_HOST=""
SSH_USER=""
SSH_IDENTITY_FILE=""
SSH_KNOWN_HOSTS_FILE=""
PROSER_BASE_URL=""
PROSER_TOKEN=""
PROSER_AUTH_SECRET=""
PROSER_TOKEN_FILE=""
PROSER_AUTH_SECRET_FILE=""
PROSER_GITHUB_ID="service:hermes-agent"
PROSER_USERNAME="hermes-agent"
PROSER_OWNER_GITHUB_ID=""
PROSER_EMAIL=""
PROSER_TOKEN_TTL_SECONDS="600"
PROSER_TOKEN_ISSUER="hermes-agent"
PROSER_TOKEN_AUDIENCE="proser-factory"
PROSER_CA_FILE=""
ENABLE_PLUGIN="1"
SKIP_ENV="0"
ENROLL_AGENT="1"
RESTART_SERVICE=""

usage() {
  cat <<'USAGE'
Deploy the Proser Hermes Agent plugin to an Ubuntu 24 host over SSH.

Required SSH options:
  --host HOST                    Remote host or IP.
  --user USER                    Remote SSH user.
  --identity-file PATH           SSH private key path.
  --known-hosts-file PATH        Pinned OpenSSH known_hosts file.

Required Proser options unless --skip-env is used:
  --proser-base-url URL          ProserFactory base URL reachable from the Hermes host.
  --proser-token-file PATH       Owner-only file containing a pre-minted bearer token.
    or
  --proser-auth-secret-file PATH Owner-only file containing HERMES_AGENT_AUTH_SECRET.

Optional:
  --port PORT                    SSH port. Default: 22.
  --remote-plugin-dir PATH       Install path. Default: ~/.hermes/plugins/proser-api.
  --proser-github-id VALUE       JWT githubId. Default: service:hermes-agent.
  --proser-username VALUE        JWT username. Default: hermes-agent.
  --proser-owner-github-id ID    Existing author identity the agent acts for.
  --proser-email VALUE           Optional JWT email.
  --token-ttl-seconds SECONDS    Signed token lifetime. Default: 600.
  --token-issuer VALUE           JWT issuer for signed tokens. Default: hermes-agent.
  --token-audience VALUE         JWT audience. Default: proser-factory.
  --proser-ca-file PATH          CA certificate bundle for Proser HTTPS. The file
                                 is uploaded beside the plugin and used by the
                                 plugin for TLS verification.
  --skip-env                     Copy plugin only; do not write plugin .env.
  --enroll / --no-enroll         After install, make one authenticated Proser
                                 call from the remote host. Default: --enroll.
  --enable / --no-enable         Enable plugin in Hermes config. Default: --enable.
  --restart-service NAME         Restart a systemd service after install.
                                 Tries systemctl --user, then sudo systemctl.

Example:
  scripts/deploy-hermes-proser-plugin-ubuntu24.sh \
    --host hivehub.example.net \
    --user hermes \
    --identity-file ~/.ssh/hermes_ed25519 \
    --known-hosts-file ~/.ssh/hermes_known_hosts \
    --proser-base-url http://proser-factory.internal:3001 \
    --proser-auth-secret-file /run/user/1000/proser-auth-secret \
    --restart-service hermes-agent
USAGE
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

load_secret_file() {
  local path="$1" label="$2" destination="$3" mode owner links size
  local -a lines=()
  [[ -f "$path" && ! -L "$path" ]] || die "$label must name a regular, non-symlink file"
  mode="$(stat -c %a -- "$path")"
  owner="$(stat -c %u -- "$path")"
  links="$(stat -c %h -- "$path")"
  size="$(stat -c %s -- "$path")"
  [[ "$mode" == 600 ]] || die "$label must have mode 0600"
  [[ "$owner" == "$(id -u)" ]] || die "$label must be owned by the current user"
  [[ "$links" == 1 ]] || die "$label must have exactly one hard link"
  [[ "$size" -gt 0 && "$size" -le 16384 ]] || die "$label has an invalid size"
  mapfile -t lines <"$path"
  [[ ${#lines[@]} -eq 1 && -n "${lines[0]}" ]] || die "$label must contain exactly one non-empty line"
  printf -v "$destination" '%s' "${lines[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) SSH_HOST="${2:-}"; shift 2 ;;
    --user) SSH_USER="${2:-}"; shift 2 ;;
    --port) SSH_PORT="${2:-}"; shift 2 ;;
    --identity-file) SSH_IDENTITY_FILE="${2:-}"; shift 2 ;;
    --known-hosts-file) SSH_KNOWN_HOSTS_FILE="${2:-}"; shift 2 ;;
    --remote-plugin-dir) REMOTE_PLUGIN_DIR="${2:-}"; shift 2 ;;
    --proser-base-url) PROSER_BASE_URL="${2:-}"; shift 2 ;;
    --proser-token-file) PROSER_TOKEN_FILE="${2:-}"; shift 2 ;;
    --proser-auth-secret-file) PROSER_AUTH_SECRET_FILE="${2:-}"; shift 2 ;;
    --proser-github-id) PROSER_GITHUB_ID="${2:-}"; shift 2 ;;
    --proser-username) PROSER_USERNAME="${2:-}"; shift 2 ;;
    --proser-owner-github-id) PROSER_OWNER_GITHUB_ID="${2:-}"; shift 2 ;;
    --proser-email) PROSER_EMAIL="${2:-}"; shift 2 ;;
    --token-ttl-seconds) PROSER_TOKEN_TTL_SECONDS="${2:-}"; shift 2 ;;
    --token-issuer) PROSER_TOKEN_ISSUER="${2:-}"; shift 2 ;;
    --token-audience) PROSER_TOKEN_AUDIENCE="${2:-}"; shift 2 ;;
    --proser-ca-file) PROSER_CA_FILE="${2:-}"; shift 2 ;;
    --skip-env) SKIP_ENV="1"; shift ;;
    --enroll) ENROLL_AGENT="1"; shift ;;
    --no-enroll) ENROLL_AGENT="0"; shift ;;
    --enable) ENABLE_PLUGIN="1"; shift ;;
    --no-enable) ENABLE_PLUGIN="0"; shift ;;
    --restart-service) RESTART_SERVICE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -z "$PROSER_TOKEN_FILE" || -z "$PROSER_AUTH_SECRET_FILE" ]] || \
  die "Provide only one of --proser-token-file or --proser-auth-secret-file"
[[ -z "$PROSER_TOKEN_FILE" ]] || load_secret_file "$PROSER_TOKEN_FILE" "--proser-token-file" PROSER_TOKEN
[[ -z "$PROSER_AUTH_SECRET_FILE" ]] || \
  load_secret_file "$PROSER_AUTH_SECRET_FILE" "--proser-auth-secret-file" PROSER_AUTH_SECRET

[[ -n "$SSH_HOST" ]] || die "--host is required"
[[ -n "$SSH_USER" ]] || die "--user is required"
[[ -f "$SSH_IDENTITY_FILE" ]] || die "--identity-file must name a readable private key"
[[ -f "$SSH_KNOWN_HOSTS_FILE" ]] || die "--known-hosts-file must name a pinned known_hosts file"

if [[ "$SKIP_ENV" != "1" ]]; then
  [[ -n "$PROSER_BASE_URL" ]] || die "--proser-base-url is required unless --skip-env is used"
  [[ -n "$PROSER_TOKEN" || -n "$PROSER_AUTH_SECRET" ]] || \
    die "Provide --proser-token-file or --proser-auth-secret-file unless --skip-env is used"
  [[ -z "$PROSER_CA_FILE" || -f "$PROSER_CA_FILE" ]] || die "Proser CA file not found: $PROSER_CA_FILE"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_SRC="$REPO_ROOT/hermes/plugins/$PLUGIN_NAME"
DEPLOY_REVISION="$(git -C "$REPO_ROOT/.." rev-parse HEAD)"

[[ -f "$PLUGIN_SRC/plugin.yaml" ]] || die "Missing plugin source at $PLUGIN_SRC"
[[ -f "$PLUGIN_SRC/__init__.py" ]] || die "Missing plugin __init__.py at $PLUGIN_SRC"

REMOTE="${SSH_USER}@${SSH_HOST}"
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
  "${SSH_CMD[@]}" "$REMOTE" "$@"
}

printf 'Checking remote host...\n'
remote 'command -v python3 >/dev/null || { echo "python3 is required on the remote Ubuntu 24 host" >&2; exit 1; }'
REMOTE_HOME="$(remote 'printf %s "$HOME"')"
REMOTE_PLUGIN_DIR="${REMOTE_PLUGIN_DIR/#\~/$REMOTE_HOME}"

printf -v REMOTE_PLUGIN_DIR_Q '%q' "$REMOTE_PLUGIN_DIR"
REMOTE_ARCHIVE="/tmp/${PLUGIN_NAME}-plugin.tar.gz"
REMOTE_ENV="/tmp/${PLUGIN_NAME}.env"
REMOTE_ENABLE="/tmp/${PLUGIN_NAME}-enable.py"
REMOTE_SKILLS_LINK="/tmp/${PLUGIN_NAME}-link-skills.py"
REMOTE_CA_BASENAME="proser-ca.crt"
REMOTE_CA="/tmp/${PLUGIN_NAME}-ca.crt"

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

archive="$tmpdir/${PLUGIN_NAME}.tar.gz"
tar -C "$PLUGIN_SRC" \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='.env' \
  -czf "$archive" .

printf 'Uploading plugin to %s:%s...\n' "$REMOTE" "$REMOTE_PLUGIN_DIR"
"${SCP_CMD[@]}" "$archive" "$REMOTE:$REMOTE_ARCHIVE"
remote "set -eu; env_keep=/tmp/${PLUGIN_NAME}.env.keep; ca_keep=/tmp/${PLUGIN_NAME}.ca.keep; [ ! -f $REMOTE_PLUGIN_DIR_Q/.env ] || cp $REMOTE_PLUGIN_DIR_Q/.env \"\$env_keep\"; [ ! -f $REMOTE_PLUGIN_DIR_Q/$REMOTE_CA_BASENAME ] || cp $REMOTE_PLUGIN_DIR_Q/$REMOTE_CA_BASENAME \"\$ca_keep\"; rm -rf -- $REMOTE_PLUGIN_DIR_Q; mkdir -p $REMOTE_PLUGIN_DIR_Q; tar -xzf '$REMOTE_ARCHIVE' -C $REMOTE_PLUGIN_DIR_Q; [ ! -f \"\$env_keep\" ] || { mv \"\$env_keep\" $REMOTE_PLUGIN_DIR_Q/.env; chmod 600 $REMOTE_PLUGIN_DIR_Q/.env; }; [ ! -f \"\$ca_keep\" ] || mv \"\$ca_keep\" $REMOTE_PLUGIN_DIR_Q/$REMOTE_CA_BASENAME; rm -f '$REMOTE_ARCHIVE'"
remote "printf '%s\n' '$DEPLOY_REVISION' > $REMOTE_PLUGIN_DIR_Q/REVISION"

printf 'Linking plugin skills into Hermes skill discovery path...\n'
skills_link_file="$tmpdir/link_plugin_skills.py"
cat > "$skills_link_file" <<'PY'
from pathlib import Path
import os
import shutil
import sys
import time

plugin_dir = Path(sys.argv[1]).expanduser().resolve()
skills_src = plugin_dir / "skills"
skills_dest = Path.home() / ".hermes" / "skills" / "writing"
skill_names = [
    "proser-authoring", "proser-book-reader", "proser-codex-entry-designer", "proser-workflows", "proser-editorial",
]
retired_skill_names = [
    "proser-book-blueprint", "proser-whole-book", "proser-story-architect",
    "proser-character-arc-designer", "proser-novel-production",
]

skills_dest.mkdir(parents=True, exist_ok=True)

for name in skill_names:
    src = skills_src / name
    if not (src / "SKILL.md").is_file():
        raise SystemExit(f"Missing skill source: {src / 'SKILL.md'}")

    dest = skills_dest / name
    if dest.is_symlink() or dest.is_file():
        dest.unlink()
    elif dest.exists():
        if dest.resolve() == src:
            continue
        backup = dest.with_name(f"{dest.name}.bak.{int(time.time())}")
        shutil.move(str(dest), str(backup))
        print(f"Backed up existing non-symlink skill directory to {backup}")

    os.symlink(src, dest, target_is_directory=True)
    print(f"{dest} -> {src}")

for name in retired_skill_names:
    dest = skills_dest / name
    if dest.is_symlink():
        dest.unlink()
        print(f"Removed retired skill link {dest}")
PY
"${SCP_CMD[@]}" "$skills_link_file" "$REMOTE:$REMOTE_SKILLS_LINK"
remote "python3 '$REMOTE_SKILLS_LINK' $REMOTE_PLUGIN_DIR_Q && rm -f '$REMOTE_SKILLS_LINK'"

if [[ "$SKIP_ENV" != "1" ]]; then
  env_file="$tmpdir/${PLUGIN_NAME}.env"
  {
    printf '# Managed by deploy-hermes-proser-plugin-ubuntu24.sh\n'
    printf 'PROSER_BASE_URL=%s\n' "$PROSER_BASE_URL"
    [[ -z "$PROSER_TOKEN" ]] || printf 'PROSER_TOKEN=%s\n' "$PROSER_TOKEN"
    [[ -z "$PROSER_AUTH_SECRET" ]] || printf 'PROSER_AUTH_SECRET=%s\n' "$PROSER_AUTH_SECRET"
    printf 'PROSER_GITHUB_ID=%s\n' "$PROSER_GITHUB_ID"
    printf 'PROSER_USERNAME=%s\n' "$PROSER_USERNAME"
    [[ -z "$PROSER_OWNER_GITHUB_ID" ]] || printf 'PROSER_OWNER_GITHUB_ID=%s\n' "$PROSER_OWNER_GITHUB_ID"
    [[ -z "$PROSER_EMAIL" ]] || printf 'PROSER_EMAIL=%s\n' "$PROSER_EMAIL"
    printf 'PROSER_TOKEN_TTL_SECONDS=%s\n' "$PROSER_TOKEN_TTL_SECONDS"
    printf 'PROSER_TOKEN_ISSUER=%s\n' "$PROSER_TOKEN_ISSUER"
    printf 'PROSER_TOKEN_AUDIENCE=%s\n' "$PROSER_TOKEN_AUDIENCE"
    printf 'PROSER_READ_TIMEOUT_SECONDS=30\n'
    printf 'PROSER_GENERATION_TIMEOUT_SECONDS=180\n'
    printf 'PROSER_MAX_RESPONSE_BYTES=8388608\n'
    [[ -z "$PROSER_CA_FILE" ]] || printf 'PROSER_CA_FILE=%s/%s\n' "$REMOTE_PLUGIN_DIR" "$REMOTE_CA_BASENAME"
  } > "$env_file"
  chmod 600 "$env_file"
  printf 'Uploading plugin environment file...\n'
  "${SCP_CMD[@]}" "$env_file" "$REMOTE:$REMOTE_ENV"
  remote "mv '$REMOTE_ENV' $REMOTE_PLUGIN_DIR_Q/.env && chmod 600 $REMOTE_PLUGIN_DIR_Q/.env"
  if [[ -n "$PROSER_CA_FILE" ]]; then
    printf 'Uploading Proser CA certificate...\n'
    "${SCP_CMD[@]}" "$PROSER_CA_FILE" "$REMOTE:$REMOTE_CA"
    remote "mv '$REMOTE_CA' $REMOTE_PLUGIN_DIR_Q/$REMOTE_CA_BASENAME && chmod 644 $REMOTE_PLUGIN_DIR_Q/$REMOTE_CA_BASENAME"
  fi
fi

if [[ "$ENABLE_PLUGIN" == "1" ]]; then
  printf 'Enabling plugin in Hermes config...\n'
  if remote "command -v hermes >/dev/null 2>&1 && hermes plugins enable '$PLUGIN_NAME'"; then
    printf 'Enabled with hermes plugins enable.\n'
  else
    enable_file="$tmpdir/enable_plugin.py"
    cat > "$enable_file" <<'PY'
from pathlib import Path
import re
import sys

name = sys.argv[1]
config = Path.home() / ".hermes" / "config.yaml"
config.parent.mkdir(parents=True, exist_ok=True)

if not config.exists():
    config.write_text(f"plugins:\n  enabled:\n    - {name}\n", encoding="utf-8")
    raise SystemExit(0)

lines = config.read_text(encoding="utf-8").splitlines()
item_re = re.compile(rf"^\s*-\s*{re.escape(name)}\s*$")
lines = [line for line in lines if not item_re.match(line)]

plugins_idx = None
for idx, line in enumerate(lines):
    if re.match(r"^plugins:\s*$", line):
        plugins_idx = idx
        break

if plugins_idx is None:
    if lines and lines[-1].strip():
        lines.append("")
    lines.extend(["plugins:", "  enabled:", f"    - {name}"])
    config.write_text("\n".join(lines) + "\n", encoding="utf-8")
    raise SystemExit(0)

block_end = len(lines)
for idx in range(plugins_idx + 1, len(lines)):
    if lines[idx] and not lines[idx].startswith((" ", "\t")):
        block_end = idx
        break

enabled_idx = None
for idx in range(plugins_idx + 1, block_end):
    if re.match(r"^\s{2}enabled:\s*$", lines[idx]):
        enabled_idx = idx
        break

if enabled_idx is None:
    lines[plugins_idx + 1:plugins_idx + 1] = ["  enabled:", f"    - {name}"]
else:
    # Hermes has historically emitted both two- and four-space list items here.
    # Normalize the complete enabled list so inserting this plugin cannot leave
    # a syntactically invalid YAML sequence beside the next two-space key.
    list_end = enabled_idx + 1
    enabled_items = []
    while list_end < block_end:
        line = lines[list_end]
        if not line.strip():
            list_end += 1
            continue
        match = re.match(r"^\s*-\s*(.+?)\s*$", line)
        if not match:
            break
        enabled_items.append(match.group(1))
        list_end += 1
    enabled_items.append(name)
    enabled_items = list(dict.fromkeys(enabled_items))
    lines[enabled_idx + 1:list_end] = [f"    - {item}" for item in enabled_items]

config.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
    "${SCP_CMD[@]}" "$enable_file" "$REMOTE:$REMOTE_ENABLE"
    remote "python3 '$REMOTE_ENABLE' '$PLUGIN_NAME' && rm -f '$REMOTE_ENABLE'"
    remote "python3 -c 'from pathlib import Path; import yaml; yaml.safe_load((Path.home() / \".hermes/config.yaml\").read_text())'"
    printf 'Enabled by updating ~/.hermes/config.yaml.\n'
  fi
fi

printf 'Verifying remote plugin files...\n'
remote "test -f $REMOTE_PLUGIN_DIR_Q/plugin.yaml && test -f $REMOTE_PLUGIN_DIR_Q/__init__.py && test -f $REMOTE_PLUGIN_DIR_Q/tools.py && test -f $REMOTE_PLUGIN_DIR_Q/schemas.py"
printf 'Verifying Hermes skill discovery symlinks...\n'
remote "test -f ~/.hermes/skills/writing/proser-authoring/SKILL.md && test -f ~/.hermes/skills/writing/proser-book-reader/SKILL.md && test -f ~/.hermes/skills/writing/proser-codex-entry-designer/SKILL.md && test -f ~/.hermes/skills/writing/proser-workflows/SKILL.md && test -f ~/.hermes/skills/writing/proser-editorial/SKILL.md"
printf 'Verifying plugin revision and editorial tool exports...\n'
remote "test \"\$(cat $REMOTE_PLUGIN_DIR_Q/REVISION)\" = '$DEPLOY_REVISION'"
remote "python3 -c 'import importlib.util; p=\"$REMOTE_PLUGIN_DIR/tools.py\"; s=importlib.util.spec_from_file_location(\"proser_tools_verify\", p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); assert callable(m.proser_editorial_optimize); assert callable(m.proser_editorial)'"
printf 'Verifying retired Hermes skill links are absent...\n'
remote "test ! -e ~/.hermes/skills/writing/proser-book-blueprint && test ! -e ~/.hermes/skills/writing/proser-whole-book && test ! -e ~/.hermes/skills/writing/proser-story-architect && test ! -e ~/.hermes/skills/writing/proser-character-arc-designer && test ! -e ~/.hermes/skills/writing/proser-novel-production"

if [[ "$ENROLL_AGENT" == "1" && "$SKIP_ENV" != "1" ]]; then
  printf 'Enrolling/verifying Hermes Proser identity from the remote host...\n'
  enroll_file="$tmpdir/enroll_proser_identity.py"
  cat > "$enroll_file" <<'PY'
from pathlib import Path
import importlib.util
import json
import sys

plugin_dir = Path(sys.argv[1])
tools_path = plugin_dir / "tools.py"
spec = importlib.util.spec_from_file_location("proser_api_tools_enroll", tools_path)
if spec is None or spec.loader is None:
    raise SystemExit(f"Unable to load {tools_path}")

tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)

result = json.loads(tools.proser_books({"action": "list_books", "timeoutSeconds": 30}))
print(json.dumps(result, indent=2, sort_keys=True))

if not result.get("ok"):
    raise SystemExit(1)

response = result.get("response")
if isinstance(response, dict) and response.get("success") is False:
    raise SystemExit(1)
PY
  REMOTE_ENROLL="/tmp/${PLUGIN_NAME}-enroll.py"
  "${SCP_CMD[@]}" "$enroll_file" "$REMOTE:$REMOTE_ENROLL"
  remote "python3 '$REMOTE_ENROLL' $REMOTE_PLUGIN_DIR_Q && rm -f '$REMOTE_ENROLL'"
  printf 'Hermes Proser identity is enrolled and reachable.\n'
fi

if [[ -n "$RESTART_SERVICE" ]]; then
  printf 'Restarting service %s...\n' "$RESTART_SERVICE"
  if remote "systemctl --user restart '$RESTART_SERVICE'"; then
    printf 'Restarted user service %s.\n' "$RESTART_SERVICE"
  else
    remote "sudo systemctl restart '$RESTART_SERVICE'"
    printf 'Restarted system service %s.\n' "$RESTART_SERVICE"
  fi
fi

printf 'Done. Plugin installed at %s:%s\n' "$REMOTE" "$REMOTE_PLUGIN_DIR"
printf 'Restart Hermes or start a new Hermes session if it was not restarted by this script.\n'
