# ASX full-universe hydration rollout plan — 2026-08-28

> Kanban task `t_575828a9`. Planning and documentation only. No all-universe hydration, cron enablement, scheduler mutation, deployment, provider credential change, or cleanup was performed.

## Decision

Do not enable a broad recurring all-ASX job yet.

Recommended next step is one supervised, explicitly approved manual expansion from the current published top-200 evidence to a top-400 prefix run:

```bash
cd /root/work/home-lab
ASX_BATCH_OFFSET=0 \
ASX_BATCH_SIZE=400 \
ASX_SLEEP_SECONDS=0.75 \
INVESTMENT_SCREENER_DATA_ROOT=/mnt/pve/NAS/services/personal-dashboard \
ASX_CACHE_DIR=/var/lib/personal-dashboard/asx-provider-cache \
services/personal-dashboard/scripts/run-asx-screener-hydration-owner.sh
```

If the top-400 run passes the stop conditions below, the next approved step can be a single supervised full-seed run:

```bash
cd /root/work/home-lab
ASX_BATCH_OFFSET=0 \
ASX_BATCH_SIZE=1838 \
ASX_SLEEP_SECONDS=0.75 \
INVESTMENT_SCREENER_DATA_ROOT=/mnt/pve/NAS/services/personal-dashboard \
ASX_CACHE_DIR=/var/lib/personal-dashboard/asx-provider-cache \
services/personal-dashboard/scripts/run-asx-screener-hydration-owner.sh
```

Both commands require Ben approval because they create provider egress beyond the current weekly owner job and update the NAS-backed latest pointer/dashboard export.

## Evidence from staged runs

A later supervised top-400 expansion is recorded in [ASX top-400 hydration result — 2026-08-29](./asx-top-400-hydration-result-2026-08-29.md). It published run `investment-screener_ASX_asx-yahoo-timeseries_2026-08-29T015127Z_5871117f2bec` with 342 usable / 400 denominator = 85.5%, which missed the 88% top-400 coverage gate. Stop before any full-seed Yahoo-only run unless Ben explicitly accepts lower coverage or enables a fallback source.

The earlier staged expansion task published run `investment-screener_ASX_asx-yahoo-timeseries_2026-08-28T103609Z_2f011d019022` with these receipts:

- Command used: `ASX_BATCH_OFFSET=0 ASX_BATCH_SIZE=200 ASX_SLEEP_SECONDS=0.75 INVESTMENT_SCREENER_DATA_ROOT=/mnt/pve/NAS/services/personal-dashboard ASX_CACHE_DIR=/var/lib/personal-dashboard/asx-provider-cache services/personal-dashboard/scripts/run-asx-screener-hydration-owner.sh`
- Coverage: 184 usable / 200 denominator = 92.0%; 16 failed and excluded.
- Denominator: top 200 ASX listings by market cap from the reviewed 1,838-entry ASX company-directory seed.
- Provenance sources: `yahoo-finance` and `derived`; no credentialed provider fill was enabled.
- Run directory size: about 2.6 MiB.
- Runtime observed by the prior worker: about 5–6 minutes for 200 tickers.
- Pointer safety: prior latest was preserved as `latest.previous.json`; prior run directories remained present; no conflicts were reported.
- Known wart: transient Python run JSON may still report the full-seed denominator, but published NAS manifest/latest/dashboard artifacts are corrected to the batch denominator by the reviewed JS publisher.

## Rollout shape

Use prefix expansion, not offset slices, for any run that publishes to the live latest pointer.

Reason: the current workflow publishes each completed run as the dashboard latest. An offset slice such as `ASX_BATCH_OFFSET=200 ASX_BATCH_SIZE=200` would be useful as a provider probe, but it would make the dashboard latest represent only that middle slice. Prefix expansion (`offset=0`, increasing `batch-size`) keeps the latest export understandable: top 400, then full seed.

Recommended rollout sequence:

1. Keep the existing weekly owner job unchanged at top 50.
2. Run one supervised top-400 prefix expansion after Ben approval.
3. Inspect coverage, failures, missingness, storage size, freshness, and dashboard latest pointer.
4. If top-400 remains healthy, run one supervised full-seed expansion after separate Ben approval.
5. Do not convert the weekly cron to all-ASX until at least one full-seed manual run has passed and the dashboard UX is confirmed acceptable with the larger export.
6. If full-seed runtime or provider failure rate is too high, keep the cron at top 50 and use manually approved top-N refreshes for broader research windows.

## Estimates

The estimates below scale from the top-200 staged result. They are planning estimates, not guarantees; Yahoo is unofficial and can change shape or throttle without sending a polite note first.

| Run | Batch command | Estimated runtime | Sleep-only floor | Estimated new run size | Purpose |
| --- | --- | ---: | ---: | ---: | --- |
| Current owner cron | `ASX_BATCH_OFFSET=0 ASX_BATCH_SIZE=50` | 1–2 min | 0.6 min | ~0.7 MiB | Weekly smoke/production latest |
| Completed staged run | `ASX_BATCH_OFFSET=0 ASX_BATCH_SIZE=200` | 5–6 min observed | 2.5 min | 2.6 MiB observed | Proven expansion evidence |
| Recommended next run | `ASX_BATCH_OFFSET=0 ASX_BATCH_SIZE=400` | 10–12 min | 5.0 min | ~5.2 MiB | Next supervised gate |
| Full seed | `ASX_BATCH_OFFSET=0 ASX_BATCH_SIZE=1838` | 46–55 min | 23.0 min | ~24 MiB | One supervised all-ASX candidate run |

Storage is cheap at this scale, but keep runs append-only. Do not delete old run directories during rollout; the latest pointer and `runs.jsonl` are the audit trail.

## Provider limits and priority

Current approved provider priority for this rollout:

1. Yahoo Finance public endpoints only, through the existing `asx-yahoo-timeseries` path.
2. Derived fields computed from Yahoo raw values.
3. No FMP, Alpha Vantage, EODHD, Twelve Data fundamentals, MarketIndex, TradingView, Morningstar, or bulk ASX PDF extraction in this rollout.

Rate controls:

- Keep `ASX_SLEEP_SECONDS=0.75` minimum for Yahoo.
- Do not lower sleep to work around a throttle.
- If Yahoo returns 429/rate-limit behavior, stop the rollout and wait at least 24 hours before another broad run.
- Add retry/backoff/jitter in a later implementation task before making broad hydration unattended.
- Keep credentialed provider adapters fail-closed until Ben provides keys and approves licensing/storage terms.

## Cache retention

Use `ASX_CACHE_DIR=/var/lib/personal-dashboard/asx-provider-cache` for manual rollout runs so repeated probes do not create unnecessary provider egress.

Retention policy for this rollout:

- Do not delete cache entries during the top-400 or first full-seed rollout.
- Do not commit cache contents.
- Do not treat cache hits as source-of-record evidence; published manifests and checksums remain the audit source.
- After two successful weekly owner runs following the broad manual run, create a separate cleanup task to inspect and prune stale cache entries older than 30 days if disk usage warrants it.

## Stop conditions

Stop and do not proceed to the next size if any of these occur:

- Preflight fails, required artifacts are missing, checksum validation fails, or `latest.json` is not fresh after the run.
- Published denominator/status does not match the requested batch size and `ranked_market_cap_batch` / `complete_exchange_listing` labeling.
- Usable coverage drops below 88% for the top-400 run or below 85% for the full-seed run.
- Provider failures/exclusions exceed 15% for top-400 or 20% for full-seed.
- Yahoo 429/rate-limit, widespread timeout, or endpoint shape-change errors appear.
- Runtime exceeds 20 minutes for top-400 or 75 minutes for full-seed.
- New run directory is unexpectedly above 100 MiB.
- `runs.jsonl`, `latest.previous.json`, or prior run directories are not preserved.
- Credentialed provider provenance appears unexpectedly.
- Field missingness regresses for the original top-200 prefix in core fields: `revenue`, `net_income`, `total_assets`, `total_liabilities`, `market_cap`, `price`, or `shares_outstanding`.

Material gaps expected to remain, based on top-200 evidence:

- `operating_cash_flow`: 169/200 missing.
- `fcf`: 170/200 missing.
- `fcf_margin`: 172/200 missing.
- `current_assets`, `current_liabilities`, `current_ratio`: 38/200 missing, mainly financial-sector shape and stale/excluded rows.
- `roe`: 40/200 missing.

Those gaps are provider/source limitations, not blockers by themselves unless they regress sharply beyond the thresholds above.

## Verification after each approved manual run

Read-only checks:

```bash
cd /root/work/home-lab/services/personal-dashboard
node scripts/preflight-investment-screener-artifacts.mjs \
  --data-root /mnt/pve/NAS/services/personal-dashboard \
  --market ASX \
  --source yahoo-finance \
  --max-generated-age-hours 26

python3 - <<'PY'
import json
from pathlib import Path
root = Path('/mnt/pve/NAS/services/personal-dashboard/investment-screener')
pointer = root / 'manifests/market=ASX/source=yahoo-finance/latest.json'
d = json.loads(pointer.read_text())
manifest = json.loads((root / d['run_manifest']).read_text())
print(json.dumps({
    'run_id': d.get('run_id'),
    'mode': d.get('mode'),
    'fixture': d.get('fixture'),
    'coverage': manifest.get('coverage'),
    'provenance_sources': manifest.get('provenance_sources'),
    'completed_at': manifest.get('completed_at'),
}, indent=2, sort_keys=True))
PY

du -sh /mnt/pve/NAS/services/personal-dashboard/investment-screener/runs/market=ASX/source=yahoo-finance/mode=asx-yahoo-timeseries/run_date=*/investment-screener_ASX_asx-yahoo-timeseries_* | tail -10
```

If dashboard latest is accidentally pointed at an unacceptable run, do not delete the bad run. Preserve it for audit and perform a bounded pointer rollback only after Ben approval:

```bash
cd /mnt/pve/NAS/services/personal-dashboard/investment-screener/manifests/market=ASX/source=yahoo-finance
cp latest.json latest.bad.$(date -u +%Y%m%dT%H%M%SZ).json
cp latest.previous.json latest.json
```

Then rerun preflight and record the hashes. Pointer rollback is a live NAS mutation even though it is non-destructive, so it still needs approval.

## Recurring scheduler ownership

Current production scheduler ownership remains unchanged:

- Job: `asx-screener-hydration` / `6bffd5f6fff6`.
- Schedule: `0 8 * * 6`.
- Mode: Hermes no-agent cron.
- Script: `/root/.hermes/scripts/run-asx-screener-hydration-owner.sh` delegating to the committed wrapper.
- Current default slice: `ASX_BATCH_OFFSET=0 ASX_BATCH_SIZE=50`.
- Delivery: `discord:#👟-hermes-👟`.

Do not enable a recurring all-ASX job or rolling slice cron from this planning task. A later scheduler/deploy task must approve any change to cadence, batch size, delivery target, or cleanup behavior.

Candidate future scheduler policy, after successful manual full-seed run:

- Keep weekly top-50 as the default dashboard freshness job.
- Add a monthly or quarterly supervised broad refresh only if Ben accepts the provider egress and dashboard export size.
- Prefer a manual runbook-triggered broad refresh over automatic slice cron until the workflow can publish combined multi-slice manifests without making `latest.json` point at a partial offset slice.

## Approval gates

Ben approval is required before:

- Running top-400, full-seed, or any batch larger than the existing weekly top-50 owner job against the NAS data root.
- Changing the default scheduler batch size or cadence.
- Enabling any broad recurring job or recurring slice job.
- Adding provider credentials or changing provider priority.
- Pruning caches, deleting run directories, or rewriting history artifacts.
- Rolling back the live latest pointer.

No approval is needed for read-only preflight, manifest inspection, documentation updates, or local dry-runs that write only to `/tmp`.

## Follow-up recommendation

Do not create an all-universe execution card until the top-400 gate passes. The next execution card should be a bounded manual top-400 run with the exact command above and an explicit Ben approval gate. If it passes, a second execution card can run the full seed with `ASX_BATCH_SIZE=1838`.
