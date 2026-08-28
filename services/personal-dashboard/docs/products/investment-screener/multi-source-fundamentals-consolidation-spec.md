# Multi-source fundamentals consolidation and conflict-resolution spec

> Kanban task `t_7e345e7b`. Design/documentation only: no live data mutation, no credentials, no provider signup, no hydration run, no cron change, and no deploy.

## Purpose

Future ASX hydration will read fundamentals from more than one source. Those sources will disagree. The screener must not average incompatible values, overwrite source-of-record evidence with convenient provider output, or hide uncertainty behind a tidy score.

This spec defines the normalized field shape, source priority, conflict detection, merge behavior, dashboard/API projection, and implementation tests required before the provider fallback and historical schema lanes can claim multi-source support.

Primary inputs:

- Current ASX coverage/missingness audit: `current-asx-coverage-fundamentals-audit-2026-08-28.md`.
- ASX universe and identity rules: `asx-universe-source-and-identity-rules.md`.
- ASX fundamentals provider coverage runbook: `asx-fundamentals-provider-coverage-runbook-2026-08-28.md`.
- Existing implementation notes in `investment-screener/screener.py`, `historical-pipeline-architecture.md`, and `investment-screener/POSTGRES_HISTORY.md`.

## Non-goals and safety boundaries

- Do not run live hydration as part of this design.
- Do not add API keys, signed URLs, tokens, raw provider payloads, or local runtime paths to Git, artifacts, provenance, dashboard payloads, or test fixtures.
- Do not bulk scrape public consumer pages such as MarketIndex, TradingView, Morningstar, or ASX search pages. They remain human comparison surfaces unless a later approval explicitly changes that.
- Do not use ASX annual-report/PDF extraction as unattended source-of-record numeric fill until a separate extraction and verification lane is approved.
- Do not market a top-50 or partial batch as full-ASX coverage. The denominator must come from the reviewed ASX universe seed and batch/run metadata.

## Current state summary

Current `FieldValue` in `investment-screener/screener.py` is intentionally small:

```python
@dataclass
class FieldValue:
    value: Optional[float]
    provenance: dict
```

Provider fallback scaffolding exists for FMP and Alpha Vantage and already strips secret query parameters from persisted `source_url`. The active Yahoo hydration path does not yet call the fallback adapters. Current latest run provenance families are only `yahoo-finance` and `derived`.

Known gaps this spec must address:

- `operating_cash_flow` is missing for 32/50 current top-50 ASX companies, cascading to `fcf` and `fcf_margin` missing for 33/50.
- `cash`, `debt`, and `total_debt` are not normalized fields yet.
- Current-assets/current-liabilities/current-ratio are weak or missing for banks and insurers.
- `EVN.AX` and `WTC.AX` are stale/excluded under the 730-day hard-exclusion rule.
- Company-detail API does not yet carry all seed identity fields.
- Historical storage can record normalized observations and provenance, but not explicit selected/alternate/conflict outcomes yet.

## Canonical identity basis

All multi-source values must attach to the same company identity rules from the ASX universe spec:

| Field | Rule |
| --- | --- |
| `company_id` | `asx:{ASX_CODE}`, for example `asx:BHP`. |
| `asx_code` | Uppercase ASX code matching `^[A-Z0-9]{2,6}$`. |
| Yahoo ticker | `{ASX_CODE}.AX`. |
| Market/exchange/region | `ASX` / `ASX` / `AU`. |
| Display name | Use source-specific `name_raw` for display; never key on company name. |
| Security type | `unknown_from_asx_directory` unless a sourced validation/enrichment provider supplies type. |

Provider adapters must map their own symbol format back to `company_id` before merging. If a provider returns a different company name, exchange, country, currency, MIC, FIGI, or security type, store that as identity evidence and possibly a conflict; do not silently rewrite the canonical ASX seed identity.

## Normalized `FieldValue` schema

Implementation may keep the Python dataclass backward-compatible, but the serialized contract for every raw or derived field should be this object shape:

