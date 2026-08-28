# Current ASX coverage and fundamentals missingness audit — 2026-08-28

> Kanban task `t_0b9ea721`. Read-only/documentation audit. No live hydration, latest-pointer mutation, scheduler creation, credential change, or deploy was performed.

## Scope and evidence checked

Repo/code/docs checked:

- `investment-screener/screener.py` — ASX universe selection, Yahoo bootstrap hydration, raw/derived fields, scoring, Postgres writer, staged provider fallback hooks.
- `src/investment-screener-storage.js` — file-first publisher/reader, manifest/latest pointer layout, DuckDB summary, company-detail field presentation.
- `src/server.js` — dashboard API read order for report, coverage, ranked, and company detail endpoints.
- `scripts/run-asx-screener-hydration.sh` and `scripts/run-asx-screener-hydration-owner.sh` — canonical workflow and scheduled owner wrapper.
- Existing product docs under `docs/products/investment-screener/`, especially scheduler ownership and data-source coverage notes.
- Cron stores for the default, sentinel, kobold, domovoi, gremlin, and scribe Hermes profiles.

Storage roots checked:

| Root | Result |
| --- | --- |
| `/mnt/pve/NAS/services/personal-dashboard` | Canonical ASX file-first tree present; latest pointer and dashboard exports exist. |
| `/mnt/nas/services/personal-dashboard` | Directory exists on this host but no ASX latest pointer/export under it. This matches the tori path-split warning: `/mnt/pve/NAS` is the NAS mount used by the owner wrapper. |
| `/var/lib/personal-dashboard/runtime-cache` | Not present in this worker namespace. Live dashboard uses a host-local runtime cache on critical; not directly visible here. |
| Repo checkout `services/personal-dashboard` | Code/docs/seeds present; no canonical generated run tree committed, as expected. |

Verification commands/checks run:

- `date -u +%Y-%m-%dT%H:%M:%SZ` → `2026-08-28T04:54:28Z`.
- `node scripts/preflight-investment-screener-artifacts.mjs --data-root /mnt/pve/NAS/services/personal-dashboard --market ASX --source yahoo-finance --max-generated-age-hours 26` → `ok: true` for the latest run.
- Local `createApp()` harness against the canonical data root for `/api/investment-screener/coverage`, `/ranked`, and `/company/:ticker` behavior.
- Direct network probes to `192.168.0.50:4322` and `172.17.0.1:4322` from this worker namespace refused; this is consistent with the dashboard not being LAN-published and the Docker bridge address not being reachable from here. API behavior below is therefore code-level/local-harness verification, not live Traefik verification.

## Current latest run

| Field | Value |
| --- | --- |
| Run ID | `investment-screener_ASX_asx-yahoo-timeseries_2026-08-27T134633Z_702240d2431e` |
| Latest pointer | `investment-screener/manifests/market=ASX/source=yahoo-finance/latest.json` under the NAS root |
| Manifest | `investment-screener/runs/market=ASX/source=yahoo-finance/mode=asx-yahoo-timeseries/run_date=2026-08-27/investment-screener_ASX_asx-yahoo-timeseries_2026-08-27T134633Z_702240d2431e/manifest.json` |
| Market/source/mode | `ASX` / `yahoo-finance` / `asx-yahoo-timeseries` |
| Fixture | `false` |
| Completed/generated | `2026-08-27T13:46:33.012Z` / `2026-08-27T13:46:33.255Z` |
| Latest provider retrieval | `2026-08-27T13:46:33.000Z` |
| Data as of | `2026-08-27` |
| Freshness at audit time | About 15.2 hours old; preflight still inside the 26h threshold. |
| Universe denominator | Top 50 ASX listings by market cap from the ASX company-directory seed. |
| Full seed size | 1,838 active entries; seed retrieved `2026-08-23T05:47:51Z`; source sha256 `a44aa810526fc4122c8fb2feee9a5f3dfbe5f3584b98c0f934cf3055758d4123`. |
| Coverage | 50 scraped / 50 scores / 48 usable / 2 excluded / 2 failed = 96.0% usable. |
| Provenance | 1,056 provenance rows; source families `yahoo-finance` and `derived`. |
| Artifacts | companies, observations, scores, provenance, coverage, failures, exclusions, ranked candidates, Parquet companions, `checksums.sha256`, and dashboard exports are present. |

