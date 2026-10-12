# Graphiti infra implementation status — 2026-10-01

Task: `t_78b195bc`

Status: ready-to-run blocked configuration; no live deployment performed.

## What was implemented

This task finalized the non-secret tori-local deployment configuration while preserving the deployment gate from the parent audit:

- `services/graphiti/docker-compose.tori.yml`
  - production template for tori-local Graphiti + Neo4j
  - Graphiti, Neo4j HTTP, and Neo4j Bolt bind to `127.0.0.1` only
  - Neo4j live `/data` binds to `/var/lib/graphiti/neo4j/data` by default, which is local disk on tori
  - NAS paths are used only for backup dumps, config snapshots, manifests, and restore-test evidence
- `services/graphiti/graphiti.env.map.example`
  - pipe-format Vaultwarden map for the repo-wide secret rendering helpers
  - references folder `Homelab` (case-sensitive), item `graphiti/openrouter`, LOGIN password for the current OpenRouter key placement
  - references folder `Homelab`, item `graphiti/neo4j`, fields `username` and `password`
- `services/graphiti/scripts/deploy-tori-local.sh`
  - repo-root helper that runs the Vaultwarden-backed OpenRouter preflight first
  - supports `--preflight-only` for no-mutation validation
  - refuses `--apply` without `GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved`
- `services/graphiti/scripts/verify-loopback-exposure.sh`
  - non-invasive `ss` receipt helper that fails on all-interface raw Graphiti/Neo4j binds
- `services/graphiti/runbooks/implementation-unblock-instructions.md`
  - exact unblock/run order for the next worker/operator
- `services/graphiti/receipts/2026-10-01-implementation-blocked.json`
  - sanitized receipt for this run

## Read-only live checks performed

Current tori state was rechecked without mutation:

- SSH to `root@192.168.0.20`: OK
- hostname: `tori`
- Docker: `Docker version 26.1.5+dfsg1, build a72d7cd`
- `/` and `/var/lib`: `/dev/sda2` ext4, local disk
- `/mnt/pve/NAS`: NFS mount from `192.168.0.250:/export/nas`; `/mnt/pve/NAS/services` reachable
- no `graphiti`/`neo4j` containers observed by the bounded name/image probe
- no listeners observed on `7474`, `7687`, or `8000`

## Current blocker

Vaultwarden remains locked in this worker environment:

- `bw status`: `locked`
- `BW_SESSION_present`: no
- `BW_PASSWORD_present`: no

Because the deployment credential path cannot be read by this worker, the OpenRouter guardrail preflight was not rerun here. Starting live services without that preflight would violate the production gate and produce the usual kind of optimistic infrastructure fiction.

## Required unblock

Unlock Vaultwarden for the worker/operator or provide an ephemeral `BW_SESSION`/`BW_PASSWORD`, then run:

```bash
cd /root/work/home-lab
services/graphiti/scripts/deploy-tori-local.sh --preflight-only
```

Only if that passes, and only under the already-approved bounded deployment gate:

```bash
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
services/graphiti/scripts/deploy-tori-local.sh --apply
```

The next live worker must still capture Neo4j readiness, Graphiti health, disposable ingest/query/provenance evidence, backup manifest, restore-test evidence, and dashboard status receipts before calling production ready.

## Safety state

No live homelab mutation was performed. This task did not create `/opt/graphiti`, `/var/lib/graphiti`, NAS Graphiti directories, containers, public routes, Traefik routes, Cloudflare routes, raw agent-facing destructive endpoints, or Hermes memory-provider changes. No secret values were printed or committed.
