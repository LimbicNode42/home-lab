# ASX Hydration Audit and Implementation Plan

> Audit artifact for Kanban task `t_6c674928`. This document is internal operator guidance, not financial advice.

## Current implementation map

### Collectors and generators

- `services/personal-dashboard/investment-screener/screener.py`
  - ASX-first CLI and library.
  - Inputs: `--asx-watchlist`, `--asx-universe-seed`, `--asx-tickers`, or `--fixture`.
  - Current bootstrap provider path: Yahoo Finance chart endpoint for quote/currency/name plus Yahoo fundamentals-timeseries for annual financial fields.
  - Current fields: price, shares outstanding, revenue/prior revenue, net income, operating cash flow, capital expenditure, total/current assets and liabilities, plus derived market cap, P/E, price/sales, margins, ROE, current ratio, debt/assets, FCF, FCF margin, and revenue growth.
  - Output modes: legacy `latest_ranked.json` + `latest_report.txt`, optional canonical file-first run payload via `--file-first-run-json`, and optional Postgres history via `--write-postgres-history`.
- `services/personal-dashboard/investment-screener/generate_asx_universe_seed.py`
  - Builds the reviewed ASX company-directory seed from the public ASX directory CSV.
- `services/personal-dashboard/scripts/generate-asx-universe-seed.mjs`
  - Node wrapper around the ASX seed generator.
- `services/personal-dashboard/scripts/publish-investment-screener-run.mjs`
  - Publishes a canonical run payload into the NAS/DuckDB file-first artifact layout via `publishInvestmentScreenerRun()`.

### Storage and API surface

- `services/personal-dashboard/src/investment-screener-storage.js`
  - Canonical file-first publisher and reader.
  - Writes immutable per-run JSONL/Parquet artifacts, `manifest.json`, `checksums.sha256`, latest pointers, and dashboard exports.
  - Reads latest manifest and rebuilds dashboard summaries through in-memory DuckDB without writing to the canonical tree.
- `services/personal-dashboard/src/server.js`
  - Dashboard APIs:
    - `GET /api/investment-screener/report`
    - `GET /api/investment-screener/ranked`
    - `GET /api/investment-screener/coverage`
  - Current read order supports legacy ranked/report files, optional Postgres summary, and NAS/DuckDB data-root summaries.
  - The browser never hydrates market data directly.
- `services/personal-dashboard/investment-screener/migrations/001_investment_screener_history.sql`
  - Optional/legacy Postgres history schema for runs, companies, observations, scores, provenance, and price snapshots.
- `services/personal-dashboard/investment-screener/POSTGRES_HISTORY.md`
  - Credential and verification guidance for optional Postgres history.

### Runtime and scheduler state observed in this audit

- A Hermes script named `asx-screener-cron.sh` exists outside the repo and still runs fixture mode. Its comments say to switch from `--fixture` to ASX watchlist mode when ready.
- The active Hermes cron job table inspected during this audit did not include a dedicated ASX screener job. The ASX script exists, but scheduler ownership is not currently visible as an enabled named cron entry.
- The script copies the repo screener code and the small watchlist to `critical`, runs fixture mode with Postgres history, then copies legacy latest files into NAS handoff and runtime-cache locations.
- Current repo deploy scripts mount/copy `INVESTMENT_SCREENER_HOST_DIR` into the dashboard runtime cache and configure `INVESTMENT_SCREENER_DATA_ROOT=/app` plus legacy latest-file environment variables.

## Data stores, freshness, and coverage

### Repo seeds

- `investment-screener/universe/asx-watchlist.json`
  - 10 active bootstrap tickers.
  - Human-reviewable, but partial coverage only.
- `investment-screener/universe/asx-listed-companies.seed.json`
  - 1,838 active entries from the ASX company directory CSV.
  - Retrieved at `2026-08-23T05:47:51Z`.
  - Source hash recorded as `a44aa810526fc4122c8fb2feee9a5f3dfbe5f3584b98c0f934cf3055758d4123`.
  - Sorted by market-cap descending, then ASX code.
  - Provides broader ASX universe metadata, but it is still a seed; it does not prove live provider hydration coverage.

### Canonical planned store

