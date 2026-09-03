#!/usr/bin/env sh
set -eu

# Desired-state helper for critical (192.168.0.50). Do not run without the
# approval gates in docs/runbook.md; this creates/recreates a live container.

APP_DIR=${APP_DIR:-/mnt/nas/services/unified-inbox/app}
IMAGE=${UNIFIED_INBOX_IMAGE:-unified-inbox:local}
CONTAINER=${UNIFIED_INBOX_CONTAINER:-unified-inbox}
PUBLISHED_IP=${UNIFIED_INBOX_PUBLISHED_IP:-172.17.0.1}
PORT=${PORT:-8766}
RUNTIME_ROOT=${UNIFIED_INBOX_RUNTIME_ROOT:-/var/lib/unified-inbox}
NAS_ROOT=${UNIFIED_INBOX_NAS_ROOT:-/mnt/nas/services/unified-inbox}
ENV_FILE=${UNIFIED_INBOX_ENV_FILE:-/root/.hermes/rendered/unified-inbox.env}

cd "$APP_DIR"
test -f "$APP_DIR/package.json"
test -d "$RUNTIME_ROOT"
test -d "$NAS_ROOT"

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

docker build -t "$IMAGE" .

if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER"; then
  docker rm -f "$CONTAINER"
fi

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "$PUBLISHED_IP:$PORT:$PORT" \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT="$PORT" \
  -e UNIFIED_INBOX_RUNTIME_ROOT=/app/state \
  -e UNIFIED_INBOX_NAS_ROOT=/app/nas-export \
  --mount "type=bind,source=$RUNTIME_ROOT,target=/app/state" \
  --mount "type=bind,source=$NAS_ROOT,target=/app/nas-export" \
  "$IMAGE"
