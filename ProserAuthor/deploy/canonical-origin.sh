# Read only the configured browser origin from the protected host file.
canonical_https_origin() {
  local LC_ALL=C origin
  origin="$(awk '
    /^AUTH_URL=/ { auth = substr($0, index($0, "=") + 1) }
    /^NEXTAUTH_URL=/ { nextauth = substr($0, index($0, "=") + 1) }
    END {
      value = (auth == "" ? nextauth : auth)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      print value
    }
  ' "$1")" || return
  origin="${origin%\"}"
  origin="${origin#\"}"
  origin="${origin%\'}"
  origin="${origin#\'}"
  origin="${origin%/}"
  if [[ ! "$origin" =~ ^https://[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z0-9]+$ ]]; then
    echo 'Set AUTH_URL or NEXTAUTH_URL to the canonical HTTPS origin on port 443.' >&2
    return 1
  fi
  printf '%s\n' "$origin"
}
