#!/usr/bin/env bash
set -euo pipefail

# mem0 backup — application-consistent pg_dump of the mem0 Postgres databases
# (memories + mem0_app auth/keys) plus the history SQLite DB, to the NAS.
#
# Run on tori (192.168.0.20) as root. Reads the Postgres password from the
# rendered /opt/mem0/.env (root-only, mode 0600). Never commit this script's
# runtime env; the committed copy is generic and portable.
#
# Usage:
#   mem0-backup.sh                 # full backup to NAS, default retention
#   RETENTION_DAYS=14 mem0-backup.sh
#   TARGET_DIR=/tmp/mem0-test mem0-backup.sh   # for restore smoke tests

BASE=${BASE:-/opt/mem0}
ENV_FILE=${ENV_FILE:-$BASE/.env}
TARGET_DIR=${TARGET_DIR:-/mnt/pve/NAS/backups/mem0}
RETENTION_DAYS=${RETENTION_DAYS:-14}
TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG_DIR=${LOG_DIR:-$BASE/backups/logs}
STAMP_DIR="$TARGET_DIR/$TS"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 127
  }
}

require docker
require gzip
require tar

# Load Postgres password from the rendered env file (never echo it).
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file not found: $ENV_FILE" >&2
  exit 1
fi
PGPASSWORD=$(grep -E '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
if [ -z "$PGPASSWORD" ]; then
  echo "ERROR: POSTGRES_PASSWORD not found in $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$STAMP_DIR" "$LOG_DIR"

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

log "Starting mem0 backup -> $STAMP_DIR"

# 1. Application-consistent dump of both databases (single pg_dumpall covers
#    postgres + mem0_app; pg_dumpall is consistent across databases).
log "Dumping Postgres (pg_dumpall)..."
docker exec -e PGPASSWORD="$PGPASSWORD" mem0-postgres-1 \
  pg_dumpall -U postgres -h 127.0.0.1 | gzip > "$STAMP_DIR/mem0-postgres-all.sql.gz"

# 2. History SQLite DB (mem0's local history store).
log "Copying history SQLite DB..."
if [ -f "$BASE/data/history/history.db" ]; then
  tar -czf "$STAMP_DIR/mem0-history.tar.gz" -C "$BASE/data/history" history.db
else
  log "WARN: history.db not found; skipping (may not exist yet)"
fi

# 3. Manifest for auditability.
{
  echo "backup_ts=$TS"
  echo "host=$(hostname)"
  echo "postgres_dump=mem0-postgres-all.sql.gz"
  echo "history_archive=mem0-history.tar.gz"
  echo "retention_days=$RETENTION_DAYS"
} > "$STAMP_DIR/MANIFEST.txt"

# 4. Retention: prune stamp dirs older than RETENTION_DAYS.
log "Pruning backups older than $RETENTION_DAYS days..."
find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -print -exec rm -rf {} + 2>/dev/null || true

# 5. Log success.
log "Backup complete: $STAMP_DIR"
echo "$TS $(du -sh "$STAMP_DIR" | cut -f1) OK" >> "$LOG_DIR/backup.log"
