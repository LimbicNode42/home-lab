# LSE and TSE/JPX universe source and identity rules

> Kanban task `t_1f9a8cc2`. Research/documentation only. No paid API signup, credential injection, broad provider hydration, live data mutation, scheduler change, or dashboard deploy was performed.
>
> Research timestamp: 2026-09-12T19:20:00Z.

## Decision summary

Add London Stock Exchange (`LSE`) and Tokyo Stock Exchange / JPX (`TSE`) as separate market buckets, not as generic Europe/Japan labels. Both lanes must follow the existing file-first, append-only screener pattern: a reviewed exchange/issuer seed is the denominator, provider adapters hydrate only from that seed, and every seed row must become included, failed, or explicitly excluded with a non-secret reason.

For LSE, use the London Stock Exchange issuer list workbook as the official public issuer-denominator source for the first implementation stage.[1][2]
The verified workbook is an unauthenticated `.xlsx`, last-modified by the server on 2026-08-03, with `Companies` and `Notes & Disclaimer` sheets; the parsed `Companies` sheet lists 1,522 companies as at 31 July 2026, split mainly across Main Market and AIM.[1]
The workbook notes that since February 2017 it includes companies with Shares, Depositary Receipts, and Other Equity-like instruments admitted to the London Stock Exchange, using MiFIR identifier categories `SHRS`, `DPRS`, and `OTHR`.[1]

The LSE workbook does not carry a ticker/TIDM, ISIN, MIC, LEI, or status column, so it is not enough by itself for automated provider-symbol hydration.[1]
Treat it as the official issuer denominator and require a provider/security-master mapping stage before any full LSE hydration.
Companies House accounts bulk data is a separate UK filings/fundamentals candidate rather than a listed-security denominator; its page describes downloadable accounts-data products, so use it later for issuer-fundamentals enrichment only after identity matching is solved.[6]
EODHD documents `LSE` as the London exchange code and says exchange codes are used as platform symbol suffixes and as `exchange-symbol-list/{exchangeCode}` path parameters, but the demo `exchange-symbol-list/LSE` request returned 403 without a valid token in this task.[4][8]
FMP search/stock-list probes also returned 401 with the demo key, so FMP cannot be used as a no-credential LSE mapping source.[10]

For TSE/JPX, use the JPX monthly listed-issues workbook as the authoritative listed-security seed source.[3][7]
The verified current workbook is an unauthenticated `.xlsx` and parsed successfully with 4,441 rows effective `20260831`; it exposes `Local Code`, English name, section/product, 33-sector code/name, 17-sector code/name, and TOPIX size fields.[7]
For ordinary equity screening, include Prime/Standard/Growth domestic and foreign market sections by default, which produced 3,712 included rows in this retrieval; exclude ETFs/ETNs, REIT/venture/country/infrastructure funds, PRO Market, and Equity Contribution Securities by default with durable exclusion records.[7]

Provider-symbol policy is deliberately stricter for Japan than for UK: the canonical seed key is the JPX local code, while provider suffixes are adapter-specific aliases. Yahoo chart smoke probes confirmed `HSBA.L` resolves as LSE equity in GBp and `7203.T` resolves as JPX equity in JPY, so Yahoo aliases are useful for bounded quote/freshness smoke only, not as source-of-truth denominators.[13][14]
EODHD documentation says exchange-code suffixes come from its authenticated exchanges list; unauthenticated probes showed `TSE` returned `Exchange Not Found`, while several plausible Japan codes returned auth-forbidden instead of data, so the implementation must discover and persist the exact EODHD Japan exchange code from authenticated `exchanges-list` before enabling an EODHD TSE adapter.[4][9][12]
Do not hard-code `TSE` as an EODHD suffix from the market name. That way lies haunted tickers.

## Existing architecture constraints to reuse

The implementation must reuse the current screener shape already used by ASX/NASDAQ/NYSE:

- file-first universe seeds under `services/personal-dashboard/investment-screener/universe/`;
- market-isolated run trees under `investment-screener/runs/market=<MARKET>/source=<SOURCE>/mode=<MODE>/run_date=.../<run_id>/`;
- latest pointers under `manifests/market=<MARKET>/source=<SOURCE>/latest.json`;
- dashboard exports under `exports/dashboard/market=<MARKET>/latest_{ranked,coverage,report}.*`;
- path-free `universe_version` values built from source labels, retrieved timestamps, and content hashes;
- sanitized provenance only: no credentials, local host paths, signed URLs, raw provider payloads, or task metadata in dashboard-visible output;
- `denominator_status` must distinguish complete issuer/listing coverage from bounded smoke/sample runs.

