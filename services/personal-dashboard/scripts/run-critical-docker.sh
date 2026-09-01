#!/usr/bin/env sh
set -eu

# Live bootstrap helper for critical (192.168.0.50), which currently has Docker
# but not the Docker Compose plugin. Keep this equivalent to docker-compose.yml.
# Run from /mnt/nas/services/personal-dashboard on critical after syncing this dir.

APP_DIR=${APP_DIR:-/mnt/nas/services/personal-dashboard}
PUBLISHED_IP=${DASHBOARD_PUBLISHED_IP:-172.17.0.1}
IMAGE=${DASHBOARD_IMAGE:-personal-dashboard:local}
CONTAINER=${DASHBOARD_CONTAINER:-personal-dashboard}
DB_NETWORK=${PERSONAL_DASHBOARD_DB_NETWORK:-critical-internal}
DB_NETWORK_ALIAS=${PERSONAL_DASHBOARD_DB_ALIAS:-postgres}
PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR=${PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR:-/var/lib/personal-dashboard/runtime-cache}
FINNICK_REPORT_HOST_DIR=${FINNICK_REPORT_HOST_DIR:-/mnt/nas/services/personal-dashboard/finnick}
INVESTMENT_SCREENER_HOST_DIR=${INVESTMENT_SCREENER_HOST_DIR:-/mnt/nas/services/personal-dashboard/investment-screener}
KANBAN_DB_HOST_DIR=${KANBAN_DB_HOST_DIR:-/mnt/nas/services/personal-dashboard/kanban}
HOMELAB_HEALTH_HOST_DIR=${HOMELAB_HEALTH_HOST_DIR:-/mnt/nas/services/personal-dashboard/homelab-health}
MOBILE_WORKFLOW_STATUS_HOST_DIR=${MOBILE_WORKFLOW_STATUS_HOST_DIR:-/mnt/nas/services/personal-dashboard/mobile-workflow}
WRITING_POSTS_HOST_DIR=${WRITING_POSTS_HOST_DIR:-/var/lib/personal-dashboard/writing}
FINNICK_REPORT_HOST_PATH=$FINNICK_REPORT_HOST_DIR/latest_report.txt
INVESTMENT_SCREENER_REPORT_HOST_PATH=$INVESTMENT_SCREENER_HOST_DIR/latest_report.txt
INVESTMENT_SCREENER_RANKED_HOST_PATH=$INVESTMENT_SCREENER_HOST_DIR/latest_ranked.json
KANBAN_DB_HOST_PATH=$KANBAN_DB_HOST_DIR/kanban.db
HOMELAB_HEALTH_HOST_PATH=$HOMELAB_HEALTH_HOST_DIR/latest_report.txt
WRITING_POSTS_HOST_PATH=$WRITING_POSTS_HOST_DIR/writing-posts.json
PERSONAL_DASHBOARD_ENV_FILE=${PERSONAL_DASHBOARD_ENV_FILE:-/root/.hermes/rendered/personal-dashboard.env}

# Source an operator-local rendered secret file when present. This keeps the
# committed deploy script portable while avoiding secret values in Git, command
# lines, or Kanban handoffs. The file is expected to be mode 0600 and rendered
# from Vaultwarden folder `homelab`, item `personal-dashboard/database`, field
# `database_url`.
if [ -f "$PERSONAL_DASHBOARD_ENV_FILE" ]; then
  set -a
  . "$PERSONAL_DASHBOARD_ENV_FILE"
  set +a
fi

: "${PERSONAL_DASHBOARD_DATABASE_URL:?Render PERSONAL_DASHBOARD_DATABASE_URL from Vaultwarden before recreating the dashboard container}"

