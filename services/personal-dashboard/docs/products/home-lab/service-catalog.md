# Home Lab Service Catalog

Source: curated import from `personal-dev-site/src/components/HomeLab.js`, reconciled against the current home-lab repository where practical.

This catalog is a maintained dashboard documentation surface, not live discovery output. Items from the old public dev-site are marked `historical-import` or `needs-verification` unless the current home-lab repo already documents them. It deliberately omits LAN addresses, host filesystem paths, secret item names, database URLs, tokens, and old admin-stack endpoints.

## Status key

| Status | Meaning |
|---|---|
| `verified-current` | Present in current home-lab repo docs/config or current dashboard conventions. |
| `repo-documented` | Documented in repo history/current docs but not asserted as live runtime state here. |
| `historical-import` | Imported from the old public HomeLab page; useful context, not source of truth. |
| `needs-verification` | Plausible from old inventory but should be checked before operational reliance. |

## Hardware

| Category | Item | Source status | Current status | Notes |
|---|---|---|---|---|
| Networking | TP-Link AX5400 Router | historical-import | needs-verification | Public-site inventory only; do not treat as current router model until rediscovered. |
| Networking | 2x TP-Link TL-SG2008P switches | historical-import | needs-verification | Old Omada-oriented hardware note. |
| Storage | Samsung Evo Plus 128GB SDXC | historical-import | needs-verification | Likely Raspberry Pi boot/media inventory from the old page. |
| Storage | Seagate IronWolf 8TB HDD | historical-import | repo-documented | Current repo documents NAS/storage concerns, but this exact disk model should be checked before procurement or restore planning. |
| Storage | 8-bay HDD enclosure | historical-import | needs-verification | Treat as historical hardware inventory. |
| Compute | ASUS GR8 Mini PC | historical-import | needs-verification | Old compute inventory; not mapped to current Proxmox naming here. |
| Compute | Raspberry Pi 4 8GB fleet | historical-import | needs-verification | Old page claimed three units; current operational role not asserted. |
| Compute | Raspberry Pi 5 8GB | historical-import | needs-verification | Imported as historical inventory only. |
| Workstation/peripherals | Philips/HP monitors, Logitech keyboard/mouse, Audeze headset, Haworth chair | historical-import | historical-import | Kept for personal inventory context; not operational homelab state. |

## Platform and operating systems

| Category | Item | Source status | Current status | Notes |
|---|---|---|---|---|
| Virtualization | Proxmox VE | repo-documented | verified-current | Current repo documents a Proxmox cluster and related backup/quorum work. |
| Operating systems | Debian | repo-documented | repo-documented | Used in current repo docs for NAS/host contexts; exact versions can drift. |
| Operating systems | Alpine | repo-documented | repo-documented | Current repo documents an Alpine-based critical container context. |
| Storage OS | OpenMediaVault | repo-documented | repo-documented | Current repo documents OMV/NAS-style storage; exact release should be rediscovered before upgrades. |

## Network and edge services

| Category | Item | Source status | Current status | Notes |
|---|---|---|---|---|
| Network management | Omada SDN Controller | historical-import | needs-verification | Old page listed it; no live assertion here. |
| Edge/security | Cloudflare | repo-documented | verified-current | Current dashboard/homelab docs use Cloudflare Access / tunnel assumptions. |
| Edge/security | Cloudflare Zero Trust / Access | repo-documented | verified-current | Existing dashboard auth boundary remains reverse-proxy/Access oriented. |
| Reverse proxy | Traefik | repo-documented | verified-current | Current repo documents Traefik/proxy on the critical service host. |
| Tunnel | cloudflared | repo-documented | verified-current | Current repo documents Cloudflare tunnel service configuration. |
| Web server | Nginx | historical-import | needs-verification | Old page listed it; not asserted as current dashboard edge. |

## Data stores

| Category | Item | Source status | Current status | Notes |
|---|---|---|---|---|
| Relational database | Postgres | repo-documented | verified-current | Current dashboard uses Postgres-backed personal data where configured. |
| Document database | MongoDB | historical-import | historical-import | Old backend used Mongo; do not import that dependency without a separate reviewed design. |
| Cache | Redis | historical-import | needs-verification | Imported only as historical tool inventory. |
| Metrics database | InfluxDB | historical-import | needs-verification | Imported only as historical observability/storage inventory. |

## Deployment and admin tools

| Category | Item | Source status | Current status | Notes |
|---|---|---|---|---|
| Secrets | Vaultwarden | repo-documented | verified-current | Current homelab convention is Vaultwarden references, not committed secrets. |
| Secrets | Infisical | historical-import | historical-import | Old dependency only; do not reintroduce it for dashboard imports. |
| Registry | Distribution Registry | historical-import | needs-verification | Imported from old software list. |
| CI/CD | DroneCI and Docker runner | historical-import | needs-verification | Imported from old software list; deployment cards should verify current pipeline before use. |
| Container admin | Portainer and Portainer Agent | repo-documented | repo-documented | Repo contains Portainer service docs/config; live scope still belongs to deployment/verification cards. |
| Identity/admin | Keycloak | historical-import | historical-import | Old backoffice used a separate identity stack; the dashboard must keep existing reverse-proxy auth instead. |
| Dashboard/admin | Homarr | repo-documented | repo-documented | Repo includes Homarr service docs/config. |
| Dashboard/admin | IT Tools | historical-import | needs-verification | Imported from old dashboard/tools list. |

## Observability

| Category | Item | Source status | Current status | Notes |
|---|---|---|---|---|
| Metrics/dashboarding | Grafana OSS | repo-documented | repo-documented | Repo includes Grafana docs/config; this catalog does not assert current health. |
| Health reporting | Homelab health report | repo-documented | repo-documented | Current repo has discovery and health-report artifacts; use those for operational checks. |

## Media services

| Category | Item | Source status | Current status | Notes |
|---|---|---|---|---|
| Media server | Jellyfin | repo-documented | repo-documented | Current repo documents Jellyfin service state/history; avoid destructive remediation without explicit approval. |
| Requests | Jellyseerr | repo-documented | repo-documented | Repo includes service docs/config. |
| Media automation | Radarr | repo-documented | repo-documented | Repo includes service docs/config. |
| Media automation | Sonarr | repo-documented | repo-documented | Repo includes service docs/config. |
| Indexers | Prowlarr | repo-documented | repo-documented | Repo includes service docs/config. |
| Download clients | qBittorrent, NZBGet | historical-import | repo-documented | qBittorrent is repo-documented; NZBGet is imported from old page and needs verification. |

## Safety boundaries for this dashboard import

- No live host probing is part of this feature.
- No old React/Tailwind component was copied directly into the dashboard.
- No hardcoded local GraphQL, identity-provider, database, SMB, CDN, or filesystem-write assumptions are used.
- Dashboard/API responses should serve this catalog only through the approved committed Markdown docs path.
- If this catalog becomes an operational inventory later, move to a reviewed structured data model with explicit owners, criticality, RPO/RTO, backup state, and freshness metadata.
