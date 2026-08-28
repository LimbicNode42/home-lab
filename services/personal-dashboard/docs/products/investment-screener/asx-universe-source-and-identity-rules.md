# ASX universe source and identity rules

> Kanban task `t_ce48b1ca`. Research/documentation only. No paid API signup, credential injection, all-universe hydration, scraping run, cron change, or live dashboard mutation was performed.
>
> Research timestamp: 2026-08-28T05:01:59Z.

## Decision summary

Use the ASX/MarkitDigital company-directory CSV already referenced by `investment-screener/screener.py` as the canonical near-full ASX listed-company universe for the next hydration stage.[1] The live pull during this task returned 1,843 rows with fields `ASX code`, `Company name`, `GICs industry group`, `Listing date`, and `Market Cap`; the existing committed seed was generated from the same endpoint and records 1,838 source rows from its 2026-08-23 retrieval.[1]

Treat the ASX code as the canonical external listing key, derive Yahoo symbols as `{ASX code}.AX`, and assign the stable internal `company_id` as `asx:{asx_code}` unless a future schema introduces a separate ASX security identifier. This is boring. Boring is good. Boring keys survive provider swaps.

Use Twelve Data's public `stocks?exchange=ASX` response as a validation and enrichment cross-check, not as the denominator: it returned 2,031 ASX instruments during this task, including 1,865 `Common Stock` entries plus depositary receipts, REITs, preferred stock, and warrants.[3] Twelve Data supplies useful identity fields (`symbol`, `name`, `currency`, `exchange`, `mic_code`, `country`, `type`, `figi_code`) and gates ISIN/CUSIP behind add-ons in the sampled response, but using it as the denominator would silently change the product from listed companies to a broader instrument list.[3]

Do not use Yahoo Finance, MarketIndex, TradingView, EODHD, FMP, or ASX announcements as the primary universe denominator for the implementation lane. Yahoo is useful for per-symbol hydration once symbols are known, but the bare screener endpoint is not a safe discovery contract for ASX universe enumeration and a GET probe returned 405.[7]

MarketIndex and TradingView are useful human comparison pages, but they are HTML/JS public pages rather than an agreed automation feed; MarketIndex advertises a full ASX list page, and TradingView advertises an all-Australian-stocks page, but neither should be scraped as source-of-truth for a private recurring job without a licensing review.[8][9]

EODHD and FMP are valid credentialed data-provider candidates, but they add API-key/licensing dependencies and should remain provider-validation inputs rather than the seed source.[4][6]

## Source comparison