- Preferred store: NAS-resident immutable `investment-screener/` tree.
- Shape:
  - `runs/market=ASX/source=yahoo-finance/mode=asx-yahoo-timeseries/run_date=.../<run_id>/`
  - `companies`, `observations`, `scores`, `provenance`, `failures`, `exclusions`, `ranked_candidates` as JSONL/Parquet where appropriate.
  - `coverage.json`, `latest_ranked.json`, `checksums.sha256`, and `manifest.json`.
  - `manifests/market=ASX/source=yahoo-finance/latest.json` and append-only `runs.jsonl`.
  - `exports/dashboard/market=ASX/latest_ranked.json`, `latest_coverage.json`, `latest_report.txt`.
- DuckDB is a read/query layer only. Do not use a DuckDB file as the source of truth and do not write generated DuckDB state into the canonical/runtime-cache tree.

### Optional historical store

- Postgres tables exist as a reviewed optional/legacy history contract.
- Postgres should not be the dashboard's only path to latest output. A database outage must not break a valid last file-first export.
- Runtime credentials must come from the approved secret manager or runtime env only; never from repo docs, process arguments, or Kanban comments.

### Current freshness/coverage status

- Repo seed freshness: ASX directory seed retrieved `2026-08-23T05:47:51Z`; small watchlist has no generated metadata wrapper.
- Tests prove fixture, stubs, file-first publish, DuckDB read, and dashboard API paths. They do not prove current live ASX Yahoo coverage.
- Existing dogfood evidence showed a dashboard response with 48 ASX candidates and `asx-yahoo-timeseries` labels, but the current worker namespace could not see a mounted NAS/runtime-cache screener directory. Treat live freshness as needing deploy-host verification, not as proven by this audit.
- The visible standalone scheduler script is fixture mode, so recurring non-fixture ASX hydration is not yet safely owned end-to-end.

## Failure modes found

- Scheduler drift: script exists but no enabled named ASX cron entry was visible in the inspected active cron table.
- Mode drift: runtime script still uses `--fixture`, so it can refresh the panel without proving live ASX hydration.
- Store drift: docs and tests prefer NAS/DuckDB file-first artifacts, while the standalone script still publishes legacy latest files and Postgres history.
- Coverage ambiguity: a 10-name watchlist is intentionally partial; the 1,838-name ASX seed is broader but not yet the default recurring hydration input.
- Provider risk: Yahoo public endpoints are unofficial and can throttle, omit fields, return stale values, or change response shape.
- Retry/backoff gap: current fetch helper has bounded timeouts and cache support, but no true per-request retry/backoff/jitter wrapper yet.
- Freshness UX gap: coverage metadata exists, but visible stale-threshold warnings are still planned rather than complete.
- Fundamentals detail gap: company drill-down API/UI does not exist yet; current UI is ranked-list/latest-snapshot first.

## Planned features inventory

Already implemented or mostly present:

- ASX watchlist and broad ASX directory seed support.
- Yahoo chart + fundamentals-timeseries bootstrap hydration.
- Per-field provenance and missing-field representation.
- Dashboard-safe ranked JSON and plain-text report.
- File-first NAS/DuckDB publisher and dashboard reader.
- Optional Postgres schema/writer for history.
- Dashboard ranked, coverage, and report APIs with sanitization.
- Tests for CLI, file-first publishing, DuckDB reads, dashboard APIs, and filter validation.

Still undone or incomplete:

- Dedicated scheduled non-fixture ASX hydration job with clear owner, cadence, logs, and failure notifications.
- Switch recurring runtime path from legacy latest-file fixture publication to canonical file-first ASX Yahoo publication.
- Live deploy-host verification of canonical NAS artifact tree and latest pointer freshness.
- Per-provider retry/backoff/jitter wrapper around Yahoo requests.
- Visible stale/freshness threshold warnings in dashboard API/UI.
- Broader ASX seed batching as the recurring input, with denominator labels that distinguish full seed, top-N batch, and small watchlist.
- Company fundamentals detail route/API/UI.
- Historical run list, company trend, sector, and performance endpoints.
- Primary-source ASX announcements/company-report verification lane.
- Paid provider evaluation, only if bootstrap value justifies credential/licensing work.
- Sector-specific scoring models for banks/financials/resources/healthcare.
- Dividend/corporate-action adjusted performance snapshots.

## Appropriate source strategy

Use now:

- Yahoo Finance chart and fundamentals-timeseries as bootstrap-only evidence, labeled `asx-yahoo-timeseries` / `yahoo-finance` with explicit trust caveats.
- ASX company directory CSV for universe identity/metadata seed generation.
- Existing committed watchlist for small bounded smoke runs.
- Existing broad ASX seed for deterministic batches once operational controls are ready.

