# ASX Screener Hydration — Scheduler Ownership & Runbook

> Operator guidance, not financial advice. This document records the *single named owner* for recurring non-fixture ASX hydration, its cadence, universe denominator, failure notification path, and runbook.

## Owner

- **Monthly full-universe hydration job / ID:** `asx-screener-monthly-full-hydration` / `6bffd5f6fff6` (enabled in the default Hermes scheduler home, `/root/.hermes`).
- **Weekly no-publish smoke job / ID:** `asx-screener-weekly-smoke` / `1c56a487f8da` (enabled in the default Hermes scheduler home, `/root/.hermes`).
- **Owner profile / operator:** Ben (homelab admin), executed by the Hermes scheduler as **no-agent** cron jobs running local scheduler shims that delegate to committed wrappers.
- **Scheduler shim (monthly, local, executable):** `/root/.hermes/scripts/run-asx-screener-full-hydration-owner.sh`
- **Scheduler shim (weekly smoke, local, executable):** `/root/.hermes/scripts/run-asx-screener-smoke-owner.sh`
- **Wrapper script (monthly, committed):** `services/personal-dashboard/scripts/run-asx-screener-full-hydration-owner.sh`
- **Wrapper script (weekly smoke, committed):** `services/personal-dashboard/scripts/run-asx-screener-smoke-owner.sh`
- **Shared owner wrapper (committed, non-secret):** `services/personal-dashboard/scripts/run-asx-screener-hydration-owner.sh`
- **Underlying canonical workflow (committed):** `services/personal-dashboard/scripts/run-asx-screener-hydration.sh`

## Cadence

### Current approved scheduler state

- **Monthly full-universe fundamentals refresh:** `0 8 1 * *` — the first day of each month at 08:00 AEST/tori-local (job `6bffd5f6fff6`). Runs the full reviewed seed (`ASX_BATCH_OFFSET=0`, `ASX_BATCH_SIZE=<full seed count, currently 1838>`), so the dashboard latest pointer carries `denominator_status=complete_exchange_listing`.
- **Weekly provider smoke:** `0 8 * * 6` — Saturday 08:00 AEST/tori-local (job `1c56a487f8da`). Runs the canonical workflow in `DRY_RUN=1` against a tiny bounded slice (`ASX_BATCH_SIZE=4`), so it exercises real Yahoo/provider connectivity (429s, SSL failures, shape changes) **without publishing `latest.json`** — the dashboard denominator is never touched.
- **Mode:** non-fixture (`asx-yahoo-timeseries`) — real Yahoo Finance hydration, never `--fixture`.
- **Regression guard (still active):** the shared owner wrapper refuses an unattended bounded publish when the live latest pointer is already full-universe. This protects the monthly full run's `1838` denominator against any accidental bounded overwrite.

> Approved by Ben 2026-09-01 (kanban `t_c344ba1c`): monthly full-universe hydration + separate weekly no-publish smoke, replacing the prior weekly top-50 job. Quarterly-only was explicitly rejected (too stale for the 26-hour freshness preflight).

## Universe (denominator)

The monthly job hydrates the **full reviewed ASX company-directory seed**; the weekly smoke exercises a tiny bounded slice in dry-run mode without publishing:

- Seed: `investment-screener/universe/asx-listed-companies.seed.json` (1,838 active entries, sorted by market cap descending; source sha256 `a44aa810…`).
- Monthly full run slice: `--batch-offset 0 --batch-size <full seed count>` (currently 1838) → `denominator_status=complete_exchange_listing`.
- Weekly smoke slice: `--batch-offset 0 --batch-size 4` with `DRY_RUN=1` → no publish, no `latest.json` write.
- Universe denominator labels (from `screener.py`):
  - **full seed** = `complete_exchange_listing` (offset 0, size = full 1838) — the recurring monthly default.
  - **top-N batch** = `ranked_market_cap_batch` — legacy bounded default, no longer the recurring production mode.
  - **watchlist** = the 10-name `asx-watchlist.json` (smoke runs only, not production).
- The wrapper's summary line emits a 12-char `universe_hash` (sha256 of the seed file) so a seed change is visible in logs even though the full hash stays in the manifest.

## Failure notification path

- Both jobs are Hermes **no-agent** cron jobs; their stdout (a single sanitized line) is delivered to the approved ops channel (`discord:#👟-hermes-👟`), same as the homelab-health and Finnick report jobs.
- On failure the monthly wrapper prints `[asx-screener-owner] FAILED:` plus the canonical workflow output to stderr and exits non-zero; the smoke wrapper prints `ASX_SCREENER_SMOKE status=failed …` and `[asx-screener-smoke] FAILED:`. The scheduler surfaces a non-zero exit to the ops channel.
- **Delivery path:** stdout is delivered to the approved shared ops channel (`discord:#👟-hermes-👟`), same as the homelab-health and Finnick report jobs. No dedicated ASX-only channel was configured for this task.

## Deployment record

Ben approved the recurring top-50 owner job in kanban task `t_68024302`. On 2026-09-01 Ben approved (kanban `t_c344ba1c`) replacing that weekly top-50 owner with the monthly full-universe hydration + weekly no-publish smoke described above. The default Hermes scheduler now has exactly two enabled ASX owner jobs: `asx-screener-monthly-full-hydration` (`6bffd5f6fff6`) and `asx-screener-weekly-smoke` (`1c56a487f8da`). The legacy kobold fixture-mode job (`11727e7f850f`, `ASX screener fixture run`) was paused rather than deleted.

### Registered scheduler entries

