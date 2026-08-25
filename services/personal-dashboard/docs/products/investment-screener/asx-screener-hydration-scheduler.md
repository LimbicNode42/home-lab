# ASX Screener Hydration — Scheduler Ownership & Runbook

> Operator guidance, not financial advice. This document records the *single named owner* for recurring non-fixture ASX hydration, its cadence, universe denominator, failure notification path, and runbook.

## Owner

- **Job name:** `asx-screener-hydration` (pending Ben's approval — see "Deployment gate" below).
- **Owner profile / operator:** Ben (homelab admin), executed by the Hermes scheduler as a **no-agent** cron job running a committed wrapper.
- **Wrapper script (committed, non-secret):** `services/personal-dashboard/scripts/run-asx-screener-hydration-owner.sh`
- **Underlying canonical workflow (committed):** `services/personal-dashboard/scripts/run-asx-screener-hydration.sh`

## Cadence

- **Proposed schedule:** `0 8 * * 6` — weekly, Saturday 08:00 AEST (tori local time). Weekly cadence matches the parent deploy note and keeps Yahoo egress well below throttle thresholds.
- **Mode:** non-fixture (`asx-yahoo-timeseries`) — real Yahoo Finance hydration, never `--fixture`.

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
- **Notification gap (pending):** if no dedicated ASX ops channel is approved, delivery falls to the shared ops channel documented here. No secrets are ever emitted — the summary line is exactly `run_id mode universe_hash usable failed excluded pointer`.

## Deployment gate — REQUIRES EXPLICIT APPROVAL

Creating/enabling this recurring job performs outbound Yahoo Finance egress and writes NAS artifacts. This is a **live mutation** and must not be enabled without Ben's approval. The exact proposed schedule and command are in the task handoff; the job is registered only after approval.

## Runbook

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