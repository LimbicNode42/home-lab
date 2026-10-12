# memory-reconciler — deployment change note (t_1bdadf8f)

Auditable record of what was installed, where, how it's scheduled, and how to
pause it. No secrets. Companion to the sanitized receipt at
`receipts/2026-10-03-deploy-receipt.json` and the operator runbook
`runbooks/operate.md`.

## What was installed

- **Runtime root** `/opt/memory-reconciler/` — the `memory_reconciler` package
  (byte-identical to `services/memory-reconciler/memory_reconciler/` in the repo)
  plus a durable entry-point shim at `bin/graceful-memory-reconciler`.
- **Sibling Graphiti package** `/opt/graphiti/agent_graphiti/` — a durable copy of
  `services/graphiti/agent_graphiti/` so the reconciler's episode-build import
  survives worktree GC (it is NOT worktree-bound).
- **venv** `/opt/memory-reconciler/.venv` (uv, CPython 3.11.15). Pure-stdlib code;
  no third-party dependencies installed.
- **State DB** `/var/lib/memory-reconciler/state.db` — tori-local ext4 (never
  NAS/NFS). Dedup ledger keyed `(source, task_id, run_id, target)`.

## How it authenticates (Vaultwarden references only)

Rendered `.env` (mode 0600) from Ben's Vaultwarden, folder `Homelab`:
- `mem0/server` field `api_key` → `MEM0_API_KEY`
- `graphiti/openrouter` field `login.password` → `GRAPHITI_OPENROUTER_API_KEY`

Git carries only `config/vaultwarden-map.example.yml` (reference map),
`.env.example` (shape), and `scripts/render-env.sh` (renderer). Never values.
Verified: rendered `MEM0_API_KEY` returns HTTP 200 on `POST /memories`.

## How it's scheduled

- **systemd service** `memory-reconciler.service` (`Type=oneshot`, `EnvironmentFile=/opt/memory-reconciler/.env`, `RuntimeMaxSec=900`, no privileged steps).
- **systemd timer** `memory-reconciler.timer` — `OnCalendar=*-*-* 04:15:00`,
  `RandomizedDelaySec=300`, `Persistent=true`. Fires daily, one bounded batch
  (25 episodes max). No per-minute loop.

## How to pause

```bash
systemctl stop  memory-reconciler.timer
systemctl disable memory-reconciler.timer
# manual / one-shot runs still available:
#   /opt/memory-reconciler/.venv/bin/python /opt/memory-reconciler/bin/graceful-memory-reconciler reconcile --once          # dry-run (default)
#   /opt/memory-reconciler/.venv/bin/python /opt/memory-reconciler/bin/graceful-memory-reconciler reconcile --apply --once --limit N
```

## Safety stance

- Read-only over `/root/.hermes/kanban.db` (`status='done'`, latest completed run
  summary + curated metadata only; `tasks.body` never read).
- `reconcile` defaults to dry-run; nothing writes without `--apply`.
- Fail-closed model/embedding allowlist (gpt-4o-mini + text-embedding-3-small,
  dim 1536) + 25/batch + 1500-words budgets.
- Rollback = advisory supersession/invalid_at + mem0 add-only correction, NOT raw
  delete. mem0 and Graphiti are never cleared.

## First ingest result (bounded)

`--apply --once --limit 25`: 25 processed, 14 Graphiti episodes + (after env fix) 2
mem0 facts; 29 dedup rows total; 8 mem0 facts + 50 Graphiti searchable facts
verified live. No secrets, no destructive operation.