# The read-only config/report/Kanban artifacts are copied into a host-local
# runtime cache before container start, then mounted as directories from that
# cache. External writers commonly publish artifacts by atomic rename on NAS/NFS,
# and Docker bind mounts can preserve stale handles across replacement/remount
# events even when the host path is readable again. Keep NAS paths out of the
# running container; the container still reads only the explicit file paths
# configured below.
#
# The kanban DB source must be a readable, read-only snapshot/export for the
# node user inside the container. Do not use the Hermes runtime DB directly:
# /root/.hermes is 0700 and the DB is commonly 0600 root:root.
#
# PERSONAL_DASHBOARD_DATABASE_URL points to Ben's shared Postgres instance over
# the Docker-local $DB_NETWORK network using the stable alias $DB_NETWORK_ALIAS.
# Render it from Vaultwarden; do not put the connection string in Git or shell
# transcripts. Diary/Goals do not use a writable SQLite /app/data bind.

cd "$APP_DIR"

test -f "$APP_DIR/config/dashboard.public.json"
if [ ! -f "$FINNICK_REPORT_HOST_PATH" ]; then
  printf '%s\n' "Finnick report bind source is missing or not a regular file: $FINNICK_REPORT_HOST_PATH" >&2
  printf '%s\n' "Refusing to recreate $CONTAINER; the directory bind must contain this expected file." >&2
  exit 1
fi
if [ ! -f "$INVESTMENT_SCREENER_REPORT_HOST_PATH" ]; then
  printf '%s\n' "Investment screener report bind source is missing or not a regular file: $INVESTMENT_SCREENER_REPORT_HOST_PATH" >&2
  printf '%s\n' "Refusing to recreate $CONTAINER; the directory bind must contain this expected file." >&2
  exit 1
fi
if [ ! -f "$INVESTMENT_SCREENER_RANKED_HOST_PATH" ]; then
  printf '%s\n' "Investment screener ranked bind source is missing or not a regular file: $INVESTMENT_SCREENER_RANKED_HOST_PATH" >&2
  printf '%s\n' "Refusing to recreate $CONTAINER; the directory bind must contain this expected file." >&2
  exit 1
fi
if [ ! -f "$KANBAN_DB_HOST_PATH" ]; then
  printf '%s\n' "Kanban DB bind source is missing or not a regular file: $KANBAN_DB_HOST_PATH" >&2
  printf '%s\n' "Refusing to recreate $CONTAINER; the dashboard must remain read-only against an explicit DB file." >&2
  exit 1
fi
if [ ! -f "$HOMELAB_HEALTH_HOST_PATH" ]; then
  printf '%s\n' "Homelab health report bind source is missing or not a regular file: $HOMELAB_HEALTH_HOST_PATH" >&2
  printf '%s\n' "Refusing to recreate $CONTAINER; the directory bind must contain this expected file." >&2
  exit 1
fi

# Blog/Drafts is the only writable filesystem-backed dashboard store. Keep it
# host-local and separate from /app/data so Diary/Goals do not regress to the old
# writable SQLite mount. On first run, preserve the existing in-container JSON
# before recreating the container; if there is no prior runtime copy, seed from
# the committed fixture without deleting existing host data.
mkdir -p "$WRITING_POSTS_HOST_DIR"
if [ ! -f "$WRITING_POSTS_HOST_PATH" ]; then
  tmp_writing_posts="$WRITING_POSTS_HOST_PATH.tmp.$$"
  if docker inspect "$CONTAINER" >/dev/null 2>&1 \
    && docker cp "$CONTAINER:/app/data/writing-posts.json" "$tmp_writing_posts" >/dev/null 2>&1; then
    mv "$tmp_writing_posts" "$WRITING_POSTS_HOST_PATH"
  else
    rm -f "$tmp_writing_posts"
    cp "$APP_DIR/data/writing-posts.json" "$WRITING_POSTS_HOST_PATH"
  fi
fi
chown 1000:1000 "$WRITING_POSTS_HOST_DIR" "$WRITING_POSTS_HOST_PATH"
chmod 0750 "$WRITING_POSTS_HOST_DIR"
chmod 0640 "$WRITING_POSTS_HOST_PATH"

PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR="$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR" \
FINNICK_REPORT_HOST_DIR="$FINNICK_REPORT_HOST_DIR" \
INVESTMENT_SCREENER_HOST_DIR="$INVESTMENT_SCREENER_HOST_DIR" \
KANBAN_DB_HOST_DIR="$KANBAN_DB_HOST_DIR" \
HOMELAB_HEALTH_HOST_DIR="$HOMELAB_HEALTH_HOST_DIR" \
MOBILE_WORKFLOW_STATUS_HOST_DIR="$MOBILE_WORKFLOW_STATUS_HOST_DIR" \
APP_DIR="$APP_DIR" \
  "$APP_DIR/scripts/sync-runtime-snapshots.sh"

docker build -t "$IMAGE" .

if ! docker network inspect "$DB_NETWORK" >/dev/null 2>&1; then
  docker network create --internal "$DB_NETWORK"
fi

if ! docker inspect postgres >/dev/null 2>&1; then
  printf '%s\n' "Postgres container 'postgres' is missing; refusing to recreate $CONTAINER without the shared DB endpoint." >&2
  exit 1
fi

if ! docker inspect postgres --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' | grep -Fxq "$DB_NETWORK"; then
  docker network connect --alias "$DB_NETWORK_ALIAS" "$DB_NETWORK" postgres
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER"; then
  docker rm -f "$CONTAINER"
fi

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "$PUBLISHED_IP:4322:4322" \
  --network bridge \
  -e NODE_ENV=production \
  -e PORT=4322 \
  -e HOST=0.0.0.0 \
  -e DASHBOARD_CONFIG_FILE=/app/config/dashboard.public.json \
  -e FINNICK_REPORT_FILE=/app/finnick/latest_report.txt \
  -e INVESTMENT_SCREENER_REPORT_FILE=/app/investment-screener/latest_report.txt \
  -e INVESTMENT_SCREENER_RANKED_FILE=/app/investment-screener/latest_ranked.json \
  -e INVESTMENT_SCREENER_DATA_ROOT=/app \
  -e HOMELAB_HEALTH_REPORT_FILE=/app/homelab-health/latest_report.txt \
  -e MOBILE_WORKFLOW_STATUS_FILE=/app/mobile-workflow/status.json \
  -e DASHBOARD_AUTH_MODE=${DASHBOARD_AUTH_MODE:-reverse-proxy} \
  -e DASHBOARD_PROXY_USER_HEADER=${DASHBOARD_PROXY_USER_HEADER:-cf-access-authenticated-user-email} \
  -e DASHBOARD_STATUS_CACHE_TTL_MS=${DASHBOARD_STATUS_CACHE_TTL_MS:-30000} \
  -e DASHBOARD_STATUS_PROBE_TIMEOUT_MS=${DASHBOARD_STATUS_PROBE_TIMEOUT_MS:-2500} \
  -e KANBAN_DB_PATH=/app/kanban/kanban.db \
  -e WRITING_POSTS_FILE=/app/writing/writing-posts.json \
  -e PERSONAL_DASHBOARD_DATABASE_URL \
  -e PGSSLMODE=${PGSSLMODE:-require} \
  -e REPO_DOCS_ROOT=/app/repo-docs \
  --mount "type=bind,source=$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/config,target=/app/config,readonly" \
  --mount "type=bind,source=$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/finnick,target=/app/finnick,readonly" \
  --mount "type=bind,source=$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/investment-screener,target=/app/investment-screener,readonly" \
  --mount "type=bind,source=$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/kanban,target=/app/kanban,readonly" \
  --mount "type=bind,source=$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/homelab-health,target=/app/homelab-health,readonly" \
  --mount "type=bind,source=$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/mobile-workflow,target=/app/mobile-workflow,readonly" \
  --mount "type=bind,source=$WRITING_POSTS_HOST_DIR,target=/app/writing" \
  "$IMAGE"

docker network connect "$DB_NETWORK" "$CONTAINER"