```json
{
  "field_name": "operating_cash_flow",
  "value": 123456789.0,
  "value_status": "present",
  "unit": "currency",
  "currency": "AUD",
  "scale": "ones",
  "period_type": "annual",
  "period_start": "2025-07-01",
  "period_end": "2026-06-30",
  "fiscal_year": 2026,
  "data_as_of": "2026-06-30",
  "filed_at": "2026-08-20",
  "retrieved_at": "2026-08-28T05:30:00Z",
  "source_reported_at": "2026-08-20",
  "source_family": "provider_statement",
  "provider": "fmp",
  "source_url": "https://financialmodelingprep.com/api/v3/cash-flow-statement/BHP",
  "source_url_sanitized": true,
  "confidence": "medium",
  "trust_level": "licensed_provider_normalized_statement",
  "stale": false,
  "method": "reported",
  "caveats": [],
  "missing_reason": null
}
```

Required fields:

| Property | Required | Allowed values / rule |
| --- | --- | --- |
| `field_name` | yes | Internal normalized field name. |
| `value` | yes | Number, string for identity/status fields, boolean where explicitly allowed, or `null`. No imputed numeric placeholders. |
| `value_status` | yes | `present`, `missing`, `not_applicable`, `stale`, `conflicted`, `provider_error`, `excluded`. |
| `unit` | yes | `currency`, `shares`, `ratio`, `percent`, `date`, `text`, `count`, `boolean`, `unknown`. |
| `currency` | conditional | Required for `unit=currency` and market-value fields. Use ISO code, normally `AUD` for ASX. Null for ratios/counts. |
| `scale` | yes | `ones`, `thousands`, `millions`, `billions`, `cents`, `percent_points`, `ratio`, `unknown`. Convert to canonical scale before scoring. |
| `period_type` | yes | `point_in_time`, `annual`, `quarterly`, `half_year`, `ttm`, `latest_market`, `not_periodic`, `unknown`. |
| `period_start` / `period_end` | conditional | Required for reported statements when available. Use ISO dates. |
| `fiscal_year` | conditional | Required for annual/half-year statements when available. |
| `data_as_of` | yes | Best date the value represents. Use ISO date. |
| `filed_at` | conditional | Required for primary filings/report-derived values when known. |
| `retrieved_at` | yes | UTC ISO timestamp when the adapter fetched/loaded the value. |
| `source_reported_at` | optional | Source-published date, if distinct from `filed_at` or `data_as_of`. |
| `source_family` | yes | Controlled vocabulary below. |
| `provider` | yes | Adapter/source name: `yahoo_finance`, `asx_report`, `fmp`, `alpha_vantage`, `eodhd`, `twelve_data`, `manual_review`, `derived`, etc. |
| `source_url` | optional | Sanitized URL only. Strip `apikey`, `api_key`, `access_token`, `key`, `token`, signatures, session IDs, and operator-local paths. |
| `source_url_sanitized` | yes | Boolean. Must be true before persistence when URL is present. |
| `confidence` | yes | `high`, `medium`, `low`, `untrusted`, `unknown`. This is not a guarantee of correctness. |
| `trust_level` | yes | More specific source quality label from the vocabulary below. |
| `stale` | yes | Boolean computed by field-specific age rules. |
| `method` | yes | `reported`, `provider_normalized`, `derived`, `estimated`, `manual_verified`, `missing_marker`. |
| `caveats` | yes | Array of short non-secret strings. |
| `missing_reason` | conditional | Required when `value_status != present`: `provider_absent`, `credential_missing`, `rate_limited`, `plan_limited`, `stale_source`, `period_mismatch`, `currency_mismatch`, `unit_mismatch`, `identity_mismatch`, `not_applicable_sector`, `excluded_instrument`, `fetch_failed`, `parse_failed`, `unavailable`. |

Backward-compatible implementation path:

```python
@dataclass
class FieldValue:
    value: Optional[float]
    provenance: dict
```

Keep `value` as the scorer-facing numeric and put the rest of the schema into `provenance` first. Do not block provider adapter work on a broad type refactor. The storage/schema lane can later promote selected attributes to columns where needed.

## Source family and trust vocabulary

