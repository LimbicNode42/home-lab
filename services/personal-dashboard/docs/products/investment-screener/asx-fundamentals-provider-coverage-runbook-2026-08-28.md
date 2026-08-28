# ASX fundamentals provider coverage runbook — 2026-08-28

> Kanban task `t_10df7a23`. Research/documentation only: no credentials, sign-ups, provider code, live hydration, scraper jobs, cron changes, or dashboard mutation were performed.
>
> This updates the earlier ASX provider note with the current top-50 audit: the latest canonical ASX run has 50 tracked companies, 48 usable, and the material gaps are `operating_cash_flow` -> `fcf`/`fcf_margin`, current assets/liabilities for banks and insurers, no normalized `cash`/`total_debt`, and stale excluded `EVN.AX`/`WTC.AX`.

## Decision summary

Keep Yahoo as the no-credential bootstrap provider, but treat it as an unofficial fill source rather than source-of-record fundamentals: the live `BHP.AX` chart endpoint returned ASX/AUD quote metadata, and the fundamentals-timeseries endpoint returned annual statement field families, but current audit data shows Yahoo still leaves `operating_cash_flow` missing for 32/50 companies.[1][2]

First no-credential improvement is not another scraper; it is better truthfulness around the existing Yahoo run: wire missing reasons, retry/backoff/jitter, identity propagation, and ASX report links for human verification. ASX pages and announcements are accessible public primary-source routes for company/report verification, but their pages are HTML/dynamic and should be used gently for targeted checks, not bulk numeric scraping.[3][4][21]

If Ben supplies one credential, use Financial Modeling Prep first via `FMP_API_KEY`.
The local codebase already has a fail-closed `FmpAdapter` scaffold, and FMP's public docs/pricing pages were CloudFront-blocked from this worker.[7][8]
Direct API probes returned 401 with an invalid-key message, so it is implementable only as a keyed adapter with sanitized provenance and no anonymous fallback.[22][23]

Use Alpha Vantage only as a low-volume spot-fill fallback via `ALPHA_VANTAGE_API_KEY`: its documentation publishes fundamentals functions for company overview, income statement, balance sheet, cash flow, and shares outstanding, but demo probes for `BHP.AX` returned the expected “claim your free API key” message rather than usable data.[5][27][28]

Defer Twelve Data and EODHD for fundamentals until Ben explicitly approves plan/cost/licensing.
Twelve Data's ASX stock list is useful for identity validation and returned ASX instruments with MIC/type/FIGI fields, but its income statement and balance-sheet endpoints returned 403 without an eligible paid key.[13][30][31]
Twelve Data's cash-flow probe also returned the same plan-gated error.[32]
EODHD documents yearly and quarterly fundamental sections including income statement, balance sheet, cash flow, and ratios, but the demo fundamentals endpoint returned 403.[9][29]

Do not automate MarketIndex, TradingView, or Morningstar scraping for this lane.
They are good human cross-check pages, but MarketIndex is a public HTML surface rather than a recurring data-feed contract.[14][15][18]
TradingView is JS-heavy and has robots limits across several bot-sensitive areas.[16][19]
Morningstar Australia returned SSR/JS HTML and robots excludes search/token paths, so recurring numeric extraction still needs an approved API/data agreement.[17][20]

## Current gaps to fill first

| Gap from current audit | Current count | Likely cause | Best next provider/action |
| --- | ---: | --- | --- |
| `operating_cash_flow` | 18 present / 32 missing | Yahoo fundamentals-timeseries coverage gap | FMP first; Alpha Vantage spot-fill; ASX annual report verification for high-interest names |
| `fcf`, `fcf_margin` | 17 present / 33 missing | Derived from OCF + capex, so OCF gap cascades | Same as OCF; do not use provider FCF if capex sign/period differs without conflict record |
| `current_assets`, `current_liabilities`, `current_ratio` | 41 present / 9 missing | Banks/insurers plus stale excluded names | Treat financials as sector-specific caveats; fallback only if same accounting period and source reports current classifications |
| `cash`, `total_debt` / `debt` | 0 present / 50 absent | Normalizer/schema gap, not just provider absence | Add fields only when provider reports them explicitly; avoid pretending total liabilities are debt |
| `EVN.AX`, `WTC.AX` full score availability | 2 excluded | stale required financials beyond 730-day threshold | Verify latest filings/provider statements; do not relax staleness threshold blindly |
| identity metadata in detail API | seed has more than API exposes | export/presentation gap | Carry seed sector/industry/exchange/company_id through artifacts before asking providers for it |

