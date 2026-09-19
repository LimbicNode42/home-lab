# Mem0

Self-hosted Mem0 memory service for Hermes and the Kanban/agent profiles. Runs on `tori` (192.168.0.20) with local primary storage and NAS-backed backups.

Status: **live** — deployed 2026-09-19, running healthy on tori.

## Architecture

- **API server**: FastAPI + mem0ai 2.1.0, built from `mem0ai/mem0` server source (pinned).
- **Vector store / DB**: `pgvector/pgvector:pg17` (Postgres 17 + pgvector).
- **LLM**: OpenRouter (`openai/gpt-4o-mini`) — mem0's OpenAI LLM auto-routes to OpenRouter when `OPENROUTER_API_KEY` is set.
- **Embedder**: OpenAI `text-embedding-3-small`.
- **Auth**: enabled (JWT + per-user API keys + legacy `ADMIN_API_KEY`).

## Access

- API: `http://127.0.0.1:8888` (localhost-only, no WAN/LAN exposure)
- OpenAPI docs: `http://127.0.0.1:8888/docs`
- Postgres: internal Docker network only (no host port published)

## Data paths (local primary storage)

| Path | Purpose |
|---|---|
| `/opt/mem0/data/postgres` | Postgres data dir (memories + mem0_app auth/keys) |
| `/opt/mem0/data/history` | mem0 history SQLite DB |
| `/opt/mem0/.env` | Rendered secrets (root-only, mode 0600, never committed) |
| `/opt/mem0/backups/logs` | Backup job logs |

## Ports

| Port | Binding | Service |
|---|---|---|
| 8888 | 127.0.0.1 only | mem0 API |
| 5432 | internal only | Postgres |

## Auth model

- Dashboard/admin login: JWT (admin user `admin@wheeler-network.com`).
- Programmatic access: `X-API-Key` header (per-user API keys) or legacy `ADMIN_API_KEY`.
- `AUTH_DISABLED=false` (auth is enforced).

## Dependencies

- OpenRouter API key (LLM) — from Hermes `.env`.
- OpenAI API key (embedder) — from Vaultwarden item `OPENAI_API_KEY`.
- Postgres password, JWT secret, admin API key, admin password, API key — Vaultwarden item `mem0/server` (folder `Homelab`).

## Secrets (Vaultwarden)

Folder: `Homelab`, item `mem0/server`. Fields:

| Field | Purpose |
|---|---|
| `postgres_password` | Postgres superuser password |
| `jwt_secret` | JWT signing secret |
| `admin_api_key` | Legacy admin API key |
| `admin_email` | Admin login email |
| `admin_password` | Admin login password |
| `api_key` | Per-user API key for Hermes/agents |
| `api_url` | `http://127.0.0.1:8888` |
| `dashboard_url` | `http://127.0.0.1:3000` (dashboard not deployed) |

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Desired state (localhost-only, apparmor=unconfined workaround). |
| `Dockerfile` | Production build (pinned mem0ai 2.1.0, libpq5). |
| `.env.example` | Non-secret env template. |
| `mem0.env.map.example` | Vaultwarden folder/item/field references for rendering `.env`. |
| `../../scripts/services/mem0-backup.sh` | Backup script (pg_dumpall + history -> NAS). |
| `../../scripts/services/mem0-restore-test.sh` | Non-destructive restore verification. |

## Deployment notes

- The Proxmox host's default AppArmor profile blocks AF_UNIX socket creation and `socketpair()`, which breaks both Postgres and uvicorn. Both containers run with `security_opt: apparmor=unconfined` (matching the existing `metamcp-pg` container).
- The `mem0_app` database and alembic migrations must be applied once (the dev compose runs `alembic upgrade head`; the production Dockerfile does not). See runbook.

## Backup

- Script: `scripts/services/mem0-backup.sh` (application-consistent `pg_dumpall` + history SQLite).
- Schedule: systemd timer `mem0-backup.timer`, daily 03:30, persistent.
- Target: `/mnt/pve/NAS/backups/mem0/<timestamp>/`.
- Retention: 14 days (configurable via `RETENTION_DAYS`).
- Restore: `scripts/services/mem0-restore-test.sh` (non-destructive, throwaway container).

## Hermes integration

See `../../docs/memory/mem0-hermes-integration.md` for how default and worker profiles point at this instance, required env vars, rollout order, and rollback.