| `source_family` | Meaning | Default confidence | Notes |
| --- | --- | --- | --- |
| `reported_filing` | Structured value extracted from ASX/company annual/half-year report and verified against the filing. | high | Authoritative for reported statements, but extraction must be verified. |
| `manual_review` | Human-reviewed value or source annotation. | high | Must record reviewer/date/caveat without PII. |
| `provider_statement` | Licensed/credentialed provider normalized financial statement. | medium | FMP/Alpha/EODHD/Twelve Data fundamentals after licensing approval. |
| `provider_ratio` | Provider-computed ratio/key metric. | low-medium | Use mainly as alternate/check unless method/period are clear. |
| `quote_market_data` | Quote endpoint, price, market cap, shares, currency, trading date. | medium for quote fields only | Not authoritative for annual statement values. |
| `unofficial_statement` | Unofficial public statement endpoint such as Yahoo fundamentals-timeseries. | low-medium | Current bootstrap base; label loudly. |
| `identity_directory` | ASX company-directory seed or approved security master. | high for identity fields | Not a fundamentals source. |
| `identity_validation` | Twelve Data or similar symbol/security validation. | medium | Cross-check only unless approved as denominator. |
| `derived` | Computed internally from selected or source-specific inputs. | inherits inputs | Must link source fields and method. |
| `missing_marker` | Explicit absence/error marker. | unknown | Used to distinguish missing from not fetched. |

Source quality labels for `trust_level` should be stable strings, for example:

- `primary_report_verified`
- `manual_verified`
- `licensed_provider_normalized_statement`
- `licensed_provider_ratio`
- `bootstrap_unofficial_yahoo_statement`
- `quote_endpoint_market_data`
- `derived_from_selected_inputs`
- `identity_seed_asx_directory`
- `identity_validation_provider`
- `missing_or_unavailable`

## Provider priority table

General rule: prefer reported filings/annual reports over provider-normalized statements, provider-normalized statements over quote endpoints for fundamentals, quote endpoints for market data, and derived calculations only after their inputs are selected and compatible.

| Field family | 1st priority | 2nd priority | 3rd priority | 4th priority | Special rule |
| --- | --- | --- | --- | --- | --- |
| Company identity (`company_id`, `asx_code`, ticker, exchange, region) | ASX company-directory seed | Approved security master/enrichment validation | Provider identity evidence as conflict/alternate | Manual review | Never let a provider display name overwrite `company_id`. |
| Security type/MIC/FIGI/ISIN | Approved security master or licensed identifier feed | Twelve Data/EODHD validation if approved | Manual review | Null/unknown | ASX CSV lacks type/MIC/ISIN; label source. |
| Price/trading currency/latest quote | Quote endpoint market data | Licensed market data | Manual checked quote | Null/stale | Use latest_market period; do not mix with annual statement period. |
| Market cap | Quote endpoint or licensed market data with price date | Provider market cap | Derived price × shares when both current and same currency | Manual review | Do not use stale annual shares with current price without caveat. |
| Shares outstanding | Reported filing / shares note | Licensed provider shares endpoint | Quote/provider overview | Derived/estimated only as alternate | Distinguish point-in-time shares from weighted-average shares. |
| Revenue, net income | Reported annual/half-year filing | Licensed provider statement | Yahoo fundamentals-timeseries | Manual review | Newer restated filing wins over older provider value. |
| Total assets/liabilities, current assets/liabilities | Reported filing | Licensed provider balance sheet | Yahoo fundamentals-timeseries | Manual review | Banks/insurers may not report industrial current classifications; `not_applicable_sector` may beat a weak fill. |
| Operating cash flow, capex | Reported filing | Licensed provider cash-flow statement | Yahoo fundamentals-timeseries | Manual review | Capex sign must be canonicalized; conflict if one source reports purchases positive and another negative after normalization still disagrees. |
| Cash/cash equivalents, total debt | Reported filing | Licensed provider balance sheet/debt schedule | Provider ratio/key metric only as alternate | Null | Do not substitute total liabilities for debt. |
| FCF, FCF margin | Internally derived from selected OCF + capex (+ revenue for margin) | Reported/provider FCF with matching method as alternate | Provider-computed FCF as conflict/check | Null | Prefer own derivation when raw inputs are compatible; do not mix periods. |
| PE, price-to-sales | Internally derived from selected market cap/price and selected earnings/revenue | Provider ratio with same period/date | Quote endpoint ratio | Null | Provider ratios are alternates unless period basis is explicit. |
| Net margin, ROE, current ratio, debt/assets, revenue growth | Internally derived from selected raw fields | Provider-computed ratio with matching definitions | Yahoo/provider reported ratio | Null | If definitions differ, surface alternate/conflict instead of merging. |
| Stale/exclusion status | Source freshness rules and run policy | Manual review | Provider status | Null | Do not relax the 730-day exclusion threshold just to fill a score. |

