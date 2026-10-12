# Graphiti read-only MCP registration handoff

Status: ready for Ben to apply manually. This file is a non-secret handoff; it does not mutate Hermes config and no gateway/worker process was restarted by the worker that prepared it.

## Smoke receipt

Real MCP client smoke was run from `/root/work/home-lab` with uv-isolated MCP on both the client and server side:

```bash
uv run --with mcp python services/graphiti/scripts/smoke-graphiti-mcp-registration.py
```

Receipt written:

```text
services/graphiti/receipts/2026-10-04-mcp-registration-smoke.json
```

Result summary:

- listed exactly 4 tools: `graphiti_status`, `graphiti_search_facts`, `graphiti_lookup_provenance`, `graphiti_validate_curated_episode`
- no unexpected tools
- no destructive tool names
- `graphiti_status` succeeded with `status=ok`
- `graphiti_search_facts` succeeded at the MCP protocol layer and returned the safe `graph_unavailable` degradation object from live loopback Graphiti rather than crashing or leaking a traceback
- no config was changed, no public route was created, and no gateway/worker restart was performed

## Exact native-MCP stanza to add

Add this under the top-level `mcp_servers:` key for each target Hermes profile config. If a config already has `mcp_servers:`, merge only the `graphiti:` child under it.

```yaml
mcp_servers:
  graphiti:
    command: "uv"
    args:
      - "run"
      - "--with"
      - "mcp"
      - "python"
      - "/root/work/home-lab/services/graphiti/scripts/graphiti-mcp-server.py"
    env:
      GRAPHITI_API_URL: "http://127.0.0.1:8000"
      GRAPHITI_SEARCH_PATH: "/search"
      GRAPHITI_HEALTH_PATH: "/healthcheck"
      GRAPHITI_INGEST_PATH: "/episodes"
      GRAPHITI_TIMEOUT_SECONDS: "20"
    timeout: 60
    connect_timeout: 30
```

Notes:

- The command intentionally uses `uv run --with mcp`; system Python does not need a global `mcp` package.
- Env values are non-secret. Graphiti/OpenRouter/Neo4j credentials remain only in the Graphiti runtime/Vaultwarden/local rendered env.
- Raw Graphiti remains loopback-only at `http://127.0.0.1:8000`; this does not create a LAN/public route.
- The MCP surface is read-only plus curated-episode validation; there is no clear/delete/arbitrary-Cypher/ingest-apply tool.

## Registration scope

Apply the stanza to these configs:

1. `/root/.hermes/config.yaml` (`default` profile/global config)
2. `/root/.hermes/profiles/kobold/config.yaml` (homelab infrastructure worker)
3. `/root/.hermes/profiles/sentinel/config.yaml` (monitoring/review worker that should query operational provenance)
4. `/root/.hermes/profiles/scribe/config.yaml` (documentation/summarization worker that should cite provenance)
5. `/root/.hermes/profiles/domovoi/config.yaml` (house-daemon/general worker access path)
6. `/root/.hermes/profiles/gremlin/config.yaml` (debugging/QA worker access path)

No existing profile config currently contains an `mcp_servers` stanza, so each target needs a new top-level key unless Ben has changed config after this handoff was prepared.

## Ben apply procedure

1. Copy the YAML stanza above into each target config listed in Registration scope.
2. From a shell outside the running Hermes gateway/session, restart the affected Hermes processes so native MCP discovery runs at startup.
3. After restart, verify that tools named with the native prefix are present, e.g. `mcp_graphiti_graphiti_status`, `mcp_graphiti_graphiti_search_facts`, `mcp_graphiti_graphiti_lookup_provenance`, and `mcp_graphiti_graphiti_validate_curated_episode`.
4. Call `graphiti_status` through one restarted profile and confirm it reports the same read-only contract.
5. Do not expose raw Graphiti over Traefik/Cloudflare as part of this registration.

## Rollback

Remove the `graphiti:` child under `mcp_servers:` from the affected profile configs, then restart the affected Hermes processes from an external shell. This only removes the MCP access path; it does not change Graphiti, Neo4j, mem0, or curated-ingest state.
