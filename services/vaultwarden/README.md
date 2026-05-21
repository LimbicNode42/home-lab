# Vaultwarden

Vaultwarden is the selected runtime secrets backend for homelab secrets.

## Current access

- Local URL: `http://192.168.0.50:8084`
- Vault selection: Ben's personal Vaultwarden vault
- Folder for homelab material: `homelab`

## Repository role

This repository should store only non-secret references:

- folder name: `homelab`
- item names such as `postgres/admin` or `proxmox/hermes-api-token`
- field names such as `username`, `password`, `host`, `token_id`, `token_secret`
- `.env.example` files
- mapping files that point to items/fields

It must not store actual Vaultwarden passwords, API keys, session tokens, exports, or unencrypted `.env` files.

## Item naming

Because Bitwarden folders are flat, use the folder for broad grouping and item names for hierarchy:

```text
Folder: homelab
Item: postgres/admin
Item: postgres/keycloak
Item: proxmox/hermes-api-token
Item: cloudflare/tunnel-critical
Item: vaultwarden/admin
```

## Automation notes

Use the Bitwarden CLI (`bw`) configured against the local Vaultwarden URL:

```sh
bw config server http://192.168.0.50:8084
bw login
export BW_SESSION="$(bw unlock --raw)"
bw sync
```

Do not commit `BW_SESSION`, `BW_CLIENTID`, `BW_CLIENTSECRET`, `BW_PASSWORD`, or rendered secret files.

See also: `../../docs/secrets/vaultwarden-secrets-backend.md`.
