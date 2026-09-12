# NYSE universe source and identity rules

> Kanban task `t_4ed1788e`. Research/documentation only. No live service, credential, scheduler, or hydration mutation was performed.
>
> Research timestamp: 2026-09-12T00:38:40Z.

## Decision summary

Use NASDAQ Trader `otherlisted.txt`, filtered to `Exchange = N`, as the canonical NYSE seed source for the first NYSE full-universe implementation.[1] The source is a direct, unauthenticated text feed with stable pipe-delimited columns: `ACT Symbol`, `Security Name`, `Exchange`, `CQS Symbol`, `ETF`, `Round Lot Size`, `Test Issue`, and `NASDAQ Symbol`.[1] The live retrieval for this spec returned 7,609 source rows, 2,935 `Exchange = N` rows, 78 NYSE rows flagged `ETF = Y`, 12 NYSE rows flagged `Test Issue = Y`, file creation time `0911202618:01`, and raw SHA-256 `ab1cd85be373c3e7a0fa17154146bc8d5dc25dcc4fa68db28a3546c96f2eb15f`.[1]

This is a security-type-filtered NYSE listed-equity denominator, not a top-N/sample universe and not an unfiltered exchange-instrument listing. Final `denominator_status` must be `complete_security_type_filtered_listing` unless the implementation deliberately includes every source row, including ETFs, test issues, warrants, units, rights, preferreds, notes, ETNs, and similar non-operating-company instruments.

The NYSE public Listings Directory was inspected as the exchange-owned comparison source, but it should not be the seed generator contract for this lane.[2] Its current page exposes a POST-backed quote directory and returned 6,806 `EQUITY` rows across multiple venues, with 2,657 rows whose quote URL uses `XNYS`; returned rows did not populate explicit `instrumentType`, `micCode`, `exchangeId`, ETF, test-issue, delisted, or detailed security-type fields in the sampled API response.[2] ICE/NYSE terms also reserve website/content rights and require use only under the published terms, so turning the JS endpoint into a recurring scraper would need licensing review before production use.[4]

EODHD remains the provider/hydration identity target and a useful licensed validation/enrichment fallback, not the authoritative seed denominator.[3] Its exchange-symbol-list documentation says requests require `api_token`, can return JSON or CSV, support active vs. delisted sets via `delisted=1`, expose fields including `Code`, `Name`, `Country`, `Exchange`, `Currency`, `Type`, and `Isin`, and accept venue-level `NYSE` as an exchange code.[3] Because the project already uses EODHD for fundamentals, use EODHD to validate symbol/provider availability when credentials are available, but do not make the seed generator require an API token.

## Source comparison

| Source | Fields/status observed | Automation and terms risk | Use in this project |
| --- | --- | --- | --- |
| NASDAQ Trader `otherlisted.txt` | Pipe-delimited rows with ACT symbol, security name, exchange code, CQS symbol, ETF flag, round lot size, test-issue flag, NASDAQ symbol; current file includes file-creation timestamp.[1] | Public unauthenticated text feed; no credential or host-local path needed. It is not NYSE-owned, but it is purpose-built market-symbol directory data and mirrors the existing NASDAQ seed pattern. | Canonical NYSE seed denominator after filtering `Exchange = N` and applying explicit exclusion accounting. |
| NYSE Listings Directory | Public page for NYSE stock listings; POST API returned all-venue `EQUITY` rows and quote URLs carrying MIC-like prefixes such as `XNYS`, `XNCM`, `XNGS`, and `XASE`.[2] | Undocumented JS/API behavior; sampled rows lacked usable security-type/test/delisted metadata. ICE terms govern website/content use and reserve rights, so recurring automated use needs licensing review.[4] | Human/source comparison only; do not use as the recurring seed source without a reviewed data license/API contract. |
| EODHD exchange-symbol-list | Credentialed endpoint; docs describe active vs. delisted mode, JSON/CSV output, type filters, venue-level `NYSE`, and fields including ticker code, exchange, currency, type, and ISIN.[3] | Requires EODHD token and plan/license fit; provider list may reflect vendor coverage rather than exchange source-of-truth. | Provider validation/enrichment and hydration identity, not the no-secret canonical seed source. |

## Seed artifact contract

Target path:

`services/personal-dashboard/investment-screener/universe/nyse-listed-equities.seed.json`

Recommended schema version:

`investment-screener-nyse-universe-seed/v1`

Top-level shape should mirror the NASDAQ seed style:

