# Secure Remote Access Runbook
# Homelab: Nippon cluster / wheeler-network.com
# Last updated: 2026-05-30
# Status: CONDITIONAL — two HIGH severity findings pending remediation (see Section 8)

---

## 1. Architecture Overview

Remote access to homelab services is provided exclusively through a Cloudflare Zero Trust tunnel.
No ports are forwarded on the home router. All public-facing routes are gated by Cloudflare Access
before traffic reaches internal services.

### Traffic flow (public access)

    Internet -> cloudflare.com (DNS / Zero Trust) -> cloudflared tunnel container (critical LXC)
             -> Traefik proxy (critical LXC port 80/443) -> backend service

### Key hosts

    critical LXC:   192.168.0.50  (VMID 100 on emperor / 192.168.0.6)
    emperor:        192.168.0.6   (Proxmox node, primary cluster member)
    shogun:         192.168.0.7   (Proxmox node)
    jester:         192.168.0.8   (Proxmox node)
    tori:           192.168.0.20  (Proxmox node — where Hermes runs)
    toyota:         192.168.0.21  (Proxmox node)
    NAS:            192.168.0.250 (Proxmox backup target + bind-mount source)

### Active public hostnames

    dashboard.wheeler-network.com  -> personal dashboard (Docker bridge: 172.17.0.1:4322)
    cluster.wheeler-network.com    -> Proxmox cluster UI (192.168.0.6-9:8006)
    vault.wheeler-network.com      -> Vaultwarden (192.168.0.50:8084)
    jellyfin.wheeler-network.com   -> Jellyfin (192.168.0.8:8096)   [CF tunnel only, no Access gate]

    Removed (DNS + tunnel ingress deleted, Traefik routes PENDING removal — see Section 8):
    traefik.wheeler-network.com    -> Traefik dashboard (no longer in DNS/tunnel)
    nas.wheeler-network.com        -> NAS UI (no longer in DNS/tunnel)


## 2. Prerequisites

Before using remote access:

a) Cloudflare Zero Trust account linked to the `wheeler-network.com` zone.
b) Your email address is on the allowlist in the relevant Cloudflare Access policy.
c) You have an authenticator app / passkey configured for that email (TOTP or similar).
d) Vaultwarden item `homelab/cloudflare/tunnel-critical` exists with a valid tunnel_token.
e) The `cloudflare` Docker container is running on critical.
f) The `proxy` (Traefik) Docker container is running on critical.

Verify containers (from within LAN or via Proxmox console):

    ssh critical 'docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "cloudflare|proxy|vaultwarden"'


## 3. Connecting to Services Remotely

### 3.1 Dashboard

URL: https://dashboard.wheeler-network.com

Flow:
  1. Browser navigates to https://dashboard.wheeler-network.com
  2. Cloudflare Access intercepts and redirects to accounts.cloudflare.com login
  3. Authenticate with allowed email + MFA
  4. Cloudflare issues a signed JWT; cloudflared validates it before forwarding
  5. Traefik receives the request from the cloudflared container (Docker bridge source)
     and the dashboard-cloudflared-only middleware permits it
  6. Request reaches the personal-dashboard backend

Note: Traefik's dashboard-cloudflared-only middleware blocks any LAN client that tries to
reach this route directly via IP (192.168.0.50:80 with Host header). Only traffic originating
from the Docker bridge range 172.16.0.0/12 is accepted.

### 3.2 Proxmox Cluster UI

URL: https://cluster.wheeler-network.com

Flow:
  1. Browser navigates to https://cluster.wheeler-network.com
  2. Cloudflare Access gate (same email + MFA required)
  3. After Access auth, traffic routes to cluster.wheeler-network.com origin inside tunnel
  4. Traefik forwards to one of the Proxmox nodes on port 8006 (HTTPS, self-signed cert ignored)

