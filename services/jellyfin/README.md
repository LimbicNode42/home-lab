# Jellyfin

Status: live service observed on `jester` (`192.168.0.8`), with candidate desired-state seed still not fully reconciled

Source evidence:
- archive `jellyfin.sh` plus `/mnt/nas/services/jellyfin` metadata
- Sanitized discovery artifact: `inventory/discovery/emperor-remaining-services-discovery-2026-05-23.json`
- 2026-05-25 read-only/live troubleshooting: `docker inspect jellyfin` on `jester` showed image `lscr.io/linuxserver/jellyfin:latest`, published `8096/tcp`, config bind `/opt/jellyfin-config:/config`, and media binds `/mnt/pve/NAS/media/movies:/movies`, `/mnt/pve/NAS/media/tv:/tv`.

Safety notes:
- Candidate compose only; not applied by Hermes.
- No live container was restarted, recreated, or modified during import.
- 2026-05-25 incident remediation: after explicit approval, only the live `jellyfin` container was restarted to refresh stale NAS bind-mount file handles. No data, volumes, users, or media files were changed.
- Image tags are preserved from archived scripts where no live container exists; pin to digests before applying.
- Review port conflicts and dependencies before any live mutation.

Secret handling:
None identified in the candidate compose.

Import notes:
- Archive includes separate LXC config for a `jellyfin` host at 192.168.0.249, not necessarily critical LXC.
- Live Traefik config routes `jellyfin.wheeler-network.com` to the host Docker service at `http://192.168.0.8:8096` as of 2026-05-25.
- 2026-05-25 follow-up: Proxmox CT `101` named `jellyfin` also exists on `jester`, has MAC `BC:24:11:65:41:B0`, mounts `/mnt/pve/NAS` as `/mnt/nas`, and has GPU/video device passthrough entries. Read-only inspection found it had no IPv4 address despite the stale `192.168.0.249` neighbor entry, and Traefik now routes to the host Docker service. CT `101` was gracefully stopped after verification; do not delete until its internal config/backups are fully reconciled.
- The candidate compose mounts `/mnt/nas/...`, but the observed host Docker container mounts `/mnt/pve/NAS/...` and `/opt/jellyfin-config`; reconcile before apply.
- Privileged + host networking are high-risk and require explicit approval before apply.

## Incident notes

### 2026-05-25 stale NAS file handles causing fatal playback errors

Symptoms:
- Jellyfin UI returned fatal playback errors.
- Logs showed `System.IO.IOException: Stale file handle` for `/tv`, `/movies/.../backdrop.jpg`, and playback media paths.
- FFmpeg transcodes failed with `FFmpeg exited with code 140` while reading media under `/movies`.

Evidence:
- Host `jester` could `stat` the same NAS paths under `/mnt/pve/NAS/media/...` successfully.
- Inside the running `jellyfin` container, `stat`, `dd`, and `ffprobe` against the same bind-mounted paths returned `Stale file handle`.

Remediation performed:
- Restarted only the `jellyfin` Docker container on `jester` after approval.
- Verified inside-container `stat`, `dd`, and `ffprobe` against the previously failing movie path succeeded.
- Verified `http://127.0.0.1:8096/System/Info/Public` returned HTTP 200 after startup.

Follow-up:
- If this recurs after NAS outages or NFS remounts, restart the affected media containers after verifying the host mount itself is healthy.
- Consider an operational runbook/health check for stale bind-mount handles in containers that consume `/mnt/pve/NAS`.

### 2026-05-25 legacy CT 101 reconciliation

Findings:
- CT `101` on `jester` was named `jellyfin`, used Alpine, had 4 cores, 4 GiB RAM, GPU/video passthrough devices, and mounted host `/mnt/pve/NAS` at guest `/mnt/nas`.
- The CT config only had IPv6 DHCP (`ip6=dhcp`) on `net0`; read-only inspection showed no IPv4 address on `eth0`, no default route, and a stale/failed host neighbor entry for `192.168.0.249`.
- Inside CT `101`, a nested Docker `lscr.io/linuxserver/jellyfin:latest` container was running with host networking and binds from `/mnt/nas/services/jellyfin/{config,cache}` plus `/mnt/nas/media/{movies,tv}`.
- That legacy Jellyfin instance reported server id `87c1cabefb5c4940808f09b172165c53`; the active host Docker Jellyfin reports server id `d85ae9f6b5d34e779ed6f4f7cb1991ad`.
- Legacy NAS-backed config had recent logs but older core config/database mtimes than the active host Docker config under `/opt/jellyfin-config`.

Action performed:
- Gracefully shut down CT `101` after verifying Traefik and direct access both use the host Docker Jellyfin on `192.168.0.8:8096`.
- Verified host Docker Jellyfin still returned HTTP 200 on `http://127.0.0.1:8096/System/Info/Public`.
- Verified Traefik route for `jellyfin.wheeler-network.com` still returned HTTP 200 from server `jester`.

Next cleanup gate:
- Keep CT `101` stopped for an observation window. Do not delete its rootfs or NAS-backed `/mnt/nas/services/jellyfin` data until confirming no unique users, metadata, plugins, or watch-state need migration.

