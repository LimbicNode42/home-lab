# mem0 namespace design — canonical decision note

Status: recommendation (read-only investigation; no live config/gateway/provider
change performed in this task). Chosen model recorded below for the implement
child (t_1a35c714). No secrets or memory contents included.

Parent epic chain: t_1b099c67 (backfill) → t_5b1f2f0d (apply) → this spec.

## 1. Ground truth: how each profile derives its mem0 namespace

The Hermes mem0 plugin source is at
`/usr/local/lib/hermes-agent/plugins/memory/mem0/__init__.py` (v0.20.1).

- Config is loaded by `_load_config()`, which reads env vars
  (`MEM0_MODE`, `MEM0_USER_ID`, `MEM0_AGENT_ID`, `MEM0_HOST`, `MEM0_API_KEY`)
  and then overlays `$HERMES_HOME/mem0.json` (canonical home for non-secret
  `mode` / `host` / `user_id` / `agent_id`).
- Per-profile `mem0.json` is what actually pins each isolate:

  | Profile  | HERMES_HOME mem0.json            | `user_id`    | `agent_id` |
  |----------|----------------------------------|--------------|------------|
  | default  | `/root/.hermes/mem0.json`        | (unset)      | `hermes`   |
  | domovoi  | `/root/.hermes/profiles/domovoi`  | `ben-domovoi`| `domovoi`  |
  | kobold   | `/root/.hermes/profiles/kobold`   | `ben-kobold` | `kobold`   |
  | gremlin  | `/root/.hermes/profiles/gremlin`  | `ben-gremlin`| `gremlin`  |
  | sentinel | `/root/.hermes/profiles/sentinel` | `ben-sentinel`| `sentinel` |
  | scribe   | `/root/.hermes/profiles/scribe`   | `ben-scribe` | `scribe`   |

- `initialize()` resolves `user_id` in this order: operator-configured
  `MEM0_USER_ID`/`mem0.json` → gateway-native id (kwargs) → literal
  `hermes-user` placeholder. A configured `user_id` wins and is applied across
  every gateway for that profile.

Treat the `_load_config()`/`initialize()` read as authoritative over the older
doc in `docs/memory/mem0-hermes-integration.md`, which claims `default` uses
`ben-default`; the live `mem0.json` for `default` carries no `user_id`, so it
falls through to `hermes-user` (or the gateway id) today. That doc is slightly
drifted from live state.

## 2. The decisive read-path fact

- `_read_filters()` returns exactly `{"user_id": self._user_id}` — **reads are
  scoped to `user_id` only**, never `agent_id`. The in-source comment states
  this is deliberate: recall should surface everything written under one
  principal, with `agent_id` retained only for attribution on writes.
- The self-hosted `SelfHostedBackend.search()` posts that single `user_id` in
  `filters`. There is no multi-user / wildcard union read exposed through the
  plugin; a profile reads ONE `user_id` namespace per `mem0_search`.

Consequence: a fact written under `user_id="ben-kobold"` is visible **only** to
a profile whose resolved `user_id` is also `ben-kobold`. The 14 durable facts
landed in `ben-kobold` because the one-shot apply card wrote through kobold's
own plugin, while the continuous reconciler's `Mem0Writer` defaults to
`ben-gremlin`. Two write paths, two principals.

## 3. Recommendation: single canonical `ben` user_id (convergence)

Chosen model: **one canonical principal `user_id="ben"` for durable personal
facts, with per-agent `agent_id` retained for attribution.** All five worker
profiles + `default` converge onto `user_id="ben"`; each keeps its distinct
`agent_id` (`kobold`, `gremlin`, `sentinel`, `scribe`, `domovoi`, `hermes`).

Why convergence over per-profile replication:

1. It matches the plugin's own design intent — `user_id` is the human
   principal, `agent_id` is the writer's attribution. Today's `ben-<profile>`
   values conflate "profile" into what the plugin models as "person", which is
   the root cause of the 1-of-5 visibility defect.
2. Single source of truth — aligns with Ben's IaC/source-of-truth posture and
   the stated goal "durable facts reduce future steering."
3. Replication (writing each durable fact into N isolates) is write-amplifying,
   needs per-namespace dedup, and is drift-prone over a long-lived store.
4. One namespace means the reconciler writes to one target and every profile's
   `mem0_search` returns the same merged facts.

