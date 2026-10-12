#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  restore-test-neo4j.sh --dry-run /path/to/neo4j.dump
  GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
    restore-test-neo4j.sh --apply /path/to/neo4j.dump

Loads a Neo4j dump into a disposable local container/path, checks Neo4j starts,
captures node/relationship counts, and writes non-secret evidence to the NAS
restore-test directory. It never mounts or overwrites production Neo4j data.
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
neo4j_image="${NEO4J_IMAGE:-neo4j:5.26.2}"
database="${GRAPHITI_NEO4J_DATABASE:-neo4j}"
nas_root="${GRAPHITI_NAS_ROOT:-/mnt/pve/NAS/services/graphiti}"
restore_root="${GRAPHITI_NAS_RESTORE_TEST_DIR:-${nas_root}/restore-tests}"
stamp="${GRAPHITI_RESTORE_TEST_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
test_name="graphiti-neo4j-restore-test-${stamp//[^A-Za-z0-9]/}"
evidence_dir="${restore_root}/${stamp}"
workdir="${GRAPHITI_RESTORE_TEST_WORKDIR:-$(mktemp -d /tmp/graphiti-restore-test.XXXXXX)}"
password="restore-test-only-${stamp}"
http_port="${GRAPHITI_RESTORE_TEST_HTTP_PORT:-17474}"
bolt_port="${GRAPHITI_RESTORE_TEST_BOLT_PORT:-17687}"

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))'
}

require_apply_gate() {
  if [[ "${GRAPHITI_ENABLE_LIVE_MUTATION:-}" != "reviewed-approved" ]]; then
    echo "Refusing --apply: GRAPHITI_ENABLE_LIVE_MUTATION must be reviewed-approved" >&2
    exit 2
  fi
}

print_plan() {
  cat <<PLAN
Graphiti Neo4j restore-test plan (${mode})
  dump_path: ${dump_path}
  neo4j_image: ${neo4j_image}
  disposable_container: ${test_name}
  disposable_workdir: ${workdir}
  evidence_dir: ${evidence_dir}
  ports: 127.0.0.1:${http_port}->7474, 127.0.0.1:${bolt_port}->7687
  production safety: no production compose file, container, or data path is touched
PLAN
}

verify_dump_checksum() {
  if [[ -f "${dump_path}.sha256" ]]; then
    (cd "$(dirname "$dump_path")" && sha256sum -c "$(basename "$dump_path").sha256")
  else
    echo "No sidecar checksum found at ${dump_path}.sha256; computing standalone checksum only" >&2
  fi
}

wait_for_neo4j() {
  local i
  for i in $(seq 1 90); do
    if docker exec "$test_name" cypher-shell -u neo4j -p "$password" 'RETURN 1 AS ok;' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cleanup() {
  set +e
  if [[ "${mode}" == "--apply" ]]; then
    docker logs "$test_name" > "${evidence_dir}/container.log" 2>&1 || true
    docker rm -f "$test_name" >/dev/null 2>&1 || true
  fi
  if [[ -z "${GRAPHITI_RESTORE_TEST_WORKDIR:-}" ]]; then
    rm -rf "$workdir"
  fi
}
trap cleanup EXIT

print_plan
if [[ "$mode" == "--dry-run" ]]; then
  if [[ -e "$dump_path" ]]; then
    echo "Dump exists: yes ($(stat -c '%s' "$dump_path" 2>/dev/null || echo unknown) bytes)"
  else
    echo "Dump exists: no; restore test would be blocked until a backup dump exists"
  fi
  echo "Dry run only; no Docker or NAS writes performed."
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

install -d -m 0750 "$evidence_dir" "$workdir/data"
verify_dump_checksum | tee "$evidence_dir/checksum.txt"
dump_sha="$(sha256sum "$dump_path" | cut -d' ' -f1)"
dump_size="$(stat -c '%s' "$dump_path")"

# Load into an empty disposable data directory. This is deliberately not a
# docker compose invocation, so it cannot accidentally target production.
docker run --rm --name "${test_name}-loader" \
  -v "${workdir}/data:/data" \
  -v "${dump_path}:/restore/${database}.dump:ro" \
  "$neo4j_image" \
  neo4j-admin database load "$database" --from-path=/restore --overwrite-destination=true

docker run -d --name "$test_name" \
  -p "127.0.0.1:${http_port}:7474" \
  -p "127.0.0.1:${bolt_port}:7687" \
  -e "NEO4J_AUTH=neo4j/${password}" \
  -v "${workdir}/data:/data" \
  "$neo4j_image" >/dev/null

if ! wait_for_neo4j; then
  echo "Neo4j restore-test container did not become ready" >&2
  exit 1
fi

nodes="$(docker exec "$test_name" cypher-shell -u neo4j -p "$password" --format plain 'MATCH (n) RETURN count(n) AS nodes;' | tail -n 1 | tr -d '[:space:]')"
rels="$(docker exec "$test_name" cypher-shell -u neo4j -p "$password" --format plain 'MATCH ()-[r]->() RETURN count(r) AS relationships;' | tail -n 1 | tr -d '[:space:]')"
constraints="$(docker exec "$test_name" cypher-shell -u neo4j -p "$password" --format plain 'SHOW CONSTRAINTS YIELD name RETURN count(name) AS constraints;' | tail -n 1 | tr -d '[:space:]' || echo unknown)"
indexes="$(docker exec "$test_name" cypher-shell -u neo4j -p "$password" --format plain 'SHOW INDEXES YIELD name RETURN count(name) AS indexes;' | tail -n 1 | tr -d '[:space:]' || echo unknown)"

cat > "$evidence_dir/restore-test-result.json" <<JSON
{
  "created_at_utc": "${stamp}",
  "status": "passed",
  "dump_path": $(printf '%s' "$dump_path" | json_escape),
  "dump_sha256": "${dump_sha}",
  "dump_size_bytes": ${dump_size},
  "neo4j_image": "${neo4j_image}",
  "disposable_container": "${test_name}",
  "disposable_workdir": $(printf '%s' "$workdir" | json_escape),
  "production_data_touched": false,
  "ports_bound": ["127.0.0.1:${http_port}", "127.0.0.1:${bolt_port}"],
  "counts": {
    "nodes": ${nodes:-0},
    "relationships": ${rels:-0},
    "constraints": $(printf '%s' "${constraints:-0}" | python3 -c 'import sys,json; s=sys.stdin.read().strip(); print(s if s.isdigit() else json.dumps(s))'),
    "indexes": $(printf '%s' "${indexes:-0}" | python3 -c 'import sys,json; s=sys.stdin.read().strip(); print(s if s.isdigit() else json.dumps(s))')
  },
  "secrets_included": false
}
JSON
python3 -m json.tool "$evidence_dir/restore-test-result.json" >/dev/null

echo "Restore test passed; evidence: ${evidence_dir}/restore-test-result.json"
