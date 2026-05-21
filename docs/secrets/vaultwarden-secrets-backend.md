# Vaultwarden secrets backend plan

Status: preparation only. No live Vaultwarden changes have been made by Hermes.

## Existing observed state

- Vaultwarden is deployed in the homelab on `critical` / `192.168.0.50`.
- Discovery shows Docker container `vaultwarden` published at `192.168.0.50:8084 -> 80/tcp`.
- A read-only HTTP probe from the Hermes host returned `HTTP/1.1 200 OK` for `http://192.168.0.50:8084`.
- The public `critical` hostname did not resolve from this Hermes environment during the probe, so use the IP or add DNS later.
- The Bitwarden CLI package `@bitwarden/cli` is currently at version `2026.4.2` according to `npm view`.

## Goal

Use the already-deployed Vaultwarden instance as the homelab secret backend while keeping GitHub as the non-secret source of truth.

The repo should contain:

- IaC/CaC code
- service manifests
- variable names
- secret item naming conventions
- `.env.example` files
- runbooks
- import/migration plans

The repo should not contain:

- passwords
- API tokens
- private keys
- Bitwarden/Vaultwarden sessions
- unencrypted `.env` files
- Terraform state
- generated credentials

## Recommended model

Use Vaultwarden for live secret values and Git for secret references.

Example committed config:

```yaml
postgres:
  host: ${PG_HOST}
  user: ${PG_APP_USER}
  password: ${PG_APP_PASSWORD}
```

Example local runtime:

```sh
export PG_HOST="$(scripts/secrets/bw-get-field.sh homelab/postgres/app host)"
export PG_APP_USER="$(scripts/secrets/bw-get-field.sh homelab/postgres/app username)"
export PG_APP_PASSWORD="$(scripts/secrets/bw-get-field.sh homelab/postgres/app password)"
```

## Authentication options

### Interactive operator use

Use this when Ben is at a terminal:

```sh
bw config server http://192.168.0.50:8084
bw login
export BW_SESSION="$(bw unlock --raw)"
bw sync
```

### Automation / Hermes use

Prefer a dedicated low-privilege Vaultwarden/Bitwarden account or organization member for automation.

Environment variables should be stored only in local secret storage, not committed:

```sh
BW_CLIENTID=...
BW_CLIENTSECRET=...
BW_PASSWORD=...
BW_SERVER=http://192.168.0.50:8084
```

Login pattern:

```sh
bw config server "$BW_SERVER"
bw login --apikey
export BW_SESSION="$(bw unlock --passwordenv BW_PASSWORD --raw)"
bw sync --session "$BW_SESSION"
```

Notes:

- `BW_CLIENTID` and `BW_CLIENTSECRET` authenticate the account/API key.
- The vault still needs to be unlocked with the account master password or equivalent configured unlock method.
- Do not pass master passwords as command-line arguments; use `--passwordenv`.
- Treat `BW_SESSION` as a secret. Do not write it into repo files or logs.

## Vault structure recommendation

Use folders or organization collections with stable names.

Suggested folders/collections:

```text
homelab/
  infrastructure/
  proxmox/
  nas/
  network/
  postgres/
  redis/
  keycloak/
  vaultwarden/
  traefik/
  cloudflare/
  apps/
    jellyfin/
    immich/
    personal-dashboard/
  hermes/
```

Suggested item naming convention:

```text
homelab/<service>/<purpose>
```

Examples:

```text
homelab/postgres/admin
homelab/postgres/keycloak
homelab/postgres/infisical
homelab/proxmox/hermes-api-token
homelab/cloudflare/tunnel-critical
homelab/jellyfin/admin
homelab/hermes/github
```

## Item field convention

Prefer standard Bitwarden login fields where they fit:

- `username`
- `password`
- `uri`
- `notes`

Use custom fields for structured values:

- `host`
- `port`
- `database`
- `token_id`
- `token_secret`
- `api_url`
- `service_url`
- `ca_cert_path`
- `scope`
- `owner`
- `rotation_interval_days`