## Provider coverage matrix

Legend: `D` direct field, `R` reported raw statement field that can derive the screener metric, `P` provider-computed ratio/value, `M` market quote/share data, `V` verification only, `-` not a safe automation source.

| Field | Yahoo current | ASX announcements / annual reports | FMP | Alpha Vantage | EODHD | Twelve Data | MarketIndex / Morningstar / TradingView |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `market_cap` | M / derived from price × shares | R / derivable from shares + price, not primary | M/P | D via overview | D | D | Page display only |
| `pe_ratio` | R / derived | R / derivable | P | D via overview | P | P | Page display only |
| `price_to_sales` | R / derived | R / derivable | P | D via overview | P | P | Page display only |
| `revenue` | R | R | R | R | R | R | Page display only |
| `net_income` | R | R | R | R | R | R | Page display only |
| `net_margin` | derived | derivable | P / derived | D via overview | P / derived | P / derived | Page display only |
| `roe` | derived | derivable | P / derived | D via overview | P / derived | P / derived | Page display only |
| `operating_cashflow` | R but current top-50 sparse | R | R | R | R | R | not safe |
| `capex` | R | R | R | R | R | R | not safe |
| `fcf` | derived from OCF + capex | R / derivable | P/R | derived | R/P | derived | not safe |
| `fcf_margin` | derived | derivable | P / derived | derived | P / derived | derived | not safe |
| `revenue_growth` | derived from current/prior revenue | derivable | P / derived | derived from annual reports | derived | derived | not safe |
| `current_ratio` | derived, weak for financials | derivable where current classes reported | P / derived | derived | P / derived | derived | page display only |
| `debt_to_assets` | current implementation uses liabilities/assets | derivable if true debt is reported | P / derived | derived | P / derived | derived | page display only |
| `current_assets` | R, sparse for financials | R if reported | R | R | R | R | not safe |
| `current_liabilities` | R, sparse for financials | R if reported | R | R | R | R | not safe |
| `total_assets` | R | R | R | R | R | R | page display only |
| `total_liabilities` | R | R | R | R | R | R | page display only |
| `cash` | not normalized | R | R if endpoint field mapped | R if endpoint field mapped | R | R | not safe |
| `debt` / `total_debt` | not normalized | R if reported | R if endpoint field mapped | R if endpoint field mapped | R | R | not safe |
| `shares_outstanding` | R / annual diluted average | R | D/R | D via shares-outstanding endpoint | D/R | D/R | page display only |

## Provider operating notes

### 1. Yahoo current path — keep as bootstrap base

Request model: no key; use `query1.finance.yahoo.com/v8/finance/chart/{ticker}` for quote metadata and `query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{ticker}` for annual statement fields.[1][2]

Historical depth: field-dependent annual time series; enough for current/prior revenue and point-in-time raw statements when Yahoo returns the fields.

Freshness: quotes are current-ish market data; annual statements lag filings and are not source-of-record.

Coverage estimate: current canonical top-50 audit is 48/50 usable, but only 18/50 have OCF and 17/50 have FCF/FCF margin.

Reliability/risk: unofficial endpoint, no SLA, possible throttling or shape changes; suitable for homelab only with pacing, retries, missing-reason output, and loud caveats.

### 2. ASX announcements, company pages, and annual report PDFs — verification lane, not bulk fill

Request model: targeted public-page access to ASX company and announcement/report pages; fetch report links for specific tickers/candidates, then extract tables/PDFs only when a human wants verification.[3][4]

Field coverage: source-of-record annual/half-year reports can contain every raw statement field needed here, including revenue, net income, assets/liabilities, cash/debt, operating cash flow, capex, and shares.

Historical depth: as deep as available filings/report archive, but extraction quality varies by issuer/report format.

Freshness: filing-timed; best source for stale-exclusion checks and candidate due diligence.

Reliability/risk: authoritative but expensive to structure; ASX robots disallows `/search*`, so avoid generic search crawling and prefer known company/report routes or manual report URLs.[21]

Homelab suitability: high for targeted verification artifacts; poor for unattended whole-universe numeric hydration unless a dedicated parser/OCR pipeline is separately approved.

### 3. Financial Modeling Prep — recommended first credentialed fill

