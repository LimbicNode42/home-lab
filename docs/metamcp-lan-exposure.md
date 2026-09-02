# MetaMCP LAN exposure runbook

Date: 2026-09-03
Tasks: implementation `t_0bbbe4a8`; approval `t_5227cffc`; this documentation `t_f1d36fd1`
Host: `tori` (`192.168.0.20`), Debian trixie
Service: MetaMCP 2.4.22, Docker container `metamcp`

## Intent

Expose the existing API-key-protected MetaMCP gateway to trusted LAN clients on tori's LAN address, without weakening the `sk_mt_*` API-key boundary and without touching Traefik, DNS, Cloudflare Tunnel, WAN, guest Wi-Fi, or untrusted VLAN routing. LAN-only; no public exposure.

## Live change as implemented

Mechanism: a host-level `socat` relay under systemd, bound to tori's LAN IP only, forwarding to the untouched Docker loopback listener. This avoids recreating the `metamcp` container (a container-recreate approach was attempted first and failed with a Drizzle migration stall; see "Prior attempt not to repeat" below).

Exact unit file — `NEW /etc/systemd/system/metamcp-lan-relay.service`:

```ini
[Unit]
Description=MetaMCP LAN relay (192.168.0.20:12008 -> 127.0.0.1:12008)
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP4-LISTEN:12008,bind=192.168.0.20,fork,reuseaddr TCP4:127.0.0.1:12008
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Enabled + started with:

```bash
systemctl enable --now metamcp-lan-relay.service
```

Bind semantics: `192.168.0.20:12008` (tori LAN IP only, never `0.0.0.0`) -> `127.0.0.1:12008` (existing Docker published loopback listener, untouched).

Not changed:
- `metamcp` / `metamcp-pg` containers (no recreate)
- Docker published port (still `127.0.0.1:12008->12008/tcp`)
- Traefik, DNS, Cloudflare Tunnel, WAN, guest Wi-Fi, untrusted VLAN routing
- Firewall: INPUT policy remains `ACCEPT`, but an approved host-local iptables allowlist now restricts TCP `12008` to `192.168.0.0/24` and rejects other routed IPv4 sources to `192.168.0.20:12008`
- No API key / bearer / `BETTER_AUTH_SECRET` read into the shell in plaintext, printed, or committed

## Preflight receipts (recorded before change)

- Listener: `127.0.0.1:12008` only, owned by Docker proxy.
- LAN probe: `curl http://192.168.0.20:12008/` fails to connect (loopback-only bind).
- Container: `metamcp`, image `ghcr.io/metatool-ai/metamcp@sha256:6d5e0cba4ffc4976069a980723c11042f993a978fe0f3071ba2ec8a91ebc3d41`, healthy.
- Published port: `127.0.0.1:12008->12008/tcp`.
- Dual-process in-container: Next.js frontend on 12008 proxies to backend on 12009 (internal only).
- Docker network: `metamcp_metamcp-network`; dependent containers `metamcp-pg` and `eodhd-mcp` on the same network; `eodhd-mcp` has no host port.

## Confirmed UI paths

- `/` -> `307` to `/en/`.
- `/en/` -> `308` to `/en`.
- `/login` -> `307` to `/en/login`.
- `/en/login` -> `200` (public login shell).
- Authenticated app pages (`/en/dashboard`, `/en/namespaces`, `/en/servers`, `/en/settings`) redirect to `/en/login?callbackUrl=...` when unauthenticated.

## Confirmed MCP / backend paths and auth model

MCP endpoints:

- `POST /metamcp/financial-data/mcp` (financial-data namespace endpoint).
- No API key -> `401` with `{"error":"authentication_required", ...}`, `supported_methods` listing `X-API-Key` header and query param.
- Valid `sk_mt_*` key via `X-API-Key` header -> `200` for `initialize` (SSE `text/event-stream`, `mcp-session-id` header returned).
- Session-scoped `tools/list` -> `200`, currently `89` tools (`eodhd__*` names).

Endpoint table confirms `financial-data` and `homelab` endpoints have `enable_api_key_auth=true`, `use_query_param_auth=false`, `enable_oauth=false`.

Auth boundary: API key required for all MCP endpoint access; no unauthenticated path reaches tools/data. The only public surfaces are the login shell, static assets, health ping, and endpoint-name catalog.

Important: `/en/login` is intentionally public as the UI login shell. Do not embed or distribute an API key in URLs, dashboard config, docs, or bookmarks.

## Backup location

Private backup for this run (mode `0700`):

