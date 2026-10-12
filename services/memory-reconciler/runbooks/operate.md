# memory-reconciler — operator runbook (pause / tune / rollback / operate)

Status: operator runbook for the memory-reconciler pipeline. Companion to
`services/graphiti/runbooks/curated-ingest-policy.md` (the ingest policy — this
runbook references it rather than restating it) and
`services/graphiti/runbooks/backup-restore.md` (the restore path).

This runbook is Git-committable and contains no secrets. Every value below is a
non-secret literal or a Vaultwarden folder/item/field reference.

## 1. What the pipeline does, and its safety stance

The memory-reconciler is a period-driven, read-only ingest pipeline that turns
**done** Kanban tasks into two downstream artifacts, both tori-local:

1. **durable mem0 facts** — high-signal facts only (preferences, stable
   environment facts, conventions, lasting decisions).
2. **curated Graphiti episodes** — advisory, provenance-bearing episodes built
   exclusively through the reviewed `services/graphiti/agent_graphiti` package
   (`validate_episode(sanitize=True)` + `to_graphiti_payload()`).

The safety stance is **advisory/ provenance, never source-of-truth**:

- It reads a read-only view over `/root/.hermes/kanban.db`, `status='done'`
  tasks only, and lifts only the latest *successful* run's `summary` plus
  curated non-secret `metadata` keys. `tasks.body` is **never** read.
- It **never** ingests raw transcripts, session-search output, or bulk logs
  (prohibited by curated-ingest-policy §3). A session-excerpt classifier is a
  stub that always returns `skip`; no session ingest exists in v1.
- Every episode is redacted/sanitized before it leaves the host; secrets are
  `[REDACTED_*]` placeholders, never values.
- Both mem0 (`127.0.0.1:8888`) and Graphiti (`127.0.0.1:8000`) are loopback-only.
  There is no public or LAN route to the reconciler or its targets.

If you ever see it moving toward "remember everything," it is misconfigured.
The pipeline is allowed to be useful; it is not allowed to become a transcript
swamp (see curated-ingest-policy §1).

### Canonical mem0 namespace

Durable facts are written to a single canonical principal **`user_id="ben"`**
with `agent_id="memory-reconciler"` (the reconciler is a distinct writer; the
`agent_id` stays for attribution). This is the convergence model recorded in
`plans/mem0-namespace-decision.md`. Do not reintroduce a per-profile
`ben-<profile>` `user_id` here: the whole point is that every Hermes profile's
`mem0_search` reads the same `user_id="ben"` principal and surfaces the same
durable facts. Any `user_id` other than `ben` in the reconciler's config/env is
a regression (rollback reversion excepted — see §5).

## 2. Cadence and trigger

- **Runtime host:** `tori` (`192.168.0.20`).
- **Schedule:** a systemd timer firing a **daily** reconcile. No per-minute loop;
  a bounded single daily trigger.
- **State DB:** `/var/lib/memory-reconciler/state.db` — tori-local ext4, never
  NAS/NFS (SQLite + NFS = corrupt ledger, and a corrupt ledger silently defeats
  dedup).
- **Runtime root:** `/opt/memory-reconciler/` (venv installed via `uv`).

Manual invocations (the `graceful-memory-reconciler` entry point / the
`scripts/graceful-memory-reconciler.py` shim) — all JSON to stdout:

```bash
# One-shot, dry-run (the default): NO writes, dedup ledger untouched.
graceful-memory-reconciler reconcile --once

# Bound the dry-run to the first N candidate records (safety valve for backlogs).
graceful-memory-reconciler reconcile --once --limit 10

# One-shot, apply (writes mem0 + Graphiti and records dedup state).
graceful-memory-reconciler reconcile --apply --once --limit 10

# Read-only inspection.
graceful-memory-reconciler status                   # dedup ledger summary
graceful-memory-reconciler query --limit 25         # what would be extracted
graceful-memory-reconciler validate --from-db       # allowlist + build check, no writes
```

`reconcile` **defaults to dry-run**; there is no `--dry-run` flag. Neither mem0,
Graphiti, nor the state ledger is touched unless `--apply` is supplied. The
`--once` flag is accepted for manual runs and is semantically the same as the
timer-driven path's single bounded batch (as of v1 it is parsed but inert — the
default `--apply`-less run is already a one-shot bounded batch).

Fire it manually (as the service user, with the rendered env present):

```bash
sudo -u <svc-user> --preserve-env \
  /opt/memory-reconciler/.venv/bin/graceful-memory-reconciler reconcile --once --limit 10
```

(Names above are the canonical shape; the exact unit names and service user are
established at deploy time by the `kobold` deployment card, and should match
what `systemctl cat memory-reconciler.timer` reports.)

## 3. Pause / unpause

Stopping the timer does **not** lose state — the dedup ledger
(`/var/lib/memory-reconciler/state.db`) is the source of idempotency and is only
ever written on `--apply`. Pausing the timer simply stops future scheduled runs.