Provider order for the current implementation lane:

1. `yahoo_current_path` remains the no-credential bootstrap base for existing fields, labelled unofficial.
2. `asx_reports_targeted_verification` is the highest-trust verification lane for shortlisted/stale names, but not a bulk numeric fill source yet.
3. `fmp_optional_fill_only` is the first credentialed fill provider when `FMP_API_KEY` is present and licensing permits local storage.
4. `alpha_vantage_optional_spot_fill` is secondary and rate-limited behind `ALPHA_VANTAGE_API_KEY`.
5. `eodhd_deferred_paid` and `twelve_data_deferred_paid` require explicit approval before fundamentals use.
6. `public_pages_manual_only` sources may appear only as human comparison links/caveats, not automated numeric evidence.

Important fill-only rule for the first implementation: configured FMP/Alpha adapters may fill fields missing from Yahoo, but must not overwrite present Yahoo values until this conflict model is implemented and tested. Once conflict handling exists, the selected value may come from higher-priority evidence even if Yahoo is present, but the old Yahoo value remains an alternate.

## Conflict detection

Every consolidation attempt compares candidates after canonicalization. Canonicalization happens before comparison and includes:

- Normalize currency units to canonical scale, normally whole currency units (`scale=ones`).
- Normalize capex sign to the project convention: cash outflow is negative.
- Normalize percentages to ratios unless the field explicitly uses percentage points.
- Normalize dates to ISO and periods to `[period_start, period_end]` where possible.
- Normalize provider names/source family vocabulary.
- Sanitize URLs before persistence.

### Universal hard conflicts

Flag `severity=blocking` and do not select a numeric value without a caveat when:

- `company_id`, exchange, region, or security type points to a different instrument.
- Currency differs and no approved FX normalization exists for that field.
- Unit/scale is unknown or incompatible after canonicalization.
- One source is annual, another is quarterly/TTM/latest-market, and the field is not designed to mix period types.
- `period_end` differs by more than the field tolerance below for statement fields.
- A provider value is newer but lower-priority and conflicts with a later/restated primary filing.
- Source URL cannot be sanitized while preserving enough non-secret provenance to audit it.

### Numeric tolerance thresholds

| Field type / fields | Near-equal tolerance | Conflict threshold | Notes |
| --- | ---: | ---: | --- |
| Large currency statement values (`revenue`, `net_income`, `assets`, `liabilities`, `cash`, `debt`, `OCF`, `capex`) | max(1 AUD, 0.5%) | > 2.0% | Exact provider rounding is common; bigger differences need alternates/conflict. |
| Market cap | max(1,000 AUD, 2.0%) | > 5.0% | Market cap moves with price; use quote `data_as_of` and trading date before fighting it. |
| Shares outstanding | max(1 share, 0.5%) | > 1.0% | Weighted average vs period-end shares must be a method conflict even if close. |
| Price | max(0.01 AUD, 0.5%) | > 2.0% | Compare only same trading date or mark stale. |
| Ratios (`pe_ratio`, `price_to_sales`, `current_ratio`, `debt_to_assets`) | max(0.01, 1.0%) | > 5.0% | Provider definition differences likely; prefer internally derived ratios from selected raw fields. |
| Percent-like ratios (`net_margin`, `roe`, `fcf_margin`, `revenue_growth`) | max(0.001 ratio, 1.0%) | > 3.0% | Store canonical as ratio, not percent points. |
| Dates | exact | > allowed date tolerance below | Dates are not numbers with vibes. |
| Boolean/status fields | exact | any mismatch | Example: active/excluded/stale. |
| Text identity fields | normalized exact | material mismatch | Store provider alternate names as identity evidence, not fundamentals conflicts. |

