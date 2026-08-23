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

copy_tree_snapshot() {
  source_dir=$1
  dest_dir=$2
  label=$3
  parent_dir=$(dirname "$dest_dir")
  tmp_dir="$dest_dir.tmp.$$"
  previous_dir="$dest_dir.previous.$$"

  if [ ! -d "$source_dir" ]; then
    printf '%s\n' "$label source is missing or not a directory: $source_dir" >&2
    exit 1
  fi

  mkdir -p "$parent_dir"
  rm -rf "$tmp_dir" "$previous_dir"
  mkdir -p "$tmp_dir"
  cp -R "$source_dir/." "$tmp_dir/"
  find "$tmp_dir" -type d -exec chmod 0755 {} +
  find "$tmp_dir" -type f -exec chmod 0644 {} +
  if [ -e "$dest_dir" ]; then
    mv "$dest_dir" "$previous_dir"
  fi
  mv "$tmp_dir" "$dest_dir"
  rm -rf "$previous_dir"
}

cleanup() {
  rm -f \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/config/dashboard.public.json.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/config/home-lab-committed-files.txt.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/finnick/latest_report.txt.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/homelab-health/latest_report.txt.tmp.$$" \
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

printf '%s\n' "Synced personal-dashboard runtime snapshots to $PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR"
