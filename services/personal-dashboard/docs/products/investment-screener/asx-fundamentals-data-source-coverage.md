# ASX Fundamentals — Data-Source Coverage Options

> Research note for the Investment Screener provider-fallback lane.
> Task `t_a8b454bb`. Research/documentation only — no credentials, no live provider code, no sign-ups.
> Verification status is recorded per source: "verified live" = fetched during this task; "vendor-documented" = from published pricing/docs, not re-fetched (some sites CloudFront/WAF-block bots).

## 1. Problem statement

The screener currently hydrates ASX fundamentals from two Yahoo Finance endpoints only:

- `query1.finance.yahoo.com/v8/finance/chart/{ticker}` — price/currency/name.
- `query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{ticker}` — annual statement fields.

Yahoo returns a subset of fields for a subset of ASX names, can throttle, and is unofficial for this use. The goal is to (a) fill missing fields per company, and (b) increase the number of ASX companies with usable fundamentals — without introducing a credential dependency before it is justified.

The fields that matter to the scorer (see `DERIVED_INPUTS` / `YAHOO_FIELD_TYPES` in `screener.py`):

`market_cap`, `pe_ratio`, `price_to_sales`, `net_margin`, `roe`, `fcf`, `fcf_margin`, `revenue_growth`, `current_ratio`, `debt_to_assets`, plus the raw statement inputs they derive from: `current_assets`, `current_liabilities`, `total_assets`, `total_liabilities` (debt/assets), `operating_cash_flow`, `capital_expenditures` (capex/FCF).

## 2. Source comparison

Legend for field-coverage column:
- **quote** = price/shares/market cap
- **inc** = income statement (revenue, net income)
- **bal** = balance sheet (assets, liabilities, current assets/liabilities)
- **cf** = cash flow (operating cash flow, capex)
- **ratios** = pre-computed ratios (PE, P/S, net margin, ROE, FCF, current ratio, debt/assets)

| Source | Fields | ASX coverage | Freshness | Method | Cost / free tier | Auth | Terms / robots risk | Rate limits | Reliable? | Homelab-automatable? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Yahoo Finance** (current path) | quote + inc + bal + cf (via fundamentals-timeseries) | Good for large caps; gaps for smaller/delisted names; field availability varies | Intraday quotes; annual fundamentals lag to filing | `urllib` against unofficial JSON endpoints | Free, no key | None | Unofficial; no SLA; may throttle/change shape. Respectful pacing required | Unpublished; can 429 | Moderate; already built, has gaps | Yes (already implemented) |
| **Alpha Vantage** | quote + inc + bal + cf + some ratios (`OVERVIEW`: market cap, PE, P/S TTM, profit margin, ROE TTM) | ASX ordinary shares covered; per-symbol `OVERVIEW`/`INCOME_STATEMENT`/`BALANCE_SHEET`/`CASH_FLOW` | End-of-day + fundamentals | REST API (key in query string) | Free: 25 requests/day (verified live); premium from $49.99/mo | Free API key required | Keyed API; standard ToS. No scraping | 25/day free, 75 req/min at lowest paid tier | Good | Yes — but 25/day free makes batch top-50 impractical without a paid tier |
| **Financial Modeling Prep (FMP)** | quote + inc + bal + cf + rich **ratios** (key-metrics-TTM: PE, P/S, net margin, ROE, FCF, current ratio, debt/assets, market cap) | Strong ASX ordinary-share coverage | End-of-day + fundamentals; TTM ratios | REST API (key) | Free: 250 API calls/day (vendor-documented); paid tiers from ~$19–$30/mo | Free API key required | Keyed API. CloudFront WAF blocks bots on docs site (verified live 403) — API itself is keyed, not scraped | 250/day free | Good | Yes — best field-coverage-per-request of the free credentialed set |
| **Twelve Data** | quote + inc + bal + cf + ratios (fundamentals is a separate subscription/add-on) | ASX coverage present | End-of-day; fundamentals separate feed | REST API (key) | Free: 8 requests/min, ~800 credits/day (verified live); Grow from $29/mo | Free API key required | Keyed API; fundamentals gated behind higher plans | 8 req/min free (800 credits/day) | Good | Yes, but fundamentals likely not on free tier |
| **EOD Historical Data (EODHD)** | quote + inc + bal + cf + ratios via "Fundamental Data" feed | ASX covered | End-of-day + fundamentals | REST API (key) | Free: 20 API calls/day (vendor-documented); Fundamentals feed $59.99/mo | Free API key required | Keyed API; fundamentals is a separate paid feed | 20/day free | Good | Yes, but fundamentals require the paid feed |
| **ASX announcements / company reports** | Primary source: annual/half-year reports (PDF/HTML). All raw statement numbers, but unstructured | Full ASX (every listed company) | Filing-timed | ASX announcements page + MarkitDigital directory API (already in repo) | Free | None | Primary filings; no scraping needed for directory CSV; announcement pages are dynamic | Low/gentle | High (source of record) but **structuring is hard** (PDF/table extraction) | Partially — verification lane only, not bulk numeric fill |
| **MarketIndex (public page)** | Screen-level fundamentals on ASX company pages | ASX-focused | Delayed | HTML scraping | Free | None | **CloudFront 403 to bots (verified live)**; scraping ToS risk | n/a (blocked) | Low | No — blocked + ToS risk |
| **TradingView (public page)** | Fundamentals widget on symbol pages (PE, P/S, ROE, etc.) | ASX covered | Delayed | HTML/JS-heavy scraping | Free | None | JS-rendered; scraping against ToS; fragile selectors | n/a | Low | No — ToS risk, fragile |
| **Company annual report PDFs** | Full financials (inc/bal/cf), definitive | Only companies you fetch | Filing-timed | Download + OCR/table extraction | Free | None | Primary docs; do not bulk-hammer issuer sites | n/a | High (authoritative) but extraction error-prone | Manual/semi-auto only — not a bulk fill |

## 3. Which sources can fill the required fields

| Field | Yahoo (current) | Alpha Vantage | FMP | Twelve Data | EODHD | ASX reports |
| --- | --- | --- | --- | --- | --- | --- |
| market_cap | yes (price × shares) | yes (`OVERVIEW.MarketCapitalization`) | yes | yes | yes | derivable |
| pe_ratio | yes (derived) | yes (`PERatio`) | yes (TTM) | yes | yes | derivable |
| price_to_sales | yes (derived) | yes (`PriceToSalesRatioTTM`) | yes | yes | yes | derivable |
| net_margin | yes (derived) | yes (`ProfitMargin`) | yes | yes | yes | derivable |
| roe | yes (derived) | yes (`ReturnOnEquityTTM`) | yes | yes | yes | derivable |
| fcf | yes (OCF + capex) | yes (via `CASH_FLOW`) | yes | yes | yes | yes |
| fcf_margin | yes (derived) | derivable | yes | derivable | derivable | derivable |
| revenue_growth | yes (revenue vs prior) | derivable (multi-year) | yes | yes | yes | yes |
| current_ratio | yes (derived) | derivable (`BALANCE_SHEET`) | yes | yes | yes | derivable |
| debt_to_assets | yes (derived) | derivable | yes | yes | yes | derivable |
| current_assets / current_liabilities | yes | yes (`BALANCE_SHEET`) | yes | yes | yes | yes |
| total_debt / total_assets | yes | yes | yes | yes | yes | yes |
| capex / OCF | yes | yes (`CASH_FLOW`) | yes | yes | yes | yes |

**Bottom line:** Yahoo already covers the raw fields *where it returns them*. The real gap is **coverage breadth + reliability**, not field taxonomy. The strongest no-new-cost fill is a *second free credentialed provider that supplies pre-computed ratios*, which cross-checks Yahoo and fills Yahoo-missing names. FMP is the best fit on field coverage per free request; Alpha Vantage is the cheapest-but-most-throttled fallback.

## 4. Staged recommendation

### Stage 0 — no-credential improvements (do now, no sign-up)

1. **Keep Yahoo as the base provider.** Add per-request retry/backoff/jitter (already planned in the audit doc, not yet implemented) so transient 429s stop surfacing as permanent missing fields.
2. **Broaden the universe input** from the 10-name watchlist to the 1,838-name `asx-listed-companies.seed.json` with bounded top-N batches (separate hydration task handles this — `t_9d2e46ba`).
3. **Add a per-field "missing reason" that distinguishes provider-absent from fetch-failed from not-applicable**, so downstream scoring never conflates a throttled fetch with a genuinely unreported metric.
4. **ASX announcements lane (manual/semi-auto only):** store report URLs and extraction status for high-interest candidates as the source-of-record verification path — never as a bulk numeric fill.

### Stage 1 — one optional credentialed provider (needs Ben to fetch a key)

Recommended first credentialed provider: **Financial Modeling Prep (FMP)**.

- Rationale: richest pre-computed ratios per request (fills every scorer field directly), ~250 free calls/day is enough for a top-50 batch in one pass with headroom, ASX ordinary-share coverage is good, and a single key covers all endpoints.
- Fail-closed scaffold: an FMP adapter that is **disabled unless** the key is present in config/env. No key = adapter skipped, Yahoo remains the sole source, missing stays missing.

Fallback alternative if Ben prefers lowest cost: **Alpha Vantage** free key, but its 25/day cap makes it a spot-fill only (a handful of names per run), not a batch source.

### Stage 2 — deferred (only after Stage 1 proves value)

- **EODHD Fundamentals feed** ($59.99/mo) or **Twelve Data fundamentals** — only if FMP coverage turns out to have specific ASX holes and Ben approves the spend.
- Any **paid tier** requires explicit Ben approval on provider, credentials, licensing, and storage terms (per the architecture spec decision gate).

## 5. Exact credential/access requests (if Ben opts in)

| Provider | Minimum permission/scope | Estimated cost | Env var (proposed) | Notes |
| --- | --- | --- | --- | --- |
| Financial Modeling Prep | Free API key (fundamentals + ratios endpoints) | $0 (free tier, 250 calls/day) | `FMP_API_KEY` | Store in Vaultwarden `homelab` folder, not in repo |
| Alpha Vantage | Free API key | $0 (25 calls/day) or $49.99/mo (75 req/min) | `ALPHA_VANTAGE_API_KEY` | Spot-fill only at free tier |
| EODHD | Free key + Fundamentals feed | $59.99/mo (feed) | `EODHD_API_KEY` | Deferred |
| Twelve Data | Free key + fundamentals plan | $0 basic / Grow $29/mo | `TWELVE_DATA_API_KEY` | Deferred |

**No secrets are to be committed.** Keys belong in Vaultwarden (`homelab` folder) and are injected as runtime env vars. Git stores only the env-var name and the provider name.

## 6. Implementation recommendations

1. Introduce a **provider-adapter registry** keyed by provider name, each adapter returning the same normalized `FieldValue` shape with `provenance.source_family` set to the provider (e.g. `fmp`, `alpha_vantage`) and a `trust_level` of `licensed` (distinct from Yahoo's `bootstrap_unofficial`).
2. **Merge/fallback semantics:** for each field, prefer the highest-trust non-missing value, but **record every source's value in provenance** rather than silently overwriting. A field filled by FMP when Yahoo was missing must carry FMP provenance + `retrieved_at` + `data_as_of`.
3. **Fail-closed by default:** every credentialed adapter is a no-op (returns `unavailable`) unless its key/config is present. Missing credential must not raise, must not fabricate, and must not fall back to scraping.
4. **Do not fabricate:** a field that no configured source can supply remains `missing`/`unavailable` with an explicit reason string.
5. **Rate-limit handling:** respect provider rate limits with backoff; treat 429/402 as `partial` run states, not hard failures.

## 7. Risks

- **Provider ToS / licensing:** FMP and Alpha Vantage free tiers allow local storage for private personal use, but *redistribution* of derived datasets is restricted — fine for a private dashboard, but do not assume re-publication rights. (Verify current ToS at key-creation time.)
- **Scraping sources are out:** MarketIndex (CloudFront 403) and TradingView (JS + ToS) are not viable or safe to automate. Do not build adapters for them.
- **Rate-limit starvation:** Alpha Vantage free (25/day) is a trap for batch work — it will look like a working source but silently starve a top-50 run. Guard any AV adapter with a hard per-run budget.
- **Accounting normalization:** provider-computed ratios may not match the screener's own derived definitions (e.g. FCF sign conventions, minority-interest treatment in `total_liabilities`). Cross-check provider ratios against Yahoo-derived values before trusting a mismatch.
- **Credential lifecycle:** a hardcoded or committed key would be an incident; keys must come from Vaultwarden/runtime env only.

## 8. Implementation status

> Task `t_00434aef`. Code/test/config-example change only — no live hydration, no cron changes, no deploy.

The staged provider-fallback framework described in §4 and §6 is implemented in `investment-screener/screener.py`:

- `ProviderAdapter` base class — fail-closed (returns no fields, no network) when its credential is absent.
- `FmpAdapter` (recommended Stage 1) and `AlphaVantageAdapter` (spot-fill) — normalize income/balance/cash-flow statements into the same raw `FieldValue` shape Yahoo produces, with `source_family`, `trust_level: licensed`, `data_as_of`, and `retrieved_at` provenance.
- `missing_field_value`, `merge_missing_fields`, `build_fallback_adapters`, `fill_company_missing_fields` — merge fallback values into missing raw fields only (never overwrite present values), prefer the highest-trust provider, and mark still-missing fields `missing_reason: unavailable`.
- Rate-limit (429) and other fetch failures degrade to "no data" (partial run state), never to fabricated values.

Credentials come only from runtime env vars `FMP_API_KEY` / `ALPHA_VANTAGE_API_KEY` (Vaultwarden `homelab` folder; see `personal-dashboard.env.map.example`). With no credentials configured, `build_fallback_adapters` returns an empty list and Yahoo remains the sole source — missing stays missing.

To enable Stage 1, Ben fetches a free FMP API key and stores it in Vaultwarden; no code change is required beyond injecting the env var at runtime. The adapters remain disabled until then.