Current precedent:

- ASX uses an official ASX company-directory seed, Yahoo `.AX` aliases, `market=ASX`, `exchange=ASX`, `region=AU`, `currency=AUD`, and keeps security type `unknown_from_asx_directory` until an approved enrichment source supplies type.[ASX doc]
- NASDAQ/NYSE use NASDAQ Trader listing feeds plus security-type filters, EODHD `.US` provider aliases, and `denominator_status=complete_security_type_filtered_listing` for reviewed full-equity seeds.[NYSE doc]
- Provider fallback is fill-only and fail-closed: optional adapters must not overwrite existing values, must surface conflicts instead of averaging, and must sanitize secret query parameters before persistence.[Fallback doc]
- The registry-driven owner wrappers already expect market entries carrying `source`, `mode`, `seed`, `seed_arg`, `denominator_label`, `denominator_status`, `full_count_policy`, `smoke_batch_size`, `sleep_seconds`, `max_generated_age_hours`, and optional `credential_env`.[Scheduler doc]

## Source comparison

| Market | Source | Fields observed / documented | Count observed in this task | Auth / automation risk | Use in this project |
|---|---|---|---:|---|---|
| LSE | LSE issuer list workbook | Admission date, company name, ICB industry, ICB super-sector, country of incorporation, world region, market.[1] Notes say the file covers Shares, Depositary Receipts, and Other Equity-like instruments admitted to LSE.[1] | 1,522 company rows as at 31 July 2026; Main Market 902, AIM 597, plus smaller trading-only/professional segments.[1] | Public workbook; public market data/issuer-list terms still require licensing review before redistribution or commercial use. Lacks ticker/ISIN, so full hydration needs mapping. | Canonical LSE issuer denominator for Stage 0/1; not enough alone for provider calls. |
| LSE | EODHD exchange-symbol-list | Docs say `LSE` is the London exchange code and exchange codes are used as symbol suffix/path parameters; symbol-list endpoint can return exchange tickers with fields such as code/name/country/exchange/currency/type/ISIN when licensed.[4] | Not counted; demo `LSE` symbol-list request returned 403 without a valid token.[8] | Requires EODHD API key and plan/license. Provider universe may reflect vendor coverage, not LSE source-of-truth. | Required provider-symbol mapping/enrichment candidate; validate against LSE issuer list before enabling full hydration. |
| LSE | FMP search/stock-list | FMP exposes keyed symbol/search APIs in docs; probe with demo key returned 401.[5][10] | Not counted. | Requires FMP key; docs/API access is credentialed and not a no-secret universe source. | Optional provider cross-check only after credential approval. |
| LSE | Yahoo chart alias | `HSBA.L` returned chart metadata with `exchangeName=LSE`, `instrumentType=EQUITY`, and `currency=GBp`.[13] | Single-symbol smoke only. | Unofficial public endpoint; no stable listing contract. | Bounded smoke/freshness probe and quote alias, never denominator. |
| TSE/JPX | JPX listed issues workbook | Effective date, local code, English name, section/products, 33-sector code/name, 17-sector code/name, TOPIX size code/name.[7] JPX source page is the official listed-issues page.[3] | 4,441 total rows effective 20260831; 3,712 Prime/Standard/Growth domestic+foreign equity-market rows; 729 default exclusions.[7] | Public workbook; updated as an exchange file, but licensing/redistribution review still applies. | Canonical TSE/JPX listed-security denominator. |
| TSE/JPX | EDINET API / filings | Prior discovery found API-key/subscription gating for automation. | Not re-counted here. | Credential/subscription blocks recurring automation. Japanese filings are audit-grade but not a cheap universe hydrator. | Future primary-source fundamentals verification, not Stage 1 seed hydration. |
| TSE/JPX | EODHD exchange-symbol-list | Docs say exchange codes must come from `exchanges-list` and then drive symbol suffix/path use.[4] | Not counted; `TSE` returned `Exchange Not Found` with demo token, while authenticated discovery is still required.[9][12] | Requires EODHD key and exact exchange-code validation. | Do not enable until authenticated exchanges-list and several local-code probes pass. |
| TSE/JPX | FMP search/stock-list | Keyed API only in this environment; `7203` Tokyo search with demo key returned 401.[11] | Not counted. | Requires FMP key and exchange-name/suffix validation. | Optional cross-check after credential approval. |
| TSE/JPX | Yahoo chart alias | `7203.T` returned chart metadata with `exchangeName=JPX`, `instrumentType=EQUITY`, and `currency=JPY`.[14] | Single-symbol smoke only. | Unofficial public endpoint; no stable listing contract. | Bounded quote/freshness smoke and alias, not denominator. |

