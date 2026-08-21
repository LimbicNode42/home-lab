# ASX Screener Historical Pipeline Architecture

## Purpose

This spec defines the first production architecture for an ASX-first Investment Screener pipeline with recurring hydration, Postgres-backed history, and the current dashboard-safe file exports.

The screener remains an investment research aid only. It produces candidate shortlists and trend evidence for human review; it does not produce recommendations, ratings, trade signals, position sizing, or financial advice.

## Scope

Included:

- ASX-first universe strategy.
- First-cut data-source strategy and trust limits.
- Contract-level Postgres model for runs, companies, observations, scores, provenance, and later price/performance snapshots.
- Sector/model caveats for Australian banks, financials, industrials, resources, and healthcare.
- Dashboard contract for the current file-backed panel and later historical queries.
- Recurring job cadence, idempotency, retry/backoff, and retention expectations.

Excluded for this phase:

- Live trading, brokerage integration, alerts, or portfolio automation.
- Raw provider-response storage in dashboard-accessible paths.
- Committed credentials, database URLs, API keys, or local operator paths.
- Full valuation models such as DCF, analyst-estimate blending, or factor backtesting.

## Reference inputs

The current dashboard endpoints consume these sanitized file artifacts:

- `latest_ranked.json`
- `latest_report.txt`

The operator prototype is reference material only. The production implementation should live under the personal dashboard service and should not import unreviewed prototype paths, task metadata, or local filesystem references into committed docs or dashboard payloads.

## Decision summary

| Area | Decision |
| --- | --- |
| Initial ASX universe | Bootstrap with a committed watchlist file in the repo, then add a generated external-ASX-list import later. |
| First data source | Use Yahoo chart plus Yahoo fundamentals-timeseries only as a pragmatic bootstrap source with explicit provenance and trust warnings. |
| Primary-source enrichment | Add ASX announcements/company-report collection as the source-of-record verification lane, not as a blocker for the first recurring run. |
| Paid APIs | Defer until the free bootstrap has proven value and failure modes are known. |
| Persistence | Store every completed hydration/scoring run in Postgres with immutable run records and per-row provenance. |
| Dashboard now | Keep the dashboard file-backed from sanitized latest exports. |
| Dashboard later | Add read-only historical API endpoints backed by Postgres for trend and performance views. |
| Cadence | Run monthly for routine hydration, quarterly after reporting seasons for deeper refresh, and manual ad hoc for code/data fixes. |

## ASX universe strategy

### Options considered

| Option | Strengths | Weaknesses |
| --- | --- | --- |
| Committed watchlist file | Auditable, deterministic, small enough to debug, no dependency on a changing external list. | Starts with partial coverage and requires manual curation. |
| External ASX list source | Broader coverage and easier expansion to all ordinary shares. | Source format/licensing can change; ticker normalization, delistings, ETFs, trusts, warrants, and dual listings need careful filtering. |
| Paid market-data universe | Cleaner security master, richer metadata, support path. | Cost, credentials, licensing limits, and provider lock-in. |

### Recommendation

Use a committed watchlist file for the bootstrap path.

Proposed repo contract:

```text
services/personal-dashboard/investment-screener/universe/asx-watchlist.json
```

Minimum entry shape:

```json
{
  "ticker": "BHP.AX",
  "asx_code": "BHP",
  "name": "BHP Group Limited",
  "market": "ASX",
  "exchange": "ASX",
  "region": "AU",
  "sector": "Materials",
  "industry": "Diversified Metals and Mining",
  "active": true,
  "notes": "bootstrap watchlist member"
}
```

Rules:

- Store tickers in Yahoo-compatible ASX form (`BHP.AX`) and keep the bare ASX code separately.
- Include sector and industry when known, but treat them as labels, not model truth.
- Keep inactive/delisted names as `active: false` rather than deleting immediately; history needs identity continuity.
- Keep the watchlist non-secret and small enough for human review.
- Do not let a dashboard filter imply full ASX coverage until the universe source is broad and documented.

Later expansion path:

1. Add a read-only importer for an external ASX-listed-securities source.
2. Normalize source rows into the same watchlist contract.
3. Produce a generated candidate file and a human-reviewed committed allowlist.
4. Record external source URL, retrieved timestamp, row count, include/exclude rules, and excluded instrument classes.

## Data-source strategy

### Yahoo chart and fundamentals-timeseries

Use Yahoo chart data for current-ish price/currency and Yahoo fundamentals-timeseries for annual financial fields during the bootstrap.

Trust limits:

- Yahoo endpoints are unofficial for this use and can change, throttle, omit fields, or return stale values without notice.
- Fundamentals-timeseries is useful for a first cut, but it is not a filings archive and should not be treated as source-of-record.
- Field names and accounting treatment can vary by issuer and sector.
- The pipeline must record missing fields explicitly; no silent imputation.
- Every value stored from Yahoo needs provenance including provider, endpoint class, retrieved time, source-reported `data_as_of` when available, and a trust label such as `bootstrap_unofficial`.

Use it for:

- First recurring ASX hydration.
- Shape validation for the scorer and dashboard.
- Finding data gaps and obvious candidate/risk patterns.

Do not use it for:

- Final investment decisions.
- Claims of full ASX coverage.
- Long-term performance attribution without later source verification.

### ASX announcements and company reports

ASX announcements/company reports should become the verification and enrichment lane.

Use it for:

- Annual and half-year report references.
- Primary-source links in provenance.
- Manual or semi-automated validation of high-interest candidates.
- Later extraction of reporting period, report type, and filing date.

Trust limits:

- Announcements are primary-source documents, but extracting structured numbers from PDFs/reports is operationally harder than consuming a market-data API.
- OCR/table extraction can misread numbers, signs, units, and consolidated-vs-segment values.
- The first architecture should store document provenance and extraction status separately from scored numeric observations.

Bootstrap stance:

- Do not block monthly hydration on ASX report extraction.
- Do store primary-source report links and extraction status when available.
- Require human verification before using extracted report values to override provider values.

### Paid APIs

Paid APIs are a later option once the screener proves useful.

Evaluate paid providers on:

- ASX ordinary-share coverage.
- Financial statement history depth and restatement handling.
- Company/security master quality.
- Corporate actions, delistings, dividends, and split adjustment support.
- Terms allowing local Postgres storage and private dashboard use.
- API reliability, export limits, and cost.

Trust limits:

- A paid source is not automatically correct.
- Provider-normalized fields can hide sector-specific accounting differences.
- Licensing may restrict retention, redistribution, dashboard display, or derived datasets.

Decision gate:

Move to a paid API only after the committed watchlist plus Yahoo bootstrap has shown recurring value and specific gaps justify cost or licensing work.

## Postgres contract

The storage model should preserve raw observations, scorer outputs, and provenance without making the dashboard depend on raw provider payloads.

### Core tables

#### `investment_screener_runs`

One row per attempted pipeline run that reaches a terminal state worth recording.

Suggested columns:

| Column | Meaning |
| --- | --- |
| `id` | Surrogate run id. |
| `run_key` | Stable idempotency key for the intended run. |
| `started_at` / `completed_at` | Runtime boundaries. |
| `status` | `started`, `completed`, `partial`, `failed`, `superseded`. |
| `market` | `ASX` for this lane. |
| `mode` | `monthly`, `quarterly`, `manual`, `fixture`, or implementation-specific equivalent. |
| `universe_version` | Hash or version label for the input universe file. |
| `source_mix` | JSON summary of source families used. |
| `code_version` | Git commit or build identifier when available. |
| `config_hash` | Hash of scoring/config inputs. |
| `metadata` | Non-secret JSON: counts, warnings, options, task id if relevant. |

Idempotency:

- Add a unique constraint on `run_key`.
- For scheduled runs, derive `run_key` from market, cadence, period, universe hash, config hash, and code version.
- Retrying the same run should resume/update the same run record or create a new attempt linked to the same logical key, not create mystery duplicates.

#### `investment_screener_companies`

Stable company/security identity.

Suggested columns:

| Column | Meaning |
| --- | --- |
| `id` | Surrogate company id. |
| `ticker` | Provider/display ticker, e.g. `BHP.AX`. |
| `asx_code` | Bare ASX code, e.g. `BHP`. |
| `name` | Current display name. |
| `market` / `exchange` / `region` | Classification labels. |
| `sector` / `industry` | Human-readable classification labels. |
| `active` | Whether the current universe considers it active. |
| `first_seen_at` / `last_seen_at` | Identity lifecycle. |
| `identity_provenance` | JSON describing where the identity/classification came from. |

Rules:

- Do not key identity solely on display name.
- Preserve inactive names for historical observations.
- Expect ticker/name changes and maintain aliases later if needed.

#### `investment_screener_observations`

One row per company per run containing the normalized field values used by scoring.

Suggested columns:

| Column | Meaning |
| --- | --- |
| `run_id` | References `investment_screener_runs`. |
| `company_id` | References `investment_screener_companies`. |
| `ticker` | Denormalized for easy inspection. |
| `period_end` | Reporting period end if known. |
| `data_as_of` | Best source-reported date for the observation set. |
| `currency` | Observation currency. |
| `raw_fields` | JSON object of normalized field names to values/statuses. |
| `derived_fields` | JSON object of derived ratios used by the scorer. |
| `missing_fields` | JSON array of fields missing or unusable. |
| `source_quality` | `fixture`, `bootstrap_unofficial`, `primary_verified`, `paid_provider`, etc. |
| `created_at` | Insert time. |

Unique key:

- `UNIQUE(run_id, company_id)`.

#### `investment_screener_scores`

One row per company per scored run.

Suggested columns:

| Column | Meaning |
| --- | --- |
| `run_id` | References `investment_screener_runs`. |
| `company_id` | References `investment_screener_companies`. |
| `rank` | Rank within non-excluded candidates for that run. |
| `excluded` | Whether hard gates excluded it. |
| `composite_score` | Final score after penalties/caps. |
| `sub_scores` | JSON object keyed by public score dimensions. |
| `missing_penalty_points` | Penalty applied for missing data. |
| `risk_flags` | JSON array. |
| `caveats` | JSON array. |
| `score_caps` | JSON object/array, depending on scorer output. |
| `exclusion_reasons` | JSON array. |
| `score_version` | Version label for scorer logic. |
| `created_at` | Insert time. |

Unique key:

- `UNIQUE(run_id, company_id)`.

#### `investment_screener_provenance`

A normalized provenance ledger for provider/document evidence.

Suggested columns:

| Column | Meaning |
| --- | --- |
| `id` | Surrogate provenance id. |
| `run_id` | Optional run reference. |
| `company_id` | Optional company reference. |
| `field_name` | Field this evidence supports, if field-specific. |
| `source_family` | `yahoo_chart`, `yahoo_timeseries`, `asx_announcement`, `paid_api`, `manual_review`, etc. |
| `source_url` | Public or provider URL where safe to store. |
| `retrieved_at` | Retrieval time. |
| `source_reported_at` | Filing/date from source, if known. |
| `data_as_of` | Date the data represents, if known. |
| `trust_level` | `unofficial`, `primary`, `licensed`, `manual_verified`. |
| `extraction_status` | `not_attempted`, `parsed`, `failed`, `human_verified`. |
| `notes` | Non-secret caveats. |

Rules:

- Store provider identifiers and public URLs, not credentials or signed URLs.
- Keep raw PDFs/provider payloads outside dashboard-readable paths unless separately approved and sanitized.

### Later price/performance snapshots

Add this once the historical scoring lane is stable.

#### `investment_screener_price_snapshots`

Suggested columns:

| Column | Meaning |
| --- | --- |
| `company_id` | References company identity. |
| `ticker` | Denormalized ticker at snapshot time. |
| `observed_at` | Timestamp of price observation. |
| `trading_date` | Market date if known. |
| `price` | Last/close price used. |
| `currency` | Price currency. |
| `source_family` | Quote source. |
| `source_quality` | Trust label. |
| `provenance` | JSON evidence summary. |

Use for:

