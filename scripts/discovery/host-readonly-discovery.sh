#!/usr/bin/env bash
set -euo pipefail

# Read-only host discovery helper.
# Usage: scripts/discovery/host-readonly-discovery.sh [output-file]
# Requires SSH access to hosts in infrastructure/hosts/inventory.yml.
# This script does not change remote hosts.

OUT="${1:-inventory/discovery/host-readonly-discovery-$(date -u +%Y%m%dT%H%M%SZ).json}"
HOSTS_TMP="$(mktemp)"
PAYLOAD_TMP="$(mktemp)"
trap 'rm -f "$HOSTS_TMP" "$PAYLOAD_TMP"' EXIT

python3 - <<'PY' > "$HOSTS_TMP"
from pathlib import Path
import re

inv = Path('infrastructure/hosts/inventory.yml').read_text()
current = None
hosts = []
for line in inv.splitlines():
    m = re.match(r'  - name: "([^"]+)"', line)
    if m:
        current = {'name': m.group(1)}
        hosts.append(current)
        continue
    m = re.match(r'    ansible_host: "([^"]+)"', line)
    if m and current is not None:
        current['ip'] = m.group(1)
for h in hosts:
    if h.get('ip'):
        print(f"{h['name']} {h['ip']}")
PY

mkdir -p "$(dirname "$OUT")"
printf '{\n  "generated_at": "%s",\n  "hosts": [\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT"
first=1
while read -r name ip; do
  [ -n "${name:-}" ] || continue
  if [ "$first" -eq 0 ]; then printf ',\n' >> "$OUT"; fi
  first=0
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$ip" 'hostname; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || true; uname -a; uptime; systemctl --failed --no-pager --plain 2>/dev/null || true; df -hT; mount | head -n 80; ss -tulpn 2>/dev/null || true; command -v docker >/dev/null 2>&1 && docker ps --format "{{.Names}} {{.Image}} {{.Status}} {{.Ports}}" || true' > "$PAYLOAD_TMP" 2>&1 || true
  python3 - "$name" "$ip" "$PAYLOAD_TMP" <<'PY' >> "$OUT"
import json
import sys

name, ip, payload_path = sys.argv[1:4]
with open(payload_path, 'r', encoding='utf-8', errors='replace') as f:
    payload = f.read()
print(json.dumps({"name": name, "ip": ip, "read_only_probe_output": payload}, indent=4))
PY
done < "$HOSTS_TMP"
printf '\n  ]\n}\n' >> "$OUT"

echo "wrote $OUT"
