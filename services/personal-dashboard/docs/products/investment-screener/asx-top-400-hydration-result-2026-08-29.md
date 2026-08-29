# ASX top-400 hydration result — 2026-08-29

> Supervised manual expansion from the existing Yahoo Finance ASX hydration path. This run updated the NAS-backed latest pointer and dashboard export. Ben explicitly chose not to rollback the pointer after the run missed the rollout coverage gate.

## Command run

```bash
cd /root/work/home-lab
ASX_BATCH_OFFSET=0 \
ASX_BATCH_SIZE=400 \
ASX_SLEEP_SECONDS=0.75 \
INVESTMENT_SCREENER_DATA_ROOT=/mnt/pve/NAS/services/personal-dashboard \
ASX_CACHE_DIR=/var/lib/personal-dashboard/asx-provider-cache \
services/personal-dashboard/scripts/run-asx-screener-hydration-owner.sh
```

## Result

| Field | Value |
| --- | --- |
| Run ID | `investment-screener_ASX_asx-yahoo-timeseries_2026-08-29T015127Z_5871117f2bec` |
| Source / mode | `yahoo-finance` / `asx-yahoo-timeseries` |
| Universe slice | Offset 0, size 400 |
| Full seed size | 1,838 active ASX entries |
| Denominator label | `top 400 ASX listings by Market Cap from ASX company directory seed` |
| Coverage | 342 usable / 400 denominator = 85.5% |
| Failed / excluded | 58 failed, 58 excluded |
| Run directory size | 4.8 MiB |
| Latest pointer | `/mnt/pve/NAS/services/personal-dashboard/investment-screener/manifests/market=ASX/source=yahoo-finance/latest.json` |
| Preflight | Passed: required artifacts, checksums, freshness, dashboard exports present |
| Provenance sources | `yahoo-finance`, `derived` only |
| Documented at | 2026-08-29T01:53:13Z |

## Gate outcome

The top-400 rollout gate did **not** pass.

The rollout plan required at least 88% usable coverage for the top-400 supervised expansion. This run reached 85.5%. Failed/excluded count was 58/400 = 14.5%, just under the 15% stop threshold, but the usable coverage threshold is enough to stop. Do not proceed to full-seed hydration from Yahoo-only coverage without either accepting the lower coverage explicitly or adding another provider/source.

## Failure pattern

The failures are mostly provider/source gaps rather than command/runtime failures:

- 36 tickers: revenue, net income, total assets, and total liabilities stale beyond the 730-day hard-exclusion threshold.
- 7 tickers: net income, total assets, and total liabilities stale beyond 730 days.
- 7 tickers: missing price or shares outstanding, preventing market cap and valuation scoring.
- 4 tickers: revenue stale beyond 730 days.
- Remaining cases: smaller stale-field combinations, including operating cash flow.

Sample affected tickers from `failures.jsonl` / `exclusions.jsonl`: `EVN.AX`, `WTC.AX`, `MIN.AX`, `GGP.AX`, `CMM.AX`.

## Pointer decision

The wrapper published the top-400 result as latest, as designed for prefix expansion. `latest.previous.json` exists, so rollback remains possible.

Ben chose: **do not change the pointer now; document the result and source-gap next steps.**

No rollback, cache pruning, scheduler change, or provider credential change was performed.

## Source-gap next steps

1. Treat Yahoo-only top-400 as a useful research window, not a passed rollout gate.
2. Do not run the full 1,838-entry seed on Yahoo-only data yet. The top-400 result already dropped below the agreed coverage floor.
3. Move to the provider-fallback lane before another broad production publish:
   - Preferred: enable Financial Modeling Prep (`FMP_API_KEY`) as a fill-only provider after Ben stores the key in Vaultwarden/runtime env.
   - Alternative: Alpha Vantage only for spot-fill; free tier is too small for broad ASX batches.
   - Keep MarketIndex/TradingView scraping out; prior research found WAF/ToS/fragility problems.
4. Wire/verify fallback behavior on a bounded local or NAS run before repeating top-400:
   - Fallbacks must fill missing raw fields only.
   - Fallback provenance must be visible as a separate source family.
   - Yahoo values must not be silently overwritten.
5. If the top-400 pointer becomes undesirable for the dashboard, perform a bounded latest-pointer rollback only after explicit approval:

```bash
cd /mnt/pve/NAS/services/personal-dashboard/investment-screener/manifests/market=ASX/source=yahoo-finance
cp latest.json latest.bad.$(date -u +%Y%m%dT%H%M%SZ).json
cp latest.previous.json latest.json
```

Then rerun preflight.
