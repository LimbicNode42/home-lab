# MetaMCP LAN exposure runbook

Date: 2026-09-03 (updated 2026-09-04)
Tasks: implementation `t_0bbbe4a8`; approval `t_5227cffc`; documentation `t_f1d36fd1`; friendly-name `t_d822a9d0`
Host: `tori` (`192.168.0.20`), Debian trixie
Service: MetaMCP 2.4.22, Docker container `metamcp`

## 2026-09-05 update — friendly-name browser login delivered (Path B)

Task `t_d822a9d0`, operator-approved path B (2026-09-05). The friendly-name **browser login** is now closed. A browser on a trusted LAN host can open `http://metamcp.local:12008`, complete login, and hit an authenticated MCP endpoint — no SSH tunnel.

### What changed (this update)

Repointed the app to its friendly name and recreated the container with the correct launch parameters:

- `APP_URL` and `NEXT_PUBLIC_APP_URL` changed `http://localhost:12008` -> `http://metamcp.local:12008`.
- Added `BETTER_AUTH_TRUSTED_ORIGINS=http://metamcp.local:12008,http://metamcp.local,http://localhost:12008,http://127.0.0.1:12008`.
- Recreated the `metamcp` container from the same digest-pinned image, preserving mounts (`metamcp_mcp_fs_data`, `metamcp_mcp_git_data`), network (`metamcp_metamcp-network`, alias `app`), user (`nextjs`), restart policy, and the `127.0.0.1:12008->12008/tcp` publish.

**No image rebuild needed.** Two runtime mechanisms make this env-only:
- Frontend uses `next-runtime-env` (v3.3.0); `NEXT_PUBLIC_APP_URL` is injected into `window.__ENV` at serve time, not baked at `next build`.
- Backend better-auth 1.4.2 auto-trusts its `baseURL` origin and honors a `BETTER_AUTH_TRUSTED_ORIGINS` env override, so the hardcoded `trustedOrigins` array in `dist/index.js` did not need a code patch.

### The critical launch pitfall (root cause of the prior "Drizzle stall")

The original compose project set `security_opt: [apparmor=unconfined]`. A plain `docker run` (or compose without that key) applies Docker's default `docker-default` AppArmor profile, which blocks something drizzle-kit/esbuild needs during config load. Symptom is indistinguishable from the runbook's documented stall:

```
No config path provided, using default 'drizzle.config.ts'
Reading config file '/app/apps/backend/drizzle.config.ts'
```

...then the container never passes that line, `npx drizzle-kit migrate` exits 124, health turns `unhealthy`. It is NOT the migration itself and NOT the port binding. Reproduced cleanly: a fresh container with the **original localhost env** still stalled under the default profile, and completed in seconds once `--security-opt apparmor=unconfined` was added. **Any future reproduce/recreate must include `--security-opt apparmor=unconfined`.**

### Verification (all passed, 2026-09-05)

- `metamcp` healthy; new `APP_URL`/`NEXT_PUBLIC_APP_URL` = `http://metamcp.local:12008`.
- Served login HTML now references `metamcp.local` (0 `localhost` refs, previously 2) — Domain Mismatch eliminated.
- `http://metamcp.local:12008/health` -> 200; `/en/login` -> 200.
- Sign-in from `Origin: http://metamcp.local:12008` -> `401 INVALID_EMAIL_OR_PASSWORD` (sane auth, not an origin/trustedOrigins `FORBIDDEN`).
- `GET /api/auth/get-session` via friendly origin -> 200.
- Authenticated MCP via friendly name: `initialize` -> 200 + `mcp-session-id`; `tools/list` -> 89 tools. API key read from container env/DB only, never printed or committed.
- Localhost regression: `127.0.0.1:12008/health` and `/en/login` still 200.
- Cross-host: `critical` reaches `192.168.0.20:12008/health` -> 200.
- Binding unchanged: `192.168.0.20:12008` (socat relay) + `127.0.0.1:12008` (docker-proxy). No `0.0.0.0`. iptables `192.168.0.0/24` allowlist intact.