## LSE seed contract

Target path:

`services/personal-dashboard/investment-screener/universe/lse-listed-issuers.seed.json`

Recommended schema version:

`investment-screener-lse-universe-seed/v1`

Recommended metadata:

```json
{
  "schema_version": "investment-screener-lse-universe-seed/v1",
  "source_name": "London Stock Exchange issuer list workbook",
  "source_url": "https://docs.londonstockexchange.com/sites/default/files/reports/Issuer%20list_111.xlsx",
  "source_page_url": "https://www.londonstockexchange.com/reports?tab=issuers",
  "retrieved_at": "2026-09-12T19:20:00Z",
  "source_as_at": "2026-07-31",
  "source_sha256": "0ea85af67f4aa597b46ebf235a76b1815393b5f58415b73cc0f7fb31fcf29024",
  "source_row_count": 1522,
  "normalized_active_count": "<entries length>",
  "excluded_count": "<excluded length>",
  "unaccounted_source_row_count": 0,
  "denominator_status": "complete_issuer_listing_requires_symbol_mapping",
  "denominator_label": "LSE listed issuers from official issuer workbook; provider-symbol mapping required",
  "identity_rule": "issuer_id=lse:{name_match_key}; provider tickers are aliases only until TIDM/ISIN mapping is validated",
  "sort_rule": "market_priority_then_company_name"
}
```

Each `entries[]` item should include at minimum:

- `issuer_id`: `lse:{name_match_key}` for Stage 0 only; replace or alias to ISIN/TIDM once a licensed mapping source is approved;
- `company_id`: same as `issuer_id` for backward compatibility in Stage 0;
- `ticker`: `null` until a provider-symbol mapping source supplies TIDM/provider symbol;
- `eodhd_ticker`: nullable; when authenticated EODHD mapping is approved, expected shape is `{provider_code}.LSE` because EODHD documents `LSE` as the exchange code/suffix, but this must come from provider data rather than name guessing.[4]
- `yahoo_ticker`: nullable; may store provider-confirmed `.L` aliases such as `HSBA.L` only after a symbol map supplies the root code and a bounded chart smoke passes.[13]
- `name`, `name_raw`, `name_normalized`, `name_match_key`;
- `market`: `LSE`;
- `exchange`: `LSE`;
- `region`: `GB` for exchange region; keep `country_of_incorporation` separately because LSE issuers include non-UK companies;
- `world_region`, `country_of_incorporation` from the workbook;
- `currency`: `null` at seed stage; set from provider/security-master instrument currency later. Do not default all LSE to GBP because LSE instruments can quote in GBp, GBP, USD, EUR, or other currencies depending on line;
- `icb_industry`, `icb_super_sector`;
- `market_segment`: workbook `Market` value (`MAIN MARKET`, `AIM`, etc.);
- `security_type`: `shares_depositary_or_other_equity_like_from_lse_issuer_workbook`;
- `active`: `true` for current workbook entries unless a later status source says otherwise;
- `source`: `{name, url, retrieved_at, as_at, sha256, row_count}`.

Each `excluded[]` item must include at minimum:

- `name_raw`;
- `reason`: e.g. `blank_company_name`, `duplicate_name_match_key`, `unsupported_market_segment`, `malformed_admission_date`, or `requires_manual_symbol_mapping` if the implementation chooses not to include unmapped issuers in a hydration-ready seed;
- raw audit fields needed to reproduce the decision.

### LSE denominator policy

Use two explicit denominator statuses:

