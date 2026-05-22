# Emperor remaining services import - 2026-05-23

This pass continued the import of emperor/critical home-network services into Git-backed IaC/CaC. It was read-only against live infrastructure. No containers were restarted, recreated, or modified.

Live discovery result:
- Host: `critical` LXC at `192.168.0.50`
- Running Docker containers observed: cloudflare, postgres, proxy, vaultwarden
- Open service ports observed from the agent: `80`, `443`, `5432`, `8080`, `8084`
- NAS service directories observed: adguard, docker, docmost, filescope, grafana, homarr, jellyfin, jellyseerr, omada, portainer, postgres, prowlarr, qbittorrent, radarr, repo, shared, sonarr, traefik, vaultwarden

The only containers currently running on `critical` are the already-imported critical set: Traefik/proxy, Vaultwarden, Cloudflare Tunnel, and shared Postgres. The rest of this pass therefore imports archived/NAS-backed service candidates as inactive/unverified desired-state seeds, not live-applied state.

Generated candidate service seeds:
- `services/adguard/`
- `services/docmost/`
- `services/grafana/`
- `services/homarr/`
- `services/jellyfin/`
- `services/jellyseerr/`
- `services/portainer/`
- `services/prowlarr/`
- `services/qbittorrent/`
- `services/radarr/`
- `services/repo/`
- `services/sonarr/`

Metadata-only placeholders:
- `services/docker/`
- `services/filescope/`
- `services/omada/`
- `services/shared/`

High-risk apply notes:
- AdGuard changes can affect DNS/DHCP for the home network.
- Portainer and Homarr mount `/var/run/docker.sock`, giving broad Docker host control.
- Jellyfin candidate uses host networking and privileged mode and appears tied to a separate LXC at `192.168.0.249` in the archive.
- Docmost depends on Redis at `192.168.0.50:6379`, but no Redis container was running during discovery.
- Repo/private-registry auth must be rendered from Vaultwarden; the archived literal htpasswd-generation command must not be reused.

Before applying any candidate:
1. Confirm whether the service should run on `critical` or a separate LXC.
2. Pin images to digests.
3. Render secrets from Vaultwarden into local `.env`/config files with mode `0600`.
4. Confirm port conflicts and reverse-proxy routes.
5. Back up persistent NAS paths before any migration/recreate.
