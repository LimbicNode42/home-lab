# Investment Screener Product Guide

## What this is

The Investment Screener is a private research aid for turning a prepared universe of public companies into a short list of candidates worth human review. It applies value-growth heuristics inspired by Graham, Buffett, and Munger, then publishes a sanitized result into the home dashboard.

It is not a brokerage tool, valuation model, alerting system, or recommendation engine. It is a triage tool: it helps decide what to read next.

## Who it is for

| Audience | Use |
| --- | --- |
| Ben | Review a small set of candidates without reading raw JSON first. |
| Future Hermes workers | Keep generator, dashboard, and docs aligned without exposing internals. |
| Household/authenticated dashboard users | Read the latest safe, summarized output if Ben chooses to share the panel. |

## When to use it

Use the screener when you want a first-pass shortlist before deeper investment research. It is useful for questions like:

- Which candidates currently look strongest on quality and valuation heuristics?
- Which markets are represented in the current export?
- What changed in the latest generated report compared with the last manual review?
- Which high-scoring candidates carry risk flags or missing-data caveats?

Do not use it as the final reason to buy, sell, hold, size, or time a position. The boring disclaimer is doing real work here.

## Product and deliverable map

| Deliverable | Purpose | Primary user action | Doc |
| --- | --- | --- | --- |
| Screener concept | Defines what the product is and is not. | Decide whether this tool fits the research question. | This guide |
| CLI/generator artifact | Produces the ranked export and plain-text report from a prepared universe. | Run or schedule a generation job after verifying inputs. | [CLI and generator](./cli-generator.md) |
| Ranked JSON output | Machine-readable, dashboard-safe candidate data. | Feed the dashboard; do not read manually unless debugging. | [Interpreting results](./interpreting-results.md) |
| Plain-text report output | Human-readable snapshot of the latest run. | Skim candidates, caveats, and limitations when the dashboard is unavailable. | [Interpreting results](./interpreting-results.md) |
| Dashboard panel | Authenticated UI for the latest export with filters and suggestion counts. | Review candidates and adjust display focus. | [Dashboard panel](./dashboard-panel.md) |
| NAS/DuckDB storage | NAS-resident immutable Parquet/JSONL run artifacts with manifests/latest pointers; DuckDB is a rebuildable query/materialization layer for dashboard summaries. | Persist recurring runs durably without requiring Postgres writes or node-local primary storage. | [Operations and limitations](./operations-limitations.md) |
| Historical storage | Legacy/optional Postgres-backed record of completed screener runs, observations, scores, and provenance. | Import or compare older runs later through sanitized projections. | [Historical pipeline architecture](./historical-pipeline-architecture.md) |
| Historical pipeline architecture | ASX-first recurring hydration, Postgres history, provenance, and dashboard evolution contract. | Guide implementation of the storage/hydration lane. | [Historical pipeline architecture](./historical-pipeline-architecture.md) |
| ASX universe source and identity rules | Canonical ASX listed-company denominator, seed schema, ticker/company ID rules, and staged expansion gates. | Expand beyond the bounded watchlist without turning the denominator into mystery soup. | [ASX universe source and identity rules](./asx-universe-source-and-identity-rules.md) |
| ASX fundamentals provider coverage | Provider coverage matrix, missing-field priorities, safe no-credential improvements, optional credential requests, and scraping risk. | Decide which fundamentals source to wire next without inventing data or upsetting ToS goblins. | [ASX fundamentals provider coverage runbook](./asx-fundamentals-provider-coverage-runbook-2026-08-28.md) |
| Operational runbook | Safe monthly/quarterly hydration, publication, checks, and troubleshooting. | Refresh output without leaking credentials or poking live services unnecessarily. | [Operations and limitations](./operations-limitations.md) |

## How to use it

1. Open the home dashboard.
2. Go to the Investment Screener tab.
3. Review the Investment Screener panel.
4. Check the generated timestamp and data-as-of value.
5. Start with the default Top 6 composite view.
6. Read every caveat, risk flag, and limitation shown for a candidate.
7. Use Market, Score focus, Weight preset, and Suggestions only to change the view of the current export.
8. For anything interesting, leave the dashboard and verify against primary filings or an authorized market-data source.

## Inputs

