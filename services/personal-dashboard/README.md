# Personal Dashboard

Private homelab dashboard MVP for household links and lightweight service status.

Status: implementation/deployment candidate only. Do not deploy, sync Traefik config, restart services, or create Cloudflare hostnames until Ben approves the exact apply commands.

## What is included

- Small dependency-free Node.js full-stack app.
- Static dashboard UI served from `public/`.
- JSON APIs:
  - `GET /healthz` unauthenticated container/proxy health endpoint; intentionally returns only `{ "status": "ok" }`.
  - `GET /api/config/public` authenticated public dashboard config, with server-side probe targets stripped.
  - `GET /api/status` authenticated status probe results, using an in-memory TTL cache.
- Reverse-proxy authentication gate by default.
- Dockerfile and Compose service for local/homelab container runs.
- Node built-in test suite.

## Source evidence / deployment constraints

Discovery identified `/root/work/home-lab/services/personal-dashboard` as the Git-backed desired-state location. The safest current remote-access target is the `critical` LXC (`192.168.0.50`), which already hosts Traefik, cloudflared, Vaultwarden, and shared Postgres. This directory prepares desired-state only; it does not modify live infrastructure.

Historical `dev`/Toyota evidence is not treated as current live state. The old Postgres-backed seed has been replaced for MVP with a no-database app per the parent spec.

## Proposed live route

- Public hostname: `dashboard.wheeler-network.com`
- Cloudflare Tunnel public hostname origin: `http://192.168.0.50:80`
- Traefik entrypoint/router: `web`, ``Host(`dashboard.wheeler-network.com`)``
- Traefik backend service: `http://172.17.0.1:4322` from the `proxy` container to the Docker host gateway
- Dashboard container: `personal-dashboard`, listening on container port `4322`
- Compose host publish: `${DASHBOARD_PUBLISHED_IP:-172.17.0.1}:4322:4322`
- Auth expectation: Cloudflare Access protects the public hostname and forwards `cf-access-authenticated-user-email`; the app requires that header for `/api/*`.

The direct LAN route to `192.168.0.50:4322` must not be published. The app trusts Cloudflare Access identity headers, so direct LAN clients must not be able to reach the API and forge `cf-access-*` headers. The Traefik dashboard router also limits source IPs to Docker private ranges so LAN clients cannot bypass Cloudflare Access by sending Host-header requests to Traefik directly. If Traefik and this app are later moved to a user-defined Docker network, prefer an un-published container port and route by service DNS instead.

## Auth model

Default deployment candidate: `DASHBOARD_AUTH_MODE=reverse-proxy` with `DASHBOARD_PROXY_USER_HEADER=cf-access-authenticated-user-email`.

In reverse-proxy mode the app requires a non-empty identity header before serving `/api/*`. `DASHBOARD_AUTH_MODE=disabled` exists for local development and tests only. In `NODE_ENV=production`, disabled auth is refused unless `DASHBOARD_ALLOW_DISABLED_AUTH=true` is explicitly set. That flag is a foot-gun with a label, not a recommendation.

Ben decisions still required before public exposure:

- Confirm Cloudflare Access policy/users/groups for `dashboard.wheeler-network.com`.
- Confirm canonical dashboard URL/hostname.
- Confirm which services/links are safe for authenticated household users.
- Confirm whether status checks should target internal backend URLs or public route URLs server-side.

## Config

Copy the example public config and edit it for the target environment:

```bash
cp config/dashboard.public.example.json config/dashboard.public.json
```

Config shape:

```json
{
  "title": "Home Dashboard",
  "sections": [
    {
      "title": "Core services",
      "links": [
        { "label": "Vaultwarden", "href": "https://vault.wheeler-network.com" }
      ]
    }
  ],
  "statusChecks": [
    {
      "id": "vaultwarden",
      "label": "Vaultwarden",
      "targetUrl": "http://192.168.0.50:8084/alive",
      "displayUrl": "https://vault.wheeler-network.com"
    }
  ]
}
```

`targetUrl` is used only server-side and is never returned by `/api/config/public` or `/api/status`. Keep internal topology in config, not in the browser bundle.

Environment variables:

| Name | Default | Notes |
| --- | --- | --- |
| `PORT` | `4322` | HTTP listen port. |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `DASHBOARD_PUBLISHED_IP` | `172.17.0.1` in `.env.example` | Host IP used by Compose publish for the critical deployment candidate. Keep this on the Docker bridge gateway unless the auth model changes. |
| `DASHBOARD_CONFIG_FILE` | built-in defaults | Path to JSON config file. Compose uses `/app/config/dashboard.public.json`. |
| `DASHBOARD_AUTH_MODE` | `reverse-proxy` | `reverse-proxy` or local-dev `disabled`. |
| `DASHBOARD_PROXY_USER_HEADER` | `cf-access-authenticated-user-email` in `.env.example` | Header trusted from Cloudflare Access or another reverse-proxy auth layer. |
| `DASHBOARD_ALLOW_DISABLED_AUTH` | unset | Must be `true` to allow disabled auth in production. Avoid this outside a private dev tunnel. |
| `DASHBOARD_STATUS_CACHE_TTL_MS` | `30000` | Status result cache TTL. |
| `DASHBOARD_STATUS_PROBE_TIMEOUT_MS` | `2500` | Per-probe timeout. |

## Local development

```bash
npm test
DASHBOARD_AUTH_MODE=disabled DASHBOARD_ALLOW_DISABLED_AUTH=true DASHBOARD_CONFIG_FILE=./config/dashboard.public.example.json npm start
```

Then open `http://127.0.0.1:4322`.

To exercise reverse-proxy auth locally:

```bash
DASHBOARD_CONFIG_FILE=./config/dashboard.public.example.json npm start
curl -i http://127.0.0.1:4322/api/config/public
curl -H 'cf-access-authenticated-user-email: ben@example.invalid' http://127.0.0.1:4322/api/config/public
```

## Docker / Compose validation

```bash
cp config/dashboard.public.example.json config/dashboard.public.json
DASHBOARD_PUBLISHED_IP=127.0.0.1 docker compose build
DASHBOARD_PUBLISHED_IP=127.0.0.1 docker compose up
curl http://127.0.0.1:4322/healthz
```

For the critical deployment candidate, render the real non-secret `.env` locally from `.env.example`, render `config/dashboard.public.json`, and keep both out of Git where applicable.

## Apply sequence

1. On `critical`, verify current ports and container state:
   - `docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'`
   - `netstat -ltnp | grep -E ':(80|443|4322)\\b'` (`ss` is not currently installed on critical)
2. Render/copy `services/personal-dashboard` to `/mnt/nas/services/personal-dashboard` and render `config/dashboard.public.json`.
3. Start only the dashboard container. Preferred once Compose is available:
   - `DASHBOARD_PUBLISHED_IP=172.17.0.1 docker compose up -d --build dashboard`
   Current critical fallback, because the Docker Compose plugin is not installed there:
   - `sh scripts/run-critical-docker.sh`
4. Verify direct health from critical and through Traefik:
   - `curl -fsS http://172.17.0.1:4322/healthz`
   - `curl -fsS -H 'Host: dashboard.wheeler-network.com' http://192.168.0.50/healthz`
   - `curl -i http://192.168.0.50:4322/api/config/public -H 'cf-access-authenticated-user-email: forged@example.invalid'` should fail to connect or otherwise not return `200`.
5. Sync the prepared Traefik `dynamic-config.yaml` route to `/mnt/nas/services/traefik/dynamic-config.yaml`.
6. Verify Traefik loaded the route; if the NAS file-provider watcher misses the update, restart only `proxy` after approval.
7. Create the Cloudflare Tunnel public hostname and Access policy described in `../cloudflare-tunnel/dashboard-public-hostname-plan.md`.
8. Verify public route with Cloudflare Access identity headers and confirm unauthenticated access is denied by Access/app.

## Rollback

- Remove/disable the Cloudflare public hostname `dashboard.wheeler-network.com` and any associated Access application/policy.
- Revert `/mnt/nas/services/traefik/dynamic-config.yaml` to the previous version and reload/restart only `proxy` if required.
- Stop/remove only the dashboard container: `docker compose down` from the approved dashboard live path.
- Leave rendered config files in place for inspection unless Ben explicitly approves deletion.

## Tests

```bash
npm test
```

The suite covers config validation, auth gate behavior, health endpoint topology minimization, status probing, and hiding server-side target URLs.

## Secret handling

No secret values are required for the default MVP. If Ben later chooses app-level auth or Cloudflare automation, store rendered values in Vaultwarden folder `homelab` and commit only item/field/env references in `personal-dashboard.env.map.example`.