```yaml
# Monthly full-universe hydration
id: 6bffd5f6fff6
name: asx-screener-monthly-full-hydration
schedule: 0 8 1 * *
script: run-asx-screener-full-hydration-owner.sh
mode: no-agent
deliver: discord:#👟-hermes-👟

# Weekly no-publish provider smoke
id: 1c56a487f8da
name: asx-screener-weekly-smoke
schedule: 0 8 * * 6
script: run-asx-screener-smoke-owner.sh
mode: no-agent
deliver: discord:#👟-hermes-👟
```

The scheduler shims live under `/root/.hermes/scripts/` (stable, boring entry points) and delegate to this repo's committed wrappers. Keep the shims small; substantive workflow logic belongs in Git.

## Runbook

### Cadence rationale

The monthly full-universe run is the production denominator refresh. Quarterly-only was explicitly rejected by Ben (2026-09-01) because the artifact preflight treats generated data as stale after 26 hours, so a quarterly refresh would leave the dashboard stale for most of the cycle. The weekly smoke exists for early provider-breakage visibility (429s, SSL failures, Yahoo shape changes) without touching `latest.json`.

The shared owner wrapper retains the fail-closed regression guard: an unattended bounded (`offset,size` not covering the full seed) publish is refused with exit 42 when the live latest pointer is already full-universe. This protects the full-universe denominator from accidental regression.

Broad hydration approval gates:

- Ben approval is required before any manual batch against `/mnt/pve/NAS/services/personal-dashboard` that would change the dashboard denominator (e.g. a bounded slice publish, or a seed change).
- Ben approval is required before changing the scheduler batch size, cadence, delivery target, provider priority, cache pruning, latest-pointer rollback, or any recurring all-ASX/slice job.
- Do not lower `ASX_SLEEP_SECONDS` below `0.75`; if Yahoo throttles or shape-changes, stop rather than tightening the loop like a tiny denial-of-service goblin.

### Normal operation

1. On the first day of each month, the scheduler fires `run-asx-screener-full-hydration-owner.sh`, which resolves the full seed count and runs the canonical workflow, which:
   - hydrates the full universe via Yahoo (throttled by `ASX_SLEEP_SECONDS`),
   - writes an immutable per-run tree under `investment-screener/runs/market=ASX/source=yahoo-finance/mode=asx-yahoo-timeseries/run_date=…/<run_id>/`,
   - atomically updates `manifests/market=ASX/source=yahoo-finance/latest.json` and appends `runs.jsonl`,
   - publishes `exports/dashboard/market=ASX/latest_{ranked,coverage,report}.*`,
   - runs preflight (checksum + required-artifact + generated-age validation).
2. The wrapper reduces output to one sanitized summary line (run_id, mode, universe_hash, usable/failed/excluded, pointer path) and exits 0.
3. Each Saturday the scheduler fires `run-asx-screener-smoke-owner.sh`, which runs the canonical workflow in `DRY_RUN=1` against a 4-name slice and emits `ASX_SCREENER_SMOKE status=ok batch=4 dry_run=1 no_publish=true` (or `status=failed` on provider failure). No publish occurs.

### Verify a run manually (no egress, read-only)

```bash
cd /root/work/home-lab/services/personal-dashboard
cat /mnt/pve/NAS/services/personal-dashboard/investment-screener/manifests/market=ASX/source=yahoo-finance/latest.json
```

Confirm `mode=asx-yahoo-timeseries`, `fixture=false`, a recent `completed_at`, and `coverage.usable` > 0.

### Dry-run the monthly wrapper before enabling

```bash
cd /root/work/home-lab/services/personal-dashboard
INVESTMENT_SCREENER_DATA_ROOT=/tmp/asx-dry-run \
  DRY_RUN=1 \
  bash scripts/run-asx-screener-full-hydration-owner.sh
```

The summary line prints a scratch `pointer` (proof the full chain ran non-fixture without touching the NAS). Note: the monthly wrapper resolves the full seed count automatically, so a dry-run against the real seed would scrape the full universe — use a small scratch seed for a fast path-smoke.

### Dry-run the smoke wrapper

```bash
cd /root/work/home-lab/services/personal-dashboard
INVESTMENT_SCREENER_DATA_ROOT=/tmp/asx-smoke \
  bash scripts/run-asx-screener-smoke-owner.sh
```

Emits a single `ASX_SCREENER_SMOKE status=ok batch=4 dry_run=1 no_publish=true` line and never writes `latest.json`.

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
| `ASX_BATCH_SIZE` | full seed count (monthly) / `4` (smoke) | Universe slice; resolved dynamically by the monthly wrapper, fixed small for smoke |
| `ASX_SLEEP_SECONDS` | `0.75` | Provider request throttle |
| `DRY_RUN` | `0` | Set `1` to write only the run payload, skip publish/preflight (smoke wrapper forces `1`) |

## Placement pitfall (documented)

**critical (192.168.0.50) is Alpine Linux** — it has no `bash`, no `node`, and no `systemd`, so the bash+node canonical workflow cannot run there natively (there is no scheduler on critical at all). The workflow therefore runs on **tori**, which has the full toolchain (bash, python3, node, and the repo `node_modules` including `@duckdb`/`parquetjs-lite`).

**NAS path split on tori:** tori mounts the NAS export (`192.168.0.250:/export/nas`) at `/mnt/pve/NAS`, *not* `/mnt/nas` — tori's `/mnt/nas` is a separate, **local** directory (device 2050, not NFS). The wrapper auto-detects `/mnt/pve/NAS/...` first. Writing to tori's local `/mnt/nas/...` would NOT reach the dashboard's data store. Critical mounts the same export at `/mnt/nas` directly.