Request model: keyed REST API only.
From this worker, docs/pricing pages were blocked by CloudFront and stable quote/key-metrics probes returned 401 without a valid key.[7][8][22]
The key-metrics and statement endpoint probes also returned 401, which is exactly why the adapter must be credential-gated and fail closed.[23][24][25]
The cash-flow endpoint behaved the same way.[26]

Field coverage: local adapter/test scaffolding maps income statement, balance sheet, and cash-flow endpoints to `revenue`, `net_income`, `total_assets`, `total_liabilities`, `current_assets`, `current_liabilities`, `operating_cash_flow`, and `capital_expenditures`; derived fields then fill `market_cap`, `pe_ratio`, `price_to_sales`, margins, ROE, current ratio, debt/assets, FCF, and revenue growth where raw values are present.

Historical depth/freshness: annual statements via provider endpoints; exact licensed depth and refresh cadence must be confirmed after key creation because anonymous probes cannot inspect payloads.

Auth/env: `FMP_API_KEY`; Ben should store `homelab|investment-screener/fmp|api_key|FMP_API_KEY` in Vaultwarden and inject it only at runtime.

Suitability: best first optional provider if licensing permits private homelab storage; wire it fill-only for missing raw fields first, never overwrite present Yahoo values until the conflict spec is implemented.

### 4. Alpha Vantage — low-volume fallback / spot fill

Request model: keyed `www.alphavantage.co/query` functions; documentation lists Company Overview, Income Statement, Balance Sheet, Cash Flow, and Shares Outstanding under Fundamental Data, and every documented example requires an `apikey`.[5]

Field coverage: overview can supply market cap and common ratios; statements can supply revenue/net income/assets/liabilities/current assets/current liabilities/OCF/capex; shares outstanding is documented as a separate endpoint category.[5]

Pricing/access note: the Alpha Vantage premium page was retrieved for access planning, but no paid tier was selected or configured in this task.[6]

Auth/env: `ALPHA_VANTAGE_API_KEY`; existing env map already includes `homelab|investment-screener/alpha-vantage|api_key|ALPHA_VANTAGE_API_KEY`.

Suitability: useful as a secondary adapter or manual spot-fill, but current code should budget it conservatively; demo probes for ASX did not return data without a real key.[27][28]

### 5. EODHD — deferred paid fundamentals candidate

Request model: keyed REST API; EODHD documentation describes fundamental data sections for General, Highlights, Valuation, SharesStats, Financials, Balance_Sheet, Cash_Flow, Income_Statement, and Earnings, with yearly and quarterly report entries.[9]

Field coverage: broad enough for every target field, including raw statements, shares stats, valuations, ratios, operating cash flow, capex, and free cash flow.[9]

Auth/env: `EODHD_API_KEY`; not currently in `personal-dashboard.env.map.example`, so add only after Ben approves a paid/licensed provider lane.

Pricing/access note: the EODHD pricing page was retrieved for planning only; this task did not approve or purchase a feed.[10]

Suitability: likely good technically, but should remain Stage 2 because the demo fundamentals probe returned 403 and the previous runbook recorded the fundamentals feed as paid/deferred.[29]

### 6. Twelve Data — identity validation now, fundamentals later

Request model: public stock-list endpoint for `exchange=ASX` worked without a key and returned ASX instruments with `symbol`, `currency`, `exchange`, `mic_code`, `country`, `type`, `figi_code`, and gated ISIN/CUSIP placeholders.[13]

Field coverage: income statement, balance sheet, and cash-flow endpoints exist, but no-key probes returned 403 saying those endpoints require pro/ultra/venture/enterprise plans.[30][31][32]

Pricing/access note: Twelve Data's documentation and pricing pages were retrieved to confirm the credits/plan model, including that API credits are consumed per endpoint and reset each minute.[11][12]

Auth/env: `TWELVE_DATA_API_KEY`; add only if Ben approves a plan that includes fundamentals.

Suitability: use now only for validation/enrichment reports, especially security type/MIC/FIGI cross-checking; not a no-credential fundamentals provider.

### 7. Morningstar / MarketIndex / TradingView public pages — manual comparison only

MarketIndex pages returned normal HTML for both the BHP page and full ASX companies page, and its robots file does not blanket-disallow `/asx/` pages, but this is still a page-rendered consumer site rather than a data-feed contract.[14][15][18]

TradingView symbol pages returned a large JS-heavy HTML document and robots disallows many AI/bot areas under `/symbols/*/minds/*`, `/chart/*`, `/watchlists/*`, and related paths; do not build a TradingView scraper without a licensing review.[16][19]