### End-to-end user path (browser login + authenticated MCP)

1. From a trusted LAN host (mDNS-aware: macOS/Windows/iOS/systemd+avahi+nss-mdns), open `http://metamcp.local:12008`.
2. Complete the email/password login (the UI was already public at `/en/login`; the app is now correctly scoped to `metamcp.local` so the session cookie is retained).
3. For MCP tool access, still authenticate with the `sk_mt_*` API key (`X-API-Key` header or query param) — the API-key boundary is unchanged and required for all `/metamcp/*/mcp` traffic.
4. Plain-Linux hosts without mDNS (e.g. `critical`) can't resolve `metamcp.local` and instead use `http://192.168.0.20:12008` directly (browser login also works there now, since the app is no longer `localhost`-bound). A LAN-wide friendly name would require a real DNS resolver — out of scope.

### Rollback (one command)

The pre-change container is preserved (renamed, not deleted) as `metamcp-rollback-20260905T105010Z` (image `sha256:d452b621…`). To roll back:

```bash
docker rm -f metamcp && docker rename metamcp-rollback-20260905T105010Z metamcp && docker start metamcp
```

Snapshots (mode 0600) under `/root/.hermes/profiles/kobold/runtime/metamcp-recreate-*/`: full `docker inspect` JSON, pre-change DB `pg_dump`, and the rebuilt env file. Image id before == after (`sha256:d452b621ee4c8829d95a7d137693933dcd991af2fff3876ddf7bed142b63bcca`); this was an env+launch-param recreate only, no image change.

### Home Dashboard note

Dashboard `metaMcp.access` already carries `localUrl: http://metamcp.local:12008` and IP-fallback links (added 2026-09-04). The freshness/status signaling is the existing dashboard live-probe (`live_probe_configured`); no dashboard change beyond that is required for this task — the friendly-name link now actually works end-to-end for browser login, which is the meaningful improvement.

## 2026-09-04 update — friendly home-network name (metamcp.local)

Task `t_d822a9d0` asked to make MetaMCP reachable via a friendly, documented path. Outcome: the friendly **name** is now live and verified via a host-local mDNS alias; the friendly-name **browser login** was a confirmed blocker that needed a bounded `APP_URL`/`trustedOrigins` change + container recreate (now delivered — see the 2026-09-05 update above).

### What changed (this update)

New host-local systemd unit, `metamcp-mdns-alias.service`, publishes a stable mDNS alias `metamcp.local` -> `192.168.0.20` using avahi. It never touches the container, the relay, Traefik, the router, or WAN/DNS. No `0.0.0.0` bind; no auth-boundary change.

```ini
[Unit]
Description=MetaMCP mDNS alias publisher (metamcp.local -> 192.168.0.20)
After=network-online.target avahi-daemon.service
Wants=network-online.target
Requires=avahi-daemon.service

[Service]
Type=simple
ExecStart=/usr/bin/avahi-publish-address -R metamcp.local 192.168.0.20
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Key pitfall: `avahi-publish-address` **without `-R`** fails with `Local name collision`, because avahi already owns `192.168.0.20` -> `tori.local` (the reverse/PTR record). `-R` (`--no-reverse`) publishes only the forward alias and is required here.

### Verification (all passed, 2026-09-04)

- `avahi-resolve -n metamcp.local` -> `192.168.0.20`; glibc `getaddrinfo` also resolves (nss-mdns present on tori).
- `http://metamcp.local:12008/health` -> `200`.
- `http://metamcp.local:12008/en/login` -> `200` (login page loads via the friendly name).
- `http://metamcp.local:12008/metamcp/financial-data/mcp` -> `401 authentication_required` (API-key boundary intact through the friendly name).
- Bind state unchanged: `192.168.0.20:12008` (socat) + `127.0.0.1:12008` (docker-proxy). No `0.0.0.0`.

### Login-through-friendly-name barrier (BLOCKING, needs approval)

