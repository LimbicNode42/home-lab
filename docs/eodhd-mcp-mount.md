# EODHD MCP server mount — MetaMCP gateway

Date: 2026-09-01
Task: t_f4ea469d
Operator: kobold profile (Hermes homelab worker)

## What was done

Mounted the upstream EODHD MCP server (financial market data) as a new server
inside the existing MetaMCP gateway on `tori`, in a dedicated `financial-data`
namespace, reachable only on loopback.

### Upstream source (pinned)

- Repo: `EodHistoricalData/EODHD-MCP-Server`
- Revision: `454a10fb71552ddf3cb022ce0fbdca122560108d` (2026-08-28, "Merge pull request #58")
- Manifest version: `2.3.2` (pyproject `eodhd-mcp`); runtime serverInfo `eodhd-datasets` / fastmcp `3.4.7`
- Clone installed at `/opt/eodhd-mcp-server` on tori (outside any git repo, as scoped).

### Runtime

- Runs as Docker container `eodhd-mcp`, image `eodhd-mcp:prod`, built from the pinned revision.
- Compose: `/opt/eodhd-mcp-server/compose.prod.yaml`.
- Transport: the server's own `streamable-http` (fits the existing gateway pattern), path `/mcp`, `MCP_HOST=0.0.0.0:8000`.
- Network: attached to `metamcp_metamcp-network` only; **no host port published** (empty `ports:`). Reachable from the gateway container as `http://eodhd-mcp:8000/mcp`.
- Secret: `EODHD_API_KEY` injected at runtime via `env_file: .secret.env` (mode 0600, git-ignored), sourced from Vaultwarden folder `Homelab`, item `EODHD_API_KEY`, field `password`. Never committed, logged, or echoed.

### MetaMCP registration (via tRPC admin surface)

- MCP server `eodhd` (type STREAMABLE_HTTP, url `http://eodhd-mcp:8000/mcp`): uuid `337b16d1-790b-4a06-8029-ee66f3a25a5d`
- Namespace `financial-data`: uuid `90a9e3bf-0352-42ac-94db-cce798498bac`
- Endpoint `financial-data` (API-key auth on, loopback): uuid `abef2d42-7f84-48b8-bda7-45805ab71d84`
- Gateway holds existing loopback bind only (`127.0.0.1:12008`); unchanged. No LAN/WAN exposure in scope here (separate task owns LAN exposure).

## Verification (live receipts)

All through the gateway endpoint `http://127.0.0.1:12008/metamcp/financial-data/mcp` with the existing gateway API key:

- `tools/list` returned **89 tools** (88 EODHD + 1 gateway). All upstream tools aggregated and prefixed `eodhd__`.
- `get_user_details` (read-only) → live account JSON: `subscriptionType=free`, `dailyRateLimit=20`, quota `remaining` decremented as expected.
- `get_historical_stock_prices` ("AAPL.US", period d, 2026-08-01..05) → returned 3 rows of real OHLCV data. **EOD/price tier works.**
- `get_fundamentals_data` ("AAPL.US") → returned `403 Forbidden`: "Only EOD data allowed for free users." **Fundamentals blocked on free tier, as documented.**

## Free-tier limitation (explicit)

The EODHD account is on the **FREE tier** (verified live). Available now:

- End-of-day / historical prices, live price/quote data, intraday, exchanges list, search, user details — and other read-only tools that EODHD serves on the free tier.

Blocked until the **All-in-one** subscription is active (HTTP 403 from upstream):

- **Fundamentals** (`get_fundamentals_data`, `get_bulk_fundamentals`).
- **Financial statements** and any tool that EODHD gates behind the paid tiers (earnings trends, insider/congressional trades, several marketplace/partner datasets — treat as unverified until a paid-key smoke test).

Do not claim fundamentals / financial-statement coverage until the tier flips. Tools are discoverable regardless; they fail closed with 403 at call time.

## Commands (receipt)

```bash
# clone + pin
git clone --depth 1 https://github.com/EodHistoricalData/EODHD-MCP-Server.git /opt/eodhd-mcp-server
# rev = 454a10fb71552ddf3cb022ce0fbdca122560108d

# build + run (secret injected from Vaultwarden at runtime)
cd /opt/eodhd-mcp-server
docker compose -f compose.prod.yaml build
docker compose -f compose.prod.yaml up -d

# register in MetaMCP (tRPC frontend router, better-auth session cookie)
#   mcpServers.create  { name: eodhd, type: STREAMABLE_HTTP, url: http://eodhd-mcp:8000/mcp }
#   namespaces.create  { name: financial-data, mcpServerUuids: [<eodhd uuid>] }
#   endpoints.create   { name: financial-data, namespaceUuid: <ns uuid>, enableApiKeyAuth: true }
```

## Pitfalls recorded (future reference)

1. **AppArmor `docker-default` denies Python `socketpair()`.** FastMCP/asyncio (Python 3.10) crashed at startup with `PermissionError: [Errno 13] Permission denied` in `asyncio` self-pipe. Fixed with `security_opt: [apparmor:unconfined]` on this network-isolated, no-host-port container. Revisit if the host AppArmor profile is later corrected.
2. **MetaMCP tRPC v11 wire format:** queries are `GET /trpc/<path>?input=<json>&batch=1`; mutations are `POST /trpc/<path>` with the raw input object as the body (not `{input:...}`).
3. **Better-auth session cookie:** sign-in returns `set-cookie` with a `%`-encoded value and `Domain=localhost`; must send the exact raw `name=value` (do not re-quote) and connect via `localhost` (not `127.0.0.1`) or the cookie won't be sent.
4. **MetaMCP keeps tools discovered live** (the `tools` DB table was empty), so verification is via the gateway endpoint's `tools/list`, not the DB.

## Secrets

- No raw `EODHD_API_KEY` in any log, container log, compose file, committed file, or the repo.
- Runtime file `/opt/eodhd-mcp-server/.secret.env` is 0600 and git-ignored.