Morningstar Australia pages returned SSR/JS HTML and robots allows most pages except `/search/*` and `/token/*`, but Morningstar content/licensing expectations make recurring numeric extraction unsafe without an approved API/data agreement.[17][20]

## Recommended implementation order

1. No-credential: wire Yahoo retry/backoff/jitter, field-level missing reasons, source caveats, and seed identity carry-through. This directly improves the current 48 usable companies without new egress contracts.
2. No-credential: add a targeted ASX-report verification table/link field for shortlisted or stale names, starting with excluded `EVN.AX` and `WTC.AX`; store report URL, filing date, extraction status, and “verified/not verified”, not unsourced OCR numbers.
3. Optional credential: enable FMP fill-only adapter behind `FMP_API_KEY`, using sanitized source URLs and conflict arrays; use a bounded top-50 smoke run before any larger batch.
4. Optional credential: enable Alpha Vantage only as secondary fallback behind `ALPHA_VANTAGE_API_KEY`, with a strict per-run budget and “rate-limited/credential-missing” missing reasons.
5. Deferred: evaluate EODHD (`EODHD_API_KEY`) and Twelve Data (`TWELVE_DATA_API_KEY`) only if FMP/AV leave material ASX holes and Ben approves pricing/licensing.
6. Never-by-default: MarketIndex, TradingView, and Morningstar scraping. Keep them as human links/comparison pages unless a formal data permission is obtained.

## Credential requests

| Provider | Env var | Minimum Ben action | Minimum access | Stage | Notes |
| --- | --- | --- | --- | --- | --- |
| Financial Modeling Prep | `FMP_API_KEY` | Create key and store in Vaultwarden `homelab` folder as `homelab|investment-screener/fmp|api_key|FMP_API_KEY` | Fundamentals statements for ASX symbols; confirm private dashboard storage terms | 1 | Recommended first optional key |
| Alpha Vantage | `ALPHA_VANTAGE_API_KEY` | Create key and store as `homelab|investment-screener/alpha-vantage|api_key|ALPHA_VANTAGE_API_KEY` | Fundamental Data functions for ASX symbols | 1b | Spot-fill/rate-limited fallback |
| EODHD | `EODHD_API_KEY` | Approve provider/cost/licensing, then add Vaultwarden item | Fundamentals feed with ASX exchange support | 2 | Not currently in env map; add only after approval |
| Twelve Data | `TWELVE_DATA_API_KEY` | Approve plan with fundamentals access, then add Vaultwarden item | Pro-or-higher fundamentals endpoints for ASX | 2 | Keep no-key usage to identity validation |

No provider key belongs in Git, command history, provenance URLs, dashboard exports, or committed `.env` files. Apparently secrets remain bad when they are Australian. Annoying, but consistent.

## Risks and controls

| Risk | Control |
| --- | --- |
| Provider data disagrees with Yahoo/source reports | Keep selected value plus alternates/conflicts; prefer source-of-record filings for verification; never average provider soup |
| FMP docs/pricing blocked to workers | Treat pricing/field-depth as needs-confirmation at key creation; make adapter fail closed and observable |
| Alpha Vantage or Twelve Data quota starvation | Enforce per-run provider budgets and record rate-limit/plan-limit missing reasons |
| Financial-sector metrics mislead rankings | Sector-aware caveats; do not score banks/insurers on industrial current ratio/debt heuristics without caps |
| Scraping consumer pages creates ToS/fragility problems | No automated public-page scraper jobs; use manual links or approved APIs only |
| Provenance leaks API keys | Strip `apikey`, `api_key`, `access_token`, `key`, and `token` query params before persistence |
| Full-universe run overstates coverage | Continue batched expansion gates and denominator reports from the ASX universe spec |

## Implementation handoff summary

For the next provider-adapter implementation task, the document-backed order is:

```json
{
  "provider_order": ["yahoo", "asx_reports_targeted_verification", "fmp_optional", "alpha_vantage_optional", "eodhd_deferred", "twelve_data_deferred"],
  "no_credential_first": [
    "yahoo_retry_backoff_jitter",
    "field_level_missing_reason",
    "seed_identity_fields_in_exports",
    "targeted_asx_report_links_for_stale_or_high_interest_companies"
  ],
  "credential_requests": {
    "FMP_API_KEY": "first optional fill-only provider; Ben stores key in Vaultwarden homelab folder",
    "ALPHA_VANTAGE_API_KEY": "secondary spot-fill provider; already documented in env map",
    "EODHD_API_KEY": "deferred paid/licensed fundamentals feed",
    "TWELVE_DATA_API_KEY": "deferred fundamentals plan; no-key endpoint stays identity validation only"
  },
  "current_missingness_priorities": [
    "operating_cash_flow",
    "fcf",
    "fcf_margin",
    "cash_and_equivalents",
    "total_debt",
    "current_assets_current_liabilities_for_financials",
    "stale_excluded_EVN_WTC"
  ],
  "do_not_automate": ["MarketIndex scraper", "TradingView scraper", "Morningstar scraper", "bulk ASX PDF OCR without separate approval"]
}
```

