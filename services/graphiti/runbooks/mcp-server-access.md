# Graphiti MCP server access path

Status: implemented as a Git-backed, read-only MCP server template. Live registration still requires the normal deployment/review step; do not expose raw Graphiti to agents as a shortcut.

## Decision: separate MCP server, registered through the gateway

Use a separate stdio MCP server (`services/graphiti/scripts/graphiti-mcp-server.py`) instead of adding Graphiti tools directly inside MetaMCP.

Reasons:

- Failure isolation: Graphiti client hangs, SDK issues, or wrapper bugs terminate only the child MCP server process. They do not require a MetaMCP gateway rebuild or restart.
- Least privilege: the server receives only non-secret endpoint config such as `GRAPHITI_API_URL=http://127.0.0.1:8000`; Graphiti/OpenRouter/Neo4j credentials stay in the Graphiti runtime, Vaultwarden, and local rendered env files.
- Network boundary: the MCP server is intended to run on `tori`, where raw Graphiti is still loopback-only. Gateway or native-MCP clients connect to the MCP process/gateway, not to `:8000` directly.
- Reviewability: the tool surface is defined in one Python module and can be smoke-tested by a real MCP client before registration.

## Tool contract

Allowed tools:

- `graphiti_status`: sanitized wrapper/MCP health and contract metadata.
- `graphiti_search_facts`: read-only search over curated operational/provenance facts; returns normalized facts with provenance fields.
- `graphiti_lookup_provenance`: read-only search that returns provenance/caveat fields for source checking.
- `graphiti_validate_curated_episode`: validates one curated episode JSON string without ingesting it.

Prohibited tools/endpoints:

- no `clear`, `delete`, `drop`, `remove`, `truncate`, `admin`, `write`, or arbitrary Cypher tools;
- no raw graph dumps;
- no broad transcript/private-memory ingest;
- no MCP tool that applies curated ingest. Live curated ingest remains the explicit operator CLI path documented in `read-only-agent-wrapper.md`.

Graphiti remains advisory operational/provenance context. mem0 remains the personal/preference memory provider.

## Runtime configuration

The MCP server reads only non-secret environment variables:

```bash
GRAPHITI_API_URL=http://127.0.0.1:8000
GRAPHITI_SEARCH_PATH=/search
GRAPHITI_HEALTH_PATH=/healthcheck
GRAPHITI_INGEST_PATH=/episodes
GRAPHITI_TIMEOUT_SECONDS=8
```

It requires the Python `mcp` package in the supervised runtime. With `uv`, an operator can test without mutating the system Python environment:

```bash
cd /root/work/home-lab
uv run --with mcp python services/graphiti/scripts/graphiti-mcp-server.py
```

For Hermes native MCP, the non-secret config shape is:

```yaml
mcp_servers:
  graphiti:
    command: "/root/work/home-lab/services/graphiti/scripts/graphiti-mcp-server.py"
    env:
      GRAPHITI_API_URL: "http://127.0.0.1:8000"
      GRAPHITI_SEARCH_PATH: "/search"
      GRAPHITI_HEALTH_PATH: "/healthcheck"
      GRAPHITI_INGEST_PATH: "/episodes"
    timeout: 30
    connect_timeout: 30
```

For MetaMCP, register the same command/env as a separately supervised stdio server. Do not add public HTTP forwarding to raw Graphiti.

## Status publishing for Overview

`services/graphiti/scripts/publish-graphiti-mcp-status.sh` runs a real MCP client smoke against the server and writes a sanitized snapshot:

```text
/mnt/pve/NAS/services/graphiti/status/latest-mcp-status.json
```

The Home Dashboard reads that file through the existing Graphiti status bind and surfaces a separate `graphiti-mcp` card. The snapshot contains only tool names, coarse health, timestamps, and safety booleans. It intentionally omits raw paths, credentials, Graphiti result bodies, and endpoint URLs.

Run manually on the host that can reach Graphiti loopback:

```bash
cd /root/work/home-lab
OUT=/mnt/pve/NAS/services/graphiti/status/latest-mcp-status.json \
GRAPHITI_API_URL=http://127.0.0.1:8000 \
  uv run --with mcp bash services/graphiti/scripts/publish-graphiti-mcp-status.sh
```

If `mcp` is missing, the publisher writes `status: not_configured` rather than lying green. Small mercy; still annoying.

## Deployment sketch

1. Copy the reviewed repo files to the tori Graphiti runtime location or keep using the checked-out repo path.
2. Install the MCP SDK in an isolated runtime (`uv` preferred; no global pip needed).
3. Register the stdio server in MetaMCP or Hermes native MCP with the non-secret env above.
4. Run `publish-graphiti-mcp-status.sh` once and verify `/api/status` shows `graphiti-mcp` healthy or an honest degraded/not-configured state.
5. Only after review, schedule the publisher every 5 minutes, similar to the existing mem0/Graphiti publishers.

No gateway restart is required just to review the committed code. A MetaMCP/native-MCP registration change may require restarting the consuming gateway/agent process; do that only in an approved maintenance window.

## Rollback

- Remove/disable the `graphiti` MCP registration from MetaMCP/Hermes native MCP.
- Stop the Graphiti MCP publisher cron/timer if installed.
- Leave raw Graphiti/Neo4j bindings unchanged (`127.0.0.1` only).
- The dashboard will show the MCP card as stale/not-configured once the snapshot ages out; Graphiti/Neo4j backend health remains a separate card.

## Verification checklist

- `list_tools` returns exactly the four allowed tools.
- Calling `graphiti_status` succeeds and reports the contract.
- Calling `graphiti_search_facts` returns either normalized facts or the safe `graph_unavailable` degradation object.
- Tool names and output do not contain destructive verbs, credentials, raw local paths, or raw graph dumps.
- LAN probe to `http://192.168.0.20:8000/healthcheck` remains refused; raw Graphiti is still not public.
