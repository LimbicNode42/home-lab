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

For missing or stale dashboard output:

1. Check the dashboard panel message.
2. If it says output is not configured, inspect the dashboard runtime configuration through the approved operator process.
3. If it says output has not been generated, inspect the generator job and export artifacts.
4. If output exists but is stale, rerun the generator using the approved artifact workflow.
5. Publish both the ranked JSON and plain-text report together.
6. Refresh the Reports tab.
7. Confirm generated timestamp, candidates, limitations, and doc links appear.

For documentation changes:

1. Edit only committed Markdown docs and the approved docs manifest.
2. Keep paths repo-relative in prose and code.
3. Run the dashboard test suite.
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
- Unofficial live data can be stale, incomplete, blocked, or silently changed by the provider.
- Different markets can have incompatible accounting conventions and currencies.
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
