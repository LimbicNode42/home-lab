#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  restore-neo4j-dump.sh --dry-run /path/to/neo4j.dump
  GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
  GRAPHITI_RESTORE_TARGET=live-neo4j \
  GRAPHITI_RESTORE_PRE_SNAPSHOT_CONFIRMED=approved \
    restore-neo4j-dump.sh --apply /path/to/neo4j.dump

Restores a dump into the live Graphiti Neo4j database. This is destructive to
the target database and must not be used for routine restore testing. Use
restore-test-neo4j.sh first.
USAGE
}

mode="${1:---help}"
case "$mode" in
  --dry-run|--apply) shift ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

dump_path="$1"
compose_dir="${GRAPHITI_COMPOSE_DIR:-/opt/graphiti}"
compose_file="${GRAPHITI_COMPOSE_FILE:-${compose_dir}/docker-compose.yml}"
neo4j_service="${GRAPHITI_NEO4J_SERVICE:-neo4j}"
graphiti_service="${GRAPHITI_API_SERVICE:-graphiti-api}"
database="${GRAPHITI_NEO4J_DATABASE:-neo4j}"
live_data_dir="${GRAPHITI_NEO4J_DATA_DIR:-/var/lib/graphiti/neo4j/data}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

print_plan() {
  cat <<PLAN
Graphiti Neo4j LIVE restore plan (${mode})
  dump_path: ${dump_path}
  compose_file: ${compose_file}
  database: ${database}
  live_data_dir: ${live_data_dir}
  destructive: yes, overwrites live database
  required prior evidence: successful restore-test for this dump and pre-restore filesystem snapshot/copy
PLAN
}

require_apply_gate() {
  if [[ "${GRAPHITI_ENABLE_LIVE_MUTATION:-}" != "reviewed-approved" ]]; then
    echo "Refusing --apply: GRAPHITI_ENABLE_LIVE_MUTATION must be reviewed-approved" >&2
    exit 2
  fi
  if [[ "${GRAPHITI_RESTORE_TARGET:-}" != "live-neo4j" ]]; then
    echo "Refusing --apply: GRAPHITI_RESTORE_TARGET must be live-neo4j" >&2
    exit 2
  fi
  if [[ "${GRAPHITI_RESTORE_PRE_SNAPSHOT_CONFIRMED:-}" != "approved" ]]; then
    echo "Refusing --apply: confirm a pre-restore filesystem snapshot/copy with GRAPHITI_RESTORE_PRE_SNAPSHOT_CONFIRMED=approved" >&2
    exit 2
  fi
}

check_live_data_is_local() {
  local fstype source
  fstype="$(findmnt -T "$live_data_dir" -no FSTYPE 2>/dev/null || true)"
  source="$(findmnt -T "$live_data_dir" -no SOURCE 2>/dev/null || true)"
  if [[ -z "$fstype" ]]; then
    echo "Cannot determine filesystem for live data path: $live_data_dir" >&2
    exit 1
  fi
  case "$fstype" in
    nfs|nfs4|cifs|smb3|fuse.*)
      echo "Refusing: live data path $live_data_dir is on $fstype ($source); production live data must be local disk" >&2
      exit 3
      ;;
  esac
}

verify_dump_checksum() {
  if [[ -f "${dump_path}.sha256" ]]; then
    (cd "$(dirname "$dump_path")" && sha256sum -c "$(basename "$dump_path").sha256")
  else
    echo "No sidecar checksum found at ${dump_path}.sha256; computing standalone checksum only" >&2
    sha256sum "$dump_path"
  fi
}

print_plan
if [[ "$mode" == "--dry-run" ]]; then
  if [[ -f "$dump_path" ]]; then
    echo "Dump exists: yes ($(stat -c '%s' "$dump_path" 2>/dev/null || echo unknown) bytes)"
  else
    echo "Dump exists: no; live restore would be blocked"
  fi
  echo "Dry run only; no Docker/service mutation performed."
  exit 0
fi

require_apply_gate
if [[ ! -f "$dump_path" ]]; then
  echo "Dump not found: $dump_path" >&2
  exit 1
fi
if [[ "$dump_path" == /var/lib/graphiti/* ]]; then
  echo "Refusing: dump path must not be inside production live data path" >&2
  exit 3
fi
check_live_data_is_local
verify_dump_checksum

cd "$compose_dir"
restart_needed=0
cleanup() {
  set +e
  if [[ "$restart_needed" == "1" ]]; then
    docker compose -f "$compose_file" up -d "$neo4j_service" "$graphiti_service" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker compose -f "$compose_file" stop "$graphiti_service"
docker compose -f "$compose_file" stop "$neo4j_service"
restart_needed=1

docker compose -f "$compose_file" run --rm --no-deps \
  -v "${dump_path}:/restore/${database}.dump:ro" \
  "$neo4j_service" \
  neo4j-admin database load "$database" --from-path=/restore --overwrite-destination=true

docker compose -f "$compose_file" up -d "$neo4j_service" "$graphiti_service"
restart_needed=0

echo "Live restore applied from ${dump_path} at ${stamp}; run health/count/query verification now."
