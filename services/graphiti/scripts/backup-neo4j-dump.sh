#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  backup-neo4j-dump.sh --dry-run
  GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
  GRAPHITI_BACKUP_ALLOW_SERVICE_STOP=approved \
    backup-neo4j-dump.sh --apply

Creates a Neo4j dump plus non-secret config/evidence snapshots for the tori-local
Graphiti service. Live Neo4j data must remain on local disk; NAS is used only
for dump/config/manifest/evidence output.

Safety gates:
  --dry-run prints the plan and performs no Docker/NAS mutation.
  --apply requires GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved.
  Community Neo4j dumps are treated as offline dumps, so --apply also requires
  GRAPHITI_BACKUP_ALLOW_SERVICE_STOP=approved and will stop graphiti-api/neo4j,
  dump via an ephemeral Neo4j container, then restart them.
USAGE
}

mode="${1:---dry-run}"
case "$mode" in
  --dry-run|--apply) ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

compose_dir="${GRAPHITI_COMPOSE_DIR:-/opt/graphiti}"
compose_file="${GRAPHITI_COMPOSE_FILE:-${compose_dir}/docker-compose.yml}"
neo4j_service="${GRAPHITI_NEO4J_SERVICE:-neo4j}"
graphiti_service="${GRAPHITI_API_SERVICE:-graphiti-api}"
neo4j_image="${NEO4J_IMAGE:-neo4j:5.26.2}"
database="${GRAPHITI_NEO4J_DATABASE:-neo4j}"
live_data_dir="${GRAPHITI_NEO4J_DATA_DIR:-/var/lib/graphiti/neo4j/data}"
nas_root="${GRAPHITI_NAS_ROOT:-/mnt/pve/NAS/services/graphiti}"
backup_dir="${GRAPHITI_NAS_BACKUP_DIR:-${nas_root}/backups/neo4j-dumps}"
snapshot_dir="${GRAPHITI_NAS_SNAPSHOT_DIR:-${nas_root}/config-snapshots}"
manifest_dir="${GRAPHITI_NAS_MANIFEST_DIR:-${nas_root}/manifests}"
stamp="${GRAPHITI_BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
backup_set="${backup_dir}/${stamp}"
snapshot_set="${snapshot_dir}/${stamp}"
manifest="${manifest_dir}/neo4j-backup-${stamp}.manifest.json"
dump_name="${database}-${stamp}.dump"

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))'
}

require_apply_gate() {
  if [[ "${GRAPHITI_ENABLE_LIVE_MUTATION:-}" != "reviewed-approved" ]]; then
    echo "Refusing --apply: GRAPHITI_ENABLE_LIVE_MUTATION must be reviewed-approved" >&2
    exit 2
  fi
  if [[ "${GRAPHITI_BACKUP_ALLOW_SERVICE_STOP:-}" != "approved" ]]; then
    echo "Refusing --apply: community dump path stops services; set GRAPHITI_BACKUP_ALLOW_SERVICE_STOP=approved" >&2
    exit 2
  fi
}

check_live_data_is_local() {
  local fstype source
  if ! command -v findmnt >/dev/null 2>&1; then
    echo "findmnt is required to verify live data is not on NAS/NFS" >&2
    exit 1
  fi
  fstype="$(findmnt -T "$live_data_dir" -no FSTYPE 2>/dev/null || true)"
  source="$(findmnt -T "$live_data_dir" -no SOURCE 2>/dev/null || true)"
  if [[ -z "$fstype" ]]; then
    echo "Cannot determine filesystem for live data path: $live_data_dir" >&2
    exit 1
  fi
  case "$fstype" in
    nfs|nfs4|cifs|smb3|fuse.*)
      echo "Refusing: live Neo4j data path $live_data_dir is on $fstype ($source); live data must be local disk" >&2
      exit 3
      ;;
  esac
  printf '%s\t%s\n' "$fstype" "$source"
}

write_config_snapshots() {
  install -d -m 0750 "$snapshot_set"
  if [[ -f "$compose_file" ]]; then
    cp "$compose_file" "$snapshot_set/docker-compose.yml"
  else
    echo "missing compose file: $compose_file" > "$snapshot_set/docker-compose.yml.missing"
  fi
  if [[ -f "${compose_dir}/.env" ]]; then
    # Store keys only, never values.
    grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "${compose_dir}/.env" | cut -d= -f1 | sort -u > "$snapshot_set/env.keys"
  else
    : > "$snapshot_set/env.keys"
    echo "runtime .env missing at ${compose_dir}/.env" > "$snapshot_set/env.keys.note"
  fi
  {
    echo "stamp=${stamp}"
    echo "compose_file=${compose_file}"
    echo "database=${database}"
    echo "neo4j_service=${neo4j_service}"
    echo "graphiti_service=${graphiti_service}"
    echo "backup_script_version=git:$(git -C "$(dirname "$0")/../../.." rev-parse --short HEAD 2>/dev/null || echo unknown)"
  } > "$snapshot_set/backup-context.txt"
}

