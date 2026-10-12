#!/usr/bin/env bash
set -euo pipefail

# Non-invasive exposure check for Graphiti/Neo4j local ports.
# Fails if raw service ports are bound to all interfaces.
# Set GRAPHITI_VERIFY_HOST=root@192.168.0.20 to run the ss probe over SSH.

OUT="${1:-/tmp/graphiti-loopback-exposure.txt}"
TARGET="${GRAPHITI_VERIFY_HOST:-}"
probe="ss -ltnp '( sport = :7474 or sport = :7687 or sport = :8000 )'"

if [[ -n "$TARGET" ]]; then
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$TARGET" "$probe" > "$OUT" || true
else
  eval "$probe" > "$OUT" || true
fi

if grep -E '(^|[[:space:]])(0\.0\.0\.0|\[::\]|:::)(:7474|:7687|:8000)\b' "$OUT" >/dev/null; then
  echo "Unsafe bind detected; raw Graphiti/Neo4j ports must not listen on all interfaces." >&2
  sed -E 's/(password|token|key)=[^[:space:]]+/\1=REDACTED/Ig' "$OUT" >&2
  exit 1
fi

echo "No all-interface raw Graphiti/Neo4j binds detected. Receipt: ${OUT}"
