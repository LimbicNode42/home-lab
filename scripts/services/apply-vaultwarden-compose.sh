#!/usr/bin/env bash
set -euo pipefail

# Controlled migration from the legacy raw Docker Vaultwarden container to the
# Git-backed compose desired state.
#
# Run on critical (192.168.0.50) as an operator with Docker permissions.
# This script intentionally preserves the old container by renaming it instead
# of deleting it, and rolls back automatically if the new container fails health
# or API checks.

BASE=${BASE:-/mnt/nas/services/vaultwarden}
COMPOSE_DIR=${COMPOSE_DIR:-$BASE/compose}
REPO_COMPOSE=${REPO_COMPOSE:-services/vaultwarden/docker-compose.yml}
IMAGE=${IMAGE:-vaultwarden/server@sha256:9a8eec71f4a52411cc43edc7a50f33e9b6f62b5baca0dd95f0c6e7fd60f1a341}
TS=${TS:-$(date -u +%Y%m%dT%H%M%SZ)}
BACKUP_DIR=${BACKUP_DIR:-$BASE/backups/pre-compose-$TS}
OLD_NAME=${OLD_NAME:-vaultwarden-pre-compose-$TS}

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 127
  }
}

require docker
require python3
require gzip
require tar

if ! docker compose version >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache docker-cli-compose
  else
    echo "ERROR: docker compose plugin missing and apk is unavailable." >&2
    exit 127
  fi
fi

if [[ ! -f "$REPO_COMPOSE" ]]; then
  echo "ERROR: run from the home-lab repo root or set REPO_COMPOSE." >&2
  exit 2
fi

mkdir -p "$COMPOSE_DIR" "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

DB_URL=$(docker inspect vaultwarden | python3 -c 'import json,sys; j=json.load(sys.stdin)[0]; print([e.split("=",1)[1] for e in j["Config"]["Env"] if e.startswith("DATABASE_URL=")][0])')
DOMAIN=$(docker inspect vaultwarden | python3 -c 'import json,sys; j=json.load(sys.stdin)[0]; vals=[e.split("=",1)[1] for e in j["Config"]["Env"] if e.startswith("DOMAIN=")]; print(vals[0] if vals else "https://vault.wheeler-network.com")')

docker inspect vaultwarden > "$BACKUP_DIR/vaultwarden.inspect.raw.json"
chmod 600 "$BACKUP_DIR/vaultwarden.inspect.raw.json"

docker exec -e DATABASE_URL="$DB_URL" postgres sh -lc '/opt/bitnami/postgresql/bin/pg_dump "$DATABASE_URL"' | gzip -c > "$BACKUP_DIR/vaultwarden-db.sql.gz"
chmod 600 "$BACKUP_DIR/vaultwarden-db.sql.gz"

tar -C "$BASE" -czf "$BACKUP_DIR/vaultwarden-data-dir.tgz" data
chmod 600 "$BACKUP_DIR/vaultwarden-data-dir.tgz"

cp "$REPO_COMPOSE" "$COMPOSE_DIR/docker-compose.yml"
cat > "$COMPOSE_DIR/.env" <<EOF
DOMAIN=$DOMAIN
DATABASE_URL=$DB_URL
SIGNUPS_ALLOWED=false
EOF
chmod 600 "$COMPOSE_DIR/.env"

cd "$COMPOSE_DIR"
docker compose config >/dev/null

rollback() {
  echo "Rollback starting..." >&2
  docker compose down >/dev/null 2>&1 || true
  if docker ps -a --format '{{.Names}}' | grep -qx vaultwarden; then
    docker rm -f vaultwarden >/dev/null 2>&1 || true
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx "$OLD_NAME"; then
    docker rename "$OLD_NAME" vaultwarden >/dev/null 2>&1 || true
    docker start vaultwarden >/dev/null 2>&1 || true
  fi
}
trap rollback INT TERM HUP ERR

docker stop vaultwarden >/dev/null
docker rename vaultwarden "$OLD_NAME"
docker compose up -d >/dev/null

ok=false
for _ in $(seq 1 60); do
  status=$(docker inspect vaultwarden --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo missing)
  if [[ "$status" == healthy ]]; then
    ok=true
    break
  fi
  sleep 2
done

if [[ "$ok" != true ]]; then
  docker logs --tail 100 vaultwarden > "$BACKUP_DIR/failed-new-container.log" 2>&1 || true
  exit 1
fi

python3 - <<'PY'
import json, urllib.request, sys
with urllib.request.urlopen('http://127.0.0.1:8084/api/config', timeout=10) as r:
    j = json.load(r)
if j.get('settings', {}).get('disableUserRegistration') is not True:
    print('ERROR: disableUserRegistration is not true', file=sys.stderr)
    sys.exit(2)
print('api_config_ok disableUserRegistration=True version=' + str(j.get('version')))
PY

trap - INT TERM HUP ERR

echo "migration_ok timestamp=$TS backup_dir=$BACKUP_DIR old_container=$OLD_NAME"
