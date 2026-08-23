# Investment Screener Operations and Limitations

## What this is

This runbook explains how to keep the Investment Screener docs, generator outputs, and dashboard panel aligned without leaking secrets or poking live infrastructure unnecessarily.

## Who it is for

- Operators maintaining the dashboard.
- Hermes workers updating the screener contract.
- Ben when deciding whether a missing or stale panel needs action.

## When to use it

Use this when the panel is missing output, output appears stale, filters behave unexpectedly, docs are absent from the Documentation panel, or the generator contract changes.

## Safety rules

- Do not publish raw task bodies, local filesystem paths, tokens, internal DB names, error output, or debug dumps into user-facing docs or dashboard outputs.
- Do not restart or redeploy the live dashboard for documentation-only changes.
- Do not bind unsanitized generator workspaces directly into the dashboard runtime.
- Do not treat unofficial market data as authoritative.
- Do not use Tori/Toyota node-local storage, SD cards, or a DuckDB file as the durable primary screener store. The durable store is the NAS-backed immutable file layout.
- Do not run active OLTP-style Postgres/DuckDB WAL writes over NFS/mergerfs for screener history; publish files atomically, then rebuild query summaries.
- Keep product docs non-secret and internal by default.

## Documentation information architecture

The investment screener docs live as committed Markdown under the personal dashboard docs tree:

| File | Purpose |
| --- | --- |
| `services/personal-dashboard/docs/products/investment-screener/README.md` | Product overview and deliverable map. |
| `services/personal-dashboard/docs/products/investment-screener/cli-generator.md` | Generator usage and output contract in human terms. |
| `services/personal-dashboard/docs/products/investment-screener/dashboard-panel.md` | Dashboard panel usage, controls, and UI troubleshooting. |
| `services/personal-dashboard/docs/products/investment-screener/interpreting-results.md` | Scores, filters, caveats, and review workflow. |
| `services/personal-dashboard/docs/products/investment-screener/operations-limitations.md` | Operations, trust boundaries, and limitations. |
| `services/personal-dashboard/docs/products/investment-screener/historical-pipeline-architecture.md` | ASX-first recurring hydration, Postgres history, provenance, and dashboard evolution contract. |

Rationale: these docs sit beside the dashboard service because the authenticated home dashboard is the current delivery surface. A future public/sanitized docs site can copy from this structure, but should not be assumed by default.

## Operational runbook

### Missing or stale dashboard output

1. Check the dashboard panel message.
2. If it says output is not configured, inspect the dashboard runtime configuration through the approved operator process.
3. If it says output has not been generated, inspect the generator job and export artifacts.
4. If output exists but is stale, rerun the generator using the approved artifact workflow.
5. For the NAS/DuckDB path, inspect `manifests/market=<MARKET>/source=<SOURCE>/latest.json`, the referenced run `manifest.json`, `checksums.sha256`, and the generated `exports/dashboard/market=<MARKET>/latest_ranked.json` / `latest_coverage.json` files.
6. For the legacy latest-file path, publish both the ranked JSON and plain-text report together.
7. Refresh the Investment Screener tab.
8. Confirm generated timestamp, candidates, limitations, coverage, provenance/source summary, and doc links appear.

### NAS/DuckDB file-first publication

Use the file-first storage path for durable recurring screener history. The NAS directory mounted or copied into the dashboard runtime should contain an `investment-screener/` tree with immutable run artifacts and small latest pointers.

1. Produce a complete run payload with explicit `market`, `source`, `mode`, `started_at`, `completed_at`, `data_as_of`, universe metadata, companies, scores, observations, provenance, failures, and exclusions.
2. Publish through the storage helper (`publishInvestmentScreenerRun` in `src/investment-screener-storage.js`) or an equivalent single-writer job. It writes to a same-filesystem staging directory, validates rows, writes JSONL and Parquet companions, calculates checksums, then atomically promotes the run directory and `manifests/.../latest.json` pointer.
3. If validation fails, do not manually advance `latest.json`; the previous latest pointer must remain valid.
4. Publish safe dashboard exports under `exports/dashboard/market=<MARKET>/` in the same single-writer path. Runtime API reads may query the immutable Parquet artifacts with in-memory DuckDB, but must not create `duckdb/`, materialized databases, or export files in the canonical/runtime-cache tree.
5. Configure the dashboard with `INVESTMENT_SCREENER_DATA_ROOT=/app` when `/app/investment-screener` is the read-only runtime-cache copy of the NAS data tree. `INVESTMENT_SCREENER_RANKED_FILE` and `INVESTMENT_SCREENER_REPORT_FILE` remain supported as legacy fallback paths.
6. Verify the browser/API payloads do not contain NAS mount paths, local paths, DB URLs, task ids, stack traces, or secret-shaped values.

Quick read-only verification examples, run against a copied/safe data root rather than live writer staging:

```sh
node --input-type=module -e "import { readLatestInvestmentScreenerManifest } from './src/investment-screener-storage.js'; console.log(await readLatestInvestmentScreenerManifest({ dataRoot: process.env.INVESTMENT_SCREENER_DATA_ROOT || '/app', market: 'ASX', source: 'yahoo-finance' }))"
node --input-type=module -e "import { buildInvestmentScreenerDuckDbSummary } from './src/investment-screener-storage.js'; console.log(await buildInvestmentScreenerDuckDbSummary({ dataRoot: process.env.INVESTMENT_SCREENER_DATA_ROOT || '/app', market: 'ASX', source: 'yahoo-finance' }))" # read-only query, no canonical writes
```