PENDING REMEDIATION (BLOCK-1): The cluster Traefik router currently has no IP-whitelist
middleware. LAN clients can bypass Cloudflare Access by hitting 192.168.0.50:80 directly
with the correct Host header. Task t_3757feb2 will add dashboard-cloudflared-only middleware
to this route. Until applied, treat as soft gate only.

Proxmox login: Proxmox native auth is still required after passing CF Access.
Credentials are stored under Vaultwarden homelab folder (not tracked in Git).

### 3.3 Vaultwarden

URL: https://vault.wheeler-network.com

Flow:
  1. Browser navigates to vault.wheeler-network.com
  2. Cloudflare Access gate
  3. Traefik routes to Vaultwarden container at 192.168.0.50:8084

Admin panel: https://vault.wheeler-network.com/admin
  - Admin token stored in Vaultwarden item: homelab/vaultwarden/admin field: admin_token
  - Only enable the admin UI when needed; disable ADMIN_TOKEN env var when not in use

PENDING REMEDIATION (BLOCK-1): Same as cluster — vault route has no IP-whitelist middleware.
Direct LAN access to /admin bypasses CF Access until t_3757feb2 is applied.

### 3.4 Connecting to Proxmox Shell / SSH (LAN only)

Proxmox nodes are not exposed externally. Shell access requires LAN presence (or Tailscale/VPN
if that is added in future).

    # Proxmox web UI (LAN):
    https://192.168.0.6:8006    (emperor)
    https://192.168.0.7:8006    (shogun)
    https://192.168.0.8:8006    (jester)
    https://192.168.0.20:8006   (tori)
    https://192.168.0.21:8006   (toyota)

    # LXC/VM shell from any Proxmox node:
    ssh critical    # 192.168.0.50

### 3.5 Hermes Agent (Kanban / AI agent)

Hermes runs on tori (192.168.0.20). Its gateway listens on 0.0.0.0:9119 (all interfaces)
with no authentication currently configured.

PENDING REMEDIATION (BLOCK-3 MEDIUM): Hermes gateway is accessible from any LAN host.
Ben must manually bind gateway to loopback (127.0.0.1) or enable gateway auth in
~/.hermes/config.yaml. This is a manual action to avoid restarting the gateway mid-session.

Until remediated, keep tori off public networks and rely on LAN access controls.


## 4. Account and MFA Expectations

### Cloudflare Access

- One allowlist email per authorized operator (currently: Ben only)
- MFA enforced via login_method requirement in Access policy
- Sessions are time-limited; re-authentication is prompted automatically
- If locked out of CF Access, all public routes become inaccessible — use LAN access to debug

### Proxmox

- Native Proxmox auth separate from CF Access
- Credentials stored in Vaultwarden (not in Git)
- Do not use the default root account for day-to-day operations where possible

### Vaultwarden

- Master password for the vault is personal to Ben — not stored anywhere in Git or Hermes
- Admin token stored in Vaultwarden item homelab/vaultwarden/admin


## 5. Verifying the Security Posture

Run these checks periodically or after any Traefik/CF config change.

### 5.1 Confirm public routes redirect to CF Access (fail-closed)

    curl -sI https://dashboard.wheeler-network.com | grep -E "^HTTP|^location"
    curl -sI https://cluster.wheeler-network.com   | grep -E "^HTTP|^location"
    curl -sI https://vault.wheeler-network.com     | grep -E "^HTTP|^location"

Expected: HTTP/2 302 (or 307) redirecting to accounts.cloudflare.com — not a 200.

### 5.2 Confirm removed routes are dead (no 200 or 308 from traefik/nas)

    # These should return 404 after t_3757feb2 is applied:
    curl -sI https://traefik.wheeler-network.com | grep "^HTTP"
    curl -sI https://nas.wheeler-network.com     | grep "^HTTP"
    # From LAN (bypassing DNS):
    curl -s -o /dev/null -w "%{http_code}" -H "Host: traefik.wheeler-network.com" http://192.168.0.50/
    curl -s -o /dev/null -w "%{http_code}" -H "Host: nas.wheeler-network.com"     http://192.168.0.50/

    Expected after t_3757feb2: both return 404.
    Current state (before t_3757feb2): return 308/200 (live routes — BLOCK-2 outstanding).

