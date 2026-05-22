# Vaultwarden homelab item map

Status: initial non-secret import map. Values live in Ben's personal Vaultwarden vault under folder `homelab`. Git stores only folder, item, and field references.

## Canonical service items

| Purpose | Folder | Item | Fields | Notes |
|---|---|---|---|---|
| Vaultwarden service config | `homelab` | `vaultwarden/service` | `domain`, `signups_allowed`, `service_url`, `host`, `port` | Non-secret values may still be stored here to keep render flows consistent. |
| Vaultwarden database connection | `homelab` | `vaultwarden/database` | `database_url`, `host`, `port`, `database`, `username`, `password`, `sslmode` | `database_url` is secret-bearing because it includes credentials. |
| Vaultwarden admin UI token | `homelab` | `vaultwarden/admin` | `admin_token`, `service_url`, `scope`, `rotation_interval_days` | Only create/use if the admin UI is intentionally enabled. |
| Postgres CA certificate path | `homelab` | `postgres/ca` | `ca_cert_path` | Reference path only; do not commit cert private keys. |

## Render mapping

Use `services/vaultwarden/vaultwarden.env.map.example` to render a local `.env` file:

```sh
eval "$(scripts/secrets/bw-login-vaultwarden.sh)"
scripts/secrets/render-env-from-vaultwarden.sh services/vaultwarden/vaultwarden.env.map.example > services/vaultwarden/.env
chmod 0600 services/vaultwarden/.env
```

The rendered `.env` file is ignored by Git and must not be committed.

## Current import evidence

Read-only evidence captured on 2026-05-22:

- Local service URL: `http://192.168.0.50:8084`
- Public domain exposed by `/api/config`: `https://vault.wheeler-network.com`
- API config version: `2025.12.0`
- API config git hash: `e7e4b9a8`
- API config reports `disableUserRegistration=false`, so the candidate `.env.example` preserves `SIGNUPS_ALLOWED=true` until hardening is explicitly approved.
- Previous SSH inventory observed container `vaultwarden` on host `critical` / `192.168.0.50`, published as `0.0.0.0:8084->80/tcp`, healthy at the time of that snapshot.

Machine-readable import seed: `inventory/discovery/vaultwarden-import-2026-05-22.json`.

## Before applying the candidate compose file

Run a credentialed read-only check on `critical` and compare the live container to `services/vaultwarden/docker-compose.yml`:

```sh
ssh critical 'docker inspect vaultwarden' > /tmp/vaultwarden.inspect.json
```

Redact secret values before copying any derived data into Git. In particular, do not commit `DATABASE_URL`, `ADMIN_TOKEN`, SMTP passwords, YubiKey secrets, Duo secrets, or generated keys.

Open unknowns:

- Exact running image tag or digest.
- Exact secret-related env var names currently set.
- Whether `DATABASE_URL` uses `sslmode=disable` or `sslmode=verify-full`.
- Whether the Postgres CA cert mount is currently active.
- Whether admin UI is enabled.
- Whether user registration should be disabled as a separate security hardening change.
