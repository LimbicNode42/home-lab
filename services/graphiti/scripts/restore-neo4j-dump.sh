#!/usr/bin/env bash
set -euo pipefail

# Draft only. Destructive if pointed at live data. Prefer restore-test first.
: "${GRAPHITI_ENABLE_LIVE_MUTATION:?set to reviewed-approved after an approved restore card}"
if [[ "${GRAPHITI_ENABLE_LIVE_MUTATION}" != "reviewed-approved" ]]; then
  echo "Refusing to run: GRAPHITI_ENABLE_LIVE_MUTATION must be reviewed-approved" >&2
  exit 2
fi

: "${1:?usage: restore-neo4j-dump.sh /path/to/neo4j.dump}"
: "${GRAPHITI_COMPOSE_DIR:=/opt/graphiti}"
dump_path="$1"

test -f "${dump_path}"
if [[ -f "${dump_path}.sha256" ]]; then
  (cd "$(dirname "${dump_path}")" && sha256sum -c "$(basename "${dump_path}").sha256")
fi

docker compose -f "${GRAPHITI_COMPOSE_DIR}/docker-compose.yml" stop graphiti-api
# Stop Neo4j before loading into live database.
docker compose -f "${GRAPHITI_COMPOSE_DIR}/docker-compose.yml" stop neo4j
# Operator must preserve a filesystem snapshot/copy of GRAPHITI_NEO4J_DATA_DIR before this point.
docker compose -f "${GRAPHITI_COMPOSE_DIR}/docker-compose.yml" run --rm -v "${dump_path}:/restore/neo4j.dump:ro" neo4j \
  neo4j-admin database load neo4j --from-path=/restore --overwrite-destination=true

docker compose -f "${GRAPHITI_COMPOSE_DIR}/docker-compose.yml" up -d neo4j graphiti-api

echo "Restore requested from ${dump_path}; now run health, count, and representative query checks."