### 5.3 Confirm LAN bypass is blocked for gated routes (post-t_3757feb2)

    # From tori (192.168.0.20):
    curl -s -o /dev/null -w "%{http_code}" -H "Host: cluster.wheeler-network.com" http://192.168.0.50/
    curl -s -o /dev/null -w "%{http_code}" -H "Host: vault.wheeler-network.com"   http://192.168.0.50/admin

    Expected after t_3757feb2: 403.
    Current state (before t_3757feb2): 200 (bypass possible — BLOCK-1 outstanding).

### 5.4 Confirm dashboard LAN bypass is blocked (already applied)

    curl -s -o /dev/null -w "%{http_code}" -H "Host: dashboard.wheeler-network.com" http://192.168.0.50/

    Expected: 403. If 200, the dashboard-cloudflared-only middleware is missing or broken.

### 5.5 Confirm JWT forgery does not bypass Access

    curl -s -o /dev/null -w "%{http_code}"       -H "Host: dashboard.wheeler-network.com"       -H "CF-Access-Jwt-Assertion: FAKE_TOKEN"       http://192.168.0.50/

    Expected: 403 (middleware blocks at IP level, before any header parsing).

### 5.6 Check tunnel is active via CF API

    # Requires Vaultwarden item homelab/cloudflare/api field: api_token + account_id
    curl -s -H "Authorization: Bearer <api_token>"       "https://api.cloudflare.com/client/v4/accounts/<account_id>/cfd_tunnel"       | python3 -m json.tool | grep -E "name|status|healthy"

### 5.7 Check Traefik nmap exposure

    nmap -p 80,443,8080 192.168.0.50

    Expected open: 80, 443, 8080.
    Port 8080 is the Traefik API (MEDIUM finding — unauthenticated, LAN only for now).
    No ports should be open on the router's public interface.

### 5.8 Check Hermes gateway binding

    # On tori:
    ss -tlnp | grep 9119

    Expected until remediated: 0.0.0.0:9119. Goal: 127.0.0.1:9119.


## 6. Credential and Token Rotation

### 6.1 Cloudflare Tunnel Token

Stored in: Vaultwarden homelab/cloudflare/tunnel-critical field: tunnel_token

Rotation steps:
  1. Log in to Cloudflare Zero Trust dashboard
  2. Navigate to Networks -> Tunnels -> find the critical tunnel
  3. Edit the tunnel and rotate/regenerate the token
  4. Update the Vaultwarden item with the new token
  5. Re-render the cloudflared env on critical:
       ssh critical
       # Stop existing container
       docker stop cloudflare && docker rm cloudflare
       # Fetch new token from Vaultwarden, then re-run:
       docker run -d --name cloudflare --restart unless-stopped          cloudflare/cloudflared@sha256:6b599ca3e974349ead3286d178da61d291961182ec3fe9c505e1dd02c8ac31b0          tunnel --no-autoupdate run --token <NEW_TOKEN>
  6. Verify tunnel is healthy (Step 5.6 above)

### 6.2 Cloudflare DNS API Token (Traefik ACME/cert renewal)

Stored in: Vaultwarden homelab/cloudflare/dns-api-token field: CF_DNS_API_TOKEN

Rotation steps:
  1. Rotate the token in Cloudflare -> My Profile -> API Tokens
  2. Update the Vaultwarden item
  3. Update the env file for the proxy container on critical:
       ssh critical
       # Edit /path/to/traefik.env with new token
       docker restart proxy
  4. Watch Traefik logs for ACME renewal success on next cert expiry cycle

### 6.3 Vaultwarden Admin Token

Stored in: Vaultwarden homelab/vaultwarden/admin field: admin_token

