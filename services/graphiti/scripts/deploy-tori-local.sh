#!/usr/bin/env bash
set -euo pipefail

# Gated tori-local deployment helper for Graphiti + Neo4j.
# This script is intentionally noisy about gates and intentionally silent about
# secret values. It refuses to mutate tori unless GRAPHITI_ENABLE_LIVE_MUTATION
# is exactly `reviewed-approved`.

usage() {
  cat >&2 <<'USAGE'
Usage:
  eval "$(scripts/secrets/bw-login-vaultwarden.sh)"
  services/graphiti/scripts/deploy-tori-local.sh --preflight-only
  GRAPHITI_IMAGE=zepai/graphiti@sha256:<reviewed_digest> \
    GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved services/graphiti/scripts/deploy-tori-local.sh --apply

Options:
  --preflight-only   Validate Vaultwarden/OpenRouter and target posture; no live mutation.
  --apply            Copy reviewed compose/env to tori and start loopback-only Neo4j.
                     Refuses unless GRAPHITI_IMAGE is an explicit sha256 digest.
USAGE
}

mode="${1:-}"
case "$mode" in
  --preflight-only|--apply) ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
graphiti_dir="$repo_root/services/graphiti"
secret_runner="$repo_root/scripts/secrets/run-with-vaultwarden-env.sh"
render_env="$repo_root/scripts/secrets/render-env-from-vaultwarden.sh"
map_file="$graphiti_dir/graphiti.env.map.example"
compose_template="$graphiti_dir/docker-compose.tori.yml"
preflight_py="$graphiti_dir/scripts/openrouter-guardrail-preflight.py"
ingest_patch="$graphiti_dir/patches/ingest.py"

target_host="${GRAPHITI_TORI_HOST:-root@192.168.0.20}"
runtime_dir="${GRAPHITI_RUNTIME_DIR:-/opt/graphiti}"
local_data_dir="${GRAPHITI_NEO4J_DATA_DIR:-/var/lib/graphiti/neo4j/data}"
local_log_dir="${GRAPHITI_NEO4J_LOG_DIR:-/var/log/graphiti/neo4j}"
nas_root="${GRAPHITI_NAS_ROOT:-/mnt/pve/NAS/services/graphiti}"

for required in "$secret_runner" "$render_env" "$map_file" "$compose_template" "$preflight_py" "$ingest_patch"; do
  if [[ ! -e "$required" ]]; then
    echo "ERROR: required file missing: $required" >&2
    exit 1
  fi
done

validate_graphiti_image() {
  if [[ -z "${GRAPHITI_IMAGE:-}" ]]; then
    echo "ERROR: refusing apply; GRAPHITI_IMAGE must be set to a reviewed immutable image digest." >&2
    echo "Example: GRAPHITI_IMAGE=zepai/graphiti@sha256:<64-hex-digest>" >&2
    exit 2
  fi
  if [[ ! "${GRAPHITI_IMAGE}" =~ @sha256:[0-9a-fA-F]{64}$ ]]; then
    echo "ERROR: refusing apply; GRAPHITI_IMAGE must be an immutable sha256 digest, not a mutable tag." >&2
    echo "got: ${GRAPHITI_IMAGE%%:*}:<redacted>" >&2
    exit 2
  fi
}

if [[ "$mode" == "--apply" ]]; then
  validate_graphiti_image
fi

if [[ -z "${BW_SESSION:-}" ]]; then
  echo "ERROR: BW_SESSION is not exported; unlock Vaultwarden before deployment preflight." >&2
  exit 1
fi

