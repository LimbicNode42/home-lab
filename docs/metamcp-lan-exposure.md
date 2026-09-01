# MetaMCP LAN exposure runbook

Date: 2026-09-01
Task: `t_cf7ca56d`
Host: `tori` (`192.168.0.20`)
Service: MetaMCP 2.4.22, Docker container `metamcp`

## Intent

Expose the existing MetaMCP gateway to trusted LAN clients on tori's LAN address while preserving the current API-key boundary for MCP endpoints. This is LAN-only; do not add Cloudflare Tunnel, public DNS, Traefik, guest-Wi-Fi, or WAN exposure as part of this change.

## Current preflight receipts

Read-only checks from tori before any exposure change:

- Listener: `127.0.0.1:12008` only, owned by Docker proxy.
- LAN probe: `curl http://192.168.0.20:12008/` fails to connect, as expected for loopback-only bind.
- Container: `metamcp`, image `ghcr.io/metatool-ai/metamcp@sha256:6d5e0cba4ffc4976069a980723c11042f993a978fe0f3071ba2ec8a91ebc3d41`, health `Up` / healthy.
- Published port: `127.0.0.1:12008->12008/tcp`.
- Docker network: `metamcp_metamcp-network`; observed container IP `172.23.0.3` at time of preflight.
- Dependent containers: `metamcp-pg` and `eodhd-mcp` are on the same `metamcp_metamcp-network`; `eodhd-mcp` has no host port.
- The original Docker Compose config path recorded in container labels no longer exists: `/root/.hermes/kanban/workspaces/t_cb1827a0/metamcp/compose.yaml`. Treat the running container as the live source until a proper `services/metamcp/` desired-state import is created.

Private rollback/forensics backup captured on tori before mutation:

- Full secret-bearing Docker inspect: `/root/.hermes/profiles/kobold/runtime/metamcp-lan-exposure-20260901T111325Z/docker-inspect-full.json` (mode `0600`, not committed).
- Sanitized inspect: `/root/.hermes/profiles/kobold/runtime/metamcp-lan-exposure-20260901T111325Z/metamcp-inspect-sanitized.txt`.
- Listener snapshot: `/root/.hermes/profiles/kobold/runtime/metamcp-lan-exposure-20260901T111325Z/ss-ltnp-before.txt`.

## Confirmed UI and MCP paths

UI / app shell:

- `/` returns `307` to `/en/`.
- `/en/` returns `308` to `/en`.
- `/login` returns `307` to `/en/login`.
- `/en/login` returns `200` and serves the unauthenticated login page.
- Authenticated UI pages are protected by app login; unauthenticated `/en/dashboard`, `/en/namespaces`, `/en/servers`, and `/en/settings` return `307` to `/en/login?callbackUrl=...`.

MCP endpoints:

- `POST /metamcp/financial-data/mcp` without API key returns `401 authentication_required`.
- `POST /metamcp/financial-data/mcp` with an active `sk_mt_*` key returns `200` for MCP `initialize`.
- `POST /metamcp/financial-data/mcp` with an active `sk_mt_*` key returns `200` for `tools/list`; observed tool count: `89`.
- Database endpoint config confirms `financial-data` and `homelab` endpoints have `enable_api_key_auth=true`, `use_query_param_auth=false`, and `enable_oauth=false`.

Important: `/en/login` is intentionally public as the UI login shell. Do not embed or distribute an API key in URLs, dashboard config, docs, or bookmarks.

## Preferred live change after approval

Because the original Compose file is missing, do not pretend this is clean GitOps yet. The least-bad bounded live change is to recreate only the `metamcp` app container with the same image, env, volumes, labels/network shape, and a LAN-address bind:

```text
192.168.0.20:12008:12008/tcp
```

Use tori's LAN IP rather than `0.0.0.0` so the bind does not accidentally include future non-LAN interfaces. Do not change API-key settings, endpoint rows, database credentials, `metamcp-pg`, `eodhd-mcp`, Traefik, Cloudflare, or DNS.

