#!/usr/bin/env bash
set -euo pipefail

# Draft only. Requires explicit approval before use against live tori service.
: "${GRAPHITI_ENABLE_LIVE_MUTATION:?set to reviewed-approved after an approved deploy/backup card}"
if [[ "${GRAPHITI_ENABLE_LIVE_MUTATION}" != "reviewed-approved" ]]; then
  echo "Refusing to run: GRAPHITI_ENABLE_LIVE_MUTATION must be reviewed-approved" >&2
  exit 2
fi

: "${GRAPHITI_NAS_BACKUP_DIR:?set NAS dump destination}"
: "${GRAPHITI_COMPOSE_DIR:=/opt/graphiti}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_name="neo4j-${stamp}.dump"
manifest="${GRAPHITI_NAS_BACKUP_DIR}/neo4j-${stamp}.manifest.json"
mkdir -p "${GRAPHITI_NAS_BACKUP_DIR}"

# If write ingestion exists later, pause it here before dumping. The first phase is read-only-from-agents.
docker compose -f "${GRAPHITI_COMPOSE_DIR}/docker-compose.yml" exec -T neo4j \
  neo4j-admin database dump neo4j --to-path=/tmp --overwrite-destination=true

docker cp graphiti-neo4j:/tmp/neo4j.dump "${GRAPHITI_NAS_BACKUP_DIR}/${dump_name}"
sha256sum "${GRAPHITI_NAS_BACKUP_DIR}/${dump_name}" > "${GRAPHITI_NAS_BACKUP_DIR}/${dump_name}.sha256"

cat > "${manifest}" <<JSON
{
  "created_at": "${stamp}",
  "dump": "${dump_name}",
  "sha256_file": "${dump_name}.sha256",
  "source": "graphiti-neo4j",
  "database": "neo4j",
  "notes": "Graphiti Neo4j candidate backup manifest; verify counts and restore-test separately."
}
JSON

echo "Created ${GRAPHITI_NAS_BACKUP_DIR}/${dump_name}"
