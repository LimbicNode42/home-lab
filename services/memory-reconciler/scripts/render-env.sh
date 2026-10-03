#!/usr/bin/env bash
# Render /opt/memory-reconciler/.env from Vaultwarden (mode 0600).
#
# Non-secret values are literals here; the two secrets (MEM0_API_KEY,
# GRAPHITI_OPENROUTER_API_KEY) are pulled by folder/item/field reference from
# Ben's personal Vaultwarden at render time and NEVER committed. This is the
# canonical render path for tori-local deployment; Git carries only this script
# plus config/vaultwarden-map.example.yml (the reference map) and .env.example
# (the rendered shape) — never values.
#
# References (see config/vaultwarden-map.example.yml):
#   folder  Homelab
#   item    mem0/server        field  api_key            -> MEM0_API_KEY
#   item    graphiti/openrouter field login.password    -> GRAPHITI_OPENROUTER_API_KEY
set -euo pipefail
umask 077
export BW_NOINTERACTION=1

# BW_PASSWORD is the master password (sourced from the hermes runtime env by the
# caller, or set explicitly). It is consumed only to unlock; never echoed.
if [[ -z "${BW_PASSWORD:-}" ]]; then
  echo "FATAL: BW_PASSWORD not set; cannot unlock Vaultwarden" >&2
  exit 1
fi

VAULT_SERVER="${VAULT_SERVER:-https://vault.wheeler-network.com}"
# Only reconfigure the server URL if it differs, since `bw config server`
# fails while a session is already logged in.
CUR_SERVER="$(bw config server 2>/dev/null || true)"
if [[ "$CUR_SERVER" != "$VAULT_SERVER" ]]; then
  bw config server "$VAULT_SERVER" >/dev/null 2>&1 || true
fi

unset BW_SESSION
BW_SESSION="$(bw unlock --passwordenv BW_PASSWORD --raw 2>/dev/null)"
if [[ -z "$BW_SESSION" ]]; then
  echo "FATAL: unlock produced empty session" >&2
  exit 2
fi

bw sync --session "$BW_SESSION" >/dev/null 2>&1 || true

FOLDER_ID="$(
  bw list folders --session "$BW_SESSION" 2>/dev/null \
    | jq -r '.[] | select(.name=="Homelab") | .id' | head -n1
)"
if [[ -z "$FOLDER_ID" || "$FOLDER_ID" == "null" ]]; then
  echo "FATAL: Homelab folder not found in Vaultwarden" >&2
  exit 3
fi

MEM0_KEY="$(
  bw list items --folderid "$FOLDER_ID" --session "$BW_SESSION" 2>/dev/null \
    | jq -r '.[] | select(.name=="mem0/server") | .fields[] | select(.name=="api_key") | .value // empty' \
    | head -n1
)"
GRAPHITI_KEY="$(
  bw list items --folderid "$FOLDER_ID" --session "$BW_SESSION" 2>/dev/null \
    | jq -r '.[] | select(.name=="graphiti/openrouter") | .login.password // empty' \
    | head -n1
)"

if [[ -z "$MEM0_KEY" ]]; then
  echo "FATAL: mem0/server api_key field empty" >&2
  exit 4
fi
if [[ -z "$GRAPHITI_KEY" ]]; then
  echo "FATAL: graphiti/openrouter login password empty" >&2
  exit 5
fi

DEST="${DEST:-/opt/memory-reconciler/.env}"
{
  printf 'MEMORY_RECONCILER_KANBAN_DB=/root/.hermes/kanban.db\n'
  printf 'MEMORY_RECONCILER_STATE_DB=/var/lib/memory-reconciler/state.db\n'
  printf 'MEMORY_RECONCILER_MEM0_HOST=http://127.0.0.1:8888\n'
  printf 'MEMORY_RECONCILER_MEM0_USER_ID=ben\n'
  printf 'MEMORY_RECONCILER_MEM0_AGENT_ID=memory-reconciler\n'
  printf 'MEM0_API_KEY=%s\n' "$MEM0_KEY"
  printf 'MEMORY_RECONCILER_GRAPHITI_URL=http://127.0.0.1:8000\n'
  printf 'GRAPHITI_OPENROUTER_API_KEY=%s\n' "$GRAPHITI_KEY"
  printf 'OPENROUTER_BASE_URL=https://openrouter.ai/api/v1\n'
  printf 'GRAPHITI_COMPLETION_MODEL=openai/gpt-4o-mini\n'
  printf 'GRAPHITI_RERANK_MODEL=openai/gpt-4o-mini\n'
  printf 'GRAPHITI_EMBEDDING_MODEL=openai/text-embedding-3-small\n'
  printf 'GRAPHITI_EMBEDDING_DIM=1536\n'
} > "$DEST"
chmod 0600 "$DEST"
echo "wrote $DEST (mode 0600), MEM0_API_KEY len=${#MEM0_KEY}, GRAPHITI key len=${#GRAPHITI_KEY}"