# Graphiti shared knowledge graph

Status: **deployed and production-smoke verified** on `tori` (`192.168.0.20`). This directory contains the Git-backed, non-secret production templates, wrapper code, deployment helpers, receipts, and runbooks for the tori-local Graphiti + Neo4j shared operational/provenance graph.

## Decision summary

Graphiti + Neo4j is an optional shared operational/provenance graph for Hermes agents and homelab incidents. It does **not** replace mem0. mem0 remains the active personal/preference memory provider.

The deployed production shape is deliberately bounded:

- host: `tori` (`192.168.0.20`)
- Graphiti API: `127.0.0.1:8000` only
- Neo4j HTTP/Bolt: `127.0.0.1:7474` and `127.0.0.1:7687` only
- no Cloudflare Tunnel route and no public Traefik route for raw Graphiti/Neo4j
- Neo4j live data: tori-local ext4 disk at `/var/lib/graphiti/neo4j/data`, not NAS/NFS
- NAS: database dumps, config snapshots, manifests, status snapshots, and restore-test evidence only
- agent access: reviewed wrapper/tool path only; no direct write/delete/clear Graphiti endpoints

## Current verification

Production evidence is recorded in:

- `receipts/2026-10-02-bounded-deploy-remediation.json` — bounded tori-local ingest remediation, health, loopback, and rollback evidence.
- `receipts/2026-10-02-production-smoke-backup.json` — production health, Neo4j readiness, curated ingest/query/provenance smoke, raw endpoint exposure check, wrapper degraded behavior, backup, and restore-test evidence.
- `runbooks/production-runbook.md` — operator handoff covering health checks, safe smokes, backup/restore-test, rollback, dashboard interpretation, residual risks, and safety boundaries.

Verified production receipt summary:

- `graphiti-api` healthy on loopback only.
- `graphiti-neo4j` healthy on loopback-only HTTP/Bolt.
- Curated `/episodes` ingest and `/search` query returned the expected non-secret smoke fact with timestamp provenance.
- Worker LAN requests to raw Graphiti on `192.168.0.20:8000` were refused, including `/clear`.
- Neo4j backup dump was copied to NAS with manifest and checksum.
- Disposable restore-test passed without touching production data.
- Home Dashboard Overview shows fresh Graphiti/Neo4j memory evidence while keeping mem0 distinct.

## Why this exists

The spike verified Graphiti `0.30.2` with OpenRouter-compatible completions and embeddings:

- completion/rerank/small model: `openai/gpt-4o-mini`
- embedding model: `openai/text-embedding-3-small`
- embedding dimension: `1536`
- OpenRouter base URL: `https://openrouter.ai/api/v1`
- Neo4j version: `5.26.2`

Useful fit: cross-agent operational provenance, service dependencies, incident timelines, and source-backed temporal facts.

Unsafe fit: source-of-truth memory or automatic remediation. Retrieval can miss operational recommendations, and graph facts can go stale. Treat graph output as advisory evidence with provenance, not marching orders from the YAML goblin.

## Production layout

```text
/opt/graphiti/                       # runtime root on tori, not Git
  docker-compose.yml                 # rendered/reviewed runtime compose
  .env                               # rendered from Vaultwarden, mode 0600, never Git
  patches/ingest.py                  # reviewed non-secret local Graphiti ingest patch

/var/lib/graphiti/neo4j/data/         # Neo4j live data, tori-local ext4 disk

/mnt/pve/NAS/services/graphiti/       # NAS evidence/backup target
  backups/neo4j-dumps/
  config-snapshots/
  manifests/
  restore-tests/
  status/
```

## Files in this service area

- `docker-compose.candidate.yml` - historical non-secret candidate topology; not an apply instruction.
- `docker-compose.tori.yml` - reviewed tori-local production template: loopback-only ports, local Neo4j data, NAS backups/evidence only.
- `.env.example` - non-secret variable names and safe defaults/placeholders.
- `config/vaultwarden-map.example.yml` and `graphiti.env.map.example` - Vaultwarden folder/item/field references only.
- `agent_graphiti/` - safe Python wrapper package for read-only query normalization and curated-ingest validation; not a Hermes memory provider.
- `scripts/graphiti-agent-wrapper.py` - CLI entrypoint for safe status, query, validate-ingest, and curated ingest operations.
- `seeds/initial-approved-episodes.json` - sanitized representative seed episodes for provenance/query smokes.
- `tests/test_agent_graphiti.py` - unit tests for query normalization, service-down degradation, redaction/sanitization, seed validation, and destructive-path rejection.
- `patches/ingest.py` - reviewed tori-local patch for the pinned Graphiti async ingest bug.
- `scripts/openrouter-guardrail-preflight.py` - exact-model guardrail probe for OpenRouter.
- `scripts/deploy-tori-local.sh` - gated deployment helper; supports read-only preflight and refuses live mutation unless explicitly approved.
- `scripts/verify-loopback-exposure.sh` - non-invasive listener check for unsafe all-interface raw Graphiti/Neo4j binds.
- `scripts/backup-neo4j-dump.sh` - gated Neo4j dump/config-snapshot/manifest automation with dry-run mode.
- `scripts/restore-neo4j-dump.sh` - gated live restore helper; destructive and intentionally harder to run than restore-test.
- `scripts/restore-test-neo4j.sh` - gated disposable restore-test automation that writes sanitized NAS evidence.
- `runbooks/production-architecture-rollout.md` - production architecture, boundaries, rollout order, and acceptance gates.
- `runbooks/production-runbook.md` - current production operator runbook and handoff.
- `runbooks/deploy-read-only-service.md` - reviewed deployment checklist.
- `runbooks/backup-restore.md` - backup, restore, and restore-test plan.
- `runbooks/dashboard-status-design.md` - Home Dashboard status/freshness design.
- `runbooks/read-only-agent-wrapper.md` - wrapper/tool contract that prevents direct destructive access.
- `runbooks/curated-ingest-policy.md` - production policy for allowed sources, redaction, grouping, temporal review, seed sets, and OpenRouter spend controls.
- `receipts/` - sanitized machine-readable deployment/preflight/smoke/backup receipts; no secrets or raw graph data.

## Guardrails

1. Do not expose raw Graphiti to agents. It has destructive endpoints.
2. Do not expose raw Graphiti or Neo4j publicly.
3. Do not place live Neo4j data on NAS/NFS/CIFS/FUSE.
4. Do not commit rendered `.env`, API keys, Neo4j passwords, dumps, raw graph exports, or raw transcripts.
5. Do not treat Graphiti as a replacement for mem0.
6. Do not treat Graphiti as source-of-truth live state. Verify the actual host/service before remediation.
7. Do not run destructive live restore without a successful restore test for the exact dump and a separate explicit approval gate.
