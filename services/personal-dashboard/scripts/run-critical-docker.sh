#!/usr/bin/env sh
set -eu

# Live bootstrap helper for critical (192.168.0.50), which currently has Docker
# but not the Docker Compose plugin. Keep this equivalent to docker-compose.yml.
# Run from /mnt/nas/services/personal-dashboard on critical after syncing this dir.

APP_DIR=${APP_DIR:-/mnt/nas/services/personal-dashboard}
PUBLISHED_IP=${DASHBOARD_PUBLISHED_IP:-172.17.0.1}
IMAGE=${DASHBOARD_IMAGE:-personal-dashboard:local}
CONTAINER=${DASHBOARD_CONTAINER:-personal-dashboard}
FINNICK_REPORT_HOST_PATH=${FINNICK_REPORT_HOST_PATH:-/mnt/nas/services/personal-dashboard/finnick/latest_report.txt}
KANBAN_DB_HOST_PATH=${KANBAN_DB_HOST_PATH:-/root/.hermes/kanban.db}

# The kanban DB must be world-readable so the 'node' user inside the container can read it.
# Run: chmod 644 $KANBAN_DB_HOST_PATH
# The container mounts it read-only; write access remains with the host root only.

cd "$APP_DIR"

test -f "$APP_DIR/config/dashboard.public.json"

docker build -t "$IMAGE" .

if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER"; then
  docker rm -f "$CONTAINER"
fi

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "$PUBLISHED_IP:4322:4322" \
  -e NODE_ENV=production \
  -e PORT=4322 \
  -e HOST=0.0.0.0 \
  -e DASHBOARD_CONFIG_FILE=/app/config/dashboard.public.json \
  -e FINNICK_REPORT_FILE=/app/finnick/latest_report.txt \
  -e DASHBOARD_AUTH_MODE=${DASHBOARD_AUTH_MODE:-reverse-proxy} \
  -e DASHBOARD_PROXY_USER_HEADER=${DASHBOARD_PROXY_USER_HEADER:-cf-access-authenticated-user-email} \
  -e DASHBOARD_STATUS_CACHE_TTL_MS=${DASHBOARD_STATUS_CACHE_TTL_MS:-30000} \
  -e DASHBOARD_STATUS_PROBE_TIMEOUT_MS=${DASHBOARD_STATUS_PROBE_TIMEOUT_MS:-2500} \
  -e KANBAN_DB_PATH=/app/kanban/kanban.db \
  -v "$APP_DIR/config/dashboard.public.json:/app/config/dashboard.public.json:ro" \
  -v "$FINNICK_REPORT_HOST_PATH:/app/finnick/latest_report.txt:ro" \
  -v "$KANBAN_DB_HOST_PATH:/app/kanban/kanban.db:ro" \
  "$IMAGE"