| Source | Fields observed / documented | Coverage count observed | Update / status handling | Auth / automation risk | Use in this project |
| --- | --- | ---: | --- | --- | --- |
| ASX/MarkitDigital company-directory CSV | ASX code, company name, GICs industry group, listing date, market cap.[1] | 1,843 live rows on 2026-08-28; committed seed metadata records 1,838 rows from 2026-08-23. | Appears to represent active ASX company-directory constituents; it does not expose delisted history, security type, ISIN, MIC, or explicit suspended status in the CSV. | No credential observed; direct CSV retrieval succeeded with a normal user agent. | Canonical denominator and seed generator source. |
| Legacy `www.asx.com.au/asx/research/ASXListedCompanies.csv` | Intended historical ASX listed-companies CSV path. | Not usable in this worker: probe returned a rejected/404-style response instead of CSV. | Not relied on. | Fragile behind ASX web/WAF behavior. | Do not use except as a manual fallback URL to test when the MarkitDigital URL changes.[2] |
| ASX announcements pages | Search/listing pages for company announcements, including today's announcements and the older announcements search page.[10][11] | Event feed, not a universe list. | Good source-of-record lane for filings and report verification; not a stable company denominator. | HTML/dynamic pages; use gently and only for targeted verification. | Verification path for shortlisted companies, not bulk universe hydration. |
| Twelve Data `stocks?exchange=ASX` | Symbol, name, currency, exchange, MIC, country, instrument type, FIGI; ISIN/CUSIP are add-on-gated placeholders in the sampled response.[3] | 2,031 total instruments: 1,865 Common Stock, 68 Depositary Receipt, 41 REIT, 30 Preferred Stock, 27 Warrant.[3] | Provider-managed instrument list; includes more than ordinary listed companies. | Public endpoint worked, but fundamentals require provider terms/limits; relying on it as denominator changes semantics. | Cross-check ASX seed, enrich security type/MIC/FIGI when permitted, and flag likely non-ordinary instruments. |
| EODHD exchange-symbol-list | Documentation says the endpoint can pull active or delisted tickers by exchange code and returns JSON or CSV; response examples include Code, Name, Country, Exchange, Currency, Type, and ISIN.[4] | Not counted here: demo AU endpoint returned 403 without a valid token.[5] | Stronger delisted/status story than ASX CSV if licensed; active/delisted support is documented. | Requires API token; license/cost approval needed. | Optional validation/enrichment provider after Ben approves credentials/licensing. |
| Financial Modeling Prep symbol/search APIs | Documentation page describes symbol search, exchange variants, broad symbol lists, and delisted-company endpoints.[6] | Not counted here: demo stock-list and ASX search API probes returned 401 without authorization.[12][13] | Potentially useful for provider-specific symbol mapping and delisted checks if licensed.[6] | Requires API key; docs/API access can be bot/WAF-sensitive. | Optional provider mapping check, not denominator. |
| Yahoo Finance symbol discovery / `.AX` | Hydration target format is `{ASX code}.AX` in existing code; discovery endpoint probe by GET returned 405.[7] | No reliable ASX universe count established. | Unofficial public endpoints can change/throttle and are already documented as bootstrap inputs in the product docs. | No formal contract; use only after ASX seed supplies codes. | Per-symbol hydration adapter target only. |
| MarketIndex ASX listed companies | Public page title/description advertises a full list of ASX companies ranked by size and sortable by performance or market cap.[8] | Not safely counted as a feed. | Useful human sanity check; page embeds market data and HTML app state.[8] | Public HTML page; scraping/licensing risk. | Manual comparison only. |
| TradingView Australia all stocks | Public page title advertises all Australian stocks on one page.[9] | Not safely counted as a feed. | Broad market page, JS-heavy. | Public HTML/JS; scraping/licensing risk. | Manual comparison only. |
| Existing committed seed | JSON seed at `investment-screener/universe/asx-listed-companies.seed.json`; generated by `investment-screener/generate_asx_universe_seed.py`. | 1,838 entries in current committed seed metadata. | Point-in-time snapshot with source URL, retrieved_at, row_count, sha256, and deterministic market-cap ranking. | Safe and auditable, but can drift from live ASX directory. | Runtime seed input until a reviewed refresh commit is made. |

## Canonical identity rules

### External identifiers

1. `asx_code` is the canonical external listing key. Store uppercase alphanumeric ASX codes only, matching the current code path's `^[A-Z0-9]{2,6}$` validator.
2. `ticker` is the provider-facing Yahoo symbol, generated as `{asx_code}.AX` for Yahoo-family adapters.
3. `exchange` and `market` are both `ASX` for this lane.
4. `region` is `AU`.
5. `mic_code` is not available from the ASX CSV; if Twelve Data enrichment is used later, store `XASX` as a sourced provider-enrichment field rather than pretending ASX supplied it.[3]
6. `isin` is not available from the ASX CSV; do not add it to the canonical seed until it comes from a licensed source such as EODHD/Twelve Data add-ons or another approved identifier feed.[3][4]

### Internal company id

Use `company_id = "asx:" + asx_code` for the next implementation stage. This key is stable across provider swaps because it does not embed `.AX`, provider names, display names, market cap rank, or retrieval date.

If a ticker is renamed, keep the historical `company_id` attached to the old ASX code in historical observations and create a new `company_id` for the new ASX code unless a reviewed corporate-action mapping proves continuity. Do not silently rewrite old observations to the new code; that is how time-series ghosts get invited in.

### Name normalization

Store both:

- `name_raw`: exact `Company name` from the ASX CSV.
- `name_normalized`: uppercase, trimmed, whitespace-collapsed, punctuation-normalized display name used for matching only.

Do not use company name as a primary key. Names change, suffixes vary, and punctuation is apparently where databases go to die.

Recommended normalization for matching:

1. Unicode normalize to NFKC.
2. Trim and collapse whitespace.
3. Uppercase.
4. Strip trailing punctuation only for match keys.
5. Maintain legal suffixes (`LIMITED`, `LTD`, `NL`, `INC`, `PLC`) in `name_raw`; optionally remove them in a separate `name_match_key`.

### Security and instrument type filtering

The ASX CSV does not provide a security-type column.[1] For Stage 1 ingestion, treat every ASX CSV row as an active listed company candidate and keep `security_type = "unknown_from_asx_directory"` unless enriched.

When a validation/enrichment provider supplies type information, use this filter policy:

- Include: ordinary/common shares and ordinary listed-company CDIs when the ASX directory includes them and they hydrate cleanly.
- Include but flag: REITs, LICs/listed investment companies, and stapled securities; they may need sector-specific scoring rules.
- Exclude from ordinary-share scoring by default: warrants, options, preferred securities, ETFs, funds/trust products that are not operating-company equities, notes, rights, and other derivative/income instruments.
- Keep excluded instruments in an audit table with `exclude_reason`, not in the scoring denominator.

Twelve Data's observed ASX list is useful for this validation because it distinguishes Common Stock, Depositary Receipt, REIT, Preferred Stock, and Warrant instrument types.[3]

### Duplicate, renamed, suspended, and delisted handling

- Duplicate `asx_code` in the same seed export is a hard error.
- Duplicate `ticker` after `.AX` conversion is a hard error.
- Missing or invalid ASX code is an exclusion with an audit record, not a generated ticker.
- Missing market cap is allowed, but those rows sort after rows with market cap and then by ASX code.
- Suspended status is not represented by the ASX CSV; it must be inferred from hydration failure, provider status fields, or a future approved exchange-status source.
- Delisted history is not represented by the ASX CSV; EODHD documents active/delisted ticker support and can be considered later if a historical denominator is needed.[4]

## Implementation-ready seed schema

Recommended path:

`services/personal-dashboard/investment-screener/universe/asx-listed-companies.seed.json`

Current generator:

`services/personal-dashboard/investment-screener/generate_asx_universe_seed.py`

Current source default:

`ASX_DIRECTORY_SOURCE_URL` in `services/personal-dashboard/investment-screener/screener.py`.

Recommended schema version for the next implementation card:

```json
{
  "schema_version": "investment-screener-asx-universe-seed/v2",
  "metadata": {
    "source_name": "ASX company directory CSV",
    "source_url": "https://asx.api.markitdigital.com/asx-research/1.0/companies/directory/file",
    "retrieved_at": "2026-08-28T05:01:59Z",
    "source_row_count": 1843,
    "normalized_active_count": 1843,
    "source_sha256": "<sha256 of raw CSV>",
    "sort_rule": "market_cap_desc_nulls_last_then_asx_code_asc",
    "identity_rule": "company_id=asx:{asx_code}; yahoo_ticker={asx_code}.AX"
  },
  "entries": [
    {
      "company_id": "asx:BHP",
      "asx_code": "BHP",
      "ticker": "BHP.AX",
      "name_raw": "BHP GROUP LIMITED",
      "name_normalized": "BHP GROUP LIMITED",
      "market": "ASX",
      "exchange": "ASX",
      "region": "AU",
      "sector": "Materials",
      "industry": "Materials",
      "listing_date": "1885-08-13",
      "market_cap": 334284993458,
      "currency": "AUD",
      "security_type": "unknown_from_asx_directory",
      "active": true,
      "universe_rank": 1,
      "source": {
        "name": "ASX company directory CSV",
        "url": "https://asx.api.markitdigital.com/asx-research/1.0/companies/directory/file",
        "retrieved_at": "2026-08-28T05:01:59Z"
      }
    }
  ],
  "excluded": []
}
```

The v2 seed should keep backward-compatible aliases (`name`, `sector`, `industry`, `ticker`) until the dashboard and storage layer read the richer fields directly.

## CLI flags and environment variables

Seed generation should stay explicit and reviewable:

```bash
python3 investment-screener/generate_asx_universe_seed.py \
  --output investment-screener/universe/asx-listed-companies.seed.json
```

For deterministic reviews or offline tests:

```bash
python3 investment-screener/generate_asx_universe_seed.py \
  --input-csv /path/to/asx-directory.csv \
  --retrieved-at 2026-08-28T05:01:59Z \
  --output investment-screener/universe/asx-listed-companies.seed.json
```

Hydration should continue to use existing bounded controls:

- `ASX_UNIVERSE_SEED_PATH` — reviewed seed path.
- `ASX_BATCH_OFFSET` — resumable offset into ranked seed.
- `ASX_BATCH_SIZE` — bounded batch size; do not default this to full universe.
- `ASX_SLEEP_SECONDS` — provider throttle; keep at least `0.75` seconds for Yahoo bootstrap unless a reviewed provider-specific limiter supersedes it.
- `DRY_RUN=1` — dry-run artifact path for smoke checks.

Do not add credentials for seed generation. Optional provider enrichment keys (`FMP_API_KEY`, `ALPHA_VANTAGE_API_KEY`, `EODHD_API_KEY`, `TWELVE_DATA_API_KEY`) belong only to provider adapters and must remain disabled unless present at runtime.