```bash
# Pause (stop future scheduled runs, leave already-ingested state intact).
systemctl stop  memory-reconciler.timer
systemctl disable memory-reconciler.timer

# Confirm it will not fire again.
systemctl list-timers --all | grep memory-reconciler || echo "timer inactive"

# Unpause (resume the daily cadence).
systemctl enable --now memory-reconciler.timer
systemctl list-timers memory-reconciler.timer
```

To also block a **one-shot run already in flight**:

```bash
systemctl stop memory-reconciler.service
systemctl status memory-reconciler.service --no-pager
```

Stopping mid-run is safe: the reconciler has no partial-write primitive — each
target (`mem0`, `graphiti`) is recorded in the ledger only *after* its own write
succeeds, so a killed run leaves at most a completed-and-recorded side, never a
half-recorded one. Re-running skips already-seen `(source, task_id, run_id,
target)` rows.

## 4. Tune

Knobs and where each lives — **config vs code vs Vaultwarden**:

| Knob | Where it lives | How to change |
|---|---|---|
| Batch cap — max episodes per batch (25) | **code** — `memory_reconciler/config.py` `MAX_EPISODES_PER_BATCH` | edit + re-test (`pytest`), policy change per curated-ingest-policy §8.3 |
| Word cap — max words/episode (1500) | **code** — `config.py` `MAX_WORDS_PER_EPISODE` | edit + re-test, policy change |
| Max extraction attempts (2) then review bucket | **code** — `config.py` `MAX_EXTRACTION_ATTEMPTS` | edit + re-test |
| Model allowlist (completion/rerank/embedding + dim 1536 + base URL) | **code** — `config.py` `ALLOWED_*`; also surfaced in `.env` | change is fail-closed: any mismatch *raises* and stops the run. Do not loosen without a reviewed policy update (§8.1) |
| Schedule (daily) | **systemd timer** — `memory-reconciler.timer` `OnCalendar=` | edit unit, `systemctl daemon-reload` |
| Host/ports — mem0 / Graphiti / kanban DB / state DB paths | **config** — `.env` (`MEMORY_RECONCILER_*`), rendered to `/opt/memory-reconciler/.env` mode 0600 | re-render from Vaultwarden |
| API keys / OpenRouter key | **Vaultwarden only** — folder `Homelab`, items `mem0/server` (`api_key`) and `graphiti/openrouter` (login `password`); model/embedding shape is non-secret `.env` literal | update in Vaultwarden, re-render `.env`; keys are never in Git or logs |
| Group/domain mapping (which `group_id` a record lands in) | **code** — `memory_reconciler/episode_builder.py` `domain_for_record` / `group_id_for_record` | edit + re-test; honors curated-ingest-policy §6 domain/group strategy |

**Never** commit a rendered `.env` or any value. Git carries only the reference
map `config/vaultwarden-map.example.yml` and the `.env.example` template. Fresh
secrets and schedule changes are the two things that most often tempt an
operator to bypass `--dry-run` — resist; the pipeline is fail-closed on purpose.

## 5. Rollback

Two layers, in this order of preference. **Do not raw-delete mem0 facts or
Graphiti episodes unless an explicit destructive-approval card authorizes it.**

### 5a. Advisory supersession / correction (preferred)

Graphiti facts carry `valid_at` / `invalid_at` and an explicit `supersedes`
list. To correct an ingested episode without destroying history:

1. Ingest a **supersession episode** whose fact names the prior `episode_id`
   (`kanban:<task_id>:completion`) and sets `invalid_at` to the correction time.
   Per curated-ingest-policy §7, a derived `invalid_at` is *advisory* until
   reviewed — record the supersession explicitly and cite its source.
2. For mem0, correct by adding/updating the corrected fact (preferred) rather
   than deleting the old one — mem0's personal/preference store is treated as
   the durable memory; a correction is a new declarative fact, not a blind
   `DELETE`.

The pipeline's own `source_type` supports `decision_supersession` for exactly
this shape (`episode_builder.build_episode`), so a reviewed supersession can flow
back through the normal curated path.

### 5b. Restore from NAS (if the graph or ledger itself is bad)

For a broken Neo4j graph (not for a single bad fact), follow
`services/graphiti/runbooks/backup-restore.md`:

- Restore **test** first against the exact dump (`restore-test-neo4j.sh`), into a
  disposable container — never against live data.
- Live restore (`restore-neo4j-dump.sh`) is destructive and requires a separate
  approved restore card plus all three gates
  (`GRAPHITI_ENABLE_LIVE_MUTATION`, `GRAPHITI_RESTORE_TARGET=live-neo4j`,
  `GRAPHITI_RESTORE_PRE_SNAPSHOT_CONFIRMED`) — plus a successful restore test and
  a filesystem snapshot of the current data path.

