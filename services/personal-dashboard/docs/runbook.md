# Personal Dashboard Runbook

## NAS/NFS file-bind stale handles

The dashboard reads several externally produced NAS-backed artifacts:

- `config/dashboard.public.json`
- `finnick/latest_report.txt`
- `investment-screener/latest_report.txt`
- `investment-screener/latest_ranked.json`
- `kanban/kanban.db`
- `homelab-health/latest_report.txt`

Those files are written outside the dashboard container and may be published with an atomic replace (`write temp file` → `rename over latest`). That pattern is good for readers on the host, but it is hostile to Docker bind mounts on NFS/NAS storage. File binds can hold the replaced inode, and even directory binds can remain attached to stale NFS handles after a NAS outage/remount. The host may stat/read `/mnt/nas/services/personal-dashboard/...` cleanly while the long-running container gets `Stale file handle` for `/app/...` paths. When this happens the API may return 502/503 through Traefik because report/config/Kanban reads fail inside the container.

Prevention: copy the NAS/repo-backed read-only artifacts into a host-local runtime cache on critical, then bind-mount only that cache into the container. The deploy helper `scripts/sync-runtime-snapshots.sh` atomically copies these files into `${PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR:-/var/lib/personal-dashboard/runtime-cache}` before `scripts/run-critical-docker.sh` recreates the container. Compose expects the same cache layout:

- runtime cache `config/` → `/app/config` read-only
- runtime cache `finnick/` → `/app/finnick` read-only
- runtime cache `investment-screener/` → `/app/investment-screener` read-only
- runtime cache `kanban/` → `/app/kanban` read-only
- runtime cache `homelab-health/` → `/app/homelab-health` read-only

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

## Diary/Goals 503 triage

If `/api/goals` or `/api/diary/entries` returns `personal_data_unavailable`, first
check deployment config rather than assuming the frontend lost state:

1. Verify the dashboard env has `PERSONAL_DASHBOARD_DATABASE_URL` and redacted host
   component points at the stable `postgres` alias, not a raw Docker bridge IP.
2. Verify Postgres is running and attached to `critical-internal` with alias
   `postgres`.
3. From the dashboard container network context, verify DNS/TCP to `postgres:5432`
   and then run an app-only `SELECT 1` without printing the URL or password.
4. Sample authenticated API load and save paths with obviously fake content, then
   delete only the exact fake rows if a smoke write succeeded.

The server retries Postgres initialization on later Diary/Goals requests after an
initial connection failure, so a temporary database startup race should recover
without wiping data or restarting the dashboard. A persistent 503 after the database
is healthy usually means the rendered DB endpoint/secret is still wrong and should
be corrected through the stable-alias deploy path above.

## Recovery when stale handles recur

If dashboard APIs fail while host-side files remain readable, check inside the running container:

```bash
docker exec personal-dashboard stat /app/config/dashboard.public.json \
  /app/finnick/latest_report.txt \
  /app/investment-screener/latest_report.txt \
  /app/investment-screener/latest_ranked.json \
  /app/kanban/kanban.db \
  /app/homelab-health/latest_report.txt
```

`Stale file handle` on any of these paths points at a stale bind handle, not a Traefik or Cloudflare problem by itself. With the runtime-cache model, first verify the container is not mounted directly to `/mnt/nas` by checking `docker inspect personal-dashboard --format '{{json .Mounts}}'`. If any read-only config/report/Kanban mount still uses `/mnt/nas`, deploy the Git-backed cache model after approval. If the mount source is already the local runtime cache, refresh the cache with `scripts/sync-runtime-snapshots.sh`, then recreate only the `personal-dashboard` container so Docker rebinds local paths. Do not restart shared ingress, cloudflared, Vaultwarden, databases, or the LXC unless separate evidence points there.

Any live restart/recreate still needs operator approval and should use the Git-backed `docker-compose.yml` or `scripts/run-critical-docker.sh` from the approved live path.

## Homelab health report — configuration and troubleshooting

The Reports tab shows a **Homelab Health** card alongside the Finnick card. The data
source is the existing `homelab-daily-health-report` cron job (Hermes, daily at 08:00
AEST, id `7b2504ab9f36`).

### How the report reaches the dashboard

1. The cron job script `/root/.hermes/scripts/homelab_daily_health.sh` runs
   `scripts/homelab_health_report.py`, applies sanitization, and writes
   `latest_report.txt` atomically to the NAS path:
   `/mnt/nas/services/personal-dashboard/homelab-health/latest_report.txt`

2. `scripts/sync-runtime-snapshots.sh` copies it to the host-local runtime cache
   (`$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/homelab-health/latest_report.txt`) before
   container start.

3. The container reads `/app/homelab-health/latest_report.txt` via a read-only bind,
   configured via `HOMELAB_HEALTH_REPORT_FILE`.

4. `GET /api/homelab/health` returns a JSON envelope:
   `{ state, content, generated_at, fetched_at, alert_count, age_hours }`

### Environment variable

| Variable | Default (in container) | Description |
|---|---|---|
| `HOMELAB_HEALTH_REPORT_FILE` | `/app/homelab-health/latest_report.txt` | Path to the report file inside the container |

### States

| State | Meaning |
|---|---|
| `ok` | File fresh (< 26h), content present, no alerts |
| `degraded` | File fresh, alerts > 0 in Summary section |
| `stale` | File exists but mtime >= 26h (missed at least one run) |
| `empty` | File exists but content is blank/whitespace-only |
| `not_configured` | `HOMELAB_HEALTH_REPORT_FILE` env var not set (503) |
| `not_found` | File does not exist (404) |
| `read_error` | File exists but read failed (502) |

### Pre-deploy checklist for new deploys

1. Create NAS directory: `mkdir -p /mnt/nas/services/personal-dashboard/homelab-health`
2. Test-run the cron script manually on Tori:
   `bash /root/.hermes/scripts/homelab_daily_health.sh`
   — should write `latest_report.txt` to the NAS path and print output to stdout.
3. Verify the file is readable and non-empty.
4. Run `scripts/sync-runtime-snapshots.sh` (with env vars set for homelab-health dir).
5. Run `scripts/run-critical-docker.sh` (preflight will check for the file before
   docker run).

### Sanitization

The cron script applies defence-in-depth sanitization at write time (Section 4 of the
implementation spec). The dashboard server serves the file as-is — no further
sanitization. Rules applied:

1. Lines matching `token_secret=`, `password=`, `api_key=`, etc. have the value
   portion replaced with `[REDACTED]`
2. Credential-bearing HTTPS URLs (`https://user:pass@host`) are replaced with
   `[REDACTED_URL]`
3. Lines beginning with `sshpass:` or `debug1:` are stripped
4. Lines exceeding 512 characters are stripped
5. If the sanitized output exceeds 64 KB, the NAS write is skipped entirely

