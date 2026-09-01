# ASX Screener Hydration — Scheduler Ownership & Runbook

> Operator guidance, not financial advice. This document records the *single named owner* for recurring non-fixture ASX hydration, its cadence, universe denominator, failure notification path, and runbook.

## Owner

- **Job name / ID:** `asx-screener-hydration` / `6bffd5f6fff6` (enabled in the default Hermes scheduler home, `/root/.hermes`).
- **Owner profile / operator:** Ben (homelab admin), executed by the Hermes scheduler as a **no-agent** cron job running a local scheduler shim that delegates to the committed wrapper.
- **Scheduler shim (local, executable):** `/root/.hermes/scripts/run-asx-screener-hydration-owner.sh`
- **Wrapper script (committed, non-secret):** `services/personal-dashboard/scripts/run-asx-screener-hydration-owner.sh`
- **Underlying canonical workflow (committed):** `services/personal-dashboard/scripts/run-asx-screener-hydration.sh`

## Cadence

### Current approved scheduler state

- **Enabled schedule:** `0 8 * * 6` — weekly, Saturday 08:00 AEST (tori local time). This is still the previously approved bounded top-50 owner job, not a monthly or quarterly full-universe refresh.
- **Mode:** non-fixture (`asx-yahoo-timeseries`) — real Yahoo Finance hydration, never `--fixture`.
- **Regression guard:** after the 2026-08-31 supervised full-seed publish, the owner wrapper refuses an unattended bounded publish when the live latest pointer is already full-universe. That prevents the weekly top-50 job from replacing the dashboard's `1838` denominator while cadence approval is pending.

### Recommended recurring policy awaiting Ben approval

- **Monthly full-universe fundamentals refresh:** run once per month, preferably Saturday 08:00 AEST after market close/weekend quiet time, with `ASX_BATCH_OFFSET=0` and `ASX_BATCH_SIZE=1838` (or the current reviewed seed count). This keeps the dashboard's full-universe denominator explicit and avoids quarterly staleness.
- **Optional weekly smoke/freshness check:** keep a small dry-run/no-publish smoke (`DRY_RUN=1`, e.g. `ASX_BATCH_SIZE=4`) if Yahoo/provider shape monitoring is useful. A smoke job must not publish `latest.json`; otherwise it would intentionally change the dashboard denominator.
- **Quarterly-only refresh:** not recommended unless the dashboard freshness thresholds are deliberately relaxed, because the current artifact preflight still treats generated data as stale after 26 hours.

Exact scheduler proposal for approval:

```bash
# Replace the existing top-50 owner with the approved monthly full-universe owner
# after updating the scheduler shim/wrapper defaults or adding a full-universe shim.
hermes --profile default cron edit 6bffd5f6fff6 \
  --schedule '0 8 1 * *' \
  --name asx-screener-monthly-full-hydration \
  --script run-asx-screener-full-hydration-owner.sh \
  --no-agent \
  --deliver 'discord:#👟-hermes-👟'

# Optional no-publish weekly provider smoke, if Ben wants early breakage notice.
hermes --profile default cron create '0 8 * * 6' \
  --name asx-screener-weekly-smoke \
  --script run-asx-screener-smoke-owner.sh \
  --no-agent \
  --deliver 'discord:#👟-hermes-👟' \
  'Run a no-publish ASX provider smoke and emit one sanitized summary line.'
```

Both proposed shim scripts must live under `/root/.hermes/scripts/`, emit exactly one sanitized stdout line, and delegate substantive logic to committed repo wrappers.

## Universe (bounded denominator)

The recurring job hydrates a **bounded top-N batch** from the reviewed ASX company-directory seed:

- Seed: `investment-screener/universe/asx-listed-companies.seed.json` (1,838 active entries, sorted by market cap descending; source sha256 `a44aa810…`).
- Default slice: `--batch-offset 0 --batch-size 50` → `denominator_status=ranked_market_cap_batch`.
- Universe denominator labels (from `screener.py`):
  - **full seed** = `complete_exchange_listing` (offset 0, size = full 1838) — *not* the recurring default.
  - **top-N batch** = `ranked_market_cap_batch` — the recurring default.
  - **watchlist** = the 10-name `asx-watchlist.json` (smoke runs only, not production).
