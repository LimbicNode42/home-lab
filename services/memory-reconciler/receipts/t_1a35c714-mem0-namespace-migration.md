# mem0 canonical namespace migration receipt — t_1a35c714

- Applied by: gremlin
- Task: t_1a35c714
- Decision doc: plans/mem0-namespace-decision.md (parent t_d62298a4)
- Chosen model: single canonical principal `user_id="ben"`, per-agent `agent_id`
  retained for attribution (convergence; per-profile replication rejected).

## What was done (worker-applicable only — no gateway-touching change)

1. Reconciler writer now targets the canonical principal:
   - `memory_reconciler/config.py` `DEFAULT_MEM0_USER_ID` -> `"ben"` (agent_id stays
     `"memory-reconciler"`).
   - `memory_reconciler/cli.py` `--mem0-user-id` default -> `"ben"`.
   - `.env.example` `MEMORY_RECONCILER_MEM0_USER_ID=ben`.
   - `scripts/render-env.sh` renders `MEMORY_RECONCILER_MEM0_USER_ID=ben`.
   - `runbooks/operate.md` §1 documents the canonical `ben` principal and the
     no-regression rule.
2. Migrated the 14 durable facts additively into `user_id="ben"` with
   `agent_id="memory-reconciler"`, `infer=False` (verbatim copies — no LLM
   rephrasing). No `ben-kobold` original was deleted.
3. Dashboard mem0 status publisher now enumerates all six profiles
   (`default`, `domovoi`, `kobold`, `gremlin`, `sentinel`, `scribe`) instead of
   `{default, kobold}` — still coarse provider/enabled booleans only, no
   content or secrets.
4. Live runtime `.env` (`/opt/memory-reconciler/.env`, mode 0600) updated so the
   next scheduled 04:15 timer fire writes to `user_id="ben"` — runtime-only fix,
   not committed (the env file is secret-bearing).

## Verification (counts + namespace only, non-secret)

- `user_id="ben"` now holds 14 memories, all `agent_id="memory-reconciler"`.
- Exact-phrase match against the 14 backfill facts: **14 / 14**.
- `ben-kobold` originals: still **14 / 14** present (no deletes anywhere).
- Deletes performed: 0 against any pre-existing row. (During the first migration
  attempt the 14 copies were inadvertently written with `infer=True`, which
  rephrased them; those 14 non-verbatim copies — all `agent_id="memory-reconciler"`
  under the previously-empty `ben` principal — were removed and re-written
  verbatim with `infer=False`. Zero originals touched.)
- Dedup ledger `(source, task_id, run_id, target)` semantics unchanged; the 14
  facts bypassed the reconciler and remain un-ledgered (as they were), so no
  double-write path is introduced by this migration.

## Ben-gated (NOT performed by a worker — requires Ben's edits)

Convergence is not observable end-to-end until each profile reads `user_id="ben"`.
Ben must apply these 6 gateway-touching `mem0.json` edits himself (per his
standing continuity preference). Each profile then starts a fresh session so
`initialize()` reloads `mem0.json`:

- `/root/.hermes/mem0.json`                              -> add `"user_id": "ben"`
- `/root/.hermes/profiles/domovoi/mem0.json`             -> `"user_id": "ben"`
- `/root/.hermes/profiles/kobold/mem0.json`              -> `"user_id": "ben"`
- `/root/.hermes/profiles/gremlin/mem0.json`             -> `"user_id": "ben"`
- `/root/.hermes/profiles/sentinel/mem0.json`            -> `"user_id": "ben"`
- `/root/.hermes/profiles/scribe/mem0.json`              -> `"user_id": "ben"`

Keep each profile's existing `agent_id`, and do NOT drop `host`/`mode` in files
that have them. The `default` profile keeps `agent_id="hermes"`. No gateway
restart is required (config is read at session init).

## Post-Ben-gate residual (for the sentinel verify child)

Until Ben applies the 6 `mem0.json` edits, a non-converged profile still reads
its own `ben-<profile>` isolate and will NOT surface the canonical `ben` facts by
default — that is expected and is exactly the Ben-gated half of this change.