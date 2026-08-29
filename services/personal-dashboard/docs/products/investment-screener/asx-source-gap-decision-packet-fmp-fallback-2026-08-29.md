# ASX source-gap decision packet — FMP fallback

> Kanban task `t_7a94c81e`. Documentation/decision packet only. No signups, secrets, live hydration, scheduler changes, pointer rollback, cache pruning, or provider credential changes were performed.

## Decision needed

Yahoo-only ASX top-400 hydration missed the agreed rollout gate. Do not run the full 1,838-entry ASX seed on Yahoo-only data unless Ben explicitly accepts the lower coverage or enables a credentialed fallback source.

Recommended path: enable Financial Modeling Prep (`FMP_API_KEY`) first as a fill-only fallback provider. Keep Alpha Vantage as low-volume spot-fill only. Do not build MarketIndex or TradingView scrapers.

## Why Yahoo-only stopped

The supervised top-400 run `investment-screener_ASX_asx-yahoo-timeseries_2026-08-29T015127Z_5871117f2bec` published 342 usable companies out of 400, or 85.5% coverage. The rollout plan required at least 88% usable coverage for top-400 before proceeding toward a full-seed run.

The failure pattern points to source coverage, not a broken command path:

- 36 tickers had revenue, net income, total assets, and total liabilities stale beyond the 730-day exclusion threshold.
- 7 tickers had net income, total assets, and total liabilities stale beyond 730 days.
- 7 tickers were missing price or shares outstanding, preventing market cap and valuation scoring.
- 4 tickers had revenue stale beyond 730 days.
- Remaining cases were smaller stale-field combinations, including operating cash flow.

Published provenance was `yahoo-finance` and `derived` only. That means Yahoo already supplies the needed raw-field taxonomy when it has data; the gap is breadth/freshness/reliability across ASX names.

Reference: [ASX top-400 hydration result — 2026-08-29](./asx-top-400-hydration-result-2026-08-29.md).

## Provider path

### 1. Financial Modeling Prep first

Use FMP as the first optional credentialed fallback because it has the best field coverage per request for this screener:

- quote, income statement, balance sheet, cash flow, and ratio coverage;
- useful pre-computed ratios including PE, price-to-sales, net margin, ROE, FCF, current ratio, debt/assets, and market cap;
- documented free tier around 250 API calls/day, enough to validate bounded top-N runs more realistically than Alpha Vantage free tier;
- already represented in the provider-fallback implementation as a fail-closed runtime adapter behind `FMP_API_KEY`.

Expected implementation behavior is fill-only: FMP may fill missing raw fields, but must not silently overwrite present Yahoo values. Provider provenance must remain visible as a separate source family.

### 2. Alpha Vantage spot-fill only

Alpha Vantage remains a secondary option for a small number of names, not a broad ASX batch source. Its free tier is too small for routine top-50/top-400 hydration without starving the run and creating misleading partial coverage.

### 3. No MarketIndex or TradingView scraping

Do not build MarketIndex or TradingView scrapers for this lane. Prior research recorded MarketIndex bot/WAF/ToS fragility and TradingView JS-heavy/ToS/selector fragility. They can remain human comparison pages, not automated recurring data sources. Boring, but less likely to wake the goblins.

References:

- [ASX Fundamentals — Data-Source Coverage Options](./asx-fundamentals-data-source-coverage.md)
- [ASX fundamentals provider coverage runbook — 2026-08-28](./asx-fundamentals-provider-coverage-runbook-2026-08-28.md)
- [Provider fallback and conflict handling](./provider-fallback-conflict-handling.md)

## Exact non-secret operator ask for Ben

Ben, if you approve the FMP fallback path:

1. Create a Financial Modeling Prep API key.
2. Store the secret value in Vaultwarden, folder `homelab`.
3. Use this item/field convention unless you prefer another runtime secret path:
   - folder: `homelab`
   - item: `investment-screener/fmp`
   - field: `api_key`
   - runtime environment variable: `FMP_API_KEY`
4. Confirm the runtime injection path for manual/scheduler execution. Acceptable examples:
   - a local root-only env file rendered from Vaultwarden with mode `0600`; or
   - an existing approved wrapper that exports `FMP_API_KEY` only for the hydration command.
5. Do not commit the key. Git should contain only the item/field/env-var references above.

Do not paste the key into a kanban comment, commit message, shell transcript, Discord message, or documentation file. The next hydration worker only needs to know where the key lives and how the runtime receives `FMP_API_KEY`; it does not need to see the value.

## Gate after Ben provides the key

Once Ben has stored the key and confirmed runtime injection, the follow-up execution card can proceed with a bounded FMP fallback validation:

1. Preflight current latest state and confirm no ASX hydration job is already running.
2. Inject `FMP_API_KEY` at runtime only; do not echo it.
3. Run a tiny smoke first, preferably top 5 or a selected previously-failed set if supported, writing to `/tmp` or dry-run where possible.
4. If smoke passes, run supervised top-400 prefix with fallback enabled against the NAS data root.
5. Verify preflight, coverage, provenance (`fmp` present only where FMP filled), preservation of `latest.previous.json`, failure reduction, sane run size, and whether coverage clears the 88% gate.
6. Keep full-seed blocked unless the FMP-backed top-400 result clears the gate or Ben explicitly accepts the remaining coverage gap.

## Non-actions in this packet

- No provider signup was performed.
- No key was created, requested from an API, stored, printed, or committed.
- No hydration run was started.
- No scheduler/cadence/default batch setting changed.
- No NAS latest pointer rollback or cache cleanup was performed.