- The wrapper's summary line emits a 12-char `universe_hash` (sha256 of the seed file) so a seed change is visible in logs even though the full hash stays in the manifest.

## Failure notification path

- The job is a Hermes **no-agent** cron job; its stdout (the single sanitized `ASX_SCREENER …` line) is delivered to the approved ops channel (`discord:#👟-hermes-👟`), same as the homelab-health and Finnick report jobs.
- On failure the wrapper prints `[asx-screener-owner] FAILED:` plus the canonical workflow output to stderr and exits non-zero. The scheduler surfaces a non-zero exit to the ops channel.
- **Delivery path:** stdout is delivered to the approved shared ops channel (`discord:#👟-hermes-👟`), same as the homelab-health and Finnick report jobs. No dedicated ASX-only channel was configured for this task.

## Deployment record

Ben approved enabling the recurring job in kanban task `t_68024302` after reviewing the exact schedule, bounded top-50 universe, no-agent cron mechanism, and Discord delivery target. The default Hermes scheduler now has exactly one enabled ASX owner job: `asx-screener-hydration` (`6bffd5f6fff6`). The legacy kobold fixture-mode job (`11727e7f850f`, `ASX screener fixture run`) was paused rather than deleted.

### Registered scheduler entry

```yaml
id: 6bffd5f6fff6
name: asx-screener-hydration
schedule: 0 8 * * 6
script: run-asx-screener-hydration-owner.sh
mode: no-agent
deliver: discord:#👟-hermes-👟
```

The scheduler shim lives at `/root/.hermes/scripts/run-asx-screener-hydration-owner.sh` and delegates to this repo's committed wrapper. Keep the shim small; substantive workflow logic belongs in Git.

## Runbook

### Full-universe rollout gate

Keep the recurring owner job at the approved top-50 slice until a separate scheduler/deploy task changes it. Because the live latest pointer now references the supervised 2026-08-31 full-seed run (`1015/1838` usable), the owner wrapper fails closed instead of letting that top-50 job publish over the full-universe dashboard denominator. The staged top-200 expansion completed with 184/200 usable coverage, about 5–6 minutes runtime, and about 2.6 MiB of new run artifacts, but that evidence is not enough to make all-ASX unattended without approval.

The current rollout recommendation is documented in [ASX full-universe hydration rollout plan](./asx-full-universe-hydration-rollout-plan-2026-08-28.md): run one supervised top-400 prefix expansion after Ben approval, verify the stop conditions, then consider a separately approved full-seed run with `ASX_BATCH_SIZE=1838`. Do not run offset slices against the live NAS publisher unless the goal is a temporary probe; each successful run updates `latest.json`, so prefix expansion keeps the dashboard denominator understandable.

Broad hydration approval gates:

- Ben approval is required before any manual batch larger than the current top-50 recurring job against `/mnt/pve/NAS/services/personal-dashboard`.
- Ben approval is required before changing the scheduler batch size, cadence, delivery target, provider priority, cache pruning, latest-pointer rollback, or any recurring all-ASX/slice job.
- Do not lower `ASX_SLEEP_SECONDS` below `0.75`; if Yahoo throttles or shape-changes, stop rather than tightening the loop like a tiny denial-of-service goblin.

### Normal operation

1. The scheduler fires `run-asx-screener-hydration-owner.sh` on tori.
2. It resolves the NAS data root (`/mnt/pve/NAS/services/personal-dashboard`) and runs the canonical workflow, which:
   - hydrates the bounded seed slice via Yahoo (throttled by `ASX_SLEEP_SECONDS`),
   - writes an immutable per-run tree under `investment-screener/runs/market=ASX/source=yahoo-finance/mode=asx-yahoo-timeseries/run_date=…/<run_id>/`,
   - atomically updates `manifests/market=ASX/source=yahoo-finance/latest.json` and appends `runs.jsonl`,
   - publishes `exports/dashboard/market=ASX/latest_{ranked,coverage,report}.*`,
   - runs preflight (checksum + required-artifact + generated-age validation).