### Date and period thresholds

| Field family | Allowed period/date mismatch before conflict | Notes |
| --- | --- | --- |
| Annual financial statements | Same fiscal year and period_end within 31 days | ASX issuers can have different fiscal calendars; fiscal year alone is not enough when comparing companies, but acceptable for same-company same-period matching. |
| Half-year statements | Same fiscal year and half, period_end within 31 days | Do not merge half-year with annual values. |
| Quarterly statements | Same fiscal quarter, period_end within 15 days | Generally not first-class for current ASX annual screener. |
| TTM values | Same TTM end date within 7 days | Do not merge TTM with annual without explicit method caveat. |
| Quote/market data | Same trading date preferred; stale if older than run freshness policy | Market cap/price can conflict quickly; use latest selected quote and retain older alternates. |
| Filing/retrieval freshness | Newer retrieved_at alone does not win | `filed_at` / `source_reported_at` / `data_as_of` matter more than fetch time. |

### Restatement and newer-source handling

- If two values come from the same priority class and same provider/source family for the same period, prefer the value with the newer `filed_at` or `source_reported_at`; record the older as `alternate` with reason `superseded_by_newer_filing`.
- A restated annual report or official correction beats older provider-normalized statements and older Yahoo values for the same field/period.
- A newer provider retrieval does not beat an older-but-authoritative filing if the provider does not expose the underlying filing date or restatement basis.
- Do not overwrite historical observations from old runs. Store a new run with selected values and alternates/conflicts for that run.

### Sector-specific caveats

Banks, insurers, REITs/LICs, stapled securities, miners/resources, and CDIs/share classes need explicit caveats where industrial-company metrics are weak.

Minimum rules:

- For banks/insurers, `current_ratio`, `debt_to_assets`, OCF/capex-derived FCF, and simple Graham safety scoring should be caveated and may be score-capped.
- For REITs/LICs/stapled securities, net income, assets, liabilities, and debt metrics can reflect fair-value movements or vehicle structure; attach sector caveats and avoid direct comparison with industrials.
- For resources/energy, revenue growth and FCF can be commodity/project-cycle effects; attach caveats when score is driven mainly by one-year growth or FCF.
- For CDIs/dual-listed/share-class names, identity conflicts are blocking until provider ticker mapping is proven.

## Consolidated field output schema

After merging candidates for one company/field, produce this shape for storage and dashboard-safe projection:

```json
{
  "field_name": "operating_cash_flow",
  "selected": {
    "value": 123456789.0,
    "unit": "currency",
    "currency": "AUD",
    "period_type": "annual",
    "period_end": "2026-06-30",
    "provider": "fmp",
    "source_family": "provider_statement",
    "method": "reported",
    "confidence": "medium"
  },
  "selection_reason": "filled_yahoo_missing_from_highest_available_provider_same_period",
  "alternates": [
    {
      "value": null,
      "provider": "yahoo_finance",
      "source_family": "unofficial_statement",
      "value_status": "missing",
      "missing_reason": "provider_absent"
    }
  ],
  "conflicts": [],
  "caveats": ["Provider-normalized statement; verify against ASX filing before investment action."],
  "score_effect": {
    "usable_for_scoring": true,
    "penalty_points": 0,
    "score_cap": null
  }
}
```

For a real conflict:

```json
{
  "field_name": "fcf",
  "selected": null,
  "selection_reason": "period_mismatch_blocks_merge",
  "alternates": [
    {"provider": "yahoo_finance", "value": 1000000, "period_type": "annual", "period_end": "2025-06-30"},
    {"provider": "fmp", "value": 1800000, "period_type": "ttm", "period_end": "2026-03-31"}
  ],
  "conflicts": [
    {
      "kind": "period_type_mismatch",
      "severity": "blocking",
      "message": "Annual Yahoo FCF and TTM provider FCF are not comparable.",
      "providers": ["yahoo_finance", "fmp"]
    }
  ],
  "caveats": ["Free cash flow unavailable because candidate sources disagree on period basis."],
  "score_effect": {"usable_for_scoring": false, "penalty_points": 1.5, "score_cap": "quality<=60"}
}
```