```
/root/.hermes/profiles/kobold/runtime/metamcp-lan-exposure-20260902T194939Z/
```

Contents (non-secret; env captured as key NAMES only, no values): `compose-labels.json`, `mounts.txt`, `env-keys.txt`, `port-bindings.json`, `networks.json`, `ss-ltnp-before.txt`, `docker-ps-before.txt`.

A prior secret-bearing full `docker inspect` already exists from an earlier preflight run at `/root/.hermes/profiles/kobold/runtime/metamcp-lan-exposure-20260902T164958Z/` (mode `0600`, not committed). No plaintext secrets were added to backup during the LAN-exposure run.

## Post-change verification checklist

Run from tori first:

```bash
ss -ltnp | grep ':12008'     # expect 127.0.0.1:12008 (docker-proxy) AND 192.168.0.20:12008 (socat)
curl --max-time 5 -I http://127.0.0.1:12008/en/login     # 200
curl --max-time 5 -I http://127.0.0.1:12008/health        # 200
curl --max-time 5 -I http://192.168.0.20:12008/health     # 200
curl --max-time 5 -I http://192.168.0.20:12008/en/login   # 200
```

Expected unauthenticated MCP result from LAN:

```bash
curl --max-time 5 -i http://192.168.0.20:12008/metamcp/financial-data/mcp
```

Expected: HTTP `401` with `authentication_required`. (A bare GET without the JSON-RPC initialize body still returns the 401 auth boundary.)

Authenticated `initialize` + `tools/list` from a LAN-origin host — API key provided via local secret env only, never echoed, committed, or pasted into logs:

```bash
export METAMCP_API_KEY_FILE=/path/to/local/secret/file
METAMCP_API_KEY=$(cat "$METAMCP_API_KEY_FILE")
endpoint='http://192.168.0.20:12008/metamcp/financial-data/mcp'
headers_file=$(mktemp)
body_file=$(mktemp)
trap 'rm -f "$headers_file" "$body_file"' EXIT

curl --max-time 10 -sS -D "$headers_file" -o "$body_file" \
  -H "X-API-Key: $METAMCP_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"lan-smoke","version":"1.0"}}}' \
  "$endpoint"

session_id=$(awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/ {gsub("\\r", "", $2); print $2}' "$headers_file")
test -n "$session_id"

curl --max-time 10 -sS \
  -H "X-API-Key: $METAMCP_API_KEY" \
  -H "mcp-session-id: $session_id" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  "$endpoint"
```

Expected authenticated result: `initialize` returns HTTP `200`, `content-type: text/event-stream`, and an `mcp-session-id` header. The follow-up `tools/list` with that session header returns HTTP `200`; expected current count is `89` tools, including `eodhd__get_historical_stock_prices` and `eodhd__get_user_details`. Do not print the API key while debugging this command; inspect only status, headers, and sanitized tool counts.

True cross-host probe (from `critical`, `192.168.0.50`, via ssh):

```bash
curl --max-time 5 -I http://192.168.0.20:12008/health                        # 200
curl --max-time 5 -i http://192.168.0.20:12008/metamcp/financial-data/mcp   # 401
```

Recorded verification results (all passed):
- Loopback `/en/login` 200, `/health` 200
- LAN `/health` 200, `/en/login` 200
- LAN unauth MCP -> `401 authentication_required`
- LAN authed `initialize` -> `200` + `mcp-session-id`; `tools/list` -> `89` tools
- Cross-host from critical: `/health` 200, unauth MCP 401
- Rollback tested live (see below), then re-enabled

## Guest/untrusted network assurance status

Current assurance is host-local plus trusted-LAN source restriction. The relay is bound to `192.168.0.20` rather than `0.0.0.0`, and the approved remediation added a host-local iptables allowlist on tori for TCP `12008`.

Live rules after remediation:

```bash
-A INPUT -s 192.168.0.0/24 -d 192.168.0.20/32 -p tcp -m tcp --dport 12008 -j ACCEPT
-A INPUT -d 192.168.0.20/32 -p tcp -m tcp --dport 12008 -j REJECT --reject-with tcp-reset
```

The rules are managed by `metamcp-lan-allowlist.service`:

```ini
[Unit]
Description=MetaMCP LAN relay source allowlist (TCP 12008)
After=network-online.target
Before=metamcp-lan-relay.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c '/usr/sbin/iptables -C INPUT -p tcp -d 192.168.0.20 --dport 12008 -s 192.168.0.0/24 -j ACCEPT 2>/dev/null || /usr/sbin/iptables -I INPUT 1 -p tcp -d 192.168.0.20 --dport 12008 -s 192.168.0.0/24 -j ACCEPT; /usr/sbin/iptables -C INPUT -p tcp -d 192.168.0.20 --dport 12008 -j REJECT --reject-with tcp-reset 2>/dev/null || /usr/sbin/iptables -I INPUT 2 -p tcp -d 192.168.0.20 --dport 12008 -j REJECT --reject-with tcp-reset'
ExecStop=/bin/sh -c '/usr/sbin/iptables -D INPUT -p tcp -d 192.168.0.20 --dport 12008 -j REJECT --reject-with tcp-reset 2>/dev/null || true; /usr/sbin/iptables -D INPUT -p tcp -d 192.168.0.20 --dport 12008 -s 192.168.0.0/24 -j ACCEPT 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
```

Private rollback/evidence backup for this firewall remediation: `/root/.hermes/profiles/kobold/runtime/metamcp-lan-allowlist-20260902T232822Z/`.

No real guest Wi-Fi client or router ACL export was available during this run. Instead, a temporary local network namespace on tori with source `10.254.120.2/30` was used as a simulated non-`192.168.0.0/24` routed source; `curl http://192.168.0.20:12008/health` failed with `000 exit=7` after the allowlist was installed. This is defense-in-depth host enforcement, not a claim that the upstream router is correctly segmented. Small distinction; large blast radius.

## Rollback (restore loopback-only binding)

To remove only the source allowlist while leaving the LAN relay running:

```bash
systemctl disable --now metamcp-lan-allowlist.service \
  && rm /etc/systemd/system/metamcp-lan-allowlist.service \
  && systemctl daemon-reload
```

The allowlist unit's `ExecStop` removes both TCP `12008` INPUT rules. If the unit file is missing or rollback is being done manually, delete the rules directly:

```bash
iptables -D INPUT -p tcp -d 192.168.0.20 --dport 12008 -j REJECT --reject-with tcp-reset 2>/dev/null || true
iptables -D INPUT -p tcp -d 192.168.0.20 --dport 12008 -s 192.168.0.0/24 -j ACCEPT 2>/dev/null || true
```

To remove the LAN relay entirely and return MetaMCP to loopback-only:

```bash
systemctl disable --now metamcp-lan-relay.service \
  && rm /etc/systemd/system/metamcp-lan-relay.service \
  && systemctl daemon-reload
```

Expected rollback state: `192.168.0.20:12008/health` refused (curl exit 000), loopback `127.0.0.1:12008/en/login` still 200; Docker published port unchanged at `127.0.0.1:12008->12008/tcp`.

Rollback was tested live: stopping the relay restored loopback-only (LAN refused, loopback 200); the relay was re-enabled afterward, leaving the final state exposed.

## Prior attempt not to repeat

A container-recreate approach was attempted first (recreate `metamcp` app container with published port changed to `192.168.0.20:12008->12008/tcp`). The replacement container never became healthy: logs stopped at Drizzle migration config load (`Reading config file '/app/apps/backend/drizzle.config.ts'`), and UI/MCP probes failed with connection refused. It was rolled back to the original loopback-only container. The socat relay avoids this entirely — it never touches the container. Do not retry the container-recreate path without a new approach and explicit approval.

## Known security findings for follow-up (NOT part of this LAN-exposure change)

Recorded during implementation verification, carried forward for a separate security-review task — these are pre-existing behaviors, not regressions from the relay:

1. `/api/auth/*` returns permissive CORS (`access-control-allow-origin: *` with credentials), not the "Invalid origin" block that was originally assumed for LAN UI login.
2. `POST /api/auth/sign-up/email` accepts writes from a LAN/bogus Origin (HTTP 200, creates a user). Registration UI is hidden via `BOOTSTRAP_DISABLE_REGISTRATION_UI`/`BOOTSTRAP_DISABLE_REGISTRATION_SSO`, but the endpoint itself is open to the trusted LAN. (A junk probe user created during verification was deleted immediately.)
3. `/service/*` (external Cloudflare worker rewrite) is reachable unauthenticated and returns `404` upstream, with parity loopback-vs-LAN; it does not expose tools/data.

These do not affect the MCP API-key acceptance criteria but should be triaged separately.

## Follow-up desired-state gap

The live MetaMCP app was originally launched from a now-missing temporary kanban workspace; the running container is the live source of truth. A separate service-import task should build `services/metamcp/` desired state with non-secret `.env.example` / Vaultwarden references, digest-pinned image, restore notes, and explicit API-key/auth boundaries. This runbook is operational documentation, not the long-term source of truth for the service definition.
