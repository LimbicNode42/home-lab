# Interpreting Investment Screener Results

## What this is

This guide explains how to read the ranked JSON/report outputs without treating them as financial advice. It is for human interpretation, not implementation detail.

## Who it is for

- Ben reviewing candidates.
- Operators validating that a generated report makes sense.
- Future workers changing scores, filters, or dashboard display fields.

## When to use it

Use this guide whenever the panel shows a surprising ranking, a high score with warnings, an empty filtered result, or a stale-looking report.

## Ranked output vs report output

| Output | Best use | Avoid |
| --- | --- | --- |
| Ranked JSON | Feeding the dashboard API and debugging field-level contract issues. | Manual investment review. Raw JSON is where readability goes to die. |
| Plain-text report | Quick scan of the generated shortlist and limitations. | Assuming it contains every field used by the dashboard. |
| Dashboard panel | Normal candidate review and filter exploration. | Treating filters as a fresh model run. |

## Score dimensions

| Dimension | How to read it | Common trap |
| --- | --- | --- |
| Composite | Overall blended attractiveness within the current model. | Comparing across runs with different inputs or weights. |
| Quality | Profitability, consistency, and business strength signals. | Ignoring valuation because quality is high. |
| Valuation | Cheapness or margin-of-safety signals. | Treating cheapness as safety. Sometimes it is just a warning label. |
| Growth | Growth signals available in the source data. | Assuming growth is durable without checking filings. |
| Graham safety | Conservative downside and balance-sheet style indicators. | Treating it as full risk management. |
| Durability | Persistence and resilience indicators. | Assuming a moat from historical data alone. |
| Risk adjustments | Penalties and warning offsets. | Ignoring them because the headline score is shiny. |

## Suggestion counts

Suggestion count controls how many candidates are displayed from the current sorted list. It does not change the export, source universe, scoring formula, or underlying data.

Use smaller counts for quick triage. Use larger counts when hunting for second-tier candidates, market coverage issues, or odd exclusions.

## Filters

| Filter | Interpretation |
| --- | --- |
| Market | Shows candidates whose sanitized market label matches the selected value. |
| Exchange, region, sector, industry | Planned filters that require safe export fields before dashboard use. |
| Score focus | Reorders candidates by one public sub-score. |
| Weight preset | Uses a public sub-score as a display tilt. |

If a valid filter returns no candidates, that means no currently exported candidate survived the filter. It does not mean the market or sector has no investable companies.

## Candidate review checklist

For each candidate that looks interesting:

1. Read ticker, name, market, and currency.
2. Check rank and composite score.
3. Read sub-scores to understand what drove the rank.
4. Read risk flags.
5. Read caveats and score caps.
6. Check run-level limitations.
7. Verify against primary filings or an authorized market-data source.
8. Only then decide whether the company deserves deeper research.

## Data-source trust

Treat data as untrusted until verified. Stale, missing, unofficial, or inconsistent data can move scores. Generated timestamps say when the screener ran; data-as-of values say what the source claims about freshness. Neither proves the facts are correct.

For ASX mode, Yahoo-derived chart and fundamentals-timeseries values are bootstrap inputs. They are acceptable for recurring shortlisting experiments, but any candidate that survives review should be checked against ASX announcements, company reports, or another authorized source before it influences a real decision.

## Reading historical trends

Historical storage makes the screener more useful, but it also adds ways to fool yourself. Compare trends only after checking:

1. Cadence: monthly runs and quarterly reporting-season runs answer different questions.
2. Universe: a candidate appearing or disappearing may reflect watchlist changes, not business performance.
3. Source quality: bootstrap, primary-verified, and paid-provider rows should not be blended without labels.
4. Scoring version: a score jump can come from code/config changes rather than new company data.
5. Sector fit: bank, resources, healthcare, and industrial scores are not equally comparable under the first model.

Useful trend signals include repeated appearance near the top of the shortlist, improving or deteriorating sub-scores under the same scoring version, and recurring caveats that fail to clear after source refreshes. Weak signals include one-off rank moves, stale source dates, and apparent performance without dividend/corporate-action treatment.

## Financial-advice disclaimer

This product is informational only. It is not financial advice, not a rating, not a recommendation, and not a trading signal. The output should support research prioritization, not investment decisions.

## Known limitations

- Scores may not be comparable across markets or accounting regimes.
- Missing data can penalize or cap candidates.
- Risk flags and caveats may compress complex issues into short labels.
- The dashboard sees a sanitized subset of fields.
- The current model does not replace portfolio construction, tax, liquidity, or personal risk analysis.

## Troubleshooting interpretation issues

| Observation | Likely explanation | What to do |
| --- | --- | --- |
| High score with many caveats | Strong available metrics, weak confidence. | Verify source data before deeper analysis. |
| Low valuation score for a quality company | Price may already reflect quality, or data may be stale. | Compare against recent filings and market price. |
| Market filter hides expected ticker | Market label missing, different, or sanitized out. | Inspect safe export fields or regenerate with richer data. |
| Results look unchanged | Export may not have refreshed. | Check generated timestamp. |

## Next improvements

- Add score explanation snippets per candidate.
- Add safe sector/industry metadata.
- Add dashboard historical trend comparison for candidates that recur across sanitized runs.
