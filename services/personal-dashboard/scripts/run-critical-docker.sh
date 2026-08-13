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
INVESTMENT_SCREENER_REPORT_HOST_PATH=${INVESTMENT_SCREENER_REPORT_HOST_PATH:-/mnt/nas/services/personal-dashboard/investment-screener/latest_report.txt}
INVESTMENT_SCREENER_RANKED_HOST_PATH=${INVESTMENT_SCREENER_RANKED_HOST_PATH:-/mnt/nas/services/personal-dashboard/investment-screener/latest_ranked.json}
KANBAN_DB_HOST_PATH=${KANBAN_DB_HOST_PATH:-/mnt/nas/services/personal-dashboard/kanban/kanban.db}
PERSONAL_DASHBOARD_DB_HOST_PATH=${PERSONAL_DASHBOARD_DB_HOST_PATH:-/mnt/nas/services/personal-dashboard/data/personal-dashboard.sqlite3}
PERSONAL_DASHBOARD_DB_HOST_DIR=$(dirname "$PERSONAL_DASHBOARD_DB_HOST_PATH")

# The kanban DB bind source must be a readable, read-only snapshot/export for the
# node user inside the container. Do not bind /root/.hermes/kanban.db directly:
# /root/.hermes is 0700 and the DB is commonly 0600 root:root.
#
# PERSONAL_DASHBOARD_DB_HOST_PATH is the writable host-side SQLite file for the
# private Diary/Goals store. Create the parent directory and an empty file before
# first deploy so Docker does not turn a missing source into a directory bind.
# The fallback mounts the containing directory to /app/data because SQLite WAL
# mode creates sidecar files next to the database; a file bind alone opens but
# fails writes as a readonly database.
# Include this path in personal-data backups (it is not under Git).

cd "$APP_DIR"

test -f "$APP_DIR/config/dashboard.public.json"
if [ ! -f "$FINNICK_REPORT_HOST_PATH" ]; then
  printf '%s\n' "Finnick report bind source is missing or not a regular file: $FINNICK_REPORT_HOST_PATH" >&2
  printf '%s\n' "Refusing to recreate $CONTAINER; this avoids Docker turning a missing file bind source into a directory." >&2
  exit 1
fi
if [ ! -f "$INVESTMENT_SCREENER_REPORT_HOST_PATH" ]; then
  printf '%s\n' "Investment screener report bind source is missing or not a regular file: $INVESTMENT_SCREENER_REPORT_HOST_PATH" >&2
  printf '%s\n' "Refusing to recreate $CONTAINER; this avoids Docker turning a missing file bind source into a directory." >&2
  exit 1
fi
if [ ! -f "$INVESTMENT_SCREENER_RANKED_HOST_PATH" ]; then
  printf '%s\n' "Investment screener ranked bind source is missing or not a regular file: $INVESTMENT_SCREENER_RANKED_HOST_PATH" >&2
  printf '%s\n' "Refusing to recreate $CONTAINER; this avoids Docker turning a missing file bind source into a directory." >&2
  exit 1
fi
if [ ! -f "$KANBAN_DB_HOST_PATH" ]; then
  printf '%s\n' "Kanban DB bind source is missing or not a regular file: $KANBAN_DB_HOST_PATH" >&2
  printf '%s\n' "Refusing to recreate $CONTAINER; the dashboard must remain read-only against an explicit DB file." >&2
  exit 1
fi
if [ ! -f "$PERSONAL_DASHBOARD_DB_HOST_PATH" ]; then
  printf '%s\n' "Personal dashboard DB bind source is missing or not a regular file: $PERSONAL_DASHBOARD_DB_HOST_PATH" >&2
  printf '%s\n' "Create it first: mkdir -p \$(dirname \"$PERSONAL_DASHBOARD_DB_HOST_PATH\") && touch \"$PERSONAL_DASHBOARD_DB_HOST_PATH\"" >&2
  printf '%s\n' "Refusing to recreate $CONTAINER; this avoids Docker turning a missing file bind source into a directory." >&2
  exit 1
fi

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
  -e INVESTMENT_SCREENER_REPORT_FILE=/app/investment-screener/latest_report.txt \
  -e INVESTMENT_SCREENER_RANKED_FILE=/app/investment-screener/latest_ranked.json \
  -e DASHBOARD_AUTH_MODE=${DASHBOARD_AUTH_MODE:-reverse-proxy} \
  -e DASHBOARD_PROXY_USER_HEADER=${DASHBOARD_PROXY_USER_HEADER:-cf-access-authenticated-user-email} \
  -e DASHBOARD_STATUS_CACHE_TTL_MS=${DASHBOARD_STATUS_CACHE_TTL_MS:-30000} \
  -e DASHBOARD_STATUS_PROBE_TIMEOUT_MS=${DASHBOARD_STATUS_PROBE_TIMEOUT_MS:-2500} \
  -e KANBAN_DB_PATH=/app/kanban/kanban.db \
  -e PERSONAL_DASHBOARD_DB_FILE=/app/data/personal-dashboard.sqlite3 \
  -e REPO_DOCS_ROOT=/app/repo-docs \
  --mount "type=bind,source=$APP_DIR/config/dashboard.public.json,target=/app/config/dashboard.public.json,readonly" \
  --mount "type=bind,source=$FINNICK_REPORT_HOST_PATH,target=/app/finnick/latest_report.txt,readonly" \
  --mount "type=bind,source=$INVESTMENT_SCREENER_REPORT_HOST_PATH,target=/app/investment-screener/latest_report.txt,readonly" \
  --mount "type=bind,source=$INVESTMENT_SCREENER_RANKED_HOST_PATH,target=/app/investment-screener/latest_ranked.json,readonly" \
  --mount "type=bind,source=$KANBAN_DB_HOST_PATH,target=/app/kanban/kanban.db,readonly" \
  --mount "type=bind,source=$PERSONAL_DASHBOARD_DB_HOST_DIR,target=/app/data" \
  "$IMAGE"
