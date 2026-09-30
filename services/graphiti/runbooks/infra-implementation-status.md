# Graphiti infra implementation status — 2026-09-30

Task: `t_5a650bed`

Status: blocked before live deployment.

## What was verified

Read-only checks completed against the current repo and target host:

- Graphiti scaffold scripts still parse:
  - `python3 -m py_compile services/graphiti/scripts/openrouter-guardrail-preflight.py`
  - `bash -n services/graphiti/scripts/*.sh`
  - `git diff --check -- services/graphiti`
- Tori is reachable by SSH as `root@192.168.0.20`.
- Tori Docker is present: `Docker version 26.1.5+dfsg1, build a72d7cd`.
- No existing Graphiti/Neo4j containers were observed by the bounded read-only probe.
- `/var/lib` is local ext4 on tori, suitable as the intended parent for Neo4j live data after approval.
- `/mnt/pve/NAS/services` is reachable as NFS from `192.168.0.250:/export/nas`, suitable for future dump/snapshot/restore-test evidence.
- No listeners were observed on `7474`, `7687`, or `8000` during the bounded probe.

## Blocker

The OpenRouter guardrail preflight failed using the current deployment credential path available to this worker:

- base URL: `https://openrouter.ai/api/v1`
- completion model: `openai/gpt-4o-mini`
- embedding model: `openai/text-embedding-3-small`
- completion probe: HTTP `403`, classified as `possible_workspace_guardrail_or_allowlist_block`
- embedding probe: HTTP `403`, classified as `possible_workspace_guardrail_or_allowlist_block`

No API key or secret value is recorded in this repo. The sanitized machine-readable receipt is `services/graphiti/receipts/2026-09-30-infra-preflight.json`.

## Safety state

No live homelab mutation was performed. The task did not create `/opt/graphiti`, `/var/lib/graphiti`, NAS Graphiti directories, containers, public routes, Traefik routes, Cloudflare routes, or Hermes memory-provider changes.

This is intentionally a hard stop: production gate 1 failed, and continuing would only produce a handsomely documented lie. We already have enough of those in the industry.

## Required human action

Provide or allow a Graphiti/OpenRouter deployment credential that can access both required models through OpenRouter:

- `openai/gpt-4o-mini` for completion/rerank/small model
- `openai/text-embedding-3-small` with observed dimension `1536`

Preferred shape: store/update the credential in Vaultwarden under folder `homelab`, item `graphiti/openrouter`, field `api_key`, then unblock this task so the preflight can be rerun before any deployment.
