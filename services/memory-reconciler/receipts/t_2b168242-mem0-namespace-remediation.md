# mem0 canonical namespace remediation receipt — t_2b168242

- Applied by: gremlin
- Task: t_2b168242 (remediate: finish canonical mem0 namespace rollout)
- Parent epic: t_ada9d451 (canonical mem0 namespace)
- Canonical decision: single principal `user_id="ben"`, per-agent `agent_id`
  retained for attribution; all six profiles converge on `ben`. (Not re-decided
  here — recorded in `plans/mem0-namespace-decision.md`.)

## 1. writer-target — deployed namespace-aware reconciler code

Flipped the live `/opt/memory-reconciler` source defaults from `ben-gremlin` to
`ben` so a future `render-env.sh` regeneration cannot revert the write target:

- `memory_reconciler/config.py` — `DEFAULT_MEM0_USER_ID` default `"ben"` (plus the
  canonical-principal comment block).
- `memory_reconciler/cli.py` — `--mem0-user-id` default `"ben"`.
- `render-env.sh` — emits `MEMORY_RECONCILER_MEM0_USER_ID=ben`.

Verified (read-only): `.env` already carries `MEMORY_RECONCILER_MEM0_USER_ID=ben`;
code defaults now also resolve to `ben`; `grep -rn ben-gremlin` across
`/opt/memory-reconciler` (excluding `.venv`/`__pycache__`) returns zero hits.
No Hermes gateway restart and no gateway-touching config edit performed. The
memory-reconciler systemd service was not restarted (`.env` already forced `ben`,
so the live write target was already canonical).

## 2. raw-memory-git-runbook — sanitized the backfill plan

`services/memory-reconciler/plans/mem0-backfill-plan.md` no longer carries the
verbatim 14-fact corpus. Each of the 14 entries is now identified by a
non-reversible SHA-256 fingerprint (first 16 hex chars) plus a category label;
the fact text itself is held only in the private apply receipt and the live mem0
store. The sanitized version is what is committed to `origin/master`.

Flagged for Ben: the two origin worktree branches `wt/t_1d8377d3` and
`wt/t_5685e9a0` still carry the raw corpus in their history (ancestor commit
`192bdaf`). Whether to sanitize or delete those branches is Ben's call — no
force-push to origin was performed.

## 3. dashboard-truthfulness — deployed + ran the 6-profile publisher

Deployed the converge version of
`services/personal-dashboard/scripts/publish-mem0-status.sh` (enumerates all six
profiles) to the live path
`/mnt/pve/NAS/services/personal-dashboard/scripts/publish-mem0-status.sh` and ran
it once. The live
`/mnt/pve/NAS/services/personal-dashboard/mem0/status.json` now enumerates all six
profiles (`default`, `domovoi`, `kobold`, `gremlin`, `sentinel`, `scribe`) with
coarse `provider`/`configured`/`enabled` booleans only — no content, no secrets,
no two-profile green.

## 4. source-of-truth — non-secret reconciler source committed to master

Committed the non-secret reconciler source (config.py, cli.py, .env.example,
render-env.sh, operate.md, the namespace decision doc, the sanitized backfill
plan, the publisher, and the remaining non-secret reconciler files) to
`origin/master`. The raw backfill corpus was NOT merged. `git diff --check` is
clean; a secret-pattern scan found only redaction test fixtures with placeholder
values (no real secret-shaped values).

## Safety conformance

- No deletes of existing mem0 data (additive/idempotent only).
- No provider switch away from mem0.
- No Hermes gateway restart or gateway-touching config edit.
- No secret/content leakage into Git/Kanban/dashboard/logs.
- Graphiti/Neo4j loopback posture untouched.
