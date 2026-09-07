#!/usr/bin/env bash
# Publish a sanitized MetaMCP registry snapshot for the Home Dashboard.
#
# Queries the live MetaMCP control-plane Postgres (container 'metamcp-pg' on
# tori) for registered MCP servers + namespaces, reduces them to a safe,
# secret-free shape, and copies the result to critical's NAS + local runtime
# cache (the same two locations the mobile-workflow publisher writes to).
#
# The dashboard container reads only the runtime-cache copy
# (/var/lib/personal-dashboard/runtime-cache/metamcp/status.json). Never
# include command/args/env/headers/url/bearer_token here: those may carry
# operator secrets. We expose only name, transport, error_status, and the
# namespace a server is mapped into.
set -euo pipefail

PG_CONTAINER=${METAMCP_PG_CONTAINER:-metamcp-pg}
PG_USER=${METAMCP_PG_USER:-metamcp_user}
PG_DB=${METAMCP_PG_DB:-metamcp_db}
LOCAL_OUT=${LOCAL_OUT:-/opt/metamcp/run/status.json}
REMOTE_NAS=${REMOTE_NAS:-root@192.168.0.50:/mnt/nas/services/personal-dashboard/metamcp/status.json}
REMOTE_CACHE=${REMOTE_CACHE:-root@192.168.0.50:/var/lib/personal-dashboard/runtime-cache/metamcp/status.json}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A -F $'\t' -c \
  "SELECT s.name, s.type, s.error_status, COALESCE(n.name,'(unmapped)') \
     FROM mcp_servers s \
     LEFT JOIN namespace_server_mappings m ON m.mcp_server_uuid = s.uuid \
     LEFT JOIN namespaces n ON n.uuid = m.namespace_uuid ORDER BY s.name;" \
  > "$WORK/servers.tsv"

docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A -F $'\t' -c \
  "SELECT name FROM namespaces ORDER BY name;" \
  > "$WORK/namespaces.tsv"

python3 - "$WORK/servers.tsv" "$WORK/namespaces.tsv" "$LOCAL_OUT" <<'PY'
import json, sys
from datetime import datetime, timezone

servers_tsv, namespaces_tsv, local_out = sys.argv[1:4]

SERVER_NAME_RE = __import__('re').compile(r'^[a-z0-9][a-z0-9-]{0,62}$')
TRANSFORTS = {'STDIO', 'STREAMABLE_HTTP', 'SSE', 'HTTP'}
ERROR_OK = {'NONE', 'OK'}

def clean_name(s):
    s = (s or '').strip()
    return s if SERVER_NAME_RE.match(s) else ''

servers = []
with open(servers_tsv, encoding='utf-8') as fh:
    for line in fh:
        line = line.rstrip('\n')
        if not line:
            continue
        parts = line.split('\t')
        name = clean_name(parts[0] if len(parts) > 0 else '')
        transport = (parts[1] if len(parts) > 1 else '').strip().upper()
        raw_err = (parts[2] if len(parts) > 2 else '').strip().upper()
        namespace = clean_name(parts[3] if len(parts) > 3 else '')
        if not name:
            continue
        if transport not in TRANSFORTS:
            transport = 'UNKNOWN'
        error_status = 'ok' if raw_err in ERROR_OK else (raw_err.lower() if raw_err else 'ok')
        servers.append({
            'name': name,
            'transport': transport,
            'namespace': namespace or None,
            'errorStatus': error_status,
        })

namespaces = []
with open(namespaces_tsv, encoding='utf-8') as fh:
    for line in fh:
        name = clean_name(line)
        if name:
            namespaces.append({'name': name})

payload = {
    'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
    'servers': servers,
    'namespaces': namespaces,
    'counts': {'servers': len(servers), 'namespaces': len(namespaces)},
}

with open(local_out, 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, sort_keys=True)
    fh.write('\n')
PY

chmod 0644 "$LOCAL_OUT"
ssh -o BatchMode=yes -o ConnectTimeout=5 root@192.168.0.50 \
  'mkdir -p /mnt/nas/services/personal-dashboard/metamcp /var/lib/personal-dashboard/runtime-cache/metamcp'
scp -q "$LOCAL_OUT" "$REMOTE_NAS"
scp -q "$LOCAL_OUT" "$REMOTE_CACHE"
printf 'published %s -> %s and %s\n' "$LOCAL_OUT" "$REMOTE_NAS" "$REMOTE_CACHE"