The current run is therefore the expected bounded top-50 non-fixture ASX run, not a fixture and not a full-exchange run. Good. The annoying part, because there is always one: the run is only as good as Yahoo's public ASX fundamentals coverage.

## Field-level missingness

Counts below are across the 50 tracked companies in the latest run. `missing_null` means the observation row exists but the value is null. `absent` means the field is not emitted for that ticker, usually because the ticker was excluded before derived metrics were created.

| Field | Present | missing_null | absent | Missing total | Main missing tickers / pattern |
| --- | ---: | ---: | ---: | ---: | --- |
| `market_cap` | 48 | 0 | 2 | 2 | Absent for excluded `EVN.AX`, `WTC.AX`. |
| `pe_ratio` | 48 | 0 | 2 | 2 | Absent for excluded `EVN.AX`, `WTC.AX`. |
| `price_to_sales` | 48 | 0 | 2 | 2 | Absent for excluded `EVN.AX`, `WTC.AX`. |
| `net_margin` | 48 | 0 | 2 | 2 | Absent for excluded `EVN.AX`, `WTC.AX`. |
| `roe` | 47 | 1 | 2 | 3 | `CSL.AX` null; absent for excluded `EVN.AX`, `WTC.AX`. |
| `fcf` | 17 | 31 | 2 | 33 | Broadly missing where Yahoo lacks `operating_cash_flow`; absent for excluded `EVN.AX`, `WTC.AX`. |
| `fcf_margin` | 17 | 31 | 2 | 33 | Same pattern as `fcf`. |
| `revenue_growth` | 48 | 0 | 2 | 2 | Absent for excluded `EVN.AX`, `WTC.AX`. |
| `current_ratio` | 41 | 7 | 2 | 9 | Null for financial/insurance names `ANZ.AX`, `CBA.AX`, `IAG.AX`, `NAB.AX`, `QBE.AX`, `SUN.AX`, `WBC.AX`; absent for excluded `EVN.AX`, `WTC.AX`. |
| `debt_to_assets` | 48 | 0 | 2 | 2 | Uses total liabilities / total assets; absent for excluded `EVN.AX`, `WTC.AX`. |
| `total_assets` | 48 | 2 | 0 | 2 | Null for `EVN.AX`, `WTC.AX`. |
| `current_assets` | 41 | 9 | 0 | 9 | Financial/insurance names plus `EVN.AX`, `WTC.AX`. |
| `total_liabilities` | 48 | 2 | 0 | 2 | Null for `EVN.AX`, `WTC.AX`. |
| `current_liabilities` | 41 | 9 | 0 | 9 | Financial/insurance names plus `EVN.AX`, `WTC.AX`. |
| `operating_cash_flow` | 18 | 32 | 0 | 32 | Biggest raw-field gap; mostly Yahoo fundamentals-timeseries absence for ASX names. |
| `capital_expenditures` | 45 | 5 | 0 | 5 | Null for `ANZ.AX`, `EVN.AX`, `IAG.AX`, `SUN.AX`, `WTC.AX`. |
| `cashflow` | 0 | 0 | 50 | 50 | No aggregate field named `cashflow` exists; the implemented fields are `operating_cash_flow` and `capital_expenditures`. |
| `debt` / `total_debt` | 0 | 0 | 50 | 50 | No separate debt field exists; `debt_to_assets` currently proxies leverage as total liabilities / total assets. |

Existing extra fields emitted by the latest run:

- Raw: `price`, `shares_outstanding`, `revenue`, `prior_revenue`, `net_income`, `operating_cash_flow`, `capital_expenditures`, `total_assets`, `total_liabilities`, `current_assets`, `current_liabilities`.
- Derived: `market_cap`, `pe_ratio`, `price_to_sales`, `net_margin`, `roe`, `current_ratio`, `debt_to_assets`, `equity`, `fcf`, `fcf_margin`, `revenue_growth`.
- Score/API fields: `composite_score`, `quality`, `valuation`, `growth`, `graham_safety`, `durability`, and `risk_adjustments` in score subfields; company-detail API also exposes unsupported placeholders for identity enrichment, dividends, EPS, and earnings date.

## Missingness diagnosis

### Provider absence / stale source data

- `EVN.AX` and `WTC.AX` are the only fully unusable companies. They are excluded because required recent financial fields are stale beyond the screener's 730-day hard-exclusion threshold. The null raw observations then cascade into absent derived valuation/quality fields.
- Most companies have quote, shares, revenue, prior revenue, net income, total assets, and total liabilities. Yahoo is good enough there for the current top-50 batch.
- `operating_cash_flow` is the major provider-absence gap: 32/50 null. Because `fcf` and `fcf_margin` derive from operating cash flow plus capex, those derived fields collapse to only 17/50 present.

### Sector-specific accounting

- Current assets/current liabilities are missing for several financials/insurers: `ANZ.AX`, `CBA.AX`, `IAG.AX`, `NAB.AX`, `QBE.AX`, `SUN.AX`, `WBC.AX`. This is likely sector/accounting shape rather than a generic parser failure; banks and insurers often report liquidity and balance-sheet structure differently from industrial companies.
- The current `debt_to_assets` label is mildly misleading for financials: implementation uses total liabilities / total assets, not interest-bearing debt / total assets. It is still useful as a leverage proxy, but not a clean Graham-style debt metric.

### Parser/normalizer gaps

- No evidence of a broad parser failure for the currently requested Yahoo field names: observation rows exist for all raw fields, and values are present where Yahoo returns them.
- However, no aggregate `cashflow`, `debt`, or `total_debt` field is normalized today. If downstream tasks require debt rather than total liabilities, this needs a schema/normalizer addition.
- `current_ratio` is absent rather than null for excluded tickers because derived metrics are not emitted when a row is hard-excluded. That is defensible, but the detail API presents those fields as unavailable rather than explicitly stale/excluded; a future API polish could expose the exclusion reason alongside field state.

### Ticker/company identity mismatch

- No obvious `.AX` identity mismatch surfaced in the latest run: 50 companies were scraped and scored rows exist for 50 tickers.
- The top-50 seed contains CDI/share-class cases such as `NEM.AX` and `NWSLV.AX`; they hydrate successfully, but they deserve source-of-record review before any future full-exchange claims.
- Identity enrichment is still not carried through to company-detail API output: exchange, region, sector, and industry are marked unavailable even though the seed has those fields. That is a dashboard/export presentation gap, not provider absence.

### Dashboard/API presentation

- The local app harness returns 401 for unauthenticated API calls, then returns 200 for authenticated coverage/ranked/company detail when configured with the expected proxy header. The coverage and ranked APIs read the canonical DuckDB/file-first path and report 48/50 coverage.
- The coverage API reports `stale: 0` in the normalized coverage object while nested `freshness.stale` is `false`. That is a type/presentation wart from historical coverage normalization: not blocking for truthfulness, but worth cleaning so `stale` is consistently boolean.
- `source_summary.provenance_fields` is null in the API coverage payload even though the manifest has provenance rows; the dashboard can still explain sources, but it does not currently expose the distinct provenance-field count.
- Direct probes to the live backend addresses from this worker namespace refused, so this audit does not independently prove current Traefik/live-container availability. Previous live verification did; this task did not mutate or restart anything to re-check it.

## Provider fallback and scheduler ownership

Provider fallback hooks exist in code:

- `ProviderAdapter` base class.
- `FmpAdapter` gated by `FMP_API_KEY`.
- `AlphaVantageAdapter` gated by `ALPHA_VANTAGE_API_KEY`.
- `build_fallback_adapters`, `merge_missing_fields`, and `fill_company_missing_fields`.
- Credential names are documented in `personal-dashboard.env.map.example` and `asx-fundamentals-data-source-coverage.md`.

