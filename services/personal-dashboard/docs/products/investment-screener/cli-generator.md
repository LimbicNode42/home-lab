# Investment Screener CLI and Generator

## What this is

The CLI/generator is the backend artifact that turns an input universe into two safe deliverables:

1. a ranked JSON object for the dashboard API; and
2. a plain-text report for quick human reading or fallback review.

The generator is the production line. The dashboard is the display case. Do not confuse the two unless you enjoy debugging ghosts.

## Who it is for

- Operators running or scheduling the screener export.
- Hermes workers maintaining the scoring contract.
- Ben when validating why the dashboard has, or lacks, fresh output.

## When to use it

Use the generator when the dashboard output is stale, missing, or needs a refreshed ASX watchlist/universe. Use fixture or sample mode for local validation. Use live or unofficial data modes only when the data-source risk has been explicitly accepted and the run will label provenance accordingly.

## Inputs

| Input | Purpose | Notes |
| --- | --- | --- |
| Company universe | Defines which securities can be considered. | The screener cannot discover or score companies that are absent. |
| Financial fields | Supplies valuation, quality, growth, durability, and safety signals. | Missing fields should create caveats or penalties, not silent confidence. |
| Filters | Narrow the universe before scoring where supported by the input data. | Market, exchange, region, sector, and industry are only meaningful if present. |
| Weighting | Tilts category importance for the run. | Keep weights explicit and non-negative. |
| Suggestion count | Limits how many candidates are highlighted. | Current dashboard-safe maximum is 25. |
| ASX watchlist | Bootstrap universe for recurring ASX hydration. | Small explicit sample; useful for narrow recurring runs and fixtures. |
| ASX company-directory seed | Reviewed near-full ASX listed-company universe generated from `investment-screener/generate_asx_universe_seed.py`. | Seed entries use `company_id=asx:{asx_code}`, Yahoo ticker `{asx_code}.AX`, sanitized source URL, and dashboard-safe denominator metadata. |
| Historical database | Stores run, observation, score, and provenance history. | Inject credentials at runtime only; see [Historical pipeline architecture](./historical-pipeline-architecture.md). |

## Outputs

| Output | Purpose | Human should read it? |
| --- | --- | --- |
| Ranked JSON | Dashboard-safe machine contract consumed by the API. | Usually no; use the dashboard unless debugging. |
| Plain-text report | Human-readable generated report. | Yes, especially if the dashboard panel is unavailable. |
| Limitations and caveats | Explain missing data, filter behavior, source trust, or scoring caps. | Always. |

## How to use it

1. Confirm the input universe and data source are appropriate for the question.
2. Run the generator in fixture/sample mode first after code changes.
3. Run the intended export mode.
4. Verify that both ranked JSON and report outputs were produced.
5. Check that the ranked JSON is an object with `candidates`, not a raw array or internal scorer dump.
6. Copy or publish only sanitized outputs into the dashboard handoff location through the approved deployment flow.
7. Refresh the dashboard Investment Screener tab and confirm the timestamps changed.

## ASX and historical mode

For the ASX-first lane, the generator should start from either the small committed `asx-watchlist.json` or the reviewed `asx-listed-companies.seed.json`, hydrate values from explicitly labeled sources, write the sanitized latest files, and store the same run in Postgres when database storage is enabled. Yahoo-derived ASX values are bootstrap evidence, not authoritative filings data; high-interest candidates still need ASX report verification.

The near-full ASX universe seed is generated from the ASX/MarkitDigital company-directory CSV without committing the raw CSV or credential-bearing URLs:

```bash
python3 investment-screener/generate_asx_universe_seed.py \
  --input-csv /path/to/reviewed-asx-directory.csv \
  --retrieved-at 2026-08-28T05:01:59Z \
  --output investment-screener/universe/asx-listed-companies.seed.json
```

The generated seed schema is `investment-screener-asx-universe-seed/v2`. Each entry carries `company_id`, `asx_code`, Yahoo `ticker`, raw/normalized company name, market/exchange/region, `currency=AUD`, `security_type`, and explicit `active`/`suspended`/`delisted` booleans. Because the ASX directory does not publish security type, freshly generated ASX-only rows use `security_type=unknown_from_asx_directory` until an approved enrichment source supplies a better type.

Use seed batches instead of all-universe hydration by default:

```bash
python3 investment-screener/screener.py \
  --asx-universe-seed investment-screener/universe/asx-listed-companies.seed.json \
  --batch-offset 0 \
  --batch-size 50 \
  --sleep-seconds 1.0 \
  --file-first-run-json /tmp/asx-screener-run.json
```

If enrichment has populated security types, generator-side filters can keep the dashboard denominator honest:

```bash
python3 investment-screener/screener.py \
  --asx-universe-seed investment-screener/universe/asx-listed-companies.seed.json \
  --include-security-types ordinary_share,common_stock \
  --exclude-security-types etf,warrant,preferred \
  --denominator-label "ordinary ASX shares" \
  --batch-size 50 \
  --file-first-run-json /tmp/asx-ordinary-shares-run.json
```

Do not combine this with broad live hydration unless a separate reviewed task approves the batch size/provider plan. The denominator fields in the file-first payload distinguish complete seed, security-type-filtered seed, and ranked market-cap batch runs. Small labels: large consequences, fewer dashboard lies.

Historical storage must be optional from the dashboard's point of view. A failed or unavailable database should not make the existing latest-file panel unusable if the last sanitized files are present.

See [Historical pipeline architecture](./historical-pipeline-architecture.md) for the storage contract and recurring job rules. The implementation keeps the repo-backed SQL and credential notes beside the generator at `services/personal-dashboard/investment-screener/POSTGRES_HISTORY.md`; the database URL is read only from a runtime environment variable (default `DATABASE_URL`) rendered from Vaultwarden, never from committed config.

First-cut storage command shape:

```bash
export SCREENER_OUTPUT_DIR="<runtime-output-directory>"
python3 screener.py --asx-watchlist universe/asx-watchlist.json \
  --max-tickers 25 \
  --sleep-seconds 1.0 \
  --cache-dir "$SCREENER_OUTPUT_DIR/provider-cache" \
  --output-dir "$SCREENER_OUTPUT_DIR" \
  --write-postgres-history \
  --run-key investment-screener:ASX:asx-yahoo-timeseries:YYYY-MM:<universe-hash>:<config-hash>:<code-version>
```

Use `--max-tickers` for bounded/manual backfills, `--sleep-seconds` for provider throttling, and `--cache-dir` to avoid refetching the same provider JSON during a run or retry. Use `--database-url-env NAME` only to change which runtime variable holds the Postgres URL; do not place the URL itself in the command, docs, or Git. Render both the output directory and database URL from the deployment environment or secret manager, not from committed examples. Real ASX Yahoo bootstrap output is labeled `asx-yahoo-timeseries`, not `fixture`, so the dashboard/API and Postgres can distinguish it from sample data.

## Filter behavior

Generator-side filters should operate before scoring when the source data includes the requested fields. If a field is absent, the generator should fail explicitly or record a clear limitation; it should not return a mystery-empty export.

Dashboard-side filters are different: they only reshape the already-sanitized ranked export. They do not re-run the generator, fetch more data, or recompute raw metrics.

## Score dimensions

| Dimension | Meaning |
| --- | --- |
| Composite | Overall blended heuristic. |
| Quality | Business quality and profitability signals. |
| Valuation | Cheapness or margin-of-safety style signals. |
| Growth | Historical or expected growth signals where available. |
| Graham safety | Conservative balance-sheet and downside-protection signals. |
| Durability | Moat-like persistence and resilience indicators. |
| Risk adjustments | Penalties or offsets for missing data, leverage, cyclicality, or other warnings. |

## Operational runbook

For a generator run:

1. Validate inputs are current enough for the intended review.
2. Run the unit tests or fixture-mode smoke check for the generator artifact.
3. Generate both ranked JSON and plain-text report outputs.
4. Inspect the top candidates and limitations in the report.
5. Confirm the JSON contains only dashboard-safe fields.
6. Publish outputs atomically through the approved file handoff.
7. Refresh the dashboard and verify the new generated timestamp.

## Troubleshooting

| Symptom | Likely cause | Response |
| --- | --- | --- |
| Generator exits on a filter | Requested field is absent or unsupported in the input universe. | Use a supported filter or enrich the universe. |
| Dashboard has old results after a run | New outputs were not published to the dashboard handoff location. | Verify the export step and dashboard read location. |
| JSON parses but dashboard shows no candidates | Sanitization removed unsafe or incomplete candidate rows. | Inspect candidate fields for missing ticker/name or forbidden values. |
| Report exists but JSON is missing | Generator produced only one deliverable or the publish step was partial. | Re-run export and publish both files together. |

## Known limitations

- Input coverage governs output quality.
- Prototype live-data sources can be incomplete or rate-limited.
- The generator should not publish raw provider responses or internal task metadata.
- Scoring is a heuristic shortlist, not a substitute for financial analysis.

## Next improvements

- Add a machine-readable generation summary with input universe count, filtered count, excluded count, and top-level warnings.
- Add a schema check for the ranked JSON object before publication.
- Preserve safe historical snapshots for comparison via the Postgres contract in [Historical pipeline architecture](./historical-pipeline-architecture.md).
