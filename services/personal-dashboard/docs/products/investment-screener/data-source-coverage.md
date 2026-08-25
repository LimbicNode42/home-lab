# Investment Screener Data Source and Coverage

The **Investment Screener** tab displays the latest sanitized value-growth screening output. This guide explains the data freshness and coverage signals so the panel is easier to interpret.

## Where to find it

Open **Investment Screener**. The data-source and coverage information appears near the ranked candidates when the latest export includes it.

## What the source and coverage fields mean

The screener can read from generated dashboard artifacts. The current first-class populated market is **Australia / ASX**. The panel may show:

- generation time: when the dashboard export was produced;
- data-as-of time: the date or timestamp represented by the underlying source data when available;
- source mode: fixture, live prototype, ASX time-series, or unknown;
- coverage denominator: the size of the candidate universe used for the run;
- usable candidate count: how many records had enough information to rank;
- warnings or limitations: known gaps in the current export.

Coverage is a quality signal, not a promise. A high score from a thin or stale universe deserves more skepticism than a high score from a fresh, broad universe. Annoying, but cheaper than false confidence.

## How to use it

1. Check whether the panel says the output is fixture/sample, live prototype, or ASX-generated.
2. Compare generation time and data-as-of time.
3. Review coverage before trusting the ranking order.
4. Read warning messages and candidate caveats before doing any follow-up research.
5. Use primary filings or an authorised market-data source before making any financial decision.

## Data source and freshness

The dashboard reads the latest sanitized screener export from its runtime cache. It does not fetch market data from the browser and it does not recompute scores during filtering. Search, market, score focus, weight presets, and pagination operate on the already-sanitized export.

When richer file-first artifacts are available, the backend can build a summary from immutable run outputs and latest-run pointers. When those artifacts are unavailable, the dashboard may fall back to the older latest ranked/report files if they are configured.

## Empty and error states

- **No output yet** means no dashboard-safe screener export is available.
- **Not configured** means the dashboard instance does not have a screener source wired in.
- **Unsupported filter** means the current export does not include a requested filter field, such as sector or industry.
- **No matching candidates** means your filters were valid but matched nothing in the current sanitized universe.
- **Degraded source** means the panel loaded data with warnings, fallback behavior, or incomplete coverage.

## Known limitations

- The screener is an investigation aid, not financial advice or a trading signal.
- Unofficial or prototype data sources can be incomplete, delayed, throttled, or wrong.
- Scores are simplified screening heuristics and are not comparable across all markets without context.
- Filtering never adds fresh data; it only narrows the current export.
- Exchange, region, sector, and industry filters remain disabled until those fields are exported safely.

## Troubleshooting hints

- If the panel shows sample or fixture data, do not treat the ranking as a live market result.
- If coverage is unexpectedly low, review the upstream screener generation status before tuning dashboard filters.
- If a filter says unsupported, reset filters and use search or market until the export includes richer fields.
