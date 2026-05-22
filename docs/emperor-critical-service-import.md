# Emperor / critical service import

Status: non-secret IaC/CaC import snapshot for remaining Docker services on `critical`, the LXC hosted on Proxmox node `emperor`.

Already promoted before this pass:

- `services/traefik/`
- `services/vaultwarden/`

Promoted in this pass as candidate desired state:

- `services/cloudflare-tunnel/` for the live `cloudflare` / Cloudflare Tunnel container.
- `services/postgres/` for the live shared Postgres container backing Vaultwarden.

Machine-readable evidence:

- `inventory/discovery/emperor-critical-services-import-2026-05-22.json`

Read-only live discovery also observed additional NAS service data directories that likely need future import passes:

- `adguard`
- `qbittorrent`
- `radarr`
- `docmost`
- `repo`
- `grafana`
- `omada`
- `filescope`
- `jellyseerr`
- `prowlarr`
- `portainer`
- `shared`
- `homarr`
- `jellyfin`
- `sonarr`

Those directories were inventoried by name and metadata only. Their app configs may contain secrets, API keys, private keys, session keys, or database files, so they should be imported one service at a time with per-service redaction and Vaultwarden item mapping.

No live mutations were performed by this import pass.