```json
{
  "schema_version": "investment-screener-nyse-universe-seed/v1",
  "metadata": {
    "source_name": "NASDAQ Trader other listed securities (otherlisted.txt)",
    "source_url": "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt",
    "retrieved_at": "2026-09-12T00:38:40Z",
    "source_file_creation_time": "0911202618:01",
    "source_sha256": "ab1cd85be373c3e7a0fa17154146bc8d5dc25dcc4fa68db28a3546c96f2eb15f",
    "source_row_count": 7609,
    "nyse_source_row_count": 2935,
    "normalized_active_count": "<entries length>",
    "excluded_count": "<excluded length>",
    "unaccounted_source_row_count": 0,
    "denominator_status": "complete_security_type_filtered_listing",
    "denominator_label": "NYSE listed equities (NASDAQ Trader otherlisted Exchange=N, security-type-filtered)",
    "identity_rule": "company_id=nyse:{symbol}; eodhd_ticker={symbol}.US",
    "sort_rule": "source_order_then_symbol_asc"
  },
  "entries": [],
  "excluded": []
}
```

Each `entries[]` item should include at minimum:

- `company_id`: `nyse:{symbol}`
- `us_code`: normalized US ticker without `.US`
- `ticker`: `{symbol}.US` for backward-compatible provider-facing code if existing adapters still expect `ticker`
- `eodhd_ticker`: `{symbol}.US`
- `name`, `name_raw`, `name_normalized`
- `market`: `NYSE`
- `exchange`: `NYSE`
- `region`: `US`
- `currency`: `USD`
- `security_type`: e.g. `nyse_listed_equity`
- `active`: `true`
- `delisted`: `false` unless an approved delisted source is merged later
- `suspended`: `false` or `null`; `otherlisted.txt` does not expose suspension status
- `etf`: original `ETF` flag from source, normally `false` for included entries
- `test_issue`: original `Test Issue` flag from source, normally `false` for included entries
- `act_symbol`, `cqs_symbol`, `nasdaq_symbol`, and `round_lot_size` from the source
- `universe_rank`: deterministic rank in seed order
- `source`: `{name, url, retrieved_at, row_count, sha256}`

Each `excluded[]` item must include at minimum:

- `code`: original `ACT Symbol`
- `name_raw`: original `Security Name`
- `exchange`: original source exchange code
- `reason`: non-secret machine-readable reason, such as `not_nyse_exchange`, `etf`, `test_issue`, `non_equity:warrant`, `non_equity:unit`, `non_equity:right`, `non_equity:preferred`, `non_equity:notes`, `invalid_symbol`, or `duplicate_symbol`
- optional raw fields needed to audit the exclusion: `cqs_symbol`, `nasdaq_symbol`, `etf`, `test_issue`, `round_lot_size`

The generator must fail closed: every source row from `otherlisted.txt` must become either an included seed entry or an exclusion record, and `unaccounted_source_row_count` must be zero before review.

## Symbol normalization and collision rules

1. Read `ACT Symbol` as the canonical source ticker for NYSE rows.
2. Preserve dot-class symbols such as `BRK.B` and `BF.B` in `us_code`, `company_id`, display labels, and source audit fields. Do not collapse dot classes to hyphens or remove the class separator in canonical project identity.
3. Append `.US` only at provider call time / provider-facing fields: `eodhd_ticker = {us_code}.US`. Do not write `.US` into `company_id`.
4. Preserve source suffix punctuation in audit fields. If a downstream provider requires alternate forms, store that as provider-specific mapping, not as the canonical symbol.
5. Reject or exclude blank symbols, non-ASCII symbols, or symbols that would collide after the chosen canonical normalization.
6. Duplicate `us_code`, duplicate `company_id`, or duplicate `eodhd_ticker` after normalization is a hard error unless a reviewed collision table explicitly chooses one row and excludes the other with a documented reason.
7. Normalize names for matching only: Unicode NFKC, trim, collapse whitespace, uppercase. Never key identity on company name.

## EODHD NYSE contract

Use this canonical NYSE market contract:

- `mode`: `nyse-eodhd-fundamentals`
- `source`: `eodhd`
- `market`: `NYSE`
- `exchange`: `NYSE`
- `region`: `US`
- `currency`: `USD`
- `company_id`: `nyse:{symbol}`
- `eodhd_ticker`: `{symbol}.US`
- credential reference: use the existing EODHD runtime key reference only; never commit token values or host-local credential paths.

Do not collapse NYSE into the existing NASDAQ market bucket. NYSE and NASDAQ must remain separate in recurring registry entries, API responses, dashboard labels, storage accounting, and denominator status.

