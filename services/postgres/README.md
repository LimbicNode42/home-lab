# Postgres service

Status: candidate IaC/CaC import seed from the live `postgres` container on `critical` (`192.168.0.50`), hosted by Proxmox node `emperor` (`192.168.0.6`).

This Postgres instance currently backs Vaultwarden and may be reused by future services. Treat it as shared critical infrastructure until a service ownership split is documented. The desired-state Docker Compose attaches it to the internal `critical-internal` network with the stable service alias `postgres` so app URLs do not depend on raw Docker bridge IPs.

Live evidence captured 2026-05-22, refreshed 2026-09-15:

- Container: `postgres`
- Image tag observed: `bitnamilegacy/postgresql:17`
- Candidate pinned image: `bitnamilegacy/postgresql@sha256:42a8200d35971f931b869ef5252d996e137c6beb4b8f1b6d2181dc7d1b6f62e0`
- Restart policy: `unless-stopped`
- Published port: `5432:5432`
- Stable Docker-local network: `critical-internal` with container alias `postgres`
- Data mount: `/srv/postgres:/bitnami/postgresql` (host-local storage on `critical`; moved off NAS-backed NFS after stale file-handle incidents)
- Certificate mount: `/srv/postgres/certs:/opt/bitnami/postgresql/certs`
- TLS enabled: yes
- TLS cert path: `/opt/bitnami/postgresql/certs/postgres.crt`
- TLS key path: `/opt/bitnami/postgresql/certs/postgres.key`

Secrets are not stored in Git. Required secret refs:

- Vaultwarden folder: `homelab`
- Item: `postgres/service`
- Fields: `password`, `postgres_password`

Important safety notes:

- Preserve `/srv/postgres/data` on any migration. Deleting or reinitializing it can break Vaultwarden access.
- `/mnt/nas/services/postgres/data` is historical migration source evidence, not the active live mount as of 2026-09-15. Do not delete it without a separate backup/retention decision.
- The live directory contains private key material and local rendered environment under `/srv/postgres/certs`; do not copy those into Git.
- The live data directory contains multiple large `core*` files. Do not delete them without explicit approval; document and plan cleanup separately.
- Port `5432` is published on all interfaces. Consider firewalling or binding to a narrower address as a separate approved hardening change, not as part of the import.


## 2026-09-15 degraded status investigation

Vaultwarden was reported degraded because the Home Dashboard intentionally mapped a passing `/alive` probe to `degraded` while the prior shared Postgres NAS/NFS stale file-handle root cause was unresolved. Read-only checks on `critical` found:

- `vaultwarden` container: running and Docker health `healthy`, `/alive` returning 200.
- Public URL: `https://vault.wheeler-network.com/api/config` returning 200 through Cloudflare.
- Traefik LAN route: `Host: vault.wheeler-network.com` over HTTP returning 200 to `/api/config`.
- Prior failure evidence: Vaultwarden logs from 2026-09-14 showed repeated Postgres errors `could not open file "global/pg_filenode.map": Stale file handle`.
- Current Postgres mount: Docker binds `/srv/postgres` into `/bitnami/postgresql`, not `/mnt/nas/services/postgres`; `pg_isready` reports accepting connections and Vaultwarden has idle DB sessions.

No Vaultwarden credential, master-password, user, or data migration was performed during this status cleanup.