Required top-level merge fields:

| Property | Meaning |
| --- | --- |
| `selected` | The value used for scoring/display, or null if no truthful selection is possible. |
| `selection_reason` | Stable machine-readable reason: `highest_priority_same_period`, `filled_missing`, `newer_restatement`, `quote_latest`, `derived_from_selected_inputs`, `near_equal_sources`, `no_value`, `blocking_conflict`, etc. |
| `alternates` | Sanitized candidate values not selected, including missing markers. Keep enough metadata to explain why. |
| `conflicts` | Array of conflict objects. Empty when no material conflict exists. |
| `caveats` | Human-readable caveats safe for dashboard/API. |
| `score_effect` | Whether scoring may use it, and any penalty/cap imposed. |

Conflict object schema:

```json
{
  "kind": "currency_mismatch",
  "severity": "blocking",
  "field_name": "revenue",
  "providers": ["yahoo_finance", "fmp"],
  "message": "Yahoo reported AUD while provider reported USD and no FX normalization is approved.",
  "threshold": "currency_exact_match_required",
  "observed_delta": null,
  "selected_provider": null,
  "requires_review": true
}
```

Allowed conflict `kind` values:

- `identity_mismatch`
- `security_type_mismatch`
- `currency_mismatch`
- `unit_or_scale_mismatch`
- `period_type_mismatch`
- `period_end_mismatch`
- `fiscal_year_mismatch`
- `numeric_delta_exceeds_threshold`
- `method_mismatch`
- `stale_source`
- `restatement_superseded`
- `provider_missing_or_error`
- `sector_not_comparable`
- `source_url_not_sanitizable`

Severity values:

- `info`: alternate is useful context but not a scoring concern.
- `warning`: selection is possible, but display a caveat and possibly a small confidence penalty.
- `blocking`: do not use the field for scoring until resolved or a higher-priority same-period value exists.

## Merge algorithm

For each company/run:

1. Build candidate `FieldValue` entries from each source adapter and explicit missing markers.
2. Attach canonical identity (`company_id`, `asx_code`, `ticker`) before field-level merge.
3. Drop or mark any candidate that fails URL sanitization, credential safety, or provider payload hygiene.
4. Canonicalize value, unit, currency, scale, period, and method.
5. Partition candidates by field name.
6. For each field, compare candidates against identity, currency/unit, period, staleness, and numeric thresholds.
7. Apply field-specific priority rules and restatement rules.
8. Select one value only if the winning candidate is compatible with the scoring method and no blocking conflict invalidates it.
9. Store all non-selected candidates as alternates or conflict members.
10. Derive ratios only from selected compatible raw fields unless the ratio is explicitly labelled as provider-computed alternate.
11. Recompute score inputs from selected fields and apply caveats/penalties/caps.
12. Export only sanitized selected/alternate/conflict summaries to dashboard/API. Raw provider payloads stay out.

Pseudo-code:

```python
def consolidate_field(field_name, candidates, context):
    sanitized = [sanitize_and_canonicalize(c) for c in candidates]
    hard_rejects = [c for c in sanitized if c.value_status in ("identity_mismatch", "unit_mismatch")]
    compatible = [c for c in sanitized if not has_blocking_shape_conflict(c, context)]

    conflicts = detect_conflicts(field_name, compatible, hard_rejects, context)
    blocking = [c for c in conflicts if c["severity"] == "blocking"]

    winner = select_by_priority_and_period(field_name, compatible, context)
    if winner and not invalidated_by_blocking_conflict(winner, blocking):
        return selected_result(winner, compatible, conflicts, context)
    return no_selection_result(field_name, compatible, conflicts, context)
```

Do not implement `average(candidates)`. That function should not exist. If it appears, the review model should make rude noises.

## Score and ranking behavior