Rotation steps:
  1. Generate a new token (argon2id hash recommended):
       docker run --rm -it vaultwarden/server:latest /vaultwarden hash --preset owasp
  2. Update the Vaultwarden item in your vault
  3. On critical, update ADMIN_TOKEN in the vaultwarden env and restart:
       docker restart vaultwarden
  4. Verify admin panel still loads at https://vault.wheeler-network.com/admin

### 6.4 Cloudflare Access Policy

CF Access policies do not have tokens to rotate. Manage authorized emails:
  1. Log in to Cloudflare Zero Trust -> Access -> Applications
  2. Find the relevant application, edit the policy
  3. Add or remove email addresses from the allowlist
  4. Confirm the change takes effect (existing sessions may persist until they expire)


## 7. Troubleshooting

### Public route returns 520/502/connection refused

  - Check cloudflared container: ssh critical 'docker ps | grep cloudflare'
  - Check Traefik container:     ssh critical 'docker ps | grep proxy'
  - Check Traefik logs:          ssh critical 'docker logs proxy --tail 50'
  - Check cloudflared logs:      ssh critical 'docker logs cloudflare --tail 50'
  - Verify tunnel is active in CF Zero Trust dashboard

### Cloudflare Access redirects to login but auth loop never completes

  - Verify your email is in the Access policy allowlist
  - Check that the application in Zero Trust still has a valid hostname configured
  - Try clearing browser cookies for *.cloudflareaccess.com

### curl from LAN returns 404 for a route that should exist

  - Check dynamic-config.yaml: ssh critical 'cat /mnt/nas/services/traefik/dynamic-config.yaml'
  - Check the Traefik API:     curl http://192.168.0.50:8080/api/http/routers | python3 -m json.tool
  - If route is in the file but not in the API, restart proxy:
      ssh critical 'docker restart proxy'

### Traefik config change not taking effect

Traefik watches dynamic-config.yaml with watch: true but sometimes misses changes over NAS mounts.
  - Confirm the file changed: ssh critical 'stat /mnt/nas/services/traefik/dynamic-config.yaml'
  - Force reload: ssh critical 'docker restart proxy'
  - Re-check API: curl http://192.168.0.50:8080/api/http/routers | python3 -m json.tool | grep '"name"'

### cert / ACME failures

  - Confirm acme.json has correct permissions: ssh critical 'stat /mnt/nas/services/traefik/acme.json'
    Expected: 600
  - Check CF_DNS_API_TOKEN is current (see Section 6.2)
  - Check Traefik logs for ACME errors

### Proxmox cluster unreachable via cluster.wheeler-network.com

  - Verify CF tunnel is up (Section 5.6)
  - Verify cluster.wheeler-network.com is in CF Zero Trust Networks -> Tunnels -> Public Hostnames
  - Verify Traefik cluster router is in dynamic-config.yaml and active via API
  - Check Proxmox node(s) are up: ping 192.168.0.6


## 8. Known Outstanding Issues (as of 2026-05-30)

Severity: HIGH - BLOCK-1

  cluster.wheeler-network.com and vault.wheeler-network.com routes in Traefik have no
  IP-whitelist middleware. LAN clients on 192.168.0.0/24 can bypass Cloudflare Access by
  directly hitting 192.168.0.50:80 with a spoofed Host header.

  Remediation: Add dashboard-cloudflared-only middleware reference to cluster and vault routers
  in dynamic-config.yaml.
  Tracking: t_3757feb2 (status: ready, not yet applied)

Severity: HIGH - BLOCK-2

  traefik and nas router and service blocks are still live in dynamic-config.yaml even though
  their DNS records and tunnel ingress rules were removed. LAN clients can still reach the
  Traefik dashboard and NAS UI by hitting Traefik directly with the appropriate Host header.

  Remediation: Remove traefik and nas blocks from dynamic-config.yaml.
  Tracking: t_3757feb2 (status: ready, not yet applied)