- Later 1-month, 3-month, 6-month, and 12-month candidate performance views.
- Post-hoc comparison of high-scoring candidates versus later prices.
- Freshness checks.

Do not use for:

- Live trading or intraday alerts.
- Public performance claims without corporate-action and dividend adjustment.

#### `investment_screener_candidate_snapshots`

Optional materialized table/view for dashboard performance cards.

Suggested fields:

- `score_run_id`
- `company_id`
- `rank_at_run`
- `score_at_run`
- `price_at_run`
- `price_after_1m`
- `price_after_3m`
- `price_after_6m`
- `price_after_12m`
- `return_after_1m_pct`
- `return_after_3m_pct`
- `return_after_6m_pct`
- `return_after_12m_pct`
- `performance_caveats`

Caveat: unadjusted price return is incomplete for ASX names with dividends, splits, consolidations, spin-offs, and currency effects.

## Sector and model caveats

The current scoring model is industrial-company-shaped. ASX coverage will include sectors where that is a poor fit.

### Financials and banks

Banks, insurers, and diversified financials need different metrics.

Current industrial metrics that can mislead:

- `current_ratio`: generally not meaningful for banks.
- `debt_to_assets`: financial leverage is structural, not automatically distress.
- Operating cash flow and capital expenditure patterns differ from industrial businesses.
- Negative or volatile fair-value movements can distort simple quality/growth signals.

First-cut rule:

- Score financials, but attach sector caveats and consider a score cap until a financial-sector model exists.
- Store sector/industry in observations and scores so later sector-specific scoring can be replayed.
- Do not compare bank scores directly with industrial/resource/healthcare scores without caveats.

Later financial model candidates:

- Return on equity and return on tangible equity.
- Net interest margin.
- Common equity tier 1 ratio.
- Loan loss provisions and arrears.
- Dividend sustainability.
- Price-to-book or price-to-tangible-book.

### Resources and energy

ASX resources names are often cyclical and commodity-price exposed.

Caveats:

- One-year revenue and earnings can reflect commodity price cycles rather than durable growth.
- Capital expenditure and free cash flow can swing heavily with project cycles.
- Reserves, mine life, jurisdiction, and cost curve position are not represented in the first model.

First-cut rule:

- Keep explicit cyclicality caveats.
- Prefer multi-year history before treating high margins as durable.
- Store enough history to later smooth or sector-normalize scores.

### Industrials and consumer businesses

The first model is most suitable here, but still limited.

Caveats:

- Working-capital timing can distort single-period free cash flow.
- Moat/durability is approximated, not measured.
- Acquisitive growth and one-off gains need human review.

### Healthcare and biotech

Healthcare includes mature providers and early-stage biotech; one model does not fit both.

Caveats:

- Early-stage biotech may have negative earnings and cash burn by design.
- R&D, regulatory milestones, patent cliffs, and clinical pipeline risk are not modeled.
- Mature healthcare operators may fit industrial metrics better than biotech does.

First-cut rule:

- Apply sector caveats for biotech/pharma where fields indicate high R&D or persistent losses.
- Avoid treating low or negative earnings as a simple valuation opportunity.

## Dashboard contract

### Current dashboard contract: file-backed latest snapshot

Keep the current dashboard API backed by sanitized files:

- `latest_ranked.json`
- `latest_report.txt`

The dashboard should continue to:

- Read only sanitized latest artifacts.
- Re-sanitize responses before returning them.
- Hide raw fields, raw provider responses, provenance internals, task metadata, local paths, debug output, credentials, and secret-shaped values.
- Provide filter/sort/pagination over the latest export only.
- Show disclaimers, generated time, data-as-of, limitations, risk flags, and caveats.

This keeps the UI stable while the historical backend evolves.

### Later dashboard contract: historical Postgres views

Add separate read-only endpoints when the storage lane is stable.