- Scores consume only consolidated `selected` values or internally derived values from selected compatible raw inputs.
- Missing or blocked fields receive existing missing-data penalties, plus field-specific caps where a metric is too central to the score dimension.
- Conflicted values with `severity=blocking` count as missing for scoring unless a higher-priority compatible selected value remains valid.
- Near-equal alternates can increase confidence but should not add score points by themselves.
- Provider-computed ratios should not be mixed with internally derived ratios unless definitions and periods match.
- For financials/banks/insurers, cap or caveat score dimensions that rely on industrial liquidity/leverage metrics.
- A candidate with provider-filled `operating_cash_flow` may regain FCF/FCF margin scoring only if OCF and capex share currency, period, and method compatibility.

Suggested first score controls:

| Condition | Score behavior |
| --- | --- |
| Missing OCF prevents FCF/FCF margin | Existing missing penalty; quality/durability caveat. |
| OCF filled from licensed provider, same period/currency | Usable for FCF derivation with provider caveat. |
| OCF/capex period mismatch | Treat FCF unavailable; add blocking conflict. |
| Provider FCF exists but raw OCF/capex missing | Store as alternate; do not score until method is reviewed. |
| Currency mismatch on revenue/assets/cashflow | Treat field unavailable; add blocking conflict. |
| Financial-sector current-ratio missing/not applicable | Use `not_applicable_sector` caveat rather than generic missing-data punishment where sector model says so. |
| Stale excluded company (`EVN.AX`, `WTC.AX` pattern) | Keep excluded unless newer same-period source clears staleness; do not relax threshold. |

## Dashboard and API rules

Dashboard/API responses must be safe, compact, and honest.

Expose:

- Selected value, unit/currency, display-formatted value, data_as_of, period_type, provider/source_family, confidence/trust label.
- Whether the field was filled by fallback provider, derived from selected inputs, missing, stale, or conflicted.
- Short caveats and conflict counts/severity.
- Sanitized alternates summary for details views, capped in length.
- Run-level source mix, provider list, coverage/missingness summary, denominator status, and latest retrieval time.

Do not expose:

- API keys or raw query strings containing secret parameters.
- Signed URLs, cookies, headers, local filesystem paths, database URLs, stack traces, or raw provider payloads.
- Unlimited alternates/conflicts arrays in list views.
- Provider error bodies that could leak request details or credentials.

Recommended list-card projection:

```json
{
  "ticker": "BHP.AX",
  "company_id": "asx:BHP",
  "score": 74.2,
  "source_summary": "Yahoo bootstrap + 2 FMP-filled fields; 1 warning conflict",
  "field_quality": {
    "filled_fields": ["operating_cash_flow"],
    "conflicted_fields": ["market_cap"],
    "stale_fields": [],
    "missing_fields": ["cash", "total_debt"]
  },
  "caveats": ["Unofficial Yahoo bootstrap; verify against ASX filings before action."]
}
```

Recommended company-detail projection can include per-field `selected`, `alternates`, and `conflicts`, but should cap alternates/conflicts to a small number and retain only safe metadata.

## Storage and artifact implications

File-first run artifacts and Postgres history should preserve multi-source evidence without leaking provider payloads.

Required future artifact/schema additions:

| Area | Required support |
| --- | --- |
| `observations.jsonl` / observations table | Store raw field `FieldValue` records and consolidated selected field state, or separate `raw_fields`, `selected_fields`, `missing_fields`, and `field_quality` JSON objects. |
| `provenance.jsonl` / provenance table | Store one row per source evidence item with sanitized URL, provider, source family, trust/confidence, period, method, stale flag, and extraction status. |
| New conflicts artifact/table | Store `conflicts` by run/company/field with kind, severity, providers, thresholds, observed delta, selected provider, and requires_review. |
| New alternates support | Store non-selected candidate values with reason not selected. JSON is acceptable first; later table if querying needs it. |
| Run manifest | Include provider priority version, threshold version, source mix, provider failure summaries, denominator/security-type filters, and conflict counts. |
| Latest dashboard exports | Include only sanitized selected/conflict summaries, not raw evidence rows. |

Historical schema lane (`t_64898025`) should add non-destructive columns/tables for selected value reason, alternates, conflicts, source confidence, universe metadata, denominator/security-type filters, and per-provider failures. JSONB is acceptable for the first migration if indexed queries are not yet required.

## Required implementation tests and fixtures

Provider fallback implementation (`t_5d7125ad`) must include tests for:

