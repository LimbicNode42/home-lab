# Personal Dashboard Runbook

## NAS/NFS file-bind stale handles

The dashboard reads several externally produced NAS-backed artifacts:

- `config/dashboard.public.json`
- `finnick/latest_report.txt`
- `investment-screener/latest_report.txt`
- `investment-screener/latest_ranked.json`
- `kanban/kanban.db`

Those files are written outside the dashboard container and may be published with an atomic replace (`write temp file` → `rename over latest`). That pattern is good for readers on the host, but it is hostile to Docker bind mounts that target an individual file on NFS/NAS storage. The container can keep a handle to the replaced inode and later see `Stale file handle` even while the same host path is readable from the Docker host. When this happens the API may return 502/503 through Traefik because report/config/Kanban reads fail inside the container.

Prevention: bind-mount the containing directories read-only and keep the app pointed at the exact file paths inside those directories. The bounded directories are:

- host config directory → `/app/config` read-only
- host Finnick report directory → `/app/finnick` read-only
- host investment-screener export directory → `/app/investment-screener` read-only
- host Kanban snapshot directory → `/app/kanban` read-only

The private Diary/Goals SQLite store is different: mount its containing `data` directory read-write at `/app/data` so SQLite can create WAL/SHM sidecars. Do not widen this to broader NAS directories. The dashboard container still must not receive secrets, Docker socket access, SSH keys, the Hermes runtime DB, or writable access to report/config/Kanban sources. Tiny blast radii, not a NAS buffet.

## Recovery when stale handles recur

If dashboard APIs fail while host-side files remain readable, check inside the running container:

```bash
docker exec personal-dashboard stat /app/config/dashboard.public.json \
  /app/finnick/latest_report.txt \
  /app/investment-screener/latest_report.txt \
  /app/investment-screener/latest_ranked.json \
  /app/kanban/kanban.db
```

`Stale file handle` on any of these paths points at a stale bind handle, not a Traefik or Cloudflare problem by itself. The bounded workaround is to recreate/restart only the `personal-dashboard` container so Docker rebinds the mounts, then re-test direct backend and Traefik paths. Do not restart shared ingress, cloudflared, Vaultwarden, databases, or the LXC unless separate evidence points there.

Any live restart/recreate still needs operator approval and should use the Git-backed `docker-compose.yml` or `scripts/run-critical-docker.sh` from the approved live path.