Use next, but do not block bootstrap on it:

- ASX announcements and company reports as the source-of-record verification lane for high-interest candidates and quarterly refreshes.
- Store document links/provenance/extraction status separately before using extracted numeric values in scoring.

Defer:

- Paid APIs until the Yahoo/ASX bootstrap has proven useful gaps and Ben explicitly approves provider, credentials, licensing, and storage terms.

Do not invent:

- Broker, paid market-data, or credentialed filing-provider access.
- Raw provider payload retention in dashboard-readable paths.
- Financial metrics that the selected source did not provide.

## Implementation plan for child task `t_754decf4` — hydration and freshness

1. Add a tiny artifact preflight command if not already present in the target branch: validate manifest latest pointer, checksums, required JSONL/Parquet/dashboard export files, fixture-vs-live mode labels, coverage denominator, and stale thresholds.
2. Add per-request retry/backoff/jitter around `_fetch_json_url()` with tests using fake fetchers or monkeypatched URL openers. Preserve current timeouts: chart <= 20s, fundamentals <= 30s.
3. Change the recurring script/workflow from fixture legacy publication to canonical file-first publication using `--file-first-run-json` plus `publish-investment-screener-run.mjs`.
4. Keep legacy `latest_ranked.json` and `latest_report.txt` as compatibility exports generated by the publisher, not as the only store.
5. Make the default bounded live run use `asx-listed-companies.seed.json` with `--batch-size`/`--batch-offset`, or explicitly document why the 10-name watchlist remains the first production batch.
6. Add freshness metadata to dashboard coverage: generated age, source data-as-of age, latest retrieved time, stale boolean, and warning messages.
7. Create or update a named Hermes cron job only after the command is safe in dry-run/fixture mode and Ben approves any live deployment mutation. The job should log run id, mode, universe hash, candidate/failed counts, and pointer path, but no secrets.
8. Verify with: Python screener tests, dashboard `npm test`, a fixture publisher smoke, a bounded non-fixture dry run if network access is available, and read-only dashboard API checks.

Acceptance criteria:

- Re-running the same logical period is idempotent and does not corrupt or duplicate latest pointers.
- A failed publication leaves previous latest intact.
- Coverage API reports mode, generated time, latest retrieved time, denominator status, usable/scored/failed/excluded counts, and stale warning state.
- No raw provider payloads, credentials, local paths, or task ids appear in dashboard responses.
- The active scheduler has a named owner/job or the deployment handoff explicitly says no scheduler was created.

## Implementation plan for child task `t_83b033c1` — company fundamentals detail

1. Define a sanitized company detail payload keyed by ticker, initially from latest file-first artifacts and later from Postgres/history projections.
2. Add API path `GET /api/investment-screener/company/:ticker` or equivalent under the existing investment screener API namespace.
3. Map available latest data into sections:
   - identity/profile: ticker, name, market, exchange, region, sector, industry, currency;
   - valuation: market cap, P/E, price/sales;
   - quality/growth/safety: score components, net margin, ROE, FCF, FCF margin, revenue growth, current ratio, debt/assets;
   - statements summary: raw normalized annual fields already present;
   - provenance/freshness: source families, retrieved times, data-as-of dates, caveats;
   - unavailable data: explicit missing fields and unsupported metrics.
4. Keep raw field provenance internals and source URLs out of the browser unless separately sanitized and reviewed.
5. Add UI drill-down from ranked candidates to a company detail panel/modal/route. Missing data should be boring and explicit, not dressed up as insight.
6. Add tests for API validation, sanitization, missing-data states, and UI navigation from a candidate card.

Acceptance criteria:

- A known ticker from a fixture/file-first export returns detail data without raw provider payloads or secrets.
- Unknown or invalid tickers return sanitized 404/400 errors.
- UI distinguishes present, missing, stale, and unsupported fields.
- No metric is fabricated when source data is unavailable.
- Existing ranked/report/coverage APIs and current dashboard navigation remain green.

## Verification run during audit

- `python3 -m unittest investment-screener/tests/test_asx_screener.py -v`: 47 tests passed.
- `npm test`: 178 tests passed.
- Current working tree had unrelated untracked artifacts before this audit; this plan file is the only intentional audit output.