The friendly name loads the UI, but a browser **cannot complete login** through it. Root cause (confirmed from the served client bundle + backend `dist/index.js`, not assumed):

- `NEXT_PUBLIC_APP_URL` / `APP_URL` are `http://localhost:12008`.
- The frontend auth client resolves its base URL as `env("NEXT_PUBLIC_APP_URL") || window.location.origin`. Since `NEXT_PUBLIC_APP_URL` is baked into the served client (`window.__NEXT_DATA__` / `PublicEnvScript` shows `http://localhost:12008`), a browser at `metamcp.local` still targets `localhost:12008` for auth, and the session cookie is scoped to `localhost`.
- Backend better-auth `trustedOrigins` only lists localhost/127.0.0.1/0.0.0.0 (verified in `apps/backend/dist/index.js`).
- Net effect: login works from `localhost:12008` (or via an SSH tunnel to `localhost`), but a non-localhost LAN origin cannot complete/retain a browser session. There is also a client-side "Domain Mismatch Warning" that fires when `window.location.origin` != the configured `APP_URL`.

Closing this requires: (a) set `APP_URL` / `NEXT_PUBLIC_APP_URL` to `http://metamcp.local:12008` (or the desired friendly URL) and add it to better-auth `trustedOrigins` and `crossSubDomainCookies`; and (b) a controlled container recreate/rebuild. That is exactly the change class that previously stalled (Drizzle migration) and is gated behind "new approach + explicit approval" — do NOT retry the bare recreate. Any future attempt must first capture the current container's exact env/mount/network, snapshot the DB, and have a rollback path. The mDNS alias itself is harmless and remains live regardless.

### Router / Traefik notes (no change made)

- The TP-Link router (`192.168.0.1`, DHCP/DNS at `192.168.0.1`) has **no local DNS override / split-horizon**; `*.wheeler-network.com` resolves only to public Cloudflare anycast IPs (jellyfin/dashboard return CF IPs). There is no LAN DNS service deployed: `dnsmasq` is installed but unused, and AdGuard Home has only a NAS config directory (container not running). A `metamcp.wheeler-network.com` entry would require either a Cloudflare DNS record (rejected: WAN exposure) or deploying a LAN DNS resolver (larger, unapproved change). mDNS `metamcp.local` sidesteps this without touching any of it.
- Traefik on `critical` routes by exact `Host(...)` (jellyfin/dashboard/cluster/vault `.wheeler-network.com`), all public-CF-backed. No Traefik change is needed for a LAN-only friendly name, and none was made.

### Access note

- Friendly name works for **mDNS-aware clients only** (macOS/Windows/iOS/systemd+avahi+nss-mdns hosts). Plain-Linux hosts without avahi/nss-mdns (e.g. `critical` PVE, `hosts: files dns`) will NOT resolve `metamcp.local`; they keep using `http://192.168.0.20:12008` directly. This is expected; a full LAN-wide friendly name would require DNS (see above).
- The API key is still required for all MCP/tool access. The UI login remains `localhost`-bound until the barrier above is resolved; use `ssh -L 12008:127.0.0.1:12008 tori` from a LAN host for a working authenticated UI today.

### Pre-existing security gaps carried forward (unchanged, for sentinel)

See "Known security findings for follow-up" below. These remain open and are NOT part of this change; a separate sentinel task should own them.

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
test -r "$METAMCP_API_KEY_FILE"
METAMCP_API_KEY=$(tr -d '\r\n' < "$METAMCP_API_KEY_FILE")
test -n "$METAMCP_API_KEY"
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

A container-recreate approach was attempted first (recreate `metamcp` app container with published port changed to `192.168.0.20:12008->12008/tcp`). The replacement container never became healthy: logs stopped at Drizzle migration config load (`Reading config file '/app/apps/backend/drizzle.config.ts'`), and UI/MCP probes failed with connection refused. It was rolled back to the original loopback-only container.

