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
- Live Traefik config currently routes `jellyfin.wheeler-network.com` to `http://192.168.0.249:8096`, while an observed live Docker container is on `jester` (`192.168.0.8`) with port `8096` published. Reconcile before proxy changes.
- 2026-05-25 follow-up: Proxmox CT `101` named `jellyfin` also exists on `jester`, is running, has neighbor entry `192.168.0.249` for MAC `BC:24:11:65:41:B0`, mounts `/mnt/pve/NAS` as `/mnt/nas`, and has GPU/video device passthrough entries. This appears to be the original LXC placement and may still be the Traefik upstream. Do not delete until its internal services, config, backups, and traffic path are fully reconciled.
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