## Staged hydration plan

### Stage 0 — validate the denominator

1. Fetch ASX CSV once with the generator user agent.
2. Verify content type is CSV and the body is not HTML.
3. Validate required columns: `ASX code`, `Company name`, `GICs industry group`, `Listing date`, `Market Cap`.
4. Validate unique ASX codes and derived Yahoo tickers.
5. Compare row count to the committed seed and fail review if the delta is more than 5% without manual explanation.
6. Commit the refreshed seed only after review.

Stop conditions:

- ASX source returns HTML, 4xx/5xx, or a column set change.
- Duplicate ASX codes appear.
- Row-count delta exceeds 5%.
- More than 2% of rows fail code/date/market-cap parsing.

### Stage 1 — top 100 / top 200 smoke expansion

1. Hydrate by market-cap rank using the seed, not ad-hoc tickers.
2. Start with `ASX_BATCH_OFFSET=0 ASX_BATCH_SIZE=100`.
3. If coverage and provider-failure rates are acceptable, run `ASX_BATCH_SIZE=200`.
4. Keep Yahoo throttle at or above `ASX_SLEEP_SECONDS=0.75` unless implementation adds a reviewed adaptive limiter.
5. Publish only immutable run artifacts and latest pointer updates through the existing workflow.

Stop conditions:

- HTTP 429 / throttling cluster appears.
- Provider failures exceed 10% of attempted symbols.
- Exclusions exceed expected stale-data behavior from the top-50 audit.
- Dashboard export loses required caveats or marks partial coverage as full market.

### Stage 2 — sector-balanced sample

1. Use ASX GICs industry group from the seed to build a sector-balanced sample.
2. Include large, mid, and small names from each sector represented in the ASX CSV.
3. Include known edge cases: CDIs, REITs/LIC-like names, banks/insurers, and resource juniors.
4. Produce a gap report before attempting full universe.

Stop conditions:

- Sector-specific missingness makes score comparisons misleading.
- Identity enrichment fails for CDI/share-class names.
- The dashboard cannot explain excluded/stale names at company-detail level.

### Stage 3 — ordinary-share full-universe candidate run

1. Use the ASX seed as denominator.
2. Apply type exclusions only where an approved enrichment source supplies instrument type.
3. Run in resumable batches, not one unbounded job.
4. Store per-batch manifests with attempted, hydrated, failed, excluded, and skipped counts.
5. Do not market the dashboard as full-ASX coverage until all batches complete and a final denominator report is reviewed.

Suggested initial limits:

- `ASX_BATCH_SIZE=50` for recurring unattended runs.
- `ASX_SLEEP_SECONDS=0.75` minimum for Yahoo bootstrap.
- One batch per scheduled run until throttling and storage size are measured.
- Manual approval before increasing beyond 200 symbols per run.

## Recommendation for downstream implementation tasks

The `ASX universe ingestion and company identity layer` implementation card should:

1. Add `company_id`, `name_raw`, `name_normalized`, `currency`, and `security_type` to the normalized seed output.
2. Preserve the existing v1 fields until all readers are migrated.
3. Add seed validation tests for required columns, duplicate codes, HTML source body, deterministic sorting, and row-count-delta warning.
4. Add an optional Twelve Data validation report mode that reads a saved/provider-fetched symbol list and reports type mismatches without changing the ASX denominator.[3]
5. Keep provider enrichment outside the seed unless the source, license, and field provenance are explicitly approved.

## Sources

[1] https://asx.api.markitdigital.com/asx-research/1.0/companies/directory/file
[2] https://www.asx.com.au/asx/research/ASXListedCompanies.csv
[3] https://api.twelvedata.com/stocks?exchange=ASX
[4] https://eodhd.com/financial-apis/exchanges-api-list-of-tickers-and-trading-hours
[5] https://eodhd.com/api/exchange-symbol-list/AU?api_token=demo&fmt=json
[6] https://site.financialmodelingprep.com/developer/docs/stable
[7] https://query1.finance.yahoo.com/v1/finance/screener
[8] https://www.marketindex.com.au/asx-listed-companies
[9] https://www.tradingview.com/markets/stocks-australia/market-movers-all-stocks
[10] https://www.asx.com.au/markets/trade-our-cash-market/todays-announcements
[11] https://www.asx.com.au/asx/v2/statistics/announcements.do
[12] https://financialmodelingprep.com/api/v3/stock/list?apikey=demo
[13] https://financialmodelingprep.com/api/v3/search?query=BHP&exchange=ASX&apikey=demo