1. `complete_issuer_listing_requires_symbol_mapping` for the official LSE workbook seed before TIDM/ISIN/provider aliases exist.
2. `complete_security_type_filtered_listing` only after a reviewed mapping source can account for every issuer or excluded/unmapped issuer.

For Stage 1 implementation, do not publish LSE as full provider-hydrated coverage unless the coverage object says how many official issuer rows were mapped, unmapped, failed, and excluded. A run over only mapped provider tickers is a mapped subset, not full LSE coverage. The dashboard label should be painfully clear; ambiguity is how partial universes put on a fake mustache and walk into production.

## TSE/JPX seed contract

Target path:

`services/personal-dashboard/investment-screener/universe/tse-listed-equities.seed.json`

Recommended schema version:

`investment-screener-tse-universe-seed/v1`

Recommended metadata:

```json
{
  "schema_version": "investment-screener-tse-universe-seed/v1",
  "source_name": "JPX listed issues workbook",
  "source_url": "https://www.jpx.co.jp/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx",
  "source_page_url": "https://www.jpx.co.jp/english/markets/statistics-equities/misc/01.html",
  "retrieved_at": "2026-09-12T19:20:00Z",
  "source_effective_date": "2026-08-31",
  "source_sha256": "4d10497c2aa03bcca0b92f0673d3ab19ecc6aca6a9c9a70a3e19cd490f1d8754",
  "source_row_count": 4441,
  "normalized_active_count": 3712,
  "excluded_count": 729,
  "unaccounted_source_row_count": 0,
  "denominator_status": "complete_security_type_filtered_listing",
  "denominator_label": "TSE/JPX listed equities from JPX listed-issues workbook; Prime/Standard/Growth domestic+foreign only",
  "identity_rule": "company_id=tse:{local_code}; yahoo_ticker={local_code}.T; eodhd_ticker requires authenticated exchange-code discovery",
  "sort_rule": "section_priority_then_local_code_asc"
}
```

Each `entries[]` item should include at minimum:

- `company_id`: `tse:{local_code}`;
- `tse_code` / `local_code`: exact JPX local code as text, preserving alphanumeric forms such as `130A`;
- `ticker`: `{local_code}.T` only for backward-compatible Yahoo-family adapters;
- `yahoo_ticker`: `{local_code}.T` after normalisation;
- `eodhd_ticker`: nullable until authenticated EODHD exchange-code discovery proves the correct suffix;
- `fmp_ticker`: nullable until keyed FMP search validates convention and exchange name;
- `name`, `name_raw`, `name_normalized` from `Name (English)`;
- `market`: `TSE`;
- `exchange`: `JPX` or `TSE` consistently; recommended: `exchange=JPX`, `market=TSE` because Yahoo reports `exchangeName=JPX` for `7203.T`.[14]
- `region`: `JP`;
- `currency`: `JPY`;
- `section_product`: exact `Section/Products` value;
- `security_type`: `tse_listed_equity` for Prime/Standard/Growth domestic and foreign rows;
- `sector_33_code`, `sector_33_name`, `sector_17_code`, `sector_17_name`, `topix_size_code`, `topix_size_name`;
- `active`: `true` for rows in the current monthly file;
- `delisted`: `false` unless a future historical/status source says otherwise;
- `suspended`: `null` unless a future status source supplies it;
- `source`: `{name, url, retrieved_at, effective_date, sha256, row_count}`.

Each `excluded[]` item must include at minimum:

- `local_code`, `name_raw`, `section_product`;
- `reason`: one of `etf_etn`, `reit_venture_country_or_infrastructure_fund`, `pro_market`, `equity_contribution_security`, `unsupported_section`, `missing_or_invalid_local_code`, or `duplicate_local_code`;
- raw sector/size fields when present.

### TSE/JPX denominator policy

Include by default:

- `Prime Market (Domestic)`;
- `Standard Market(Domestic)`;
- `Growth Market(Domestic)`;
- `Prime Market(Foreign)`;
- `Standard Market(Foreign)`;
- `Growth Market (Foreign)`.

Exclude by default:

- `ETFs/ ETNs`;
- `REIT, Venture Funds, Country Funds and Infrastructure Funds`;
- `PRO Market`;
- `Equity Contribution Securities`;
- malformed/blank/duplicate local codes.

The implementation must fail closed if JPX changes the header, changes section labels unexpectedly, removes the effective-date field, serves HTML instead of a workbook, or creates duplicate local codes after normalization.

