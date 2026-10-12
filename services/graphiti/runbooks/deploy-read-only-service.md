# Graphiti read-only service deployment runbook (future reviewed card)

This runbook is a checklist for a later deployment task. The current scaffold commit does not deploy anything.

## Preconditions

1. A reviewed deploy card exists and explicitly authorizes container creation on `tori`.
2. `scripts/openrouter-guardrail-preflight.py` passes for:
   - `openai/gpt-4o-mini`
   - `openai/text-embedding-3-small` with dimension `1536`
3. Vaultwarden items exist under folder `homelab`:
   - `graphiti/openrouter`
   - `graphiti/neo4j`
   - optionally `graphiti/service-auth` for a future wrapper
4. Neo4j live data directory is on tori-local disk, not NAS/NFS.
5. NAS backup directories exist and are writeable from tori.
6. Container startup for `neo4j:5.26.2` has been verified on tori. The earlier spike found a local Docker startup failure outside the final target host.

## Network posture

Default binding is loopback only:

- Graphiti API: `127.0.0.1:8000`
- Neo4j browser: `127.0.0.1:7474`
- Neo4j Bolt: `127.0.0.1:7687`

Do not add:

- Cloudflare Tunnel route
- public Traefik route
- raw Graphiti endpoint in agent tools
- Neo4j public/LAN-wide exposure

If cross-host agents need access, add a separate authenticated read-only wrapper and bind that wrapper to a reviewed LAN address. Do not expose raw Graphiti; upstream includes clear/delete/write endpoints.

## Deployment outline

1. Render `/opt/graphiti/.env` from Vaultwarden with mode `0600`.
2. Copy reviewed `docker-compose.yml` to `/opt/graphiti/docker-compose.yml`.
3. Create tori-local data/log dirs and NAS backup dirs.
4. Run OpenRouter preflight from tori.
5. Start Neo4j only; verify health and logs.
6. Start Graphiti API; verify `/healthcheck` from loopback.
7. Run a tiny sanitized ingest and read-only query only if the deploy card approves initial data creation.
8. Run backup, restore-test plan, and capture evidence before agent-facing use.
9. Add Home Dashboard status only after the service exists and access posture is reviewed.

## Rollback outline

1. Stop `graphiti-api` first.
2. Stop `neo4j`.
3. Preserve tori-local data directory and logs; do not delete without explicit approval.
4. Disable any systemd timer/cron added by the deploy task.
5. Remove any route/wrapper exposure added by the deploy task.
