# Other Hosts Service and Backup Import

Generated: 2026-05-25

Scope: non-Emperor hosts and services after the Emperor node import work was already completed.

## Read-only evidence captured

- Host discovery: `inventory/discovery/host-readonly-discovery-20260525T111814Z.json`
- Proxmox/backup discovery: `inventory/discovery/proxmox-resources-backups-20260525T111842Z.json`
- Historical seed used for unreachable app hosts: `inventory/discovery/ssh-host-inventory-raw.json`

## Current host reachability

| Host | IP / VMID | Current status from read-only probes | Import action |
|---|---|---|---|
| `shogun` | 192.168.0.7 | Reachable; Proxmox node; hosts running VMID 103 `NAS-OMV` | Documented backup gap for NAS VM; no service compose seed generated |
| `jester` | 192.168.0.8 | Reachable; Proxmox node; Docker container `jellyfin` running | Existing `services/jellyfin/` docs updated by prior reconciliation; no new live mutation |
| `tori` | 192.168.0.20 | Reachable; Proxmox node; local Hermes vantage point; no running Docker containers | Documented residual quorum/qdevice state in evidence |
| `toyota` | 192.168.0.21 | Unreachable / offline from cluster resources and network probes | Deferred live import; preserve stale historical seeds only |
| `dev` | 192.168.0.51 / 110 | Unreachable because `toyota` is offline; historical Docker services observed | Added `services/personal-dashboard/` candidate seed from historical evidence |
| `staging` | 192.168.0.52 / 111 | Unreachable because `toyota` is offline; no historical Docker containers observed | No service seed generated |
| `prod` | 192.168.0.53 / 112 | Unreachable because `toyota` is offline; no historical Docker containers observed | No service seed generated |

## Backup coverage deltas

- VMID 100 `critical`: still has an enabled weekly Proxmox backup job to `NAS`; Emperor import is already complete.
- VMID 101 `jellyfin`: stale backup job remains disabled; legacy CT is intentionally stopped and must not be deleted until reconciled.
- VMID 103 `NAS-OMV`: running, but scheduled `NAS` target backup remains disabled because it is self-referential. Needs an independent backup target.
- VMIDs 110/111/112: backup jobs are enabled, but current cluster state reports them as `unknown` because `toyota` is offline. First artifact/restore verification still pending.

## Service import deltas

### `personal-dashboard` on `dev`

Historical evidence from 2026-05-21 observed:

- `personal-dashboard-frontend-1` image `personal-dashboard-frontend`, port `4322:80`.
- `personal-dashboard-db-1` image `postgres:16-alpine`, port `5432:5432`.

Committed candidate artifacts:

- `services/personal-dashboard/README.md`
- `services/personal-dashboard/docker-compose.yml`
- `services/personal-dashboard/.env.example`
- `services/personal-dashboard/personal-dashboard.env.map.example`

These are intentionally marked historical/unverified because live `docker inspect` could not run while `toyota` is offline.

## Next safe steps

1. Bring `toyota` back online under a separate approved remediation plan if needed.
2. Refresh read-only Proxmox and SSH discovery for VMIDs 110/111/112.
3. Resolve image digests and exact mounts/env from `docker inspect` on `dev` before applying any personal-dashboard candidate.
4. Verify first backup artifacts for VMIDs 110/111/112 and add restore-test evidence.
5. Design independent VMID 103 backup target before re-enabling NAS VM backups.