Note the reconciler's own **state ledger** (`/var/lib/memory-reconciler/state.db`)
is tori-local and currently has no dedicated backup hooking stated in v1. If you
must reset it, back it up by file copy *before* touching it; a lost ledger means
dedup is lost and re-runs become re-ingests. Flag ledger backup as a gap if it
becomes a recurring concern.

## 6. Observability

**Logs.** The CLI emits JSON to stdout/stderr:
- `status` → `{status, state: {total_rows, mem0, graphiti}, state_db}`
- `query` → `{status, count, results:[...]}`
- `validate` → `{status, episodes_built, episodes_failed, errors, sample_group_ids}`
- `reconcile` → `{status, report: {seen, processed, mem0_written, graphiti_written, failed, dry_run, review_bucket:[...]}}`

Errors are normalized to a non-secret JSON envelope on stderr
(`{status:"error", error, message}`) with exit code 2. Credentials are never
logged (the config `__repr__` omits keys; upstream responses are reduced to
non-secret scalar fields).

**Receipts.** The durable idempotency record is the state ledger itself:
`/var/lib/memory-reconciler/state.db`, `ingested` table keyed
`(source, task_id, run_id, target)`. Sanitized run receipts (redaction counts,
state-row count, episode count — no secrets) are the deploy card's deliverable
and follow the existing Git convention `services/graphiti/receipts/*.json`.

**Home Dashboard.** The Overview freshness/status signal reflects the reconciler
only insofar as the deploy card wires it (see
`services/graphiti/runbooks/dashboard-status-design.md`). Interpreting it:

- **Fresh** (`latest_*` timestamps recent, counts advancing): scheduled runs are
  landing and being recorded.
- **Degraded** (state present but stale `latest_episode_at`, or
  `mem0_written`/`graphiti_written` flat while `failed` climbs): a downstream
  target is down or an allowlist/budget guardrail is tripping. Correlate with the
  reconciler's own last `reconcile` report — `failed` and `review_bucket` are the
  two fields to read first.
- **Missing** (no signal at all): the dashboard publisher never saw the
  reconciler — check whether the timer fired (`systemctl list-timers`), whether
  the service ran (`systemctl status`), and whether the dashboard publisher
  itself is healthy. A missing freshness signal is a **service problem**, not a
  "quiet day": a daily run that ingests nothing still records a run and should
  still update freshness.

Do not expect the reconciler to emit dashboard bytes, mem0 secrets, or raw graph
content — that is explicitly out of scope and prohibited.

## 7. Failure modes

### Partial failure — one target up, one down

Each target is recorded in the state ledger **independently**, so a run where
mem0 succeeds but Graphiti is down records `mem0` and leaves `graphiti` pending.
On the next run, the already-seen `mem0` side is skipped and only the missing
`graphiti` side retries. Consequence: a partial failure degrades to the one
failed side; nothing is duplicated and nothing is silently dropped.

### Dedup state skipping an item it shouldn't

The ledger key is `(source, task_id, run_id, target)`. You will see `seen` in the
report and the item won't re-ingest. Legitimate reasons: the item was already
ingested, or `run_id` advanced (a later `completed` run supersedes the earlier).
If you believe an item was wrongly skipped, inspect the ledger directly:

```bash
sqlite3 /var/lib/memory-reconciler/state.db \
  "SELECT target, ingested_at FROM ingested WHERE task_id='<id>' ORDER BY ingested_at DESC;"
```

Do **not** hand-delete rows to force a re-ingest without understanding why it was
seen — a re-ingest is idempotent only *because* of that row; deleting it and
re-running can produce a duplicate episode/fact.

### Redaction-vetoed / failed items → review bucket

Items that fail validation, redaction, a guardrail, or a downstream write are
placed in the run report's **`review_bucket`** (a list of `{task_id, run_id,
reason}`), with reasons drawn from `mem0_write_failed` and
`graphiti_build_or_ingest_failed`. The extraction budget is capped at
`MAX_EXTRACTION_ATTEMPTS = 2` so a bad item can't turn into a retry storm; beyond
that it parks in review instead of endlessly chewing model tokens.

To review and clear:

1. Read the reason from the last `reconcile` report's `review_bucket`.
2. Inspect the item with `graceful-memory-reconciler validate --from-db` (or
   `query`) to see whether the source itself is the problem (e.g. it contains
   something the redactor correctly refused, or metadata the allowlist dropped).
3. Fix the underlying cause — correct/re-review the source, or adjust a mapping —
   rather than forcing it through.
4. Retry with a bounded `--apply --limit N` run; already-seen good items skip and
   only the previously-failed items are retried.

**Redaction-vetoed items are not a bug to route around.** A veto means the
source carried something the policy forbids. Confirm remediation before letting
it back in.

### Clearing the review bucket is not "make it disappear"

The `review_bucket` is an ephemeral per-run report field, not a durable store —
it reappears on each run for items that still fail. "Clearing" it means resolving
the failures so the next run no longer lists them. There is no command that
deletes the bucket; you fix the item or you acknowledge it as a standing,
explicitly-reviewed exclusion.