## Sources

[1] https://query1.finance.yahoo.com/v8/finance/chart/BHP.AX?range=1d&interval=1d — Yahoo chart sample BHP.AX
[2] https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/BHP.AX?type=annualTotalRevenue,annualNetIncome,annualOperatingCashFlow,annualCapitalExpenditures,annualTotalAssets,annualTotalLiabilitiesNetMinorityInterest,annualCurrentAssets,annualCurrentLiabilities&period1=0&period2=9999999999 — Yahoo fundamentals-timeseries sample BHP.AX
[3] https://www.asx.com.au/markets/trade-our-cash-market/announcements — ASX announcements search
[4] https://www.asx.com.au/markets/company/BHP — ASX company page BHP
[5] https://www.alphavantage.co/documentation — Alpha Vantage documentation
[6] https://www.alphavantage.co/premium — Alpha Vantage premium pricing
[7] https://site.financialmodelingprep.com/developer/docs/stable — FMP stable docs
[8] https://site.financialmodelingprep.com/pricing-plans — FMP pricing
[9] https://eodhd.com/financial-apis/stock-etfs-fundamental-data-feeds — EODHD fundamentals docs
[10] https://eodhd.com/pricing — EODHD pricing
[11] https://twelvedata.com/docs — Twelve Data docs fundamentals
[12] https://twelvedata.com/pricing — Twelve Data pricing
[13] https://api.twelvedata.com/stocks?exchange=ASX — Twelve Data ASX stock list
[14] https://www.marketindex.com.au/asx/bhp — MarketIndex BHP page
[15] https://www.marketindex.com.au/asx-listed-companies — MarketIndex ASX companies
[16] https://www.tradingview.com/symbols/ASX-BHP — TradingView ASX BHP symbol
[17] https://www.morningstar.com.au/investments/security/asx/bhp — Morningstar Australia BHP quote
[18] https://www.marketindex.com.au/robots.txt — MarketIndex robots
[19] https://www.tradingview.com/robots.txt — TradingView robots
[20] https://www.morningstar.com.au/robots.txt — Morningstar AU robots
[21] https://www.asx.com.au/robots.txt — ASX robots
[22] https://financialmodelingprep.com/stable/quote?symbol=BHP.AX&apikey=demo — FMP quote demo BHP.AX
[23] https://financialmodelingprep.com/stable/key-metrics-ttm?symbol=BHP.AX&apikey=demo — FMP key metrics TTM demo BHP.AX
[24] https://financialmodelingprep.com/stable/income-statement?symbol=BHP.AX&period=annual&limit=2&apikey=demo — FMP income statement demo BHP.AX
[25] https://financialmodelingprep.com/stable/balance-sheet-statement?symbol=BHP.AX&period=annual&limit=2&apikey=demo — FMP balance sheet demo BHP.AX
[26] https://financialmodelingprep.com/stable/cash-flow-statement?symbol=BHP.AX&period=annual&limit=2&apikey=demo — FMP cash flow demo BHP.AX
[27] https://www.alphavantage.co/query?function=OVERVIEW&symbol=BHP.AX&apikey=demo — Alpha overview demo BHP.AX
[28] https://www.alphavantage.co/query?function=INCOME_STATEMENT&symbol=BHP.AX&apikey=demo — Alpha income statement demo BHP.AX
[29] https://eodhd.com/api/fundamentals/BHP.AU?api_token=demo&fmt=json — EODHD fundamentals demo BHP.AU
[30] https://api.twelvedata.com/income_statement?symbol=BHP&exchange=ASX — Twelve Data income statement no key BHP
[31] https://api.twelvedata.com/balance_sheet?symbol=BHP&exchange=ASX — Twelve Data balance sheet no key BHP
[32] https://api.twelvedata.com/cash_flow?symbol=BHP&exchange=ASX — Twelve Data cash flow no key BHP
