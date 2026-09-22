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
MEM0_BACKUP_HOST_DIR=${MEM0_BACKUP_HOST_DIR:-/mnt/nas/backups/mem0}

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

cleanup() {
  rm -f \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/config/dashboard.public.json.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/config/home-lab-committed-files.txt.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/finnick/latest_report.txt.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/investment-screener/latest_report.txt.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/investment-screener/latest_ranked.json.tmp.$$" \
    "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/kanban/kanban.db.tmp.$$"
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
copy_snapshot "$INVESTMENT_SCREENER_HOST_DIR/latest_report.txt" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/investment-screener/latest_report.txt" \
  "Investment screener report"
copy_snapshot "$INVESTMENT_SCREENER_HOST_DIR/latest_ranked.json" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/investment-screener/latest_ranked.json" \
  "Investment screener ranked output"
copy_snapshot "$KANBAN_DB_HOST_DIR/kanban.db" \
  "$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/kanban/kanban.db" \
  "Kanban DB snapshot"


# Snapshot only completed mem0 backup manifests into the host-local runtime cache.
# This gives the dashboard freshness metadata without bind-mounting the whole NAS
# backup tree or exposing backup contents inside the container.
mem0_backup_cache="$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/mem0-backups"
if [ -d "$MEM0_BACKUP_HOST_DIR" ]; then
  rm -rf "$mem0_backup_cache.tmp.$$"
  mkdir -p "$mem0_backup_cache.tmp.$$"
  for manifest in "$MEM0_BACKUP_HOST_DIR"/*/MANIFEST.txt; do
    [ -f "$manifest" ] || continue
    backup_name=$(basename "$(dirname "$manifest")")
    mkdir -p "$mem0_backup_cache.tmp.$$/$backup_name"
    cp -f "$manifest" "$mem0_backup_cache.tmp.$$/$backup_name/MANIFEST.txt"
    chmod 0644 "$mem0_backup_cache.tmp.$$/$backup_name/MANIFEST.txt"
  done
  rm -rf "$mem0_backup_cache"
  mv "$mem0_backup_cache.tmp.$$" "$mem0_backup_cache"
else
  rm -rf "$mem0_backup_cache"
  mkdir -p "$mem0_backup_cache"
fi

printf '%s\n' "Synced personal-dashboard runtime snapshots to $PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR"
