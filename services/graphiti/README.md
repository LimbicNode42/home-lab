# Graphiti shared knowledge graph (experimental candidate)

Status: **ready-to-run blocked configuration**. This directory contains Git-backed, non-secret production templates and gated automation for a tori-local Graphiti + Neo4j deployment. It is not live because this worker cannot unlock Vaultwarden to rerun the mandatory OpenRouter/Vaultwarden preflight.

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

- `docker-compose.candidate.yml` - historical non-secret candidate container topology; not an apply instruction.
- `docker-compose.tori.yml` - reviewed tori-local production template: loopback-only ports, local Neo4j data, NAS backups/evidence only.
- `.env.example` - non-secret variable names and safe defaults/placeholders.
- `config/vaultwarden-map.example.yml` and `graphiti.env.map.example` - Vaultwarden folder/item/field references only.
- `agent_graphiti/` - safe Python wrapper package for agent read-only query normalization and curated-ingest validation; not a Hermes memory provider.
- `scripts/graphiti-agent-wrapper.py` - CLI entrypoint for safe `status`, `query`, `validate-ingest`, and dry-run/default curated ingest operations.
- `seeds/initial-approved-episodes.json` - sanitized representative seed episodes for provenance/query smokes.
- `tests/test_agent_graphiti.py` - unit tests for query normalization, service-down degradation, redaction/sanitization, seed validation, and destructive-path rejection.
- `scripts/openrouter-guardrail-preflight.py` - exact-model guardrail probe for OpenRouter.
- `scripts/deploy-tori-local.sh` - gated deployment helper; supports read-only preflight and refuses live mutation unless explicitly approved.
- `scripts/verify-loopback-exposure.sh` - non-invasive listener check for unsafe all-interface raw Graphiti/Neo4j binds.
- `scripts/backup-neo4j-dump.sh` - gated Neo4j dump/config-snapshot/manifest automation with dry-run mode.
- `scripts/restore-neo4j-dump.sh` - gated live restore helper; destructive and intentionally harder to run than restore-test.
- `scripts/restore-test-neo4j.sh` - gated disposable restore-test automation that writes sanitized NAS evidence.
- `runbooks/production-architecture-rollout.md` - production architecture, boundaries, rollout order, and acceptance gates.
- `runbooks/production-runbook.md` - operator runbook and handoff for deploy/update, verification, backup/restore-test, dashboard interpretation, rollback, blockers, and safety boundaries.
- `runbooks/deploy-read-only-service.md` - reviewed deployment checklist for a later card.
- `runbooks/backup-restore.md` - backup, restore, and restore-test plan.
- `runbooks/dashboard-status-design.md` - Home Dashboard status/freshness design for later deployment.
- `runbooks/read-only-agent-wrapper.md` - wrapper/tool contract that prevents direct destructive access.
- `runbooks/curated-ingest-policy.md` - production policy for allowed sources, redaction, grouping, temporal review, seed sets, and OpenRouter spend controls.
- `runbooks/infra-implementation-status.md` - current infra implementation receipt and blocker status for `t_5a650bed`.
- `runbooks/implementation-unblock-instructions.md` - exact operator unblock/run order for the current Vaultwarden/OpenRouter gate.
- `receipts/` - sanitized machine-readable deployment/preflight receipts; no secrets or raw graph data.

## Guardrails

1. Do not deploy this scaffold unless Vaultwarden is unlocked for the worker/operator and `scripts/deploy-tori-local.sh --preflight-only` passes from the deployment credential path.
2. Do not expose raw Graphiti to agents. It has destructive endpoints.
3. Do not expose Neo4j browser/Bolt beyond loopback/LAN-reviewed access.
4. Do not place live Neo4j data on NAS/NFS.
5. Do not commit rendered `.env`, API keys, Neo4j passwords, dumps, or graph data.
6. Verify OpenRouter workspace guardrails for the exact models before assuming deployment will work.
7. Verify Neo4j container startup on tori before treating containerized Neo4j as proven; the earlier local Docker attempt failed with a Java `Permission denied` path, while the host tarball worked.