## Provider symbol and adapter contracts

| Market | Canonical source key | Canonical company id | Yahoo alias | EODHD alias | FMP alias | Required implementation behavior |
|---|---|---|---|---|---|---|
| LSE | Stage 0 `name_match_key`; Stage 1 approved TIDM/ISIN mapping | `lse:{name_match_key}` until mapping; prefer `lse:{isin}:{mic}` after approved security master | Provider-confirmed `{tidm}.L` only; `HSBA.L` smoke verified.[13] | Expected `{Code}.LSE` only when authenticated EODHD symbol list supplies `Code`; docs confirm `LSE` exchange code/suffix.[4] | Unknown until keyed search/stock-list validates; demo key returned 401.[10] | Do not hydrate full LSE from names. Build a mapping report first. |
| TSE/JPX | JPX `Local Code` | `tse:{local_code}` | `{local_code}.T`; `7203.T` smoke verified.[14] | Unknown; authenticated EODHD `exchanges-list` must identify the Japan code, and `TSE` should not be assumed because demo returned not found.[9][12] | Unknown until keyed search validates; demo key returned 401.[11] | Seed can be generated now; provider adapter remains credential/suffix-gated. |

Provider adapters must emit `source_mix`, per-provider request counts, success/failure counts, and `provider_symbol_convention` in run metadata. If a provider symbol is unavailable or unverified, record `missing_provider_symbol` as a failure/exclusion reason rather than silently dropping the seed row.

## Staged implementation plan

### Stage 0 — source fetch and seed generation, no provider hydration

1. Fetch LSE and JPX workbooks once, using explicit user-agent and bounded timeout.
2. Record `retrieved_at`, content type, content length when present, SHA-256, workbook sheet names, source row count, and as-at/effective date.
3. Validate expected columns exactly enough to fail on source-shape changes.
4. Normalize rows into seed JSON with `entries[]` and `excluded[]`.
5. Assert `len(entries) + len(excluded) == source_row_count` for each seed.
6. Commit seeds only after review; do not write NAS runtime data or latest pointers in this stage.

Stop conditions:

- HTTP non-200, HTML instead of workbook, missing sheet, missing required columns, duplicate canonical keys, parse failure above 0.5%, unexpected JPX section label, or LSE workbook still lacking symbol mapping when a hydration-ready run was requested.

### Stage 1 — provider mapping smoke, bounded and no publish

1. For LSE, use authenticated EODHD `exchange-symbol-list/LSE` to build a mapping report keyed by provider code/name/ISIN when available; compare to LSE issuer names and flag unmatched/ambiguous rows.[4]
2. For TSE, run authenticated EODHD `exchanges-list` first, identify the Japan/Tokyo exchange code, then fetch only a tiny symbol-list/search sample for known JPX local codes. Do not infer the code from the market label.[4][9][12]
3. For FMP, run tiny keyed searches for representative LSE and JPX symbols only after the key is approved; current demo probes prove only that an API key is required.[10][11]
4. For Yahoo, run a 5-symbol chart smoke per market using provider aliases and record quote currency/exchangeName mismatches; do not persist Yahoo as the denominator.[13][14]

Stop conditions:

- Provider exchange code ambiguous, more than 2% mapping ambiguity in a seed sample, provider currency/exchange mismatch, 401/403/429, secret-shaped value in logs, or provider terms do not allow private local storage.

### Stage 2 — tiny hydration smoke, no publish by default

1. Add registry entries disabled by default or `smoke_only` until Stage 1 passes.
2. Use `DRY_RUN=1`, scratch `INVESTMENT_SCREENER_DATA_ROOT`, and small `smoke_batch_size` (`5` recommended for each new market).
3. Hydrate only from reviewed seed rows and provider-confirmed aliases.
4. Require every attempted seed row to be one of `usable`, `provider_failed`, `excluded`, or `missing_provider_symbol`.
5. Validate dashboard-safe ranked/coverage/report artifacts in scratch output only.

Stop conditions:

- Any unaccounted seed row, provider failure rate >20% in smoke, unsupported currency handling, source URLs with secrets, or dashboard limitations missing.

### Stage 3 — reviewed partial batch

1. After smoke passes, run a reviewed top/section-balanced batch of 25-50 names per market.
2. Publish only if Ben approves the denominator wording and target data root.
3. Ensure coverage text says mapped subset / section-balanced batch, not full exchange coverage.

### Stage 4 — full market enablement

1. Enable monthly full-universe registry only after mapping coverage and provider terms are reviewed.
2. Use `full_count_policy=complete_seed`, market-specific throttle, and credential fail-closed checks.
3. Preserve ASX/NASDAQ/NYSE buckets unchanged.
4. Do not promote to dashboard market filter unless latest coverage is fresh and honest.

## Registry entries to add after implementation

Initial disabled/smoke-only draft:

```json
{
  "key": "LSE",
  "enabled": false,
  "source": "eodhd",
  "mode": "lse-eodhd-fundamentals",
  "seed": "lse-listed-issuers.seed.json",
  "seed_arg": "--lse-universe-seed",
  "market": "LSE",
  "exchange": "LSE",
  "region": "GB",
  "currency": null,
  "denominator_label": "LSE listed issuers from official issuer workbook; provider-symbol mapping required",
  "denominator_status": "complete_issuer_listing_requires_symbol_mapping",
  "full_count_policy": "complete_seed",
  "smoke_batch_size": 5,
  "sleep_seconds": 1.0,
  "max_generated_age_hours": 26,
  "credential_env": "EODHD_API_KEY",
  "notes": "Do not enable full recurring hydration until issuer-to-provider symbol mapping is reviewed."
}
```

```json
{
  "key": "TSE",
  "enabled": false,
  "source": "eodhd",
  "mode": "tse-eodhd-fundamentals",
  "seed": "tse-listed-equities.seed.json",
  "seed_arg": "--tse-universe-seed",
  "market": "TSE",
  "exchange": "JPX",
  "region": "JP",
  "currency": "JPY",
  "denominator_label": "TSE/JPX listed equities from JPX listed-issues workbook; Prime/Standard/Growth domestic+foreign only",
  "denominator_status": "complete_security_type_filtered_listing",
  "full_count_policy": "complete_seed",
  "smoke_batch_size": 5,
  "sleep_seconds": 1.0,
  "max_generated_age_hours": 26,
  "credential_env": "EODHD_API_KEY",
  "notes": "Resolve authenticated EODHD Japan exchange code before enabling provider calls."
}
```

If implementation starts with Yahoo-only quote smoke, use `source=yahoo-finance`, modes `lse-yahoo-chart-smoke` and `tse-yahoo-chart-smoke`, `DRY_RUN=1`, and `enabled=false` for recurring full hydration. Do not route Yahoo smoke through the existing full monthly job.

## Dashboard and freshness requirements

The dashboard/API must surface these fields when LSE/TSE exports exist:

- `market`, `exchange`, `region`, `currency`;
- `denominator_status`, `denominator_label`, `source_row_count`, `seed_entries`, `excluded_count`, `unaccounted_source_row_count`;
- `mapped_count`, `unmapped_count`, and `mapping_ambiguous_count` for LSE until a complete mapping is approved;
- `provider_symbol_convention` and `source_mix`;
- `generated_at`, `data_as_of`, `source_effective_date` or `source_as_at`;
- `stale` and `max_generated_age_hours` using the existing 26-hour preflight convention;
- clear limitations: no financial advice, provider/license caveats, currency caveats, and explicit partial-coverage labels.

UI labels:

- `London / LSE` only when the latest export contains LSE rows;
- `Japan / TSE-JPX` only when the latest export contains TSE rows;
- never label a mapped subset as `Full LSE`; use `LSE mapped issuer subset` until mapping is complete;
- never collapse TSE/JPX into the existing `US`, `NASDAQ`, `NYSE`, or `ASX` buckets.

## Fail-closed rules

- Seed generation must fail if source shape changes, row counts are zero, duplicate canonical keys appear, or source workbooks are not parseable.
- Hydration must fail or mark partial if any seed row disappears without `excluded`, `provider_failed`, `missing_provider_symbol`, or `mapping_ambiguous` accounting.
- Credentialed providers must skip with `missing_credential_<ENV>` when keys are absent, not fall back to unofficial broad scraping.
- Provider URLs must be redacted before persistence.
- Currency mismatches are blocking conflicts, not values to average.
- LSE names are not provider symbols. Any adapter that tries to call a financial provider by company name should be considered a bug with a hat on.

