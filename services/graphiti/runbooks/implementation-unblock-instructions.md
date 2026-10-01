# Graphiti + Neo4j implementation unblock instructions

Task: `t_78b195bc`

This service configuration is ready to run only after the OpenRouter/Vaultwarden prerequisite is cleared. The current blocker is secret-manager access, not a design question.

## Current blocker

`bw status` in this worker environment reports `locked`; no `BW_SESSION` or `BW_PASSWORD` is exported. Because the Graphiti deployment credential path cannot be read, this worker cannot rerun the required OpenRouter guardrail preflight and must not start live services.

## Required human action

Unlock Vaultwarden for the kobold worker or provide a short-lived session through the worker environment:

```bash
bw config server http://192.168.0.50:8084
export BW_SESSION="$(bw unlock --raw)"
```

Required Vaultwarden references, under the case-sensitive folder currently documented as `Homelab`:

- `graphiti/openrouter`
  - login password or custom field `api_key` -> `OPENROUTER_API_KEY`
  - base URL remains `https://openrouter.ai/api/v1`
  - completion/rerank/small model remains `openai/gpt-4o-mini`
  - embedding model remains `openai/text-embedding-3-small`
  - expected embedding dimension remains `1536`
- `graphiti/neo4j`
  - `username`
  - `password`

## Safe run order after unblock

From `/root/work/home-lab` or a reviewed copy of this repo:

```bash
eval "$(scripts/secrets/bw-login-vaultwarden.sh)"
services/graphiti/scripts/deploy-tori-local.sh --preflight-only
```

The preflight-only mode performs no live mutation. It must pass before any service start.

Only after that passes, and only under an approved deploy card:

```bash
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
  services/graphiti/scripts/deploy-tori-local.sh --apply
```

After the containers are started, capture the loopback exposure receipt:

```bash
GRAPHITI_VERIFY_HOST=root@192.168.0.20 \
  services/graphiti/scripts/verify-loopback-exposure.sh \
  /tmp/graphiti-listen-scope-after-deploy.txt
```

## Acceptance receipts to capture before production-ready

Do not call the service production-ready until receipts exist for:

1. OpenRouter exact model preflight: chat HTTP 2xx, embedding HTTP 2xx, observed embedding dimension `1536`.
2. Neo4j readiness on tori-local disk. `findmnt -T /var/lib/graphiti/neo4j/data` must not report NFS/CIFS/fuse.
3. Raw Graphiti/Neo4j ports bound only to loopback unless a later review approves a LAN-only authenticated wrapper.
4. Disposable ingest/query/provenance smoke using a unique test group and sanitized data only.
5. Backup dump manifest under NAS Graphiti backup path.
6. Isolated restore-test evidence under NAS Graphiti restore-test path.

No Cloudflare Tunnel route, public Traefik route, mem0 provider switch, raw agent-facing clear/delete endpoint, or committed secret is part of this unblock.