1. `FieldValue` serialization includes unit/currency/period/source/confidence/stale/method/caveats fields and remains backward-compatible for scorer value access.
2. `source_url` sanitization strips `apikey`, `api_key`, `access_token`, `key`, `token`, signatures, and session IDs while preserving benign query parameters.
3. Missing credentials produce disabled adapter status and explicit missing/failure reason without network calls.
4. Provider rate-limit/plan-limit/fetch failures do not fabricate values and do not abort unrelated company processing.
5. FMP/Alpha fallback fills only missing Yahoo raw fields in the first phase; present Yahoo values remain present and alternates/conflicts are recorded when conflict handling is active.
6. Source priority selects reported/manual-verified values over provider statements, provider statements over Yahoo unofficial statements, and quote endpoints only for market-data fields.
7. Currency mismatch blocks selection for currency fields when no FX normalization is approved.
8. Unit/scale mismatch blocks selection and records `unit_or_scale_mismatch`.
9. Annual vs TTM/quarterly mismatch blocks merge for statement and derived annual metrics.
10. Same-period numeric near-equal candidates do not produce material conflicts; larger deltas do.
11. Newer restated filing supersedes older same-source/same-period value, retaining older value as alternate.
12. Provider-computed ratios are alternates when raw selected inputs can derive the ratio; they do not replace internally derived ratios without matching method/period.
13. FCF derivation uses selected OCF and capex from compatible period/currency only; mismatched inputs make FCF unavailable with conflict.
14. Financial-sector fixtures mark current ratio/debt metrics as sector-caveated or not applicable rather than generic parser failure.
15. Identity mismatch fixture (`company_id`/ticker/name/security type disagreement) creates a blocking conflict and never rewrites ASX seed identity.
16. Stale `EVN.AX`/`WTC.AX`-style fixture remains excluded unless a newer compatible source clears staleness.
17. Dashboard-safe export includes selected field source summaries, caveats, conflict counts, and no raw provider payloads.
18. Dashboard/API responses cap alternates/conflicts and sanitize provider errors.
19. Run manifest records provider priority version, threshold version, provider failures, source mix, denominator status, and conflict counts.
20. Secret scan fixture verifies committed docs/tests contain no real keys, URLs with live credentials, `.env` values, or local operator database paths.

Historical schema implementation (`t_64898025`) must include tests for:

1. Non-destructive migration applies with `CREATE ... IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` style changes.
2. Idempotent insert/upsert of the same run/company/field does not duplicate selected values, alternates, or conflicts.
3. Conflicts persist with kind/severity/providers/threshold/observed delta/requires_review.
4. Alternates persist separately from selected values or inside a documented JSON field.
5. Universe metadata persists denominator, denominator status, security-type filters, batch offset/size, and source seed hash.
6. Per-provider failure summaries persist without raw error bodies or secret-bearing URLs.
7. Dashboard read paths can project sanitized selected/conflict summaries without raw provider payloads.

## Implementation order

1. Add consolidation/threshold constants and fixture-only unit tests around a pure merge function. No network.
2. Extend provider adapter normalized `FieldValue` provenance to the schema above, preserving current scorer access.
3. Wire fallback adapters behind credentials in fill-only mode and record missing/failure reasons.
4. Add conflict/alternate output to file-first artifacts and sanitized dashboard projections.
5. Add historical schema support for selected reasons, alternates, conflicts, provider failures, and universe metadata.
6. Only after tests and review, run bounded fixture/smoke hydration. No live cron/deploy change in the implementation cards unless separately approved.

## Review checklist

Before approving implementation:

- Provider keys are optional, runtime-only, and absent from Git.
- Secret-bearing URL parameters are stripped before persistence.
- There is no value averaging across sources.
- Every selected value has source, period, currency/unit, method, confidence, and caveats.
- Every non-selected material value is retained as an alternate or conflict.
- Conflicted/mismatched values cannot silently improve a score.
- Financial-sector caveats are visible in scoring and display.
- Partial universe/batch coverage remains clearly labelled.
- Tests cover provider priority, conflict thresholds, missing credentials, rate limits, stale sources, identity mismatch, sanitized exports, and schema persistence.
