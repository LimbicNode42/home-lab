# Mem0 — Hermes/agent integration notes

How the default and worker Hermes profiles point at the self-hosted mem0 instance on tori.

## Current state

- mem0 API is live at `http://127.0.0.1:8888` (localhost-only on tori).
- Auth is enabled. Programmatic access uses `X-API-Key` (per-user API key) or the legacy `ADMIN_API_KEY`.
- The Hermes mem0 plugin supports a **self-hosted server mode** (`host` + `api_key`), which is the intended integration path.

## Required env vars / config keys

The Hermes mem0 plugin (see `plugins/memory/mem0/README.md` in the Hermes source) reads:

| Setting | Value |
|---|---|
| `MEM0_HOST` (or `host` in `$HERMES_HOME/mem0.json`) | `http://127.0.0.1:8888` |
| `MEM0_API_KEY` (or `api_key` in `mem0.json`) | the per-user API key from Vaultwarden `mem0/server` field `api_key` |

The plugin authenticates with `X-API-Key` and uses the server's `/search` and `/memories` routes.

## Rollout order

1. **This service is already deployed and verified** (add/search smoke test passed).
2. **Per-profile activation** — for each profile that should use mem0:
   - Set `memory.provider` to `mem0` and point it at the self-hosted server.
   - This is a Hermes self-configuration change that may require a gateway restart / new session to fully apply.
3. **Rollback** — set `memory.provider` back to the previous value (currently `honcho` for the domovoi profile) and remove the mem0 env vars.

## Exact commands (for Ben to apply — NOT applied here)

The domovoi profile currently uses `memory.provider: honcho`. Switching it to mem0 is a live Hermes config change that can interrupt the gateway, so it is intentionally **not** applied by this task. Ben should run:

```bash
# Point the profile at the self-hosted mem0 server (non-interactive).
hermes memory setup mem0 --mode selfhosted \
  --host http://127.0.0.1:8888 \
  --api-key <api_key from Vaultwarden mem0/server>

# Or set env vars directly in ~/.hermes/.env (profile-scoped):
#   MEM0_HOST=http://127.0.0.1:8888
#   MEM0_API_KEY=<api_key>

# Verify (in a fresh session):
#   mem0_search "what do I prefer for mem0 storage"
```

Rollback:

```bash
hermes memory setup   # select honcho (or the prior provider)
# or: hermes config set memory.provider honcho
```

## Notes

- The `api_key` field in Vaultwarden `mem0/server` is the per-user API key (prefix `m0sk_`). The `admin_api_key` field is the legacy admin key (prefix `mem0-admin-`). For Hermes agent access, use the per-user `api_key`.
- The dashboard (port 3000) is **not** deployed — the Hermes plugin talks to the API over HTTP, not the dashboard. Deploying the dashboard is optional and would require a separate Next.js build.
- Worker profiles (gremlin, kobold, scribe, sentinel) would each need their own `MEM0_HOST`/`MEM0_API_KEY` (or `mem0.json`) pointing at the same instance, with a distinct `user_id`/`agent_id` if memory isolation is desired.