**Root cause of that stall, now understood (2026-09-05):** the replacement container was launched without `security_opt: [apparmor=unconfined]`. Docker's default `docker-default` AppArmor profile blocks a step drizzle-kit needs during config load, so `pnpm exec drizzle-kit migrate` hangs and the container never gets past "Reading config file". It is not the migration, not the DB, and not the port change. A `docker run`/compose recreate must set `--security-opt apparmor=unconfined` to match the original compose project. The socat relay avoids the container recreate entirely — it never touches the container. See the 2026-09-05 update above for the full diagnosis and the successful recreated container.

## Known security findings for follow-up (NOT part of this LAN-exposure change)

Recorded during implementation verification, carried forward for a separate security-review task — these are pre-existing behaviors, not regressions from the relay:

1. `/api/auth/*` returns permissive CORS (`access-control-allow-origin: *` with credentials), not the "Invalid origin" block that was originally assumed for LAN UI login.
2. `POST /api/auth/sign-up/email` accepts writes from a LAN/bogus Origin (HTTP 200, creates a user). Registration UI is hidden via `BOOTSTRAP_DISABLE_REGISTRATION_UI`/`BOOTSTRAP_DISABLE_REGISTRATION_SSO`, but the endpoint itself is open to the trusted LAN. (A junk probe user created during verification was deleted immediately.)
3. `/service/*` (external Cloudflare worker rewrite) is reachable unauthenticated and returns `404` upstream, with parity loopback-vs-LAN; it does not expose tools/data.

These do not affect the MCP API-key acceptance criteria but should be triaged separately.

### 2026-09-05 triage outcome (sentinel, task `t_c63720cf`)

All three findings were triaged live against the running container, its baked `dist/index.js` / `index.js.map` / `packages/*/dist` sources, and the live `metamcp_db`. No test users were created. Full assessment: `metamcp-auth-security-assessment.md` (attached to `t_c63720cf`).

- **Finding 1 (permissive CORS) — LOW, accepted-risk, no action now.** Root cause: the backend mounts the OAuth router at the app root (`app.use(oauth_default)`, no path filter), and that router applies `cors({ origin: "*", credentials: true })` globally, stamping the wildcard headers on every path including `/api/auth/*`. It is not browser-exploitable: `*` + `credentials: true` is spec-rejected by browsers (they fail closed), the session cookie is `SameSite=Lax`, and better-auth `trustedOrigins` blocks cross-origin session issuance. The correct fix is a code change (trusted-origin list + drop `credentials`) requiring an image rebuild — deferred to the next service-definition rebuild, not a one-off recreate.
- **Finding 2 (open sign-up) — MEDIUM-HIGH, remediation pending approval.** Root cause: the signup gate is a DB config row `DISABLE_SIGNUP` (checked in a `databaseHooks.user.create.before` hook); the `BOOTSTRAP_DISABLE_REGISTRATION_UI`/`_SSO` env vars are consumed nowhere in the container, and the `config` table is empty, so signup is open. A new user can create their own filesystem/git MCP servers (the `filesystem`/`git` namespaces are `is_public: true`) = container filesystem access; they cannot reach the existing `financial-data`/`homelab` endpoints or the `hermes-gateway-key`. Recommended remediation is a single reversible DB insert — `INSERT INTO config (id,value,description) VALUES ('DISABLE_SIGNUP','true','…')` (rollback: `DELETE FROM config WHERE id='DISABLE_SIGNUP'`) — no recreate, no rebuild, no env change. Awaiting operator approval to apply.
- **Finding 3 (`/service/*`) — INFO, no action.** Unauthenticated 404 upstream; no tools/data exposure.

## Follow-up desired-state gap

The live MetaMCP app was originally launched from a now-missing temporary kanban workspace; the running container is the live source of truth. A separate service-import task should build `services/metamcp/` desired state with non-secret `.env.example` / Vaultwarden references, digest-pinned image, restore notes, and explicit API-key/auth boundaries. This runbook is operational documentation, not the long-term source of truth for the service definition.