Example item: `homelab/proxmox/hermes-api-token`

```text
username: root@pam!hermes
password: <token secret>
custom fields:
  api_url = https://192.168.0.6:8006
  token_id = root@pam!hermes
  token_secret = <same as password, if compatibility is useful>
  scope = Proxmox read/write API token for Hermes-approved operations
```

## Secret reference convention in Git

Use names, not values.

Examples:

```env
POSTGRES_HOST_BW_ITEM=homelab/postgres/admin
POSTGRES_HOST_BW_FIELD=host
POSTGRES_PASSWORD_BW_ITEM=homelab/postgres/admin
POSTGRES_PASSWORD_BW_FIELD=password
```

or in service docs:

```md
Secrets:
- `PG_HOST`: Vaultwarden item `homelab/postgres/admin`, field `host`
- `PG_KEYCLOAK_PASS`: Vaultwarden item `homelab/postgres/keycloak`, field `password`
```

## IaC/CaC integration patterns

### Ansible

Recommended for host config:

- Store secret names in vars.
- Retrieve values at runtime with a lookup wrapper or pre-rendered local env file.
- Avoid writing secret values to task output: use `no_log: true` on tasks that handle secrets.

Example pattern:

```yaml
vars:
  postgres_admin_item: homelab/postgres/admin

tasks:
  - name: Render app env file
    ansible.builtin.template:
      src: app.env.j2
      dest: /srv/app/.env
      mode: '0600'
    no_log: true
```

### Docker Compose

Commit `.env.example`; keep real `.env` untracked.

```sh
scripts/secrets/render-env-from-vaultwarden.sh examples/service.env.map > .env
chmod 0600 .env
docker compose up -d
```

### Terraform/OpenTofu

Be careful: provider data sources and variables can leak into state.

Recommended default:

- Keep secret values out of Terraform state where possible.
- Use Terraform for non-secret infrastructure shape.
- Use Ansible/Compose/runtime scripts to inject secrets.
- If Terraform must handle a secret, mark variables `sensitive = true`, keep state encrypted/private, and document the state risk.

### Hermes

Hermes operational secrets should remain in `/root/.hermes/.env` unless/until a safe Vaultwarden bootstrap flow is fully tested.

Do not move Hermes gateway/provider credentials to Vaultwarden in a way that could prevent Hermes from starting or communicating.

## Migration workflow from secret-littered local repo

For Ben's local `home-lab` repo copy on `192.168.0.100`:

1. Make a private backup before editing.
2. Run secret scanning.
3. Classify each secret:
   - keep only in local `.env`
   - move to Vaultwarden
   - convert to SOPS/Ansible Vault later
   - rotate because it was exposed in Git history
4. For each secret moved to Vaultwarden, create/update a mapping file or service doc with item/field references only.
5. Replace committed secret values with env vars or placeholders.
6. Add `.env.example` files.
7. Re-run secret scanning before commit.
8. If secrets were committed historically, assume they are compromised and rotate them after sanitization.

## Safety rules

- Never delete a Vaultwarden item as part of cleanup unless Ben explicitly approves the exact item deletion.
- Prefer creating new items and marking old references deprecated over destructive secret deletion.
- Never echo secret values in logs, Discord, docs, or commit messages.
- Avoid `set -x` in scripts that touch secrets.
- Use `umask 077` before rendering secret-bearing files.
- Treat `BW_SESSION` as a secret.
- When in doubt, output item names and field names, not values.

## Open questions for Ben

- Should Hermes use a dedicated Vaultwarden account, an organization collection, or Ben's own account?
- What is the canonical Vaultwarden URL: local IP, internal DNS name, or HTTPS reverse-proxy hostname?
- Should service secrets be grouped by folder or organization collection?
- Do you want Vaultwarden to replace Infisical entirely, or coexist during migration?
- Do you want generated credentials rotated as they are moved into Vaultwarden?