write_image_snapshot() {
  local image_out="$snapshot_set/images.json"
  if command -v docker >/dev/null 2>&1; then
    docker inspect graphiti-neo4j graphiti-api \
      --format '{{json .}}' 2>/dev/null \
      | python3 -c 'import json,sys; print(json.dumps([{"name": o.get("Name",""), "image": o.get("Config",{}).get("Image",""), "image_id": o.get("Image","")} for o in map(json.loads, sys.stdin) ], indent=2))' \
      > "$image_out" || echo '[]' > "$image_out"
  else
    echo '[]' > "$image_out"
  fi
}

print_plan() {
  cat <<PLAN
Graphiti Neo4j backup plan (${mode})
  compose_file: ${compose_file}
  live_data_dir: ${live_data_dir}
  database: ${database}
  neo4j_image: ${neo4j_image}
  backup_set: ${backup_set}
  snapshot_set: ${snapshot_set}
  manifest: ${manifest}
  service disruption: stop ${graphiti_service} and ${neo4j_service}, offline dump, restart
  secret handling: runtime .env values are never copied; env.keys stores variable names only
PLAN
}

print_plan
if [[ "$mode" == "--dry-run" ]]; then
  echo "Dry run only; no Docker or NAS writes performed."
  exit 0
fi

require_apply_gate
local_fs_info="$(check_live_data_is_local)"
install -d -m 0750 "$backup_set" "$snapshot_set" "$manifest_dir"
write_config_snapshots
write_image_snapshot

cd "$compose_dir"
restart_needed=0
cleanup() {
  set +e
  if [[ "$restart_needed" == "1" ]]; then
    docker compose -f "$compose_file" up -d "$neo4j_service" "$graphiti_service" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Offline dump path for Neo4j Community. This is intentionally explicit rather
# than pretending an online dump is application-consistent. Theater is for puppets.
docker compose -f "$compose_file" stop "$graphiti_service"
docker compose -f "$compose_file" stop "$neo4j_service"
restart_needed=1

docker compose -f "$compose_file" run --rm --no-deps \
  -v "${backup_set}:/graphiti-backup" \
  "$neo4j_service" \
  neo4j-admin database dump "$database" --to-path=/graphiti-backup --overwrite-destination=true

if [[ ! -f "${backup_set}/${database}.dump" ]]; then
  echo "Expected dump was not created at ${backup_set}/${database}.dump" >&2
  exit 1
fi
mv "${backup_set}/${database}.dump" "${backup_set}/${dump_name}"
sha256sum "${backup_set}/${dump_name}" > "${backup_set}/${dump_name}.sha256"
sha256sum -c "${backup_set}/${dump_name}.sha256"

dump_size="$(stat -c '%s' "${backup_set}/${dump_name}")"
dump_sha="$(cut -d' ' -f1 "${backup_set}/${dump_name}.sha256")"
local_fs_type="$(printf '%s' "$local_fs_info" | cut -f1)"
local_fs_source="$(printf '%s' "$local_fs_info" | cut -f2-)"
cat > "$manifest" <<JSON
{
  "created_at_utc": "${stamp}",
  "status": "backup_created_restore_test_required",
  "database": "${database}",
  "dump_path": "${backup_set}/${dump_name}",
  "dump_sha256": "${dump_sha}",
  "dump_size_bytes": ${dump_size},
  "sha256_file": "${backup_set}/${dump_name}.sha256",
  "config_snapshot_dir": "${snapshot_set}",
  "live_data_path": "${live_data_dir}",
  "live_data_fstype": $(printf '%s' "$local_fs_type" | json_escape),
  "live_data_source": $(printf '%s' "$local_fs_source" | json_escape),
  "nas_policy": "NAS stores dumps/config snapshots/restore-test evidence only; live Neo4j data remains local disk.",
  "secrets_included": false,
  "restore_test_required": true
}
JSON
python3 -m json.tool "$manifest" >/dev/null

docker compose -f "$compose_file" up -d "$neo4j_service" "$graphiti_service"
restart_needed=0

echo "Created backup set: ${backup_set}"
echo "Created manifest: ${manifest}"