Severity: MEDIUM - BLOCK-3

  Hermes gateway (on tori / 192.168.0.20) binds to 0.0.0.0:9119 with no authentication.
  Any LAN host can send requests to the agent.

  Remediation: Ben to manually update ~/.hermes/config.yaml on tori to bind to 127.0.0.1
  and/or enable gateway auth, then restart the gateway at a convenient time.
  Tracking: Manual action required by Ben.

Severity: MEDIUM - BLOCK-4

  Traefik API dashboard (port 8080) is unauthenticated. Any LAN host can read full routing
  config and service topology.

  Remediation: Add BasicAuth or disable the API when not needed. Pre-existing issue tracked
  separately.


## 9. Rollback Procedure

### Roll back Traefik dynamic-config.yaml to last known good

A backup was taken before the 2026-05-30 security review changes:

    /mnt/pve/NAS/services/traefik/dynamic-config.yaml.bak-20260530-160925

To restore:
    ssh critical
    cp /mnt/nas/services/traefik/dynamic-config.yaml        /mnt/nas/services/traefik/dynamic-config.yaml.bak-$(date +%Y%m%d-%H%M%S)
    cp /mnt/pve/NAS/services/traefik/dynamic-config.yaml.bak-20260530-160925        /mnt/nas/services/traefik/dynamic-config.yaml
    docker restart proxy

Verify rollback:
    curl http://192.168.0.50:8080/api/http/routers | python3 -m json.tool | grep '"name"'

### Remove a Cloudflare Access application (re-opens a route publicly)

    # Via CF Zero Trust dashboard: Access -> Applications -> delete the relevant app
    # Via API (requires homelab/cloudflare/api token):
    curl -X DELETE "https://api.cloudflare.com/client/v4/accounts/<account_id>/access/apps/<app_id>"       -H "Authorization: Bearer <api_token>"

WARNING: Deleting an Access app immediately re-exposes the route to the public internet.
Only do this intentionally (e.g. during a misconfiguration recovery).

### Recovery if cloudflared container is broken / removed

    ssh critical
    # Get token from Vaultwarden: homelab/cloudflare/tunnel-critical -> tunnel_token
    docker stop cloudflare 2>/dev/null; docker rm cloudflare 2>/dev/null
    docker run -d --name cloudflare --restart unless-stopped       cloudflare/cloudflared@sha256:6b599ca3e974349ead3286d178da61d291961182ec3fe9c505e1dd02c8ac31b0       tunnel --no-autoupdate run --token <TOKEN>
    docker logs cloudflare --tail 20    # should show "Connection established"

### Recovery if Traefik container is removed or broken

    ssh critical
    # Verify NAS mount is available:
    ls /mnt/nas/services/traefik/
    # Re-run the container (get CF_DNS_API_TOKEN from Vaultwarden homelab/cloudflare/dns-api-token):
    docker run -d --name=proxy --restart unless-stopped \
      -p 80:80 -p 443:443 -p 8080:8080 \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v /mnt/nas/services/traefik/traefik.toml:/traefik.toml \
      -v /mnt/nas/services/traefik/dynamic-config.yaml:/dynamic-config.yaml \
      -v /mnt/nas/services/traefik/acme.json:/acme.json \
      --env-file /path/to/traefik.env \
      traefik:v2.5 --configFile=/traefik.toml
    docker logs proxy --tail 20


## 10. Config File Reference

All live config files are on the NAS bind mount (not in the LXC filesystem):

    /mnt/nas/services/traefik/traefik.toml          # Traefik static config
    /mnt/nas/services/traefik/dynamic-config.yaml   # Routes, middlewares, services
    /mnt/nas/services/traefik/acme.json             # TLS certs (permissions must be 600)

Git repo (homelab IaC) mirrors of these files:

    home-lab/services/traefik/traefik.toml
    home-lab/services/traefik/dynamic-config.yaml

Secrets map (no values in Git):

    home-lab/docs/secrets/vaultwarden-item-map.md

Cloudflare tunnel Docker compose candidate:

    home-lab/services/cloudflare-tunnel/docker-compose.yml
