# Investment Screener Dashboard Panel

## What this is

The dashboard panel is the authenticated home UI for the latest sanitized Investment Screener export. It is read-only. It displays candidates, timestamps, limitations, filters, and documentation links without exposing raw generator internals.

## Who it is for

- Ben, when reviewing the latest shortlist.
- Authenticated dashboard users Ben permits to see the Reports tab.
- Operators checking whether the latest export is present and readable.

## When to use it

Use the panel for normal review. It is the preferred human-facing surface because it avoids raw JSON and exposes the safest subset of fields.

Use the plain-text report only as a fallback or when comparing output outside the browser.

## How to use it

1. Open the dashboard.
2. Select the Reports tab.
3. Review the Investment Screener panel.
4. Check generated time and data-as-of time.
5. Start with the default Top 6 composite view.
6. Adjust filters only if you are answering a narrower question.
7. Read limitations, risk flags, and caveats before treating a candidate as interesting.
8. Use the documentation links for scoring and operations detail.

## Controls

| Control | What it changes | What it does not change |
| --- | --- | --- |
| Market | Limits visible candidates to a market label in the current export. | Does not fetch new markets or enrich missing market data. |
| Exchange | Currently disabled until safely exported. | Does not imply exchange is unknown forever. |
| Region | Currently disabled until safely exported. | Does not infer geography from ticker suffix. |
| Sector | Currently disabled until safely exported. | Does not classify companies client-side. |
| Industry | Currently disabled until safely exported. | Does not classify companies client-side. |
| Score focus | Re-sorts by a public sub-score. | Does not recompute the underlying score. |
| Weight preset | Applies a display tilt using public sub-scores. | Does not change generator weights or persist preferences. |
| Suggestions | Limits the number of rendered candidate cards. | Does not change the exported file. |
| Reset filters | Restores the default view. | Does not refresh source data. |

## Inputs

The panel reads the dashboard API response generated from the latest sanitized ranked JSON output. It does not accept arbitrary file paths, local uploads, or raw JSON pasted into the browser. Historical Postgres-backed views are a later, separate API surface; the current panel remains file-backed so the UI can keep working while storage evolves.

## Outputs

The panel renders:

- disclaimer;
- generation and data-as-of timestamps;
- active filter messages;
- candidate cards with rank, ticker, name, market, currency, and score;
- selected risk flags and caveats;
- run-level limitations; and
- links to approved committed docs.

## Interpreting scores in the panel

The card score is a prompt for attention, not a decision. A candidate with a high score and serious caveats may be less useful than a slightly lower-scoring candidate with cleaner data. Score dimensions help explain why a candidate rose; caveats explain why that may still be fragile.

## Known limitations

- The panel shows only the latest exported snapshot.
- Filters operate after sanitization.
- Disabled controls represent fields not yet safely present in the dashboard export.
- The UI intentionally truncates some lists so the panel remains readable.
- The Documentation panel renders these Markdown docs with headings, tables, code blocks, a table of contents, and approved in-dashboard doc links.

## Operational runbook

For panel verification:

1. Open the Reports tab.
2. Confirm either candidate cards or a safe empty/error state appears.
3. Use Refresh and confirm the panel does not throw browser errors.
4. Change Market, Score focus, Weight preset, and Suggestions.
5. Use Reset filters.
6. Confirm no raw paths, task bodies, tokens, or debug text appear in the UI.

## Troubleshooting

| Symptom | Meaning | Response |
| --- | --- | --- |
| Output is not configured | Dashboard runtime lacks configured report/ranked sources. | Check deployment config before touching the container. |
| No output yet | Sanitized export is missing. | Run or inspect the generator export job. |
| No candidates match filters | Valid filters eliminated all candidates. | Clear filters or wait for richer data. |
| Unsupported filter error | UI or URL requested a field not present in the sanitized export. | Remove that filter or update the export contract. |

## Next improvements

- Add direct links from candidate cards to the relevant interpretation sections.
- Add a visible freshness warning when generated output is older than the accepted window.
- Add historical trend and performance panels only from sanitized Postgres projections, not raw observation tables.
