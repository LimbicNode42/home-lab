# Dashboard Cloudflare public hostname

Status: **APPLIED** 2026-05-28 via Cloudflare API (kobold worker).

## What was applied

- Tunnel ingress rule added to `nippon-overpass` (38a5cb27-6f7b-4812-999f-1e151528df38) for `dashboard.wheeler-network.com` -> `http://192.168.0.50:80`
  - Tunnel config version bumped to 59.
- Proxied CNAME DNS record created: `dashboard.wheeler-network.com` -> `38a5cb27-6f7b-4812-999f-1e151528df38.cfargotunnel.com` (DNS record ID: 6fc97d9fb63391db64fd72ffde8e7aed)

## Route chain

```
https://dashboard.wheeler-network.com
  -> Cloudflare CDN (proxied CNAME)
  -> nippon-overpass tunnel -> Traefik on critical (192.168.0.50:80)
  -> Host: dashboard.wheeler-network.com -> personal-dashboard container (192.168.0.50:4322)
```

## Authentication

**Decision: No Cloudflare Access policy** (per Ben, 2026-05-28).

The app enforces authentication internally in reverse-proxy mode:
- `DASHBOARD_AUTH_MODE=reverse-proxy`
- `DASHBOARD_PROXY_USER_HEADER=cf-access-authenticated-user-email`
- `/api/*` returns 401 without the identity header
- `/healthz` is open

In production, Cloudflare strips untrusted client-supplied headers, so the 401 on API calls from outside is expected without an Access policy forwarding the identity.

**Note for future:** If a Cloudflare Access application is added later (to SSO-gate the app), Cloudflare will forward `cf-access-authenticated-user-email` and API endpoints will work for authenticated sessions.

## Vaultwarden secret refs used

- Cloudflare API token: `homelab/cloudflare/api` > `api_token`
- Account ID: `homelab/cloudflare/api` > `account_id`
- Zone ID: `homelab/cloudflare/api` > `zone_id`

No raw secrets stored in Git.

## Verified 2026-05-28

- `curl https://dashboard.wheeler-network.com/healthz` -> `{"status":"ok"}`
- API endpoint returns 401 without identity header (fail-closed, expected on public path without Access policy)
- Traefik LAN healthcheck: `curl -H 'Host: dashboard.wheeler-network.com' http://192.168.0.50/healthz` -> `{"status":"ok"}`

## Rollback

1. Delete tunnel ingress rule for `dashboard.wheeler-network.com` from `nippon-overpass` via Zero Trust dashboard or Cloudflare API.
2. Delete DNS record ID `6fc97d9fb63391db64fd72ffde8e7aed` from `wheeler-network.com` zone (or remove via Cloudflare dashboard).
3. Optionally: restore `/mnt/nas/services/traefik/dynamic-config.yaml` from `/mnt/nas/services/traefik/dynamic-config.yaml.bak-dashboard-20260527T135706Z`, restart `proxy` if needed.
4. Stop/remove dashboard container: `docker rm -f personal-dashboard`
5. Optionally remove `/mnt/nas/services/personal-dashboard` after inspection.