## Implementation verification checklist

- Parse LSE workbook and assert 1,522 rows for the current fixture or an explained delta for a refreshed fixture.
- Parse JPX workbook and assert entries plus exclusions equal source row count.
- Preserve alphanumeric JPX local codes such as `130A`.
- Assert TSE included sections and excluded section reasons exactly.
- Assert LSE seed reports `complete_issuer_listing_requires_symbol_mapping` until TIDM/ISIN mapping is reviewed.
- Assert TSE seed reports `complete_security_type_filtered_listing` for Prime/Standard/Growth filtered rows.
- Assert provider aliases are nullable and provenance-labelled.
- Assert no secret values or local host paths appear in seeds, manifests, coverage, ranked output, report output, or logs.
- Assert registry iteration leaves ASX/NASDAQ/NYSE behavior unchanged.
- Run scratch smoke only; do not mutate `/mnt/pve/NAS/services/personal-dashboard` in implementation without explicit approval.

## Open questions / blockers

1. LSE symbol mapping: the official workbook is issuer-level and lacks TIDM/ISIN. Choose a licensed/security-master mapping path before full LSE hydration.
2. EODHD Japan code: authenticated `exchanges-list` must identify the actual Japan/Tokyo exchange code; unauthenticated `TSE` is not valid evidence.
3. FMP conventions: FMP requires a real key to verify LSE/JPX exchange names and symbol suffixes.
4. Licensing: LSE/JPX/provider data may be fine for private homelab research but is not cleared for public redistribution or commercial use.
5. Fundamentals quality: filing/XBRL paths remain the audit-grade source, but normalized fundamentals will probably need a licensed provider or parsers. Spreadsheets do not magically become due diligence because they are wide.

## Handoff contract for implementation task

- `chosen_lse_source`: London Stock Exchange issuer list workbook.
- `chosen_tse_source`: JPX listed issues workbook.
- `lse_seed_path`: `services/personal-dashboard/investment-screener/universe/lse-listed-issuers.seed.json`.
- `tse_seed_path`: `services/personal-dashboard/investment-screener/universe/tse-listed-equities.seed.json`.
- `lse_denominator_status_initial`: `complete_issuer_listing_requires_symbol_mapping`.
- `tse_denominator_status`: `complete_security_type_filtered_listing`.
- `lse_market`: `LSE`; `exchange`: `LSE`; `region`: `GB`; seed currency nullable.
- `tse_market`: `TSE`; `exchange`: `JPX`; `region`: `JP`; `currency`: `JPY`.
- `lse_mode_draft`: `lse-eodhd-fundamentals` after mapping, disabled until reviewed.
- `tse_mode_draft`: `tse-eodhd-fundamentals` after authenticated EODHD exchange-code discovery, disabled until reviewed.
- `exclusion_policy`: fail closed; every source row is included or excluded with a non-secret reason, and every hydration attempt is usable/failed/excluded/unmapped/ambiguous.

## Sources

[1] https://docs.londonstockexchange.com/sites/default/files/reports/Issuer%20list_111.xlsx
[2] https://www.londonstockexchange.com/reports?tab=issuers
[3] https://www.jpx.co.jp/english/markets/statistics-equities/misc/01.html
[4] https://eodhd.com/financial-apis/exchanges-api-list-of-tickers-and-trading-hours
[5] https://site.financialmodelingprep.com/developer/docs/stable
[6] https://download.companieshouse.gov.uk/en_accountsdata.html
[7] https://www.jpx.co.jp/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx
[8] https://eodhd.com/api/exchange-symbol-list/LSE?api_token=demo&fmt=json
[9] https://eodhd.com/api/exchange-symbol-list/TSE?api_token=demo&fmt=json
[10] https://financialmodelingprep.com/api/v3/search?query=HSBA&exchange=LSE&apikey=demo
[11] https://financialmodelingprep.com/api/v3/search?query=7203&exchange=Tokyo&apikey=demo
[12] https://eodhd.com/api/exchanges-list/?api_token=demo&fmt=json
[13] https://query1.finance.yahoo.com/v8/finance/chart/HSBA.L?range=5d&interval=1d
[14] https://query1.finance.yahoo.com/v8/finance/chart/7203.T?range=5d&interval=1d
