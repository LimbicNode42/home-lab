# Vaultwarden

Vaultwarden is the selected runtime secrets backend for homelab secrets.

Status: initial IaC/CaC import seed is committed as candidate desired state only. No live Vaultwarden changes should be made from these files until the running container on `critical` has been compared with a fresh `docker inspect`.

## Current observed access

- Local URL: `http://192.168.0.50:8084`
- Public domain from `/api/config`: `https://vault.wheeler-network.com`
- Host: `critical` / `192.168.0.50`
- Previous discovery and credentialed read-only inspect: Docker container `vaultwarden`, image `vaultwarden/server:latest`, user `1001:1003`, restart policy `unless-stopped`, published as `0.0.0.0:8084->80/tcp`, default bridge network, `/mnt/nas/services/vaultwarden/data` mounted at `/data`, healthy at inspection time.
- Vault selection: Ben's personal Vaultwarden vault
- Folder for homelab material: `homelab`

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Candidate desired state imported from public probes, previous SSH inventory, and archived bootstrap script. |
| `.env.example` | Non-secret env template. Copy/render to `.env` locally; real `.env` is ignored. |
| `vaultwarden.env.map.example` | Vaultwarden folder/item/field references for rendering `.env`. |
| `../../docs/secrets/vaultwarden-item-map.md` | Canonical item and field map for this service. |
| `../../inventory/discovery/vaultwarden-import-2026-05-22.json` | Machine-readable import seed and follow-up summary. |
| `../../inventory/discovery/vaultwarden-live-inspect-2026-05-22.json` | Sanitized credentialed read-only `docker inspect` evidence. |

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
docker compose -f services/vaultwarden/docker-compose.yml --env-file services/vaultwarden/.env.example config
```

The candidate compose file has been aligned to sanitized `docker inspect` evidence for image, user, restart policy, port binding, data mount, network mode, and healthcheck. Applying it would still recreate/restart the critical secrets service and requires a separate explicit approval plus rollback plan.

## Remaining decisions

- Whether user registration should be disabled as a separate hardening task.
- Whether to pin `vaultwarden/server` by version or digest instead of tracking `latest`.
- Whether to migrate the running raw container into compose-managed lifecycle.

See also: `../../docs/secrets/vaultwarden-secrets-backend.md`.
