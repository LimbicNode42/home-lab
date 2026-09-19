#!/usr/bin/env bash
set -euo pipefail

# mem0 restore — restore a mem0 backup produced by mem0-backup.sh into a
# FRESH postgres container (non-destructive: never touches the live container).
#
# This is the restore verification path. It restores into a throwaway
# postgres container on a random port, verifies the data is readable, then
# tears down. For a real disaster recovery, the same pg_restore/pg_dumpall
# replay is applied to a fresh mem0 stack.
#
# Usage:
#   mem0-restore-test.sh /path/to/mem0-postgres-all.sql.gz

DUMP_FILE=${1:?Usage: mem0-restore-test.sh <mem0-postgres-all.sql.gz>}
RESTORE_PORT=${RESTORE_PORT:-15433}
CONTAINER_NAME=${CONTAINER_NAME:-mem0-restore-test}

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 127
  }
}

require docker
require gzip

if [ ! -f "$DUMP_FILE" ]; then
  echo "ERROR: dump file not found: $DUMP_FILE" >&2
  exit 1
fi

echo "Starting throwaway postgres on port $RESTORE_PORT..."
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER_NAME" \
  --security-opt apparmor=unconfined \
  -e POSTGRES_PASSWORD=restoretest \
  -e POSTGRES_USER=postgres \
  -p "127.0.0.1:$RESTORE_PORT:5432" \
  pgvector/pgvector:pg17 >/dev/null

# Wait for readiness.
for i in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Restoring dump..."
# pg_dumpall emits CREATE ROLE postgres, which already exists in a fresh
# container — that specific error is benign; ignore it and continue.
gzip -dc "$DUMP_FILE" | docker exec -i "$CONTAINER_NAME" psql -U postgres -h 127.0.0.1 2>&1 | \
  grep -v 'role "postgres" already exists' || true

echo "Verifying restored data..."
docker exec "$CONTAINER_NAME" psql -U postgres -h 127.0.0.1 -d mem0_app -tAc \
  "SELECT count(*) FROM users;" 2>/dev/null | sed 's/^/  users rows: /'
docker exec "$CONTAINER_NAME" psql -U postgres -h 127.0.0.1 -d postgres -tAc \
  "SELECT count(*) FROM memories;" 2>/dev/null | sed 's/^/  memories rows: /'

echo "Restore verification complete. Tearing down throwaway container..."
docker rm -f "$CONTAINER_NAME" >/dev/null
echo "Done."
