# Dashboard Cloudflare public hostname plan

Status: plan only. Do not apply without Ben's approval and Cloudflare Zero Trust/API access.

## Target

- Public hostname: `dashboard.wheeler-network.com`
- Existing tunnel/container: `cloudflare` on `critical` (`192.168.0.50`)
- Origin service for the public hostname: `http://192.168.0.50:80`
- Traefik router expected at origin: ``Host(`dashboard.wheeler-network.com`)`` on entrypoint `web`
- Backend behind Traefik: `http://192.168.0.50:4322`

This mirrors the existing Vaultwarden/Traefik pattern where Cloudflare Tunnel points to local Traefik on port 80 and Traefik selects the backend by Host header.

## Authentication requirement

Protect `dashboard.wheeler-network.com` with Cloudflare Access before exposing it beyond the LAN. The dashboard app's deployment candidate expects Cloudflare Access to forward this identity header:

- `cf-access-authenticated-user-email`

The app should run with:

```env
DASHBOARD_AUTH_MODE=reverse-proxy
DASHBOARD_PROXY_USER_HEADER=cf-access-authenticated-user-email
```

Without Cloudflare Access or another trusted reverse-proxy auth layer, `/api/*` intentionally returns `401` because no trusted identity header is present.

## Manual Zero Trust dashboard steps

1. Open Cloudflare Zero Trust for the `wheeler-network.com` account.
2. Add a public hostname to the existing critical tunnel:
   - Subdomain: `dashboard`
   - Domain: `wheeler-network.com`
   - Service type: `HTTP`
   - URL: `192.168.0.50:80`
3. Create an Access application for `dashboard.wheeler-network.com`.
4. Add the allowed household/user policy Ben chooses.
5. Confirm Access forwards an identity header compatible with `cf-access-authenticated-user-email`.
6. Save, then verify DNS resolves to Cloudflare and the app requires authentication.

## Automation prerequisites

If this is automated via API instead of the dashboard, use Vaultwarden refs only:

- Vaultwarden folder: `homelab`
- Item: `cloudflare/api`
- Fields: `api_token`, `zone_id`, `account_id`

The API token should be scoped narrowly to the target account/zone and Zero Trust/Tunnel/DNS operations required for this hostname. Do not put API values in Git, command transcripts, or comments.

## Verification after apply

```bash
# DNS should resolve to Cloudflare after the public hostname/DNS entry exists.
dig +short dashboard.wheeler-network.com

# Origin path should be healthy from the LAN after dashboard container + Traefik route exist.
curl -fsS -H 'Host: dashboard.wheeler-network.com' http://192.168.0.50/healthz

# API should fail closed without the Access identity header at the origin.
curl -i -H 'Host: dashboard.wheeler-network.com' http://192.168.0.50/api/config/public

# Origin API should work with the configured identity header.
curl -fsS   -H 'Host: dashboard.wheeler-network.com'   -H 'cf-access-authenticated-user-email: ben@example.invalid'   http://192.168.0.50/api/config/public
```

Public verification should be done from a browser or curl session that can complete Cloudflare Access login. Do not bypass Access for the public route.

## Rollback

1. Disable/delete the Cloudflare public hostname `dashboard.wheeler-network.com` from the existing tunnel.
2. Disable/delete the Cloudflare Access application/policy for that hostname if it was created only for the dashboard.
3. Revert/remove the Traefik `dashboard` router/service from `/mnt/nas/services/traefik/dynamic-config.yaml`.
4. Stop only the dashboard container after traffic is no longer routed to it.