Important catch: the active `main()` hydration path does not call `build_fallback_adapters()` / `fill_company_missing_fields()`. The hooks are staged and tested, but not wired into the recurring Yahoo run. No fallback-filled values appear in the current latest manifest; provenance sources are only `yahoo-finance` and `derived`.

Scheduler ownership:

- Default Hermes profile has exactly one enabled ASX owner job: `asx-screener-hydration` / `6bffd5f6fff6`, schedule `0 8 * * 6`, no-agent, script `run-asx-screener-hydration-owner.sh`, deliver target `discord:#👟-hermes-👟`.
- Kobold profile has legacy fixture job `11727e7f850f` (`ASX screener fixture run`) with `enabled: false`, deliver `local`.
- Sentinel, domovoi, and scribe profile cron stores are absent; gremlin's cron store exists but no ASX/screener job was found.

## Recommended next implementation targets

1. Wire the staged fallback adapters into the active hydration path behind explicit env-gated configuration. Start with FMP as a fill-only provider for missing raw fields; keep Yahoo as the base and never overwrite present Yahoo values until conflict-resolution policy is reviewed.
2. Add field-level missingness/reason output to the generated coverage artifacts, not just per-company caveats. The run already has the observation rows; the missingness table above should become machine-generated.
3. Add `total_debt` / `cash_and_equivalents` only if a provider can supply them reliably; then rename or clarify `debt_to_assets` if it remains total-liabilities-based.
4. Carry seed identity fields (`exchange`, `region`, `sector`, `industry`) into the file-first company artifacts and company-detail API, with sanitization. That fixes a presentation/export gap without needing provider egress.
5. Add sector-aware scoring/field expectations for banks, insurers, and diversified financials. Current ratio and liability-heavy leverage heuristics are crude for those names.
6. Normalize dashboard coverage booleans (`stale`) and expose a non-null `provenance_fields` count.
7. Keep full-ASX expansion gated. The current latest run is top-50 only; it should not be marketed as whole-exchange coverage until batched expansion plus scheduler/storage capacity is proven.

## Machine-readable audit summary

```json
{
  "audit_task": "t_0b9ea721",
  "latest_run_id": "investment-screener_ASX_asx-yahoo-timeseries_2026-08-27T134633Z_702240d2431e",
  "company_count": 50,
  "usable_count": 48,
  "excluded_count": 2,
  "failed_count": 2,
  "mode": "asx-yahoo-timeseries",
  "source": "yahoo-finance",
  "fixture": false,
  "denominator_status": "ranked_market_cap_batch",
  "full_seed_count": 1838,
  "storage_root_with_latest": "/mnt/pve/NAS/services/personal-dashboard",
  "missingness_by_field": {
    "market_cap": {"present": 48, "missing_total": 2},
    "pe_ratio": {"present": 48, "missing_total": 2},
    "price_to_sales": {"present": 48, "missing_total": 2},
    "net_margin": {"present": 48, "missing_total": 2},
    "roe": {"present": 47, "missing_total": 3},
    "fcf": {"present": 17, "missing_total": 33},
    "fcf_margin": {"present": 17, "missing_total": 33},
    "revenue_growth": {"present": 48, "missing_total": 2},
    "current_ratio": {"present": 41, "missing_total": 9},
    "debt_to_assets": {"present": 48, "missing_total": 2},
    "total_assets": {"present": 48, "missing_total": 2},
    "current_assets": {"present": 41, "missing_total": 9},
    "total_liabilities": {"present": 48, "missing_total": 2},
    "current_liabilities": {"present": 41, "missing_total": 9},
    "operating_cash_flow": {"present": 18, "missing_total": 32},
    "capital_expenditures": {"present": 45, "missing_total": 5},
    "cashflow": {"present": 0, "missing_total": 50, "note": "field not implemented; use operating_cash_flow/capital_expenditures"},
    "debt": {"present": 0, "missing_total": 50, "note": "field not implemented; debt_to_assets currently uses total liabilities / total assets"}
  }
}
```
