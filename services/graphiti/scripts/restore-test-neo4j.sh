#!/usr/bin/env bash
set -euo pipefail

# Draft isolated restore-test outline. It starts temporary containers only after review approval.
: "${GRAPHITI_ENABLE_LIVE_MUTATION:?set to reviewed-approved after an approved restore-test card}"
if [[ "${GRAPHITI_ENABLE_LIVE_MUTATION}" != "reviewed-approved" ]]; then
  echo "Refusing to run: GRAPHITI_ENABLE_LIVE_MUTATION must be reviewed-approved" >&2
  exit 2
fi

: "${1:?usage: restore-test-neo4j.sh /path/to/neo4j.dump}"
: "${GRAPHITI_NAS_RESTORE_TEST_DIR:?set restore-test evidence destination}"
dump_path="$1"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
workdir="$(mktemp -d /tmp/graphiti-restore-test.XXXXXX)"
mkdir -p "${GRAPHITI_NAS_RESTORE_TEST_DIR}/${stamp}"

cleanup() {
  docker rm -f graphiti-neo4j-restore-test >/dev/null 2>&1 || true
  rm -rf "${workdir}"
}
trap cleanup EXIT

docker run -d --name graphiti-neo4j-restore-test \
  -p 127.0.0.1:17474:7474 -p 127.0.0.1:17687:7687 \
  -e NEO4J_AUTH=neo4j/restore-test-only \
  -v "${workdir}/data:/data" \
  neo4j:5.26.2

# Placeholder: copy dump into the container, stop DB, load dump, restart, then capture counts.
# Keep this as a runbook-backed draft until the exact tori container startup behavior is verified.
cat > "${GRAPHITI_NAS_RESTORE_TEST_DIR}/${stamp}/restore-test-plan.txt" <<EOF
Dump under test: ${dump_path}
Temporary container: graphiti-neo4j-restore-test
Expected checks:
- dump checksum verified
- database loads without overwrite surprises
- Neo4j health OK on 127.0.0.1:17474
- node/relationship counts match manifest within expected delta
- representative group_id query returns facts and source episodes
EOF

echo "Restore-test scaffold created under ${GRAPHITI_NAS_RESTORE_TEST_DIR}/${stamp}"
