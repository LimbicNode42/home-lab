# Postgres service

Status: candidate IaC/CaC import seed from the live `postgres` container on `critical` (`192.168.0.50`), hosted by Proxmox node `emperor` (`192.168.0.6`).

This Postgres instance currently backs Vaultwarden and may be reused by future services. Treat it as shared critical infrastructure until a service ownership split is documented.

Live evidence captured 2026-05-22:

- Container: `postgres`
- Image tag observed: `bitnamilegacy/postgresql:17`
- Candidate pinned image: `bitnamilegacy/postgresql@sha256:42a8200d35971f931b869ef5252d996e137c6beb4b8f1b6d2181dc7d1b6f62e0`
- Restart policy: `unless-stopped`
- Published port: `5432:5432`
- Data mount: `/mnt/nas/services/postgres:/bitnami/postgresql`
- Certificate mount: `/mnt/nas/services/postgres/certs:/opt/bitnami/postgresql/certs`
- TLS enabled: yes
- TLS cert path: `/opt/bitnami/postgresql/certs/postgres.crt`
- TLS key path: `/opt/bitnami/postgresql/certs/postgres.key`

Secrets are not stored in Git. Required secret refs:

- Vaultwarden folder: `homelab`
- Item: `postgres/service`
- Fields: `password`, `postgres_password`

Important safety notes:

- Preserve `/mnt/nas/services/postgres/data` on any migration. Deleting or reinitializing it can break Vaultwarden access.
- The live directory contains private key material and a `.env` under `/mnt/nas/services/postgres/certs`; do not copy those into Git.
- The live data directory contains multiple large `core*` files. Do not delete them without explicit approval; document and plan cleanup separately.
- Port `5432` is published on all interfaces. Consider firewalling or binding to a narrower address as a separate approved hardening change, not as part of the import.