### 2026-05-26 OpenClaw/Homer handoff and repeated stale handle remediation

Symptoms:
- Jellyfin playback failed again with `System.IO.IOException: Stale file handle` on `/tv` and `/movies`.
- FFmpeg exited with code `140` during playback.
- Legacy CT `101` had been started again even though the intended active service is host Docker Jellyfin on `jester` (`192.168.0.8:8096`).

Findings:
- `/etc/cron.d/homelab-backups` ran `/root/.openclaw/workspace-homer/scripts/daily_homelab_report.sh` daily.
- That Homer report still treated CT `101` and `http://192.168.0.249:8096/health` as expected-good Jellyfin state, so it was stale relative to the Hermes-owned desired state.
- OpenClaw user systemd units were present for `openclaw-agent@homer.service` and `openclaw-gateway.service`.

Actions performed:
- Disabled and preserved OpenClaw/Homer homelab cron entries under `/root/.openclaw/disabled-cron/20260526T223112+1000`.
- Disabled/masked the OpenClaw user systemd units, preserving status/unit evidence under `/root/.openclaw/disabled-systemd-user/`.
- Gracefully stopped CT `101` again; verified it is `status: stopped`.
- Restarted only the active host Docker `jellyfin` container on `jester` after explicit approval to refresh stale NAS bind mounts.

Verification:
- Active host Docker Jellyfin returned HTTP 200 from `http://127.0.0.1:8096/System/Info/Public` with server id `d85ae9f6b5d34e779ed6f4f7cb1991ad`.
- Traefik route for `jellyfin.wheeler-network.com` returned HTTP 200 to the same `jester` backend.
- Inside the active container, `stat /tv`, `stat /movies`, and a sample read of the previously failing `Independence Day Resurgence` media path succeeded.
- Recent logs after restart showed no new `Stale file handle` or FFmpeg code `140` errors.

Operational note:
- OpenClaw/Homer artifacts were disabled, not deleted. Do not re-enable them unless their checks are updated to the Hermes-owned desired state and Ben explicitly wants OpenClaw back in the loop.

### 2026-05-27 bounded stale-handle watchdog workaround

Context:
- Root-cause investigation points at recurring NAS VM/storage instability, with VM `103` passing disks through a JMicron JMS567 USB bridge (`152d:0567`).
- Ben explicitly chose to keep the USB bridge and keep VM `103` as the cluster qdevice for now, accepting that this is a pragmatic workaround rather than structural remediation. Yes, Febreze. Labeled as such.

Live change performed after approval:
- Installed `/usr/local/sbin/jellyfin-stale-handle-watchdog` on `jester` (`192.168.0.8`).
- Installed and enabled `jellyfin-stale-handle-watchdog.service` and `jellyfin-stale-handle-watchdog.timer` under `/etc/systemd/system/`.
- Timer runs every 5 minutes after boot and previous activation.
- Repo copies are stored under `services/jellyfin/ops/`:
  - `ops/jellyfin-stale-handle-watchdog`
  - `ops/systemd/jellyfin-stale-handle-watchdog.service`
  - `ops/systemd/jellyfin-stale-handle-watchdog.timer`

Safety boundaries:
- The watchdog first verifies host NAS paths under `/mnt/pve/NAS/media/{movies,tv}` are healthy.
- It restarts only the Docker container named `jellyfin`, and only when container-side probes show `Stale file handle` while host-side probes are healthy.
- It refuses action if the host mount is unhealthy, the container is missing, the container is not running, or probes fail for a reason other than stale handles.
- It has a 30-minute restart cooldown via `/run/jellyfin-stale-handle-watchdog.last-restart`.
- It logs actions through stdout/journald and logger tag `jellyfin-stale-handle-watchdog`.

Verification:
- Script passed `bash -n` on the source and installed copy.
- `systemd-analyze verify` passed on the installed service/timer on `jester`.
- Dry-run and live healthy-state runs did not restart the container; `docker inspect jellyfin --format '{{.State.StartedAt}}'` was unchanged.
- Timer was enabled and active: `systemctl is-enabled/is-active jellyfin-stale-handle-watchdog.timer` returned `enabled` / `active`.

Manual inspection commands:
```bash
systemctl status jellyfin-stale-handle-watchdog.timer --no-pager
systemctl list-timers jellyfin-stale-handle-watchdog.timer --no-pager
journalctl -u jellyfin-stale-handle-watchdog.service -u jellyfin-stale-handle-watchdog.timer --since '24 hours ago' --no-pager
DRY_RUN=1 /usr/local/sbin/jellyfin-stale-handle-watchdog
```

Rollback:
```bash
systemctl disable --now jellyfin-stale-handle-watchdog.timer
rm -f /etc/systemd/system/jellyfin-stale-handle-watchdog.service \
      /etc/systemd/system/jellyfin-stale-handle-watchdog.timer \
      /usr/local/sbin/jellyfin-stale-handle-watchdog
systemctl daemon-reload
```
