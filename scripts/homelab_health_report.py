#!/usr/bin/env python3
"""Read-only homelab health report for Proxmox/NAS.

Requires local secrets in /root/.hermes/.env or ENV_PATH:
  PROXMOX_API_URL, PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET,
  HOMELAB_SSH_USER, HOMELAB_SSH_PASS
Optional:
  HOMELAB_NAS_USER, HOMELAB_NAS_PASS

This script does not mutate hosts. It prints a plain-text/Markdown report and exits
non-zero only when prerequisite tooling/secrets are missing or probes fail hard.
"""
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ENV_PATH = Path(os.environ.get("ENV_PATH", "/root/.hermes/.env"))
NODES = {
    "emperor": "192.168.0.6",
    "shogun": "192.168.0.7",
    "jester": "192.168.0.8",
    "tori": "192.168.0.20",
    "toyota": "192.168.0.21",
}
NAS_IP = "192.168.0.250"
BACKUP_STORAGE_NODE = "emperor"
BACKUP_STORAGE_PATHS = ["/mnt/pve/NAS/dump"]
CRITICAL_GUESTS = {"100", "103", "110", "111", "112"}


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def require(keys):
    missing = [k for k in keys if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"Missing required environment values: {', '.join(missing)}")


def pve_api(path):
    base = os.environ["PROXMOX_API_URL"].rstrip("/")
    token_id = os.environ["PROXMOX_TOKEN_ID"]
    token_secret = os.environ["PROXMOX_TOKEN_SECRET"]
    req = urllib.request.Request(base + "/api2/json" + path)
    req.add_header("Authorization", f"PVEAPIToken={token_id}={token_secret}")
    ctx = ssl._create_unverified_context()
    with urllib.request.urlopen(req, context=ctx, timeout=20) as response:
        return json.load(response)["data"]


