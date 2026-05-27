# Vaultwarden homelab item map

Status: initial non-secret import map. Values live in Ben's personal Vaultwarden vault under folder `homelab`. Git stores only folder, item, and field references.

## Canonical service items

| Purpose | Folder | Item | Fields | Notes |
|---|---|---|---|---|
| Vaultwarden service config | `homelab` | `vaultwarden/service` | `domain`, `signups_allowed`, `service_url`, `host`, `port` | Non-secret values may still be stored here to keep render flows consistent. |
| Vaultwarden database connection | `homelab` | `vaultwarden/database` | `database_url`, `host`, `port`, `database`, `username`, `password`, `sslmode` | `database_url` is secret-bearing because it includes credentials. |
| Vaultwarden admin UI token | `homelab` | `vaultwarden/admin` | `admin_token`, `service_url`, `scope`, `rotation_interval_days` | Only create/use if the admin UI is intentionally enabled. |
| Postgres CA certificate path | `homelab` | `postgres/ca` | `ca_cert_path` | Reference path only; do not commit cert private keys. |
| Shared Postgres service credentials | `homelab` | `postgres/service` | `password`, `postgres_password`, `host`, `port`, `tls_enabled`, `tls_cert_path`, `tls_key_path` | Values render to `services/postgres/.env`; `tls_key_path` is a path only, not private-key content. |
| Cloudflare Tunnel token for critical | `homelab` | `cloudflare/tunnel-critical` | `tunnel_token`, `hostname_scope`, `local_origin` | Token used by the `cloudflare` container on critical; never commit the literal token or Docker command containing it. |
| Cloudflare API automation | `homelab` | `cloudflare/api` | `api_token`, `zone_id`, `account_id` | Only needed if DNS/Zero Trust public-hostname changes are automated instead of applied manually in Cloudflare. |
| Personal Dashboard app auth | `homelab` | `personal-dashboard/auth` | `shared-password`, `session-secret` | Only create if Ben chooses app-level auth instead of Cloudflare Access/reverse-proxy auth. |
| Docmost app secret | `homelab` | `docmost/app` | `app_secret` | Used by inactive Docmost candidate; value rendered to `APP_SECRET`. |
| Docmost database URL | `homelab` | `docmost/database` | `database_url` | Credential-bearing Postgres URL; never commit rendered value. |
| Homarr encryption key | `homelab` | `homarr/app` | `secret_encryption_key` | Used by inactive Homarr candidate; generated/restored outside Git. |
| Private registry HTTP secret | `homelab` | `repo/registry` | `http_secret` | Used by inactive Docker Registry candidate as `REGISTRY_HTTP_SECRET`. |
| Private registry htpasswd username | `homelab` | `repo/registry` | `htpasswd_username` | Used to render `/mnt/nas/services/repo/config/htpasswd` outside Git. |
| Private registry htpasswd password | `homelab` | `repo/registry` | `htpasswd_password` | Used to render `/mnt/nas/services/repo/config/htpasswd` outside Git. |
| Personal Dashboard database | `homelab` | `personal-dashboard/database` | `database`, `username`, `password`, `host`, `port` | Used by historical/unverified personal-dashboard candidate on `dev`; render values outside Git. |

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
- API config originally reported `disableUserRegistration=false`; approved migration target sets `SIGNUPS_ALLOWED=false` to disable new registration.
- Previous discovery and credentialed read-only inspect observed container `vaultwarden` on host `critical` / `192.168.0.50`, published as `0.0.0.0:8084->80/tcp`, healthy at the time of inspection.
- Approved migration target: compose-managed container with `SIGNUPS_ALLOWED=false` and image pinned to the running container digest `vaultwarden/server@sha256:9a8eec71f4a52411cc43edc7a50f33e9b6f62b5baca0dd95f0c6e7fd60f1a341`.
- Live application is pending a controlled apply window. Apply script: `scripts/services/apply-vaultwarden-compose.sh`.

Machine-readable import seed: `inventory/discovery/vaultwarden-import-2026-05-22.json`.

## Before applying the candidate compose file

Run a credentialed read-only check on `critical` and compare the live container to `services/vaultwarden/docker-compose.yml`:

```sh
ssh critical 'docker inspect vaultwarden' > /tmp/vaultwarden.inspect.json
```

Redact secret values before copying any derived data into Git. In particular, do not commit `DATABASE_URL`, `ADMIN_TOKEN`, SMTP passwords, YubiKey secrets, Duo secrets, or generated keys.

Open unknowns after credentialed read-only inspect:

- Whether the container was originally launched by raw `docker run`, compose, or another supervisor; `docker inspect` shows no compose labels.
- Whether user registration should be disabled as a separate approved hardening change.
- Whether to move from `vaultwarden/server:latest` to a pinned tag or digest.
- Whether to migrate the service to compose management; this would recreate/restart the critical secrets service and needs an explicit rollback plan.