echo "== Graphiti tori-local preflight =="
echo "target=$target_host runtime_dir=$runtime_dir"
echo "checking OpenRouter exact-model access through Vaultwarden env map..."
"$secret_runner" "$map_file" -- python3 "$preflight_py" >/tmp/graphiti-openrouter-preflight.json
python3 -m json.tool /tmp/graphiti-openrouter-preflight.json >/dev/null
python3 - <<'PY'
import json
from pathlib import Path
p = Path('/tmp/graphiti-openrouter-preflight.json')
data = json.loads(p.read_text())
print(json.dumps({
    'overall': data.get('overall'),
    'credential_present': data.get('credential_present'),
    'chat_status': data.get('results', {}).get('chat_completion', {}).get('status'),
    'embedding_status': data.get('results', {}).get('embedding', {}).get('status'),
    'embedding_dim_observed': data.get('results', {}).get('embedding', {}).get('embedding_dim_observed'),
}, sort_keys=True))
if data.get('overall') != 'passed_exact_models_available':
    raise SystemExit(3)
PY

echo "checking target storage/network posture (read-only)..."
ssh -o BatchMode=yes -o ConnectTimeout=5 "$target_host" \
  "set -e; hostname; docker --version; df -PT / /var/lib /mnt/pve/NAS/services; ss -ltn | grep -E ':(7474|7687|8000)' && exit 4 || true"

if [[ "$mode" == "--preflight-only" ]]; then
  echo "preflight-only complete; no live mutation performed."
  exit 0
fi

if [[ "${GRAPHITI_ENABLE_LIVE_MUTATION:-}" != "reviewed-approved" ]]; then
  echo "ERROR: refusing live mutation; set GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved after review/approval." >&2
  exit 2
fi


tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

# Render secrets to a temporary local file, then copy with restrictive mode. Do not print it.
"$render_env" "$map_file" > "$tmpdir/.env"
cat >> "$tmpdir/.env" <<EOF
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
GRAPHITI_COMPLETION_MODEL=openai/gpt-4o-mini
GRAPHITI_RERANK_MODEL=openai/gpt-4o-mini
GRAPHITI_EMBEDDING_MODEL=openai/text-embedding-3-small
GRAPHITI_EMBEDDING_DIM=1536
GRAPHITI_NEO4J_DATA_DIR=$local_data_dir
GRAPHITI_NEO4J_LOG_DIR=$local_log_dir
GRAPHITI_PATCH_INGEST_PATH=$runtime_dir/patches/ingest.py
GRAPHITI_NAS_BACKUP_DIR=$nas_root/backups/neo4j-dumps
GRAPHITI_NAS_SNAPSHOT_DIR=$nas_root/config-snapshots
GRAPHITI_NAS_RESTORE_TEST_DIR=$nas_root/restore-tests
GRAPHITI_IMAGE=$GRAPHITI_IMAGE
GRAPHITI_API_PORT=8000
NEO4J_HTTP_PORT=7474
NEO4J_BOLT_PORT=7687
NEO4J_HEAP_INITIAL=512m
NEO4J_HEAP_MAX=1g
NEO4J_PAGECACHE=512m
EOF
chmod 0600 "$tmpdir/.env"
cp "$compose_template" "$tmpdir/docker-compose.yml"
install -d -m 0755 "$tmpdir/patches"
cp "$ingest_patch" "$tmpdir/patches/ingest.py"

ssh "$target_host" "set -e; install -d -m 0750 '$runtime_dir' '$runtime_dir/patches' '$local_data_dir' '$local_log_dir' '$nas_root/backups/neo4j-dumps' '$nas_root/config-snapshots' '$nas_root/restore-tests' '$nas_root/manifests'"
scp -q "$tmpdir/docker-compose.yml" "$target_host:$runtime_dir/docker-compose.yml"
scp -q "$tmpdir/patches/ingest.py" "$target_host:$runtime_dir/patches/ingest.py"
scp -q "$tmpdir/.env" "$target_host:$runtime_dir/.env"
ssh "$target_host" "set -e; chmod 0600 '$runtime_dir/.env'; chmod 0644 '$runtime_dir/patches/ingest.py'; cd '$runtime_dir'; docker compose config >/tmp/graphiti-compose.rendered.yml; docker compose up -d neo4j; docker compose ps"

echo "Neo4j start requested. After Neo4j health/log receipts are reviewed, start Graphiti with:"
echo "  ssh $target_host \"cd $runtime_dir && docker compose up -d graphiti-api && docker compose ps\""
