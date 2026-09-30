# Graphiti shared knowledge graph (experimental candidate)

Status: **candidate desired-state scaffold only**. This directory is Git-backed design and draft automation for a future read-only shared knowledge graph service. It is not deployed from this commit.

## Decision summary

Graphiti + Neo4j is being evaluated as an optional shared operational/provenance graph for Hermes agents and homelab incidents. It does **not** replace mem0. mem0 remains the active personal/preference memory provider.

The first deployable shape, if later reviewed and approved, is deliberately boring:

- host: `tori` (`192.168.0.20`)
- Graphiti API: loopback/LAN only; no Cloudflare Tunnel and no public Traefik route
- Neo4j live data: tori-local disk, not NAS/NFS
- NAS: database dumps, config snapshots, restore-test evidence only
- agent access: read-only wrapper/tool only; no direct write/delete/clear Graphiti endpoints

## Why this exists

The spike verified Graphiti `0.30.2` with OpenRouter-compatible completions and embeddings:

- completion/rerank/small model: `openai/gpt-4o-mini`
- embedding model: `openai/text-embedding-3-small`
- embedding dimension: `1536`
- OpenRouter base URL: `https://openrouter.ai/api/v1`
- Neo4j tested version: `5.26.2`

Useful fit: cross-agent operational provenance, service dependencies, incident timelines, and source-backed temporal facts.

Unsafe fit: source-of-truth memory or automatic remediation. Retrieval missed at least one operational recommendation during the spike, and temporal invalidation was too aggressive in one case. Treat graph output as advisory evidence with provenance, not marching orders from the YAML goblin.

## Candidate layout

```text
/opt/graphiti/                       # future runtime root on tori, not Git
  docker-compose.yml                 # rendered/reviewed from this scaffold
  .env                               # rendered from Vaultwarden, mode 0600, never Git
/var/lib/graphiti/neo4j/data/         # future Neo4j live data, tori-local disk
/mnt/pve/NAS/services/graphiti/       # future NAS dump/snapshot evidence target
  backups/neo4j-dumps/
  config-snapshots/
  restore-tests/
```

## Files in this scaffold

- `docker-compose.candidate.yml` - non-secret candidate container topology; not an apply instruction.
- `.env.example` - non-secret variable names and safe defaults/placeholders.
- `config/vaultwarden-map.example.yml` - Vaultwarden folder/item/field references only.
- `scripts/openrouter-guardrail-preflight.py` - exact-model guardrail probe for OpenRouter.
- `scripts/backup-neo4j-dump.sh` - draft backup command with approval gate.
- `scripts/restore-neo4j-dump.sh` - draft restore command with approval gate.
- `scripts/restore-test-neo4j.sh` - draft isolated restore-test outline with approval gate.
- `runbooks/production-architecture-rollout.md` - production architecture, boundaries, rollout order, and acceptance gates.
- `runbooks/deploy-read-only-service.md` - reviewed deployment checklist for a later card.
- `runbooks/backup-restore.md` - backup, restore, and restore-test plan.
- `runbooks/dashboard-status-design.md` - Home Dashboard status/freshness design for later deployment.
- `runbooks/read-only-agent-wrapper.md` - wrapper/tool contract that prevents direct destructive access.
- `runbooks/curated-ingest-policy.md` - production policy for allowed sources, redaction, grouping, temporal review, seed sets, and OpenRouter spend controls.
- `runbooks/infra-implementation-status.md` - current infra implementation receipt and blocker status for `t_5a650bed`.
- `receipts/` - sanitized machine-readable deployment/preflight receipts; no secrets or raw graph data.

## Guardrails

1. Do not deploy this scaffold without a separate reviewed deploy task.
2. Do not expose raw Graphiti to agents. It has destructive endpoints.
3. Do not expose Neo4j browser/Bolt beyond loopback/LAN-reviewed access.
4. Do not place live Neo4j data on NAS/NFS.
5. Do not commit rendered `.env`, API keys, Neo4j passwords, dumps, or graph data.
6. Verify OpenRouter workspace guardrails for the exact models before assuming deployment will work.
7. Verify Neo4j container startup on tori before treating containerized Neo4j as proven; the earlier local Docker attempt failed with a Java `Permission denied` path, while the host tarball worked.