The product is now ASX-first. The bootstrap universe is a committed ASX watchlist rather than a live full-market discovery feed. That makes recurring runs auditable and deterministic, but it also means the screener only covers names intentionally present in the watchlist until the reviewed [ASX universe source and identity rules](./asx-universe-source-and-identity-rules.md) are implemented.

Input quality matters more than UI polish. If the watchlist is stale, sparse, sector-skewed, or missing metadata, the output will inherit those limits with a nicer hat.

First-cut hydration uses explicitly labeled bootstrap data sources. Yahoo-derived chart and fundamentals-timeseries values are useful for recurring shape checks and shortlisting, but they are not ASX filings and must not be treated as source-of-record data. Interesting candidates still need verification against company reports, ASX announcements, or another authorized source.

The dashboard does not fetch fresh market data. It reads only sanitized exports or rebuildable DuckDB summaries generated from NAS-backed artifacts mounted into the dashboard runtime. Historical data is written by the generator/storage lane, not by the browser.

## Outputs

| Output | Human meaning | Notes |
| --- | --- | --- |
| Candidate rank | Relative order inside the current export. | Not comparable across unrelated runs unless inputs and weights match. |
| Composite score | Overall heuristic score. | Useful for sorting, not a valuation. |
| Sub-scores | Category-level signals such as quality, valuation, growth, Graham safety, durability, and risk adjustments. | Use to understand why a candidate surfaced. |
| Risk flags | Reasons to slow down before trusting a high score. | Read before excitement. Excitement is how spreadsheets get you. |
| Caveats | Missing data, caps, or interpretation warnings. | A caveat can matter more than the headline score. |
| Limitations | Run-level warnings about coverage, source quality, filters, or mode. | Apply to the whole output. |

## Interpreting scores

Scores are screening heuristics. Treat a high score as "worth reading" rather than "worth buying." Treat a low score as "not prioritized by this model" rather than proof that the company is poor.

The useful workflow is:

1. Look at rank and composite score.
2. Check the score dimensions that drove the result.
3. Read risk flags and caveats.
4. Confirm whether the candidate fits the intended market and currency context.
5. Do independent research before making any decision.

## Known limitations

- The screener can only score fields present in the input data.
- The ASX-first bootstrap universe is not full ASX coverage until a broader importer is implemented and reviewed.
- Yahoo-derived values are bootstrap evidence, not authoritative filings data.
- Cross-market and cross-sector comparisons may be distorted by accounting, currency, reporting cadence, and data-provider differences; banks and financials are especially easy to misread with industrial-company metrics.
- Dashboard filters operate on the latest exported data; they do not recompute the model.
- Historical trends are useful for direction and recurrence, but only when run cadence, universe, source quality, storage manifest, and scoring version are considered together.
- The canonical new storage path is the NAS-backed file store: immutable `runs/.../manifest.json`, `*.jsonl`, `*.parquet`, `checksums.sha256`, and `manifests/.../latest.json`. A DuckDB file may be regenerated from those artifacts and is not the source of truth.
- The dashboard intentionally exposes a sanitized projection, not raw scorer internals or database rows.

## Operational runbook

For routine operation, use the dashboard first. If the dashboard says output is missing, stale, or unavailable, follow [Operations and limitations](./operations-limitations.md). Do not restart the live dashboard or change deployment mounts just to refresh docs or read a report.

## Troubleshooting

| Symptom | Likely meaning | First check |
| --- | --- | --- |
| Panel says output is not configured | Runtime does not know where to read the sanitized export. | Check dashboard deployment configuration in the operator runbook. |
| Panel says output has not been generated | Export file is missing or not a regular file. | Run or inspect the generator job. |
| Filters return no candidates | Current export has no matching candidates after sanitization. | Clear filters, then check whether the requested field exists in the export. |
| Scores look surprising | Weighting, missing data, score caps, or source quality may be driving the result. | Read sub-scores, risk flags, caveats, and limitations. |

## Next improvements

- Keep the in-browser documentation map current as new screener docs are added.
- Export richer safe metadata for exchange, region, sector, and industry filters.
- Add a freshness badge and last-success marker for the generator job.
- Add side-by-side run comparison once sanitized historical Postgres projections exist.
- Add a human review notes field outside the ranked JSON contract.