Candidate endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/investment-screener/history/runs` | List completed runs with counts, status, source mix, generated time, and warning summary. |
| `GET /api/investment-screener/history/company/:ticker` | Show a company score/observation trend over time. |
| `GET /api/investment-screener/history/performance` | Show later price/performance snapshots for prior candidates. |
| `GET /api/investment-screener/history/sectors` | Compare score distributions by sector with caveats. |

Historical responses must be sanitized projections, not raw database dumps.

Minimum safe fields:

- run id or display key;
- generated/completed time;
- ticker/name/market/currency;
- rank and public scores;
- source quality labels;
- caveat/risk summaries;
- price/performance snapshots only when clearly labeled as unadjusted or adjusted.

Fields to keep out of the dashboard API:

- database connection details;
- raw provider payloads;
- local filesystem paths;
- credentials, signed URLs, API keys, sessions, or internal task metadata;
- full extraction diagnostics unless sanitized into safe warning labels.

## Recurring job design

### Cadence

Recommended schedule:

| Job | Cadence | Purpose |
| --- | --- | --- |
| ASX bootstrap hydration | Monthly | Refresh watchlist fundamentals/quotes and write historical run. |
| ASX reporting-season refresh | Quarterly | Re-run after major reporting windows and review missing/report-lag caveats. |
| Price snapshot hydration | Monthly, and optionally weekly later | Capture later price/performance baselines for prior candidates. |
| Manual smoke run | Ad hoc | Validate code/config changes before scheduled execution. |

Do not run high-frequency jobs until source limits, retention, and dashboard utility are proven.

### Idempotency

Each scheduled job should compute a logical run key before writing:

```text
investment-screener:{market}:{cadence}:{period}:{universe_hash}:{config_hash}:{code_version}
```

Expected behavior:

- If the same logical run is retried, reuse or supersede the existing run rather than inserting duplicate completed runs.
- Partial failures should preserve enough per-ticker status to continue safely.
- File publication should happen only after DB write and JSON/report validation succeed.
- Latest files should be written atomically: write temp file, validate, then rename into place.

### Retry and backoff

Provider calls should use bounded retries:

- Per-ticker retry with exponential backoff and jitter.
- Respect provider throttling; do not hammer unofficial endpoints.
- Treat repeated missing fields as data-quality warnings, not infrastructure failures.
- Mark a run `partial` when enough tickers succeed to be useful but some fail.
- Mark a run `failed` when no usable output can be produced.

Suggested first-cut limits:

- 3 attempts per provider request.
- Per-request timeout no higher than 30 seconds.
- Short sleep between tickers for unofficial sources.
- One scheduled retry later the same day for transient provider/network failures.

### Retention

Recommended retention:

| Artifact | Retention |
| --- | --- |
| Postgres run summaries, companies, scores, observations | Indefinite unless licensing or storage pressure says otherwise. |
| Provenance summaries | Indefinite when non-secret and license-safe. |
| Raw provider payloads | Do not store initially; if added later, retain separately with licensing review. |
| Dashboard latest files | Only current latest pair plus optional last-known-good pair. |
| Plain-text reports | Keep recent reports only if they are sanitized and useful for operations. |
| Job logs | Keep bounded operational logs; sanitize before exposing in dashboard. |

## Implementation handoff

Initial implementation should produce these repo-visible contracts:

1. A committed ASX watchlist file with a small bootstrap universe.
2. A hydrator that accepts the watchlist and writes normalized company observations with provenance.
3. A Postgres schema/migration matching the contract above, without credentials.
4. A scorer storage path that writes runs, observations, and scores idempotently.
5. A latest-export publisher that still writes dashboard-safe `latest_ranked.json` and `latest_report.txt`.
6. A smoke test using fixture/provider-stub data, not live network as the only validation.

## Validation checklist

Before merge/deploy:

- The watchlist and docs contain no credentials, database URLs, local operator paths, or secret-shaped values.
- The first ASX run can produce dashboard-safe `latest_ranked.json` and `latest_report.txt`.
- The Postgres schema can be initialized against a test database or verified by migration tests.
- The same run key cannot create duplicate completed logical runs.
- Missing fields are represented as missing with caveats; they are not silently imputed.
- Financials/banks/resources/healthcare caveats are visible in stored scores or dashboard-safe limitations.
- The dashboard continues to work from latest files even if historical Postgres is unavailable.
