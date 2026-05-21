#!/usr/bin/env bash
set -euo pipefail

# Configure Bitwarden CLI for the homelab Vaultwarden server and unlock a session.
# This script prints `export BW_SESSION=...` on success. Source/eval it in your shell:
#
#   eval "$(scripts/secrets/bw-login-vaultwarden.sh)"
#
# Required for automation mode:
#   BW_SERVER          e.g. http://192.168.0.50:8084
#   BW_CLIENTID        Bitwarden/Vaultwarden API key client id
#   BW_CLIENTSECRET    Bitwarden/Vaultwarden API key client secret
#   BW_PASSWORD        Vault master password, read via --passwordenv
#
# Interactive mode:
#   BW_SERVER=http://192.168.0.50:8084 scripts/secrets/bw-login-vaultwarden.sh --interactive
#
# Security:
# - Do not commit real environment files containing these values.
# - Treat BW_SESSION as a secret.
# - This script avoids echoing secret values except for the explicit export line.

usage() {
  cat >&2 <<'USAGE'
Usage:
  BW_SERVER=http://192.168.0.50:8084 BW_CLIENTID=... BW_CLIENTSECRET=... BW_PASSWORD=... scripts/secrets/bw-login-vaultwarden.sh
  BW_SERVER=http://192.168.0.50:8084 scripts/secrets/bw-login-vaultwarden.sh --interactive
USAGE
}

interactive=false
if [[ "${1:-}" == "--interactive" ]]; then
  interactive=true
elif [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
elif [[ -n "${1:-}" ]]; then
  usage
  exit 2
fi

if ! command -v bw >/dev/null 2>&1; then
  echo "ERROR: Bitwarden CLI 'bw' is not installed. Install with: npm install -g @bitwarden/cli" >&2
  exit 127
fi

: "${BW_SERVER:=http://192.168.0.50:8084}"

bw config server "$BW_SERVER" >/dev/null

status="$(bw status 2>/dev/null || true)"
if ! printf '%s' "$status" | grep -q '"status":"unauthenticated"'; then
  # Already logged in or locked/unlocked. Continue to unlock/sync.
  :
elif [[ "$interactive" == "true" ]]; then
  bw login >/dev/null
else
  : "${BW_CLIENTID:?BW_CLIENTID is required for non-interactive login}"
  : "${BW_CLIENTSECRET:?BW_CLIENTSECRET is required for non-interactive login}"
  bw login --apikey >/dev/null
fi

if [[ "$interactive" == "true" ]]; then
  session="$(bw unlock --raw)"
else
  : "${BW_PASSWORD:?BW_PASSWORD is required for non-interactive unlock}"
  session="$(bw unlock --passwordenv BW_PASSWORD --raw)"
fi

bw sync --session "$session" >/dev/null
printf 'export BW_SESSION=%q\n' "$session"
