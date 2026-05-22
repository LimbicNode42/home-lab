# Cloudflare Tunnel service

Status: candidate IaC/CaC import seed from the live `cloudflare` container on `critical` (`192.168.0.50`), hosted by Proxmox node `emperor` (`192.168.0.6`).

This service publishes `*.wheeler-network.com` routes from Cloudflare Zero Trust into the local Traefik origin. The current Vaultwarden route sends `vault.wheeler-network.com` to local origin `http://192.168.0.50:80`, so matching Traefik routers must bind to the `web` entrypoint.

Live evidence captured 2026-05-22:

- Container: `cloudflare`
- Image tag observed: `cloudflare/cloudflared:latest`
- Candidate pinned image: `cloudflare/cloudflared@sha256:6b599ca3e974349ead3286d178da61d291961182ec3fe9c505e1dd02c8ac31b0`
- Restart policy: `unless-stopped`
- Network: Docker default `bridge`
- Published ports: none
- Mounts: none
- Live command shape: `cloudflared --no-autoupdate tunnel --no-autoupdate run --token <redacted>`

Secrets are not stored in Git. Required secret refs:

- Vaultwarden folder: `homelab`
- Item: `cloudflare/tunnel-critical`
- Field: `tunnel_token`

Apply status:

Do not apply this compose file blindly. It is a candidate desired-state seed. Applying it would recreate the live Cloudflare tunnel container and can interrupt external access to services. Confirm the token exists in Vaultwarden and have local LAN access to Traefik before replacing the running container.