### Monthly ASX hydration

Use the monthly run for routine watchlist refresh and latest-dashboard publication.

1. Review the committed ASX watchlist for obvious stale entries, inactive names, or missing sector labels. Do not silently broaden the universe during a routine monthly run.
2. Run generator tests or fixture smoke checks before touching runtime artifacts.
3. Render runtime-only environment variables from the approved secret manager or deployment environment. Do not paste database URLs, passwords, tokens, or local paths into the command, logs, docs, or Git.
4. Run ASX hydration with a stable monthly run key built from market, source mode (`asx-yahoo-timeseries` for the Yahoo bootstrap lane), period, universe hash, config hash, and code version. Use `--max-tickers`, `--sleep-seconds`, and `--cache-dir` for bounded, non-aggressive provider access.
5. Prefer the NAS/DuckDB file-first publication path. Write Postgres history only when the runtime credential is available and the storage lane has been approved for that environment. A database failure should not require breaking the latest dashboard view if a valid last export exists.
6. Validate the generated artifacts before publication. Check candidate count, excluded count, coverage denominator/status, limitations, generated timestamp, data-as-of values, source-quality labels, provenance rows/fields, manifest checksums, and fixture/live mode labeling.
7. Publish via staging plus atomic promote/latest pointer update; never edit a published run directory in place.
8. Refresh the dashboard Investment Screener tab and verify the latest artifact display.
9. Record a short operator note with cadence, period, universe version/hash, code version, candidate count, excluded count, source mix, manifest run id, and any caveats worth human review. Keep the note sanitized.

### Quarterly reporting-season refresh

Use the quarterly run after major reporting windows to refresh evidence more deliberately.

1. Start with the monthly checklist.
2. Review high-interest candidates and repeated caveats from prior runs.
3. Prefer ASX announcements or company reports for verification of candidates that remain interesting, especially where bootstrap values are stale, missing, or sector-sensitive.
4. Label primary-source verification separately from bootstrap provider values; do not overwrite provenance with a vaguer label.
5. Pay special attention to banks, diversified financials, resources, and healthcare names. The first scoring model can make these look cleaner or worse than they deserve.
6. Publish dashboard latest files only after the run is internally consistent and caveats are visible enough for human review.

### Documentation changes

1. Edit only committed Markdown docs and the approved docs manifest.
2. Keep paths repo-relative in prose and code.
3. Run the dashboard test suite if the docs manifest, server code, or document-rendering behavior changes. For Markdown-only edits, run lightweight validation and `git diff --check`.
4. Do not restart the live service for docs alone.
5. Let the normal deploy/rebuild process pick up committed docs later.

## Troubleshooting

| Symptom | Likely cause | Safe response |
| --- | --- | --- |
| New doc does not appear in Documentation panel | It is not in the approved docs manifest or committed-path list. | Add the repo-relative Markdown path to the manifest source used by the dashboard. |
| Doc appears in list but fetching returns not found | Runtime docs copy does not include the file. | Rebuild/deploy through the approved flow when appropriate. |
| Doc content has missing lines | Runtime sanitizer removed lines containing forbidden local or secret-like values. | Rewrite the docs with repo-relative, non-secret wording. |
| Dashboard doc link points to old epic doc only | Investment screener API doc links need updating. | Point doc links at product docs first, epic docs second if still useful. |
| Filter error mentions unsupported field | Field is not present in the sanitized export. | Do not enable the UI control until the export safely includes it. |
| Latest run vanished after failed publication | A writer advanced the latest pointer before validation, or a manual edit bypassed staging. | Restore `latest.previous.json` if present, inspect checksums, and fix the writer before rerunning. |
| DuckDB file is locked, stale, or missing | DuckDB is a generated materialization, not the canonical store. | Delete/rebuild the materialized DB from NAS run artifacts; do not repair by editing canonical Parquet/JSONL files. |

## Data-source limitations

- Fixture/sample data is for validation, not investment research.
- The committed ASX watchlist is a bootstrap universe, not full ASX coverage.
- Unofficial live data can be stale, incomplete, blocked, rate-limited, or silently changed by the provider.
- Different markets and sectors can have incompatible accounting conventions, currencies, and reporting cadence.
- Banks and financials need different metrics from industrial companies; treat first-cut scores as rough triage only.
- A clean dashboard card does not prove the source data is correct.
- Yahoo ASX hydration is a bootstrap source, not a source-of-record filings archive.
- Historical database projections must be sanitized before dashboard exposure.
- DuckDB materializations are disposable query artifacts. The source of truth is the NAS manifest plus immutable Parquet/JSONL run files.

## Financial-advice disclaimer

The screener is informational only. It does not provide financial advice, personal recommendations, ratings, or trade signals. Any candidate selected by the screener requires independent human due diligence.

## Next improvements

- Add a docs manifest file separate from server code if the approved-docs list keeps growing.
- Add automated validation that product docs contain no forbidden runtime patterns.
- Extend generated-output schema checks to cover manifests, Parquet/JSONL companions, latest pointers, and DuckDB dashboard exports.
- Add a freshness threshold and visible stale-warning state.
- Add the ASX historical pipeline and recurring-job controls described in [Historical pipeline architecture](./historical-pipeline-architecture.md).
