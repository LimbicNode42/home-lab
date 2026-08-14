# Personal Dashboard Runbook

## NAS/NFS file-bind stale handles

The dashboard reads several externally produced NAS-backed artifacts:

- `config/dashboard.public.json`
- `finnick/latest_report.txt`
- `investment-screener/latest_report.txt`
- `investment-screener/latest_ranked.json`
- `kanban/kanban.db`

Those files are written outside the dashboard container and may be published with an atomic replace (`write temp file` → `rename over latest`). That pattern is good for readers on the host, but it is hostile to Docker bind mounts on NFS/NAS storage. File binds can hold the replaced inode, and even directory binds can remain attached to stale NFS handles after a NAS outage/remount. The host may stat/read `/mnt/nas/services/personal-dashboard/...` cleanly while the long-running container gets `Stale file handle` for `/app/...` paths. When this happens the API may return 502/503 through Traefik because report/config/Kanban reads fail inside the container.

Prevention: copy the NAS/repo-backed read-only artifacts into a host-local runtime cache on critical, then bind-mount only that cache into the container. The deploy helper `scripts/sync-runtime-snapshots.sh` atomically copies these files into `${PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR:-/var/lib/personal-dashboard/runtime-cache}` before `scripts/run-critical-docker.sh` recreates the container. Compose expects the same cache layout:

- runtime cache `config/` → `/app/config` read-only
- runtime cache `finnick/` → `/app/finnick` read-only
- runtime cache `investment-screener/` → `/app/investment-screener` read-only
- runtime cache `kanban/` → `/app/kanban` read-only

Keep `PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR` on local storage, not under `/mnt/nas`. The app still reads the same explicit in-container file paths; only the host bind source changes.

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

`Stale file handle` on any of these paths points at a stale bind handle, not a Traefik or Cloudflare problem by itself. With the runtime-cache model, first verify the container is not mounted directly to `/mnt/nas` by checking `docker inspect personal-dashboard --format '{{json .Mounts}}'`. If any read-only config/report/Kanban mount still uses `/mnt/nas`, deploy the Git-backed cache model after approval. If the mount source is already the local runtime cache, refresh the cache with `scripts/sync-runtime-snapshots.sh`, then recreate only the `personal-dashboard` container so Docker rebinds local paths. Do not restart shared ingress, cloudflared, Vaultwarden, databases, or the LXC unless separate evidence points there.

Any live restart/recreate still needs operator approval and should use the Git-backed `docker-compose.yml` or `scripts/run-critical-docker.sh` from the approved live path.
