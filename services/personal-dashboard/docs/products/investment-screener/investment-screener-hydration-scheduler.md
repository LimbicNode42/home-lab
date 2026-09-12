# Investment Screener Hydration — Scheduler Ownership & Runbook

> Operator guidance, not financial advice. This document records the *single named owner* for recurring non-fixture investment-screener hydration across all tracked markets, its cadence, per-market universe denominator, failure notification path, and runbook.
>
> This is the all-market generalization of the former ASX-only runbook. ASX behavior and its regression guards are preserved; NASDAQ and NYSE are now first-class recurring markets; US is explicitly not-applicable to the recurring full-universe cadence (see [Universe](#universe-denominator)).

## Owner

- **Monthly full-universe hydration job / ID:** `asx-screener-monthly-full-hydration` / `6bffd5f6fff6` (enabled in the default Hermes scheduler home, `/root/.hermes`).
- **Weekly no-publish smoke job / ID:** `asx-screener-weekly-smoke` / `1c56a487f8da` (enabled in the default Hermes scheduler home, `/root/.hermes`).
- **Owner profile / operator:** Ben (homelab admin), executed by the Hermes scheduler as **no-agent** cron jobs running local scheduler shims that delegate to committed wrappers.
- **Scheduler shim (monthly, local, executable):** `/root/.hermes/scripts/run-asx-screener-full-hydration-owner.sh` (re-pointed at the generalized owner at deploy).
- **Scheduler shim (weekly smoke, local, executable):** `/root/.hermes/scripts/run-asx-screener-smoke-owner.sh` (re-pointed at the generalized owner at deploy).
- **Wrapper script (monthly full, committed):** `services/personal-dashboard/scripts/run-investment-screener-full-hydration-owner.sh`
- **Wrapper script (weekly smoke, committed):** `services/personal-dashboard/scripts/run-investment-screener-smoke-owner.sh`
- **Shared owner wrapper (committed, market-parameterized):** `services/personal-dashboard/scripts/run-investment-screener-hydration-owner.sh`
- **Underlying canonical workflow (committed, market-parameterized):** `services/personal-dashboard/scripts/run-investment-screener-hydration.sh`
- **Market registry (committed, config-driven):** `services/personal-dashboard/investment-screener/universe/recurring-markets.json` (resolved by `investment-screener/recurring_markets.py`)

## Cadence

### Current approved scheduler state

- **Monthly full-universe fundamentals refresh:** `0 8 1 * *` — the first day of each month at 08:00 AEST/tori-local (job `6bffd5f6fff6`). Iterates every enabled market in the registry; for each market resolves the full reviewed seed count dynamically and runs `BATCH_OFFSET=0` / `BATCH_SIZE=<full count>`, so each latest pointer carries its honest `denominator_status`.
- **Weekly provider smoke:** `0 8 * * 6` — Saturday 08:00 AEST/tori-local (job `1c56a487f8da`). Runs each enabled market in `DRY_RUN=1` against a tiny bounded slice (per-market `smoke_batch_size`), exercising real provider connectivity **without publishing `latest.json`** — no smoke touches the dashboard denominator or moves a latest pointer.
- **Mode:** non-fixture, per market (see table below). Never `--fixture`.
- **Regression guard (still active):** the shared owner wrapper refuses an unattended bounded publish when the live latest pointer is already full-universe. This protects a full-universe denominator against accidental bounded overwrite, and is now applied per market.

> Approved by Ben 2026-09-01 (kanban `t_c344ba1c`): monthly full-universe hydration + separate weekly no-publish smoke, replacing the prior weekly top-50 job. Quarterly-only was explicitly rejected (too stale for the 26-hour freshness preflight). The all-market generalization preserves those job IDs, cadences, and delivery target.

## Universe (denominator)

Enabled markets are driven from `universe/recurring-markets.json`. The registry captures, per market: key, market/exchange/region/currency, canonical source + mode, seed path, seed arg, denominator label + status, full-count policy, smoke batch size, throttle, freshness window, and (for credentialed providers) the required credential env var.

| Market | Source | Mode | Seed | Full count (active) | `denominator_status` | Credential |
|---|---|---|---|---|---|---|
| `ASX` | `yahoo-finance` | `asx-yahoo-timeseries` | `asx-listed-companies.seed.json` | 1838 | `complete_exchange_listing` | none |
| `NASDAQ` | `eodhd` | `nasdaq-eodhd-fundamentals` | `nasdaq-listed-equities.seed.json` | 3434 | `complete_security_type_filtered_listing` | `EODHD_API_KEY` |
| `NYSE` | `eodhd` | `nyse-eodhd-fundamentals` | `nyse-listed-equities.seed.json` | 2227 | `complete_security_type_filtered_listing` | `EODHD_API_KEY` |

### Disabled / not applicable markets

- **`US`** is **disabled** in the registry (`enabled: false`) and is therefore never part of a recurring cycle. Rationale: the only committed US seed (`us-sp500-constituents.seed.json`, 503 names) is a curated S&P 500 sample (`known_sample_universe`), *not* a full US/NYSE ordinary-share listing. Selecting it unbounded would mislabel a 503-name sample as `complete_exchange_listing` (via `select_us_universe_batch`), and the codebase has no reviewed full-US seed (`generate_us_universe_seed.py` deliberately does not enumerate the ~7000 NYSE/NASDAQ names). NASDAQ and NYSE now provide separate recurring full-universe coverage for their reviewed US listed-equity surfaces. Re-enable US only after a reviewed full-US seed + a recurring-safe mode that preserves an honest `denominator_status`.

The `denominator_status` values map to the caller's honest label exactly as before: full seed → `complete_exchange_listing` (ASX) or `complete_security_type_filtered_listing` (NASDAQ/NYSE, whose reviewed seeds are security-type-filtered); bounded slice → `ranked_market_cap_batch`; explicit/curated sample → `known_sample_universe`. The owner wrappers never pass a `--denominator-label` override, so the labels come from `screener.py`'s own honest derivation and are never mislabeled.

### Full-count policy

All enabled markets use `full_count_policy: "complete_seed"`: the full-count is resolved dynamically from the reviewed seed's entry count at run time. A seed growth is picked up without a hard-coded magic number; a missing/empty seed **fails closed** (registry resolution exits non-zero) rather than scraping with a null count.

## Failure notification path

- Both jobs are Hermes **no-agent** cron jobs; their stdout (sanitized per-market summary lines) is delivered to the approved ops channel (`discord:#👟-hermes-👟`), same as the homelab-health and Finnick report jobs.
- On failure the monthly wrapper prints `[full-owner] …` / `[screener-owner <MARKET>] FAILED:` plus the canonical workflow output to stderr and exits non-zero; the smoke wrapper prints `SCREENER_SMOKE market=<MARKET> status=failed …`. The scheduler surfaces a non-zero exit to the ops channel.
- **Delivery path:** stdout is delivered to the approved shared ops channel (`discord:#👟-hermes-👟`).

## Deployment record

Ben approved the recurring top-50 owner job in kanban task `t_68024302`. On 2026-09-01 Ben approved (kanban `t_c344ba1c`) replacing that weekly top-50 owner with the monthly full-universe hydration + weekly no-publish smoke. The default Hermes scheduler has exactly two enabled owner jobs: `asx-screener-monthly-full-hydration` (`6bffd5f6fff6`) and `asx-screener-weekly-smoke` (`1c56a487f8da`). The legacy kobold fixture-mode job (`11727e7f850f`, `ASX screener fixture run`) was paused rather than deleted.

This all-market generalization (kanban `t_d1f0e53d`) keeps those two job IDs/cadences/delivery target and re-points the `/root/.hermes/scripts/` shims at the committed generalized wrappers. The legacy ASX-named wrapper filenames remain as backward-compatible shims.

### Registered scheduler entries

```yaml
# Monthly full-universe hydration (all enabled markets)
id: 6bffd5f6fff6
name: asx-screener-monthly-full-hydration
schedule: 0 8 1 * *
script: run-asx-screener-full-hydration-owner.sh
mode: no-agent
deliver: discord:#👟-hermes-👟

# Weekly no-publish provider smoke (all enabled markets)
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

The monthly full-universe run is the production denominator refresh. Quarterly-only was explicitly rejected by Ben (2026-09-01) because the artifact preflight treats generated data as stale after 26 hours, so a quarterly refresh would leave the dashboard stale for most of the cycle. The weekly smoke exists for early provider-breakage visibility (429s, SSL failures, shape changes) without touching `latest.json`.

The shared owner wrapper retains the fail-closed regression guard, applied per market: an unattended bounded (`offset,size` not covering the full seed) publish is refused with exit 42 when the live latest pointer is already full-universe.

Broad hydration approval gates:

- Ben approval is required before any manual batch against `/mnt/pve/NAS/services/personal-dashboard` that would change the dashboard denominator (e.g. a bounded slice publish, or a seed change).
- Ben approval is required before changing the scheduler batch size, cadence, delivery target, provider priority, cache pruning, latest-pointer rollback, or any recurring job.
- Do not lower the per-market throttle below its registry value (e.g. `0.75` for ASX); if a provider throttles or shape-changes, stop rather than tightening the loop like a tiny denial-of-service goblin.
- Adding a tracked market is a **registry + seed add** (a `recurring-markets.json` entry pointing at a reviewed seed with a hydration mode that exists in `screener.py`), *not* an edit to the driver loop.

### Normal operation

1. On the first day of each month, the scheduler fires `run-asx-screener-full-hydration-owner.sh` (delegating to the generalized full owner), which reads the registry and, per enabled market:
   - resolves the full seed count dynamically (fail-closed),
   - runs the canonical market workflow at `BATCH_OFFSET=0` / `BATCH_SIZE=<full count>` (throttled; credentialed markets require their credential env present),
   - for non-dry-runs, writes an immutable per-run tree under `investment-screener/runs/market=<MARKET>/source=<SOURCE>/mode=<MODE>/run_date=…/<run_id>/`,
   - atomically updates `manifests/market=<MARKET>/source=<SOURCE>/latest.json` and appends `runs.jsonl`,
   - publishes `exports/dashboard/market=<MARKET>/latest_{ranked,coverage,report}.*`,
   - runs preflight (checksum + required-artifact + generated-age validation).
2. The shared owner wrapper reduces each market to one sanitized summary line (`SCREENER market=… mode=… universe_hash=… usable=… failed=… excluded=…`) and the full owner emits a single `FULL_SCREENER status=…` rollup.
3. Each Saturday the scheduler fires the smoke shim (delegating to the generalized smoke owner), which runs each enabled market in `DRY_RUN=1` against its smoke slice, emitting `SCREENER_SMOKE market=… status=… batch=… dry_run=1 no_publish=true` per market (or `status=n/a reason=missing_credential_<ENV>` for a credentialed market without its credential) and a `SMOKE_SCREENER status=…` rollup. No publish occurs.

### Verify a run manually (no egress, read-only)

```bash
cd /root/work/home-lab/services/personal-dashboard
cat /mnt/pve/NAS/services/personal-dashboard/investment-screener/manifests/market=ASX/source=yahoo-finance/latest.json
cat /mnt/pve/NAS/services/personal-dashboard/investment-screener/manifests/market=NASDAQ/source=eodhd/latest.json
cat /mnt/pve/NAS/services/personal-dashboard/investment-screener/manifests/market=NYSE/source=eodhd/latest.json
```

Confirm `mode` matches the registry (asx-yahoo-timeseries / nasdaq-eodhd-fundamentals / nyse-eodhd-fundamentals), `fixture=false`, a recent `completed_at`, and `coverage.usable > 0`.

### Dry-run the full owner (bounded, no NAS, no provider scrape)

The full owner always resolves the real (full) seed count, so a dry-run against the real seed would scrape the full universe. To prove per-market full-count resolution + chain wiring without an unbounded scrape, override the registry with a tiny scratch seed and a scratch data root:

```bash
cd /root/work/home-lab/services/personal-dashboard
# use a scratch registry whose ASX entry points at a 2-ticker scratch seed
DRY_RUN=1 \
RECURRING_MARKETS_REGISTRY=/tmp/scratch-registry.json \
INVESTMENT_SCREENER_DATA_ROOT=/tmp/scratch-data-root \
  bash scripts/run-investment-screener-full-hydration-owner.sh
```

The per-market summary line prints the market/mode/universe_hash and `FULL_SCREENER status=ok`.

### Dry-run the smoke owner (no publish, credential-gated per market)

```bash
cd /root/work/home-lab/services/personal-dashboard
INVESTMENT_SCREENER_DATA_ROOT=/tmp/investment-screener-smoke-scratch \
  bash scripts/run-investment-screener-smoke-owner.sh
```

Emits `SCREENER_SMOKE market=ASX status=ok …` plus `SCREENER_SMOKE market=NASDAQ status=n/a reason=missing_credential_EODHD_API_KEY …` and `SCREENER_SMOKE market=NYSE status=n/a reason=missing_credential_EODHD_API_KEY …` when the credential is absent, and never writes `latest.json`. NASDAQ/NYSE smoke requires `EODHD_API_KEY` in the runtime environment (fail-closed without it).

### Credentialed smoke / top-N run pattern

`EODHD_API_KEY` (and the legacy `FMP_API_KEY` for ASX fallback) live in Vaultwarden/BW and are injected only into the child command. From the repository root, after a Bitwarden CLI unlock has exported `BW_SESSION`:

```bash
scripts/secrets/run-with-vaultwarden-env.sh \
  services/personal-dashboard/investment-screener/asx-fmp.env.map.example \
  -- \
  bash -c 'cd services/personal-dashboard && EODHD_API_KEY="$EODHD_API_KEY" INVESTMENT_SCREENER_DATA_ROOT=/tmp/eodhd-smoke bash scripts/run-investment-screener-smoke-owner.sh'
```

Only after the smoke run verifies sanitized logs should an operator run the approved credentialed smoke. The wrappers and owner scripts must not print provider key material.

### Failure / stale-data triage

- **Stale dashboard (`stale:true` / old generated_at):** check the latest pointer's `completed_at`; if > 26h old, the last scheduled run failed. Inspect the scheduler's stderr (`[screener-owner <MARKET>] FAILED:` / `[full-owner] …`) for the underlying error.
- **Provider 429/throttling:** back off and re-run; do not tighten the per-market throttle to work around a throttle.
- **Missing credential (`status=n/a reason=missing_credential_<ENV>`):** the market was skipped fail-closed; verify the credential env is exported for the no-agent job (or that the deploy step wires it).
- **Checksum mismatch:** a failed publish leaves the prior latest intact (atomic writes); re-run rather than hand-editing artifacts.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `INVESTMENT_SCREENER_DATA_ROOT` | `/mnt/pve/NAS/services/personal-dashboard` (tori) / `/mnt/nas/...` (critical) | Canonical data root |
| `RECURRING_MARKETS_REGISTRY` | `<repo>/investment-screener/universe/recurring-markets.json` | Market registry path (override for tests/scratch) |
| `DRY_RUN` | `0` | Set `1` to write only the run payload, skip publish/preflight (smoke forces `1`) |
| `EODHD_API_KEY` | (unset) | EODHD fundamentals credential for NASDAQ/NYSE/US; fail-closed when unset |

Per-market registry fields (source of truth): `source`, `mode`, `seed`, `seed_arg`, `denominator_label`, `denominator_status`, `full_count_policy`, `smoke_batch_size`, `sleep_seconds`, `max_generated_age_hours`, `credential_env`.

## Placement pitfall (documented)

**critical (192.168.0.50) is Alpine Linux** — it has no `bash`, no `node`, and no `systemd`, so the bash+node canonical workflow cannot run there natively (there is no scheduler on critical at all). The workflow therefore runs on **tori**, which has the full toolchain (bash, python3, node, and the repo `node_modules` including `@duckdb`/`parquetjs-lite`).

**NAS path split on tori:** tori mounts the NAS export (`192.168.0.250:/export/nas`) at `/mnt/pve/NAS`, *not* `/mnt/nas` — tori's `/mnt/nas` is a separate, **local** directory (device 2050, not NFS). The wrapper auto-detects `/mnt/pve/NAS/...` first. Writing to tori's local `/mnt/nas/...` would NOT reach the dashboard's data store. Critical mounts the same export at `/mnt/nas` directly.