High-level apply sequence, to be run only after explicit approval:

```bash
set -euo pipefail
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="/root/.hermes/profiles/kobold/runtime/metamcp-lan-exposure-$stamp"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

docker inspect metamcp metamcp-pg > "$backup_dir/docker-inspect-full.json"
chmod 600 "$backup_dir/docker-inspect-full.json"

docker inspect metamcp \
  --format '{{range .Config.Env}}{{println .}}{{end}}' > "$backup_dir/metamcp.env"
chmod 600 "$backup_dir/metamcp.env"

# Keep the original container intact as the immediate rollback target.
docker stop metamcp
docker rename metamcp "metamcp-loopback-backup-$stamp"

docker run -d \
  --name metamcp \
  --restart unless-stopped \
  --network metamcp_metamcp-network \
  --network-alias metamcp \
  --network-alias app \
  --env-file "$backup_dir/metamcp.env" \
  --mount type=volume,source=metamcp_mcp_fs_data,target=/home/nextjs/mcp-fs \
  --mount type=volume,source=metamcp_mcp_git_data,target=/home/nextjs/mcp-git \
  --publish 192.168.0.20:12008:12008/tcp \
  ghcr.io/metatool-ai/metamcp@sha256:6d5e0cba4ffc4976069a980723c11042f993a978fe0f3071ba2ec8a91ebc3d41
```

This intentionally leaves `metamcp-loopback-backup-$stamp` stopped but present until review confirms the new container is healthy. Remove it only in a later cleanup task after explicit approval.

## Immediate rollback

If any post-change check fails, restore the original loopback-only container:

```bash
set -euo pipefail
stamp=<stamp used during apply>

docker stop metamcp || true
docker rm metamcp || true
docker rename "metamcp-loopback-backup-$stamp" metamcp
docker start metamcp

docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}' | grep -E '^metamcp\b'
curl --max-time 5 -i http://127.0.0.1:12008/metamcp/financial-data/mcp
```

Expected rollback state: published port returns to `127.0.0.1:12008->12008/tcp`; `http://192.168.0.20:12008/` is refused again.

## Post-change verification checklist

Run from tori first:

```bash
ss -ltnp | grep ':12008'
curl --max-time 5 -I http://127.0.0.1:12008/en/login
curl --max-time 5 -I http://192.168.0.20:12008/en/login
curl --max-time 5 -i http://192.168.0.20:12008/metamcp/financial-data/mcp
```

Expected unauthenticated MCP result from LAN: HTTP `401` with `authentication_required`.

Then run an authenticated MCP `initialize` and `tools/list` from a LAN-origin host, with the API key provided via local secret/env only, never on the command line or in logs:

```bash
export METAMCP_API_KEY_FILE=/path/to/local/secret/file
METAMCP_API_KEY=$(cat "$METAMCP_API_KEY_FILE")
endpoint='http://192.168.0.20:12008/metamcp/financial-data/mcp'

curl --max-time 10 -sS -D /tmp/metamcp-init.headers \
  -H "X-API-Key: $METAMCP_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"lan-smoke","version":"1.0"}}}' \
  "$endpoint"
```

Expected authenticated result: HTTP `200`, `content-type: text/event-stream`, and an `mcp-session-id` header. Use that session header for `tools/list`; expected current count is `89` tools, including `eodhd__get_historical_stock_prices` and `eodhd__get_user_details`.

## Follow-up desired-state gap

The current live MetaMCP app was launched from a now-missing temporary kanban workspace. After LAN exposure is reviewed, create a separate service-import task to build `services/metamcp/` desired state with non-secret `.env.example` / Vaultwarden references, digest-pinned image, restore notes, and explicit API-key/auth boundaries. Do not let this emergency runbook become the long-term source of truth. That is how mystery state gets promoted to architecture, which is rude to everyone involved.
