#!/usr/bin/env bash
set -euo pipefail

# Render dotenv output from a simple Vaultwarden mapping file.
#
# Mapping file format:
#   ENV_NAME|item name|field name
#
# Example:
#   PG_HOST|homelab/postgres/admin|host
#   PG_USER|homelab/postgres/admin|username
#   PG_PASSWORD|homelab/postgres/admin|password
#
# Usage:
#   eval "$(scripts/secrets/bw-login-vaultwarden.sh)"
#   scripts/secrets/render-env-from-vaultwarden.sh docs/secrets/examples/postgres.env.map > .env
#   chmod 0600 .env
#
# Security:
#   This script prints secret values to stdout by design. Redirect to a 0600 file.
#   Do not run with `set -x`.

usage() {
  cat >&2 <<'USAGE'
Usage:
  render-env-from-vaultwarden.sh <mapping-file>
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -ne 1 ]]; then
  usage
  exit $([[ $# -eq 1 ]] && echo 0 || echo 2)
fi

mapping_file="$1"
if [[ ! -f "$mapping_file" ]]; then
  echo "ERROR: mapping file not found: $mapping_file" >&2
  exit 1
fi

: "${BW_SESSION:?BW_SESSION must be exported. Run bw-login-vaultwarden.sh first.}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
get_field="$script_dir/bw-get-field.sh"

while IFS='|' read -r env_name item_name field_name; do
  # Skip blank lines and comments.
  [[ -z "${env_name// }" ]] && continue
  [[ "${env_name:0:1}" == "#" ]] && continue

  if [[ -z "${item_name:-}" || -z "${field_name:-}" ]]; then
    echo "ERROR: invalid mapping line for env var '$env_name'" >&2
    exit 1
  fi

  value="$($get_field "$item_name" "$field_name")"
  if [[ -z "$value" ]]; then
    echo "ERROR: empty value for $env_name from item '$item_name' field '$field_name'" >&2
    exit 1
  fi

  printf '%s=%q\n' "$env_name" "$value"
done < "$mapping_file"
