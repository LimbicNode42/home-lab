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
5. Publish both the ranked JSON and plain-text report together.
6. Refresh the Investment Screener tab.
7. Confirm generated timestamp, candidates, limitations, and doc links appear.

### Monthly ASX hydration

Use the monthly run for routine watchlist refresh and latest-dashboard publication.

1. Review the committed ASX watchlist for obvious stale entries, inactive names, or missing sector labels. Do not silently broaden the universe during a routine monthly run.
2. Run generator tests or fixture smoke checks before touching runtime artifacts.
3. Render runtime-only environment variables from the approved secret manager or deployment environment. Do not paste database URLs, passwords, tokens, or local paths into the command, logs, docs, or Git.
4. Run ASX hydration with a stable monthly run key built from market, source mode (`asx-yahoo-timeseries` for the Yahoo bootstrap lane), period, universe hash, config hash, and code version. Use `--max-tickers`, `--sleep-seconds`, and `--cache-dir` for bounded, non-aggressive provider access.
5. Write Postgres history only when the runtime credential is available and the storage lane has been approved for that environment. A database failure should not require breaking the latest-file dashboard if a valid last export exists.
6. Validate the generated ranked JSON and plain-text report before publication. Check candidate count, excluded count, limitations, generated timestamp, data-as-of values, and source-quality labels.
7. Publish the latest files atomically through the approved file handoff: validate temporary outputs first, then replace the current latest pair together.
8. Refresh the dashboard Investment Screener tab and verify the latest artifact display. Do not expect historical charts yet.
9. Record a short operator note with cadence, period, universe version/hash, code version, candidate count, excluded count, source mix, and any caveats worth human review. Keep the note sanitized.

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

## Data-source limitations

- Fixture/sample data is for validation, not investment research.
- The committed ASX watchlist is a bootstrap universe, not full ASX coverage.
- Unofficial live data can be stale, incomplete, blocked, rate-limited, or silently changed by the provider.
- Different markets and sectors can have incompatible accounting conventions, currencies, and reporting cadence.
- Banks and financials need different metrics from industrial companies; treat first-cut scores as rough triage only.
- A clean dashboard card does not prove the source data is correct.
- Yahoo ASX hydration is a bootstrap source, not a source-of-record filings archive.
- Historical database projections must be sanitized before dashboard exposure.

## Financial-advice disclaimer

The screener is informational only. It does not provide financial advice, personal recommendations, ratings, or trade signals. Any candidate selected by the screener requires independent human due diligence.

## Next improvements

- Add a docs manifest file separate from server code if the approved-docs list keeps growing.
- Add automated validation that product docs contain no forbidden runtime patterns.
- Add a generated-output schema check before the dashboard reads a new ranked JSON file.
- Add a freshness threshold and visible stale-warning state.
- Add the ASX historical pipeline and recurring-job controls described in [Historical pipeline architecture](./historical-pipeline-architecture.md).