## Denominator and exclusion accounting policy

The recommended denominator is `complete_security_type_filtered_listing`.

Include by default:

- source rows where `Exchange = N`, `ETF = N`, `Test Issue = N`, symbol is valid/unique, and the security name does not identify a non-operating-company instrument class.

Exclude by default, with durable accounting:

- non-NYSE source rows (`Exchange != N`)
- ETFs and exchange-traded products (`ETF = Y`, names containing ETF/ETN/ETP where source flags are insufficient)
- test issues (`Test Issue = Y`)
- warrants
- units
- rights
- preferred/preference securities
- notes, bonds, baby bonds, debentures, trust certificates, and similar income instruments
- duplicate/colliding normalized symbols
- malformed rows or symbols

If the implementation keeps REITs or closed-end/listed investment companies in the included universe, flag them with a more specific `security_type` where detectable rather than silently treating them as ordinary operating companies. If those instruments are excluded instead, the exclusion reason must say so.

No full NYSE implementation may use `top_n`, `sample`, `known_sample_universe`, or similar labels. The existing US S&P 500 sample remains disabled/not applicable for recurring full-universe runs unless a separate task fixes its denominator semantics.

## UI/API wording requirements

Dashboard and API labels must say `NYSE` for this market and `NASDAQ` for the NASDAQ market. Do not present either as a generic `US` full-universe result.

Suggested labels:

- `NYSE listed equities`
- `NASDAQ listed equities`
- `US S&P 500 sample` only for the existing disabled/sample lane, with disabled/not-applicable status for recurring full-universe hydration

Coverage/status text should expose the denominator status and exclusion counts, for example:

`NYSE listed equities: 2,xxx included from 2,935 NYSE source rows; denominator_status=complete_security_type_filtered_listing; exclusions accounted.`

## Verification checklist for implementation lane

- Fetch `otherlisted.txt` once and store `retrieved_at`, source byte SHA-256, source row count, and source file creation time.
- Parse using the source header, not positional magic.
- Assert the expected columns are present.
- Assert all source rows are accounted for in `entries[]` or `excluded[]`.
- Assert `Exchange = N` is the only included exchange code.
- Assert included rows have `ETF = N` and `Test Issue = N`.
- Assert `company_id`, `us_code`, and `eodhd_ticker` are unique.
- Assert dot-class symbols survive unchanged.
- Assert the recurring registry records `mode=nyse-eodhd-fundamentals`, `source=eodhd`, `market=NYSE`, `exchange=NYSE`, `region=US`, `currency=USD`.
- Assert ASX, NASDAQ, and existing disabled US sample registry entries are unchanged except where explicitly reviewed.

## Open questions / blockers

- Licensing: this spec does not establish a legal right to redistribute NYSE/NASDAQ Trader-derived seed data outside Ben's private homelab repository. Before public distribution or commercial use, perform a licensing review.
- Security-type precision: `otherlisted.txt` provides ETF and test-issue flags but not a full instrument-type taxonomy. Name-based exclusion is necessary for warrants/units/rights/preferreds/notes unless a licensed enrichment source such as EODHD is added.
- Provider mapping: EODHD docs support venue-level `NYSE`, but actual provider coverage and symbol quirks should be validated with the existing credential path during the hydration task, not guessed here.[3]

## Handoff contract

- `chosen_source`: NASDAQ Trader `otherlisted.txt`, filtered to `Exchange = N`
- `seed_path`: `services/personal-dashboard/investment-screener/universe/nyse-listed-equities.seed.json`
- `denominator_status`: `complete_security_type_filtered_listing`
- `mode`: `nyse-eodhd-fundamentals`
- `source`: `eodhd`
- `market`: `NYSE`
- `exchange`: `NYSE`
- `region`: `US`
- `currency`: `USD`
- `exclusion_policy`: fail closed; every row becomes either an entry or an exclusion with a non-secret reason; exclude ETFs/test issues/warrants/units/rights/preferreds/notes/ETNs and malformed or duplicate symbols unless a later reviewed policy overrides it.

## Sources

[1] NASDAQ Trader otherlisted.txt — https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt
[2] NYSE Listings Directory — https://www.nyse.com/listings_directory/stock
[3] EODHD Exchanges API / list of tickers — https://eodhd.com/financial-apis/exchanges-api-list-of-tickers-and-trading-hours
[4] ICE Terms of Use — https://www.ice.com/privacy-security-center/terms-of-use