def ssh(host, command, user=None, password=None, timeout=30):
    user = user or os.environ.get("HOMELAB_SSH_USER", "root")
    password = password or os.environ.get("HOMELAB_SSH_PASS", "")
    cmd = [
        "sshpass", "-p", password,
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=8",
        f"{user}@{host}",
        command,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    return proc.returncode, proc.stdout, proc.stderr


def latest_backup_artifacts():
    host = NODES[BACKUP_STORAGE_NODE]
    python = r'''
from pathlib import Path
import json, re
rows=[]
for base in [Path('/mnt/pve/NAS/dump')]:
    if not base.exists():
        continue
    for f in base.glob('vzdump-*'):
        if f.suffix in ('.log', '.notes') or f.name.endswith('.tmp'):
            continue
        m=re.search(r'vzdump-(lxc|qemu)-(\d+)-', f.name)
        if not m:
            continue
        st=f.stat()
        rows.append({'vmid':m.group(2),'name':f.name,'size':st.st_size,'mtime':int(st.st_mtime)})
print(json.dumps(rows))
'''
    rc, out, err = ssh(host, f"python3 - <<'PY'\n{python}\nPY", timeout=45)
    if rc != 0:
        return {}, f"backup artifact probe failed on {BACKUP_STORAGE_NODE}: {err.strip()}"
    rows = json.loads(out or "[]")
    latest = {}
    for row in rows:
        if row["vmid"] not in latest or row["mtime"] > latest[row["vmid"]]["mtime"]:
            latest[row["vmid"]] = row
    return latest, None


def main():
    load_env(ENV_PATH)
    require(["PROXMOX_API_URL", "PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET", "HOMELAB_SSH_USER", "HOMELAB_SSH_PASS"])

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    resources = pve_api("/cluster/resources")
    jobs = pve_api("/cluster/backup")
    storage = pve_api("/storage")

    guests = {
        str(r.get("vmid")): r for r in resources
        if r.get("type") in ("qemu", "lxc") and r.get("vmid") is not None
    }
    scheduled = set()
    for job in jobs:
        for vmid in str(job.get("vmid", "")).split(","):
            vmid = vmid.strip()
            if vmid:
                scheduled.add(vmid)

    latest, artifact_error = latest_backup_artifacts()

    alerts = []
    if artifact_error:
        alerts.append(artifact_error)
    for vmid in sorted(CRITICAL_GUESTS, key=int):
        guest = guests.get(vmid)
        if not guest:
            alerts.append(f"guest {vmid} is absent from current cluster resources")
            continue
        if vmid not in scheduled:
            alerts.append(f"guest {vmid} ({guest.get('name')}) has no scheduled Proxmox backup job")
        if vmid not in latest:
            alerts.append(f"guest {vmid} ({guest.get('name')}) has no backup artifact on NAS dump path")

    stale_jobs = sorted(scheduled - set(guests.keys()), key=lambda x: int(x) if x.isdigit() else 999999)
    for vmid in stale_jobs:
        alerts.append(f"backup job references absent guest {vmid}")

    failed_unit_summary = []
    for name, ip in NODES.items():
        rc, out, err = ssh(ip, "systemctl --failed --no-legend --plain || true", timeout=20)
        units = [line.split()[0] for line in out.splitlines() if line.strip()]
        if units:
            failed_unit_summary.append((name, units))
            alerts.append(f"{name} failed systemd units: {', '.join(units)}")

    nas_cmd = "df -PT /srv/mergerfs/nas /srv/dev-disk-by-uuid-* 2>/dev/null; echo ---exports---; exportfs -v 2>/dev/null || cat /etc/exports 2>/dev/null || true"
    nas_rc, nas_out, nas_err = ssh(NAS_IP, nas_cmd, timeout=30)
    if nas_rc != 0 and os.environ.get("HOMELAB_NAS_USER") and os.environ.get("HOMELAB_NAS_PASS"):
        nas_rc, nas_out, nas_err = ssh(
            NAS_IP,
            nas_cmd,
            user=os.environ.get("HOMELAB_NAS_USER"),
            password=os.environ.get("HOMELAB_NAS_PASS"),
            timeout=30,
        )
    high_disks = []
    nfs_warning = False
    if nas_rc == 0:
        for line in nas_out.splitlines():
            fields = line.split()
            if len(fields) >= 6 and fields[0].startswith("/dev/"):
                pct = fields[5] if fields[5].endswith("%") else ""
                if pct and int(pct.rstrip("%")) >= 90:
                    high_disks.append(line)
            if "no_root_squash" in line:
                nfs_warning = True
        for line in high_disks:
            alerts.append(f"NAS high backing-disk usage: {line}")
        if nfs_warning:
            alerts.append("NAS NFS export includes no_root_squash")
    else:
        alerts.append(f"NAS probe failed: {nas_err.strip()}")

    print(f"Homelab health report - {generated}")
    print("")
    print("Summary:")
    print(f"- Proxmox guests observed: {len(guests)}")
    print(f"- Proxmox backup jobs observed: {len(jobs)}")
    print(f"- Critical tracked guests: {', '.join(sorted(CRITICAL_GUESTS, key=int))}")
    print(f"- Alerts: {len(alerts)}")
    print("")
    print("Backup coverage:")
    for vmid in sorted(CRITICAL_GUESTS | set(scheduled), key=lambda x: int(x) if x.isdigit() else 999999):
        guest = guests.get(vmid, {})
        artifact = latest.get(vmid)
        art = "none"
        if artifact:
            art_time = datetime.fromtimestamp(artifact["mtime"], timezone.utc).strftime("%Y-%m-%d %H:%MZ")
            art = f"{art_time} {artifact['name']}"
        print(f"- {vmid}: name={guest.get('name','absent')} status={guest.get('status','absent')} scheduled={'yes' if vmid in scheduled else 'no'} latest={art}")
    print("")
    print("Failed units:")
    if failed_unit_summary:
        for node, units in failed_unit_summary:
            print(f"- {node}: {', '.join(units)}")
    else:
        print("- none observed on Proxmox nodes")
    print("")
    print("Alerts:")
    if alerts:
        for alert in alerts:
            print(f"- {alert}")
    else:
        print("- none")


if __name__ == "__main__":
    try:
        main()
    except subprocess.TimeoutExpired as exc:
        raise SystemExit(f"Probe timed out: {exc}")
