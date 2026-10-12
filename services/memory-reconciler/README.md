# memory-reconciler

Curated, idempotent pipeline that turns **done** Kanban tasks into (a) durable
`mem0` facts and (b) curated `Graphiti` episodes. This is the non-secret code
layer only — deployment, review, and runbook are separate cards.

## What it does

```
done Kanban tasks  ->  extract (summary + curated metadata)
                   ->  classify (durable fact vs skip)
                   ->  dedup   (state.db keyed (source, task_id, run_id, target))
                   ->  dual-write (mem0 HTTP + Graphiti curated ingest)
```

- **Source (v1, allowlist-first):** read-only over `/root/.hermes/kanban.db`,
  `status='done'` tasks only, latest successful run's `summary` + curated
  non-secret `metadata`. `tasks.body` is NEVER read.
- **mem0:** only durable, high-signal facts (preferences, stable environment
  facts, conventions, lasting decisions). Task-progress logs, "shipped X", PR
  numbers, commit SHAs, file counts are skipped.
- **Graphiti:** curated episodes built through the existing
  `services/graphiti/agent_graphiti` package (`validate_episode(sanitize=True)`
  + `to_graphiti_payload()`). No new redactor.

## Dedup / idempotency

State lives in a local SQLite ledger at `/var/lib/memory-reconciler/state.db`
(tori-local disk, NOT NAS/NFS), keyed `(source, task_id, run_id, target)`. Each
target (`mem0`, `graphiti`) is recorded independently, so a partial failure loses
track of only the side that failed. Re-running over already-seen items is a
no-op.

## Boundaries (curated-ingest-policy section 8)

- max 25 episodes/batch
- max 1500 words/episode
- model allowlist: `openai/gpt-4o-mini` completion + rerank,
  `openai/text-embedding-3-small` embeddings (dim 1536) — fail-closed on any mismatch
- max 2 extraction attempts per item, then a "review" bucket (no retry storm)

## CLI

```
graceful-memory-reconciler status
graceful-memory-reconciler query [--limit N]
graceful-memory-reconciler validate [--file fixtures.json | --from-db]
graceful-memory-reconciler reconcile [--apply] [--limit N] [--once]
```

`reconcile` defaults to **dry-run**. It never writes mem0/Graphiti or the state
ledger unless `--apply` is passed.

## Secrets

No secret values are committed. Everything is a Vaultwarden
folder/item/field reference (see `config/vaultwarden-map.example.yml`) rendered
into `/opt/memory-reconciler/.env` (mode 0600, in Vaultwarden) — the template is
`.env.example`.

## Out of scope (v1)

Session/transcript ingest is prohibited by the curated-ingest policy (section 3).
A stub classifier (`classify.py`) marks a future review-gated session extractor;
it is not implemented.

## Test

```
cd services/memory-reconciler
python -m pytest tests/
```