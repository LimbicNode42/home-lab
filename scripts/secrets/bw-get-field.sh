#!/usr/bin/env bash
set -euo pipefail

# Read a field from a Vaultwarden/Bitwarden item using the Bitwarden CLI.
#
# Examples:
#   scripts/secrets/bw-get-field.sh homelab/postgres/admin username
#   scripts/secrets/bw-get-field.sh homelab/postgres/admin password
#   scripts/secrets/bw-get-field.sh homelab/postgres/admin host
#
# Requirements:
#   - bw installed
#   - BW_SESSION exported
#   - jq installed
#
# Notes:
#   - Item names should be unique.
#   - Standard fields: username, password, uri, notes
#   - Any other field name is read from Bitwarden custom fields.

usage() {
  cat >&2 <<'USAGE'
Usage:
  bw-get-field.sh <item-name> <field-name>

Field names:
  username | password | uri | notes | <custom-field-name>
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -ne 2 ]]; then
  usage
  exit $([[ $# -eq 2 ]] && echo 0 || echo 2)
fi

if ! command -v bw >/dev/null 2>&1; then
  echo "ERROR: Bitwarden CLI 'bw' is not installed." >&2
  exit 127
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required." >&2
  exit 127
fi
: "${BW_SESSION:?BW_SESSION must be exported. Run bw-login-vaultwarden.sh first.}"

item_name="$1"
field="$2"

item_json="$(bw get item "$item_name" --session "$BW_SESSION")"

case "$field" in
  username)
    printf '%s\n' "$item_json" | jq -r '.login.username // empty'
    ;;
  password)
    printf '%s\n' "$item_json" | jq -r '.login.password // empty'
    ;;
  uri)
    printf '%s\n' "$item_json" | jq -r '.login.uris[0].uri // empty'
    ;;
  notes)
    printf '%s\n' "$item_json" | jq -r '.notes // empty'
    ;;
  *)
    printf '%s\n' "$item_json" | jq -r --arg name "$field" '.fields[]? | select(.name == $name) | .value' | head -n 1
    ;;
esac
