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

The private Diary/Goals store is different: it now lives in the shared critical Postgres service and is reached only through `PERSONAL_DASHBOARD_DATABASE_URL` plus `PGSSLMODE`; do not add a writable SQLite `/app/data` bind back to the dashboard container. The dashboard container still must not receive Docker socket access, SSH keys, the Hermes runtime DB, or writable access to report/config/Kanban sources. Tiny blast radii, not a NAS buffet.

## Stable Postgres network alias

Diary/Goals reaches the shared critical Postgres container over a Docker-local
network alias instead of a raw bridge IP. Desired state:

- Docker network: `critical-internal` (`internal: true`)
- Postgres container: attached to `critical-internal` with alias `postgres`
- Dashboard container: attached to `critical-internal` for database DNS, and to
  its default/bridge network for status probes and the `172.17.0.1:4322` Traefik
  publish path
- Vaultwarden secret: folder `homelab`, item `personal-dashboard/database`, field
  `database_url`; update only the URL host component from the old raw bridge IP
  to `postgres` after the Docker network source-of-truth is in place. Preserve
  username, password, port, database name, and TLS/query parameters.

This task does not apply the live change by itself. Applying it requires explicit
approval because the safe sequence mutates Docker networking and recreates only
the dashboard container:

1. Back up/record current state: `docker inspect postgres personal-dashboard` and
   the current rendered `PERSONAL_DASHBOARD_DATABASE_URL` with secrets redacted.
2. Create the network if absent: `docker network create --internal critical-internal`.
3. Attach Postgres if absent: `docker network connect --alias postgres critical-internal postgres`.
4. Update the Vaultwarden `database_url` host to `postgres` only; do not rotate or
   rewrite any other component.
5. Re-render the dashboard `.env` and run `sh scripts/run-critical-docker.sh` from
   the approved live path, recreating only `personal-dashboard`.
6. Verify `http://172.17.0.1:4322/healthz`, a Diary/Goals API call with auth
   headers, and `docker exec personal-dashboard node -e` DNS/TCP checks to
   `postgres:5432` if needed.

Rollback: restore the previous Vaultwarden `database_url` host component, re-render
`.env`, rerun `sh scripts/run-critical-docker.sh`, and disconnect the dashboard
from `critical-internal` only if the recreated container still has the unwanted
network attachment. Do not remove Postgres data or rotate credentials.

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
