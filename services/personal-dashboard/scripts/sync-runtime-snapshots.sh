#!/usr/bin/env sh
set -eu

# Copy NAS/repo-backed read-only dashboard artifacts into a host-local cache.
# The dashboard container bind-mounts this cache instead of NAS/NFS paths so a
# recovered host mount does not leave long-running Docker bind handles stale.

APP_DIR=${APP_DIR:-/mnt/nas/services/personal-dashboard}
PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR=${PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR:-/var/lib/personal-dashboard/runtime-cache}
FINNICK_REPORT_HOST_DIR=${FINNICK_REPORT_HOST_DIR:-/mnt/nas/services/personal-dashboard/finnick}
INVESTMENT_SCREENER_HOST_DIR=${INVESTMENT_SCREENER_HOST_DIR:-/mnt/nas/services/personal-dashboard/investment-screener}
KANBAN_DB_HOST_DIR=${KANBAN_DB_HOST_DIR:-/mnt/nas/services/personal-dashboard/kanban}
HOMELAB_HEALTH_HOST_DIR=${HOMELAB_HEALTH_HOST_DIR:-/mnt/nas/services/personal-dashboard/homelab-health}
MOBILE_WORKFLOW_STATUS_HOST_DIR=${MOBILE_WORKFLOW_STATUS_HOST_DIR:-/mnt/nas/services/personal-dashboard/mobile-workflow}
MEM0_STATUS_HOST_DIR=${MEM0_STATUS_HOST_DIR:-/mnt/nas/services/personal-dashboard/mem0}
GRAPHITI_STATUS_HOST_DIR=${GRAPHITI_STATUS_HOST_DIR:-/mnt/nas/services/graphiti/status}
METAMCP_STATUS_HOST_DIR=${METAMCP_STATUS_HOST_DIR:-/mnt/nas/services/personal-dashboard/metamcp}

copy_snapshot() {
  source_path=$1
  dest_path=$2
  label=$3
  dest_dir=$(dirname "$dest_path")
  tmp_path="$dest_path.tmp.$$"

  if [ ! -f "$source_path" ]; then
    printf '%s\n' "$label source is missing or not a regular file: $source_path" >&2
    exit 1
  fi

  mkdir -p "$dest_dir"
  rm -f "$tmp_path"
  cp -f "$source_path" "$tmp_path"
  chmod 0644 "$tmp_path"
  mv -f "$tmp_path" "$dest_path"
}

copy_optional_snapshot() {
  source_path=$1
  dest_path=$2
  label=$3
  dest_dir=$(dirname "$dest_path")
  tmp_path="$dest_path.tmp.$$"

  mkdir -p "$dest_dir"
  if [ ! -f "$source_path" ]; then
    rm -f "$dest_path" "$tmp_path"
    printf '%s\n' "$label source is missing; skipping optional snapshot: $source_path" >&2
    return 0
  fi

  rm -f "$tmp_path"
  cp -f "$source_path" "$tmp_path"
  chmod 0644 "$tmp_path"
  mv -f "$tmp_path" "$dest_path"
}

copy_tree_snapshot() {
  source_dir=$1
  dest_dir=$2
  label=$3

  if [ ! -d "$source_dir" ]; then
    printf '%s\n' "$label source is missing or not a directory: $source_dir" >&2
    exit 1
  fi

  mkdir -p "$dest_dir"

  # In-place refresh, NOT a directory swap. The dashboard container bind-mounts
  # this directory; renaming/replacing it (mv tmp -> dest) changes its inode and
  # orphans the running container's mount, leaving it reading an empty directory.
  # Delete contents only (preserve dest_dir's own inode), then copy fresh so the
  # long-running container keeps a valid bind.
  find "$dest_dir" -mindepth 1 -delete 2>/dev/null
  cp -R "$source_dir/." "$dest_dir"/
  find "$dest_dir" -type d -exec chmod 0755 {} +
  find "$dest_dir" -type f -exec chmod 0644 {} +
}

cleanup() {
  rm -f \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/config/dashboard.public.json.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/config/home-lab-committed-files.txt.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/finnick/latest_report.txt.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/homelab-health/latest_report.txt.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/mobile-workflow/status.json.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/kanban/kanban.db.tmp.$$"
  rm -rf \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/investment-screener.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/investment-screener.previous.$$"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR"

copy_snapshot "$APP_DIR/config/dashboard.public.json" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/config/dashboard.public.json" \
  "Dashboard public config"
copy_snapshot "$APP_DIR/config/home-lab-committed-files.txt" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/config/home-lab-committed-files.txt" \
  "Home-lab committed files manifest"
copy_snapshot "$FINNICK_REPORT_HOST_DIR/latest_report.txt" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/finnick/latest_report.txt" \
  "Finnick report"
copy_tree_snapshot "$INVESTMENT_SCREENER_HOST_DIR" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/investment-screener" \
  "Investment screener NAS data root"
copy_snapshot "$KANBAN_DB_HOST_DIR/kanban.db" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/kanban/kanban.db" \
  "Kanban DB snapshot"
copy_snapshot "$HOMELAB_HEALTH_HOST_DIR/latest_report.txt" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/homelab-health/latest_report.txt" \
  "Homelab health report"
copy_optional_snapshot "$MOBILE_WORKFLOW_STATUS_HOST_DIR/status.json" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/mobile-workflow/status.json" \
  "Mobile workflow status"
copy_optional_snapshot "$MEM0_STATUS_HOST_DIR/status.json" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/memory/mem0-status.json" \
  "mem0 status"
copy_optional_snapshot "$GRAPHITI_STATUS_HOST_DIR/latest-smoke-backup.json" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/memory/graphiti-status.json" \
  "Graphiti/Neo4j status"
copy_optional_snapshot "$GRAPHITI_STATUS_HOST_DIR/latest-mcp-status.json" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/memory/graphiti-mcp-status.json" \
  "Graphiti MCP status"
copy_optional_snapshot "$METAMCP_STATUS_HOST_DIR/status.json" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/metamcp/status.json" \
  "MetaMCP registry"

printf '%s\n' "Synced personal-dashboard runtime snapshots to $PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR"
