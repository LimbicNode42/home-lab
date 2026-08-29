#!/usr/bin/env bash
set -euo pipefail

# Run a command with secrets resolved from Vaultwarden/Bitwarden only in the
# child process environment.
#
# Mapping file format:
#   ENV_NAME|folder name|item name|field name
#
# Example:
#   FMP_API_KEY|homelab|FMP_API_KEY|password
#   FMP_API_KEY|homelab|investment-screener/fmp|api_key
#
# Usage:
#   eval "$(scripts/secrets/bw-login-vaultwarden.sh)"
#   scripts/secrets/run-with-vaultwarden-env.sh path/to/service.env.map -- command arg ...
#
# Security:
#   - Requires BW_SESSION; never pass it as a command-line argument.
#   - Does not print resolved values.
#   - Exports resolved values only to the child command via env(1).

usage() {
  cat >&2 <<'USAGE'
Usage:
  run-with-vaultwarden-env.sh <mapping-file> -- <command> [args...]

Mapping format:
  ENV_NAME|folder|item|field

Requires:
  BW_SESSION exported from an unlocked Bitwarden CLI session.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 3 || "${2:-}" != "--" ]]; then
  usage
  exit 2
fi

mapping_file="$1"
shift 2

if [[ ! -f "$mapping_file" ]]; then
  echo "ERROR: mapping file not found: $mapping_file" >&2
  exit 1
fi

if [[ -z "${BW_SESSION:-}" ]]; then
  echo "ERROR: BW_SESSION must be exported. Run bw-login-vaultwarden.sh first." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
get_field="${RUN_WITH_VAULTWARDEN_GET_FIELD:-$script_dir/bw-get-field.sh}"

if [[ ! -x "$get_field" ]]; then
  echo "ERROR: field helper is not executable: $get_field" >&2
  exit 1
fi

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

assignments=()
line_number=0

while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line_number=$((line_number + 1))

  # Skip blank lines and comments, allowing leading whitespace before '#'.
  trimmed_line="$(trim "$raw_line")"
  [[ -z "$trimmed_line" ]] && continue
  [[ "${trimmed_line:0:1}" == "#" ]] && continue

  IFS='|' read -r env_name folder_name item_name field_name extra <<<"$raw_line"

  env_name="$(trim "${env_name:-}")"
  folder_name="$(trim "${folder_name:-}")"
  item_name="$(trim "${item_name:-}")"
  field_name="$(trim "${field_name:-}")"

  if [[ -n "${extra:-}" ]]; then
    echo "ERROR: too many fields in $mapping_file line $line_number for env var '$env_name'" >&2
    exit 1
  fi

  if [[ -z "$env_name" || -z "$folder_name" || -z "$item_name" || -z "$field_name" ]]; then
    echo "ERROR: invalid mapping in $mapping_file line $line_number; expected ENV_NAME|folder|item|field" >&2
    exit 1
  fi

  if [[ ! "$env_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "ERROR: invalid environment variable name in $mapping_file line $line_number: $env_name" >&2
    exit 1
  fi

  value="$($get_field "$folder_name" "$item_name" "$field_name")"
  if [[ -z "$value" ]]; then
    echo "ERROR: empty value for $env_name from item '$item_name' field '$field_name'" >&2
    exit 1
  fi

  assignments+=("$env_name=$value")
done <"$mapping_file"

if [[ ${#assignments[@]} -eq 0 ]]; then
  echo "ERROR: no active mappings found in $mapping_file" >&2
  exit 1
fi

env "${assignments[@]}" "$@"
