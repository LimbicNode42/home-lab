# Personal Dashboard

Status: historical candidate desired-state seed; live host currently unreachable

Source evidence:
- Historical SSH inventory: `inventory/discovery/ssh-host-inventory-raw.json` from 2026-05-21 observed Docker containers on `dev` (`192.168.0.51`, VMID 110).
- Current read-only discovery: `inventory/discovery/host-readonly-discovery-20260525T111814Z.json` recorded `dev`, `staging`, `prod`, and `toyota` as unreachable / no route from the current Hermes vantage point.
- Current Proxmox evidence: `inventory/discovery/proxmox-resources-backups-20260525T111842Z.json` reported `toyota` offline and VMIDs 110/111/112 as `unknown`.

Observed historical containers:
- `personal-dashboard-frontend-1` using image `personal-dashboard-frontend`, published `0.0.0.0:4322->80/tcp`.
- `personal-dashboard-db-1` using image `postgres:16-alpine`, published `0.0.0.0:5432->5432/tcp`.

Safety notes:
- Candidate compose only; not applied by Hermes.
- Do not apply until `toyota` and VMID 110 are reachable and a credentialed read-only `docker inspect` confirms exact image IDs, volumes, networks, environment names, and app configuration.
- The frontend image appears to be a local image name, not a registry-pinned digest. Preserve it as historical intent only until the build source and digest are identified.
- The database service needs an application-consistent dump/restore plan in addition to Proxmox VMID 110 backup coverage.
- Publicly binding Postgres to `0.0.0.0:5432` on the LXC is security-sensitive; review exposure before applying or hardening.

Secret handling:
- No secret values were available in committed evidence.
- Candidate environment variables use placeholders and Vaultwarden references only.
- Store rendered values in Ben's Vaultwarden folder `homelab`, item `personal-dashboard/database`.

Backup notes:
- VMID 110 has an enabled Proxmox vzdump job to storage `NAS`, but current status is unknown because host `toyota` is offline.
- Latest committed matrix still lists first backup artifact pending; verify artifacts after `toyota` returns.
- Add app-level database dump backup before treating the service as fully protected.