3. The wrapper reduces output to one sanitized summary line (run_id, mode, universe_hash, usable/failed/excluded, pointer path) and exits 0.

### Verify a run manually (no egress, read-only)

```bash
cd /root/work/home-lab/services/personal-dashboard
cat /mnt/pve/NAS/services/personal-dashboard/investment-screener/manifests/market=ASX/source=yahoo-finance/latest.json
```

Confirm `mode=asx-yahoo-timeseries`, `fixture=false`, a recent `completed_at`, and `coverage.usable` > 0.

### Dry-run the wrapper before enabling

```bash
cd /root/work/home-lab/services/personal-dashboard
INVESTMENT_SCREENER_DATA_ROOT=/tmp/asx-dry-run \
  ASX_BATCH_SIZE=4 \
  bash scripts/run-asx-screener-hydration-owner.sh
```

The summary line prints a scratch `pointer` (proof the full chain ran non-fixture without touching the NAS).

### FMP credentialed smoke/top-400 run pattern

Keep `FMP_API_KEY` in Vaultwarden/BW and inject it only for the child command.
From the repository root, after a Bitwarden CLI unlock has exported `BW_SESSION`:

```bash
scripts/secrets/run-with-vaultwarden-env.sh \
  services/personal-dashboard/investment-screener/asx-fmp.env.map.example \
  -- \
  bash -c 'cd services/personal-dashboard && INVESTMENT_SCREENER_DATA_ROOT=/tmp/asx-fmp-smoke ASX_BATCH_SIZE=5 DRY_RUN=1 bash scripts/run-asx-screener-hydration-owner.sh'
```

Only after the smoke run verifies sanitized logs and fallback provenance should an
operator run the approved top-400 prefix by replacing the scratch root/dry-run
settings with the reviewed production data root and `ASX_BATCH_SIZE=400`. The
wrapper and owner script must not print provider key material.

### Failure / stale-data triage

- **Stale dashboard (`stale:true` / old generated_at):** check the latest pointer's `completed_at`; if > 26h old, the last scheduled run failed. Inspect the scheduler's stderr (the `[asx-screener-owner] FAILED:` block) for the underlying canonical error (e.g. Yahoo `429`, missing required artifact).
- **Yahoo `429`/throttling:** Yahoo endpoints are unofficial. Back off and re-run; do not tighten `ASX_SLEEP_SECONDS` below 0.75 to work around a throttle.
- **Checksum mismatch:** a failed publish leaves the prior latest intact (atomic writes); re-run rather than hand-editing artifacts.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `INVESTMENT_SCREENER_DATA_ROOT` | `/mnt/pve/NAS/services/personal-dashboard` (tori) / `/mnt/nas/...` (critical) | Canonical data root |
| `ASX_UNIVERSE_SEED_PATH` | `investment-screener/universe/asx-listed-companies.seed.json` | Reviewed seed |
| `ASX_BATCH_OFFSET` | `0` | Resumable batch offset |
| `ASX_BATCH_SIZE` | `50` | Bounded universe slice |
| `ASX_SLEEP_SECONDS` | `0.75` | Provider request throttle |
| `DRY_RUN` | `0` | Set `1` to write only the run payload, skip publish/preflight |

## Placement pitfall (documented)

**critical (192.168.0.50) is Alpine Linux** — it has no `bash`, no `node`, and no `systemd`, so the bash+node canonical workflow cannot run there natively (there is no scheduler on critical at all). The workflow therefore runs on **tori**, which has the full toolchain (bash, python3, node, and the repo `node_modules` including `@duckdb`/`parquetjs-lite`).

**NAS path split on tori:** tori mounts the NAS export (`192.168.0.250:/export/nas`) at `/mnt/pve/NAS`, *not* `/mnt/nas` — tori's `/mnt/nas` is a separate, **local** directory (device 2050, not NFS). The wrapper auto-detects `/mnt/pve/NAS/...` first. Writing to tori's local `/mnt/nas/...` would NOT reach the dashboard's data store. Critical mounts the same export at `/mnt/nas` directly.