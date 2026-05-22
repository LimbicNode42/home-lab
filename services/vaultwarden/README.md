# Vaultwarden

Vaultwarden is the selected runtime secrets backend for homelab secrets.

Status: initial IaC/CaC import seed is committed as candidate desired state only. No live Vaultwarden changes should be made from these files until the running container on `critical` has been compared with a fresh `docker inspect`.

## Current observed access

- Local URL: `http://192.168.0.50:8084`
- Public domain from `/api/config`: `https://vault.wheeler-network.com`
- Host: `critical` / `192.168.0.50`
- Previous discovery: Docker container `vaultwarden`, published as `0.0.0.0:8084->80/tcp`, healthy at snapshot time
- Vault selection: Ben's personal Vaultwarden vault
- Folder for homelab material: `homelab`

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Candidate desired state imported from public probes, previous SSH inventory, and archived bootstrap script. |
| `.env.example` | Non-secret env template. Copy/render to `.env` locally; real `.env` is ignored. |
| `vaultwarden.env.map.example` | Vaultwarden folder/item/field references for rendering `.env`. |
| `../../docs/secrets/vaultwarden-item-map.md` | Canonical item and field map for this service. |
| `../../inventory/discovery/vaultwarden-import-2026-05-22.json` | Machine-readable import evidence and open unknowns. |

## Repository role

This repository should store only non-secret references:

- folder name: `homelab`
- item names such as `vaultwarden/database` or `proxmox/hermes-api-token`
- field names such as `username`, `password`, `database_url`, `token_id`, `token_secret`
- `.env.example` files
- mapping files that point to items/fields

It must not store actual Vaultwarden passwords, API keys, session tokens, exports, unencrypted `.env` files, or Terraform state.

## Item naming

Because Bitwarden/Vaultwarden folders are flat, use the folder for broad grouping and item names for hierarchy:

```text
Folder: homelab
Item: vaultwarden/service
Item: vaultwarden/database
Item: vaultwarden/admin
Item: postgres/admin
Item: proxmox/hermes-api-token
Item: cloudflare/tunnel-critical
```

## Render local environment

```sh
eval "$(scripts/secrets/bw-login-vaultwarden.sh)"
scripts/secrets/render-env-from-vaultwarden.sh services/vaultwarden/vaultwarden.env.map.example > services/vaultwarden/.env
chmod 0600 services/vaultwarden/.env
```

Do not commit `BW_SESSION`, `BW_CLIENTID`, `BW_CLIENTSECRET`, `BW_PASSWORD`, rendered `.env`, or copied Vaultwarden exports.

## Candidate compose usage

Read-only validation first:

```sh
docker compose -f services/vaultwarden/docker-compose.yml config
```

Before any live apply, compare against the current container on `critical`:

```sh
ssh critical 'docker inspect vaultwarden' > /tmp/vaultwarden.inspect.json
```

Redact secrets before copying any derived information into Git. Applying this compose file would be a live mutation and needs explicit approval.

## Known open questions

- Exact running image tag/digest.
- Whether live `DATABASE_URL` uses `sslmode=disable` or `sslmode=verify-full`.
- Whether the Postgres CA cert mount is active.
- Whether the admin UI token is enabled.
- Whether signups should be disabled as a separate approved hardening task.

See also: `../../docs/secrets/vaultwarden-secrets-backend.md`.