Trade-off (explicit, non-blocking): convergence collapses per-profile memory
isolation. A worker's own `mem0_add` (e.g. kobold storing a working fact
mid-task) will land in the shared `ben` store and become visible to all
profiles. This is consistent with "durable facts about Ben," but it is a
behaviour change beyond the 14 facts. `agent_id` + `metadata.channel` remain
attached on every write, so per-agent/per-channel views are still recoverable
at query time via the API even though the plugin's default read is user-scoped.

If Ben wants strict per-profile working-memory isolation preserved, the fallback
model is **per-profile replication** of durable facts into each isolate — but
this is not recommended for the drift/maintenance reasons above, and it does
not fix the plugin's single-user-id read limit by itself (each profile would
still only read its own isolate; a shared "read-everything" view would still
require the canonical principal).

## 4. Concrete change list (split by who applies it)

### A. Worker-applicable (reconciler code + repo; no gateway change)

1. `memory_reconciler/config.py` — change `DEFAULT_MEM0_USER_ID` default from
   `"ben-gremlin"` to `"ben"`. Leave `DEFAULT_MEM0_AGENT_ID =
   "memory-reconciler"` (the reconciler is a distinct writer).
2. `.env.example` — set `MEMORY_RECONCILER_MEM0_USER_ID=ben`.
3. `runbooks/operate.md` — document the canonical `ben` principal and that
   `agent_id` remains `memory-reconciler` for attribution.
4. (No change to `writers.py` — it already reads the user/agent from config.)
5. Re-write the 14 durable facts into `user_id="ben"` **additively**. Do NOT
   delete the `ben-kobold` originals unless Ben explicitly approves deletion;
   prefer supersession/re-write. The reconciler dedup ledger
   (`/var/lib/memory-reconciler/state.db`, keyed `source,task_id,run_id,target`)
   has no record of the 14 (they bypassed the reconciler), so the additive
   re-write is a fresh write and must also be recorded so the continuous
   reconciler does not later double-write.

### B. Ben-gated (gateway-touching profile config — Ben edits himself)

Edit each `$HERMES_HOME/mem0.json` to set `"user_id": "ben"` and keep the
existing `agent_id`. Files:

- `/root/.hermes/mem0.json`                              → add `"user_id": "ben"`
- `/root/.hermes/profiles/domovoi/mem0.json`             → `user_id` → `ben`
- `/root/.hermes/profiles/kobold/mem0.json`              → `user_id` → `ben`
- `/root/.hermes/profiles/gremlin/mem0.json`             → `user_id` → `ben`
- `/root/.hermes/profiles/sentinel/mem0.json`            → `user_id` → `ben`
- `/root/.hermes/profiles/scribe/mem0.json`              → `user_id` → `ben`

Each profile starts a fresh session after the edit so `initialize()` reloads
`mem0.json` (cached tools will otherwise keep the old `user_id`). The
`default` profile's `agent_id` stays `hermes`; do not drop `host`/`mode`.

These edits are the only gateway-touching items. They do not require a gateway
restart (config is read at session init), but because they change the
`default`/active profile's live memory principal, Ben applies them himself per
the standing continuity preference.

## 5. Reconciler writer change (summary)

`writers.py` already passes `config.mem0_user_id` / `config.mem0_agent_id`; the
only code delta is the default flip in `config.py` (item A1) plus the env
template (A2). Result: future durable facts write to `user_id="ben"`,
`agent_id="memory-reconciler"` — and, after Ben applies B, every profile reads
that same principal.

## 6. Rollback

1. Revert `config.py` default to `"ben-gremlin"` and `.env.example` to
   `ben-gremlin`; commit. (Reconciler-only; no profile impact.)
2. Revert each `mem0.json` `user_id` back to its prior `ben-<profile>` value
   (or remove the `user_id` key for `default`). Start fresh sessions.
3. The additive `ben` facts remain but become invisible to per-profile reads
   once `user_id` reverts (they live under `user_id="ben"`); they are not
   deleted and can be re-exposed by re-applying the convergence. The `ben-kobold`
   originals stay untouched throughout, so rollback loses nothing.

No provider switch and no gateway restart are involved at any step.

## 7. Open item (Ben confirm, non-blocking for this spec)

The one decision Ben must explicitly sign off before the implement child runs:
**collapse all profiles onto `user_id="ben"` (recommended) vs. keep per-profile
isolates and replicate durable facts (fallback).** All gateway-touching edits in
§4B wait on that approval.