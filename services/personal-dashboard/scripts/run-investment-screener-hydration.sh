#!/usr/bin/env bash
set -euo pipefail

# Canonical investment-screener hydration workflow — market-parameterized.
#
# This is the generalized replacement for the old ASX-only canonical workflow.
# It drives a single market through the screener CLI and, for non-dry-runs,
# the file-first publisher + artifact preflight. The market identity is passed
# via environment so the recurring owner wrappers can loop over the registry
# without hard-coding ASX.
#
# Required environment (set by the owner wrappers):
#   INVESTMENT_SCREENER_DATA_ROOT   canonical data root
#   MARKET                          market key (ASX / NASDAQ / US)
#   SOURCE                          canonical source identity (yahoo-finance / eodhd)
#   SEED_ARG                        screener.py flag for the market's seed (e.g. --nasdaq-universe-seed)
#   SEED_PATH                       reviewed universe seed JSON (absolute)
#   BATCH_OFFSET / BATCH_SIZE       hydrated slice
#   SLEEP_SECONDS                   provider throttle
#   DRY_RUN                         0/1
# Optional:
#   DENOMINATOR_LABEL               honest denominator label override
#   CACHE_DIR                       provider cache dir (scratch for smoke)
#   WORK_DIR                        run-payload scratch dir
#   MAX_GENERATED_AGE_HOURS         preflight freshness window (default 26)

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

: "${INVESTMENT_SCREENER_DATA_ROOT:?INVESTMENT_SCREENER_DATA_ROOT is required}"
: "${MARKET:?MARKET is required}"
: "${SOURCE:?SOURCE is required}"
: "${SEED_PATH:?SEED_PATH is required}"

DATA_ROOT=${INVESTMENT_SCREENER_DATA_ROOT}
MARKET=$(printf '%s' "$MARKET" | tr '[:lower:]' '[:upper:]')
SEED_ARG=${SEED_ARG:-}
BATCH_OFFSET=${BATCH_OFFSET:-0}
BATCH_SIZE=${BATCH_SIZE:-10}
SLEEP_SECONDS=${SLEEP_SECONDS:-0.75}
CACHE_DIR=${CACHE_DIR:-/var/lib/personal-dashboard/investment-screener-provider-cache}
WORK_DIR=${WORK_DIR:-/tmp/personal-dashboard-investment-screener}
DRY_RUN=${DRY_RUN:-0}
MAX_GENERATED_AGE_HOURS=${MAX_GENERATED_AGE_HOURS:-26}
DENOMINATOR_LABEL=${DENOMINATOR_LABEL:-}

mkdir -p "$WORK_DIR" "$CACHE_DIR"
run_json="$WORK_DIR/investment-screener-run.${MARKET}.$(date -u +%Y%m%dT%H%M%SZ).json"

printf 'investment-screener hydration: market=%s source=%s seed=%s offset=%s size=%s data_root=%s dry_run=%s\n' \
  "$MARKET" "$SOURCE" "$SEED_PATH" "$BATCH_OFFSET" "$BATCH_SIZE" "$DATA_ROOT" "$DRY_RUN" >&2

SCREENER_ARGS=(
  --batch-offset "$BATCH_OFFSET"
  --batch-size "$BATCH_SIZE"
  --sleep-seconds "$SLEEP_SECONDS"
  --cache-dir "$CACHE_DIR"
  --file-first-run-json "$run_json"
)
if [[ -n "$SEED_ARG" ]]; then
  SCREENER_ARGS+=( "$SEED_ARG" "$SEED_PATH" )
fi
if [[ -n "$DENOMINATOR_LABEL" ]]; then
  SCREENER_ARGS+=( --denominator-label "$DENOMINATOR_LABEL" )
fi

python3 "$APP_DIR/investment-screener/screener.py" "${SCREENER_ARGS[@]}"

if [ "$DRY_RUN" = "1" ]; then
  printf 'investment-screener dry run wrote canonical payload: %s\n' "$run_json" >&2
  python3 - "$run_json" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf8') as fh:
    payload = json.load(fh)
print(json.dumps({
    'ok': True,
    'dry_run': True,
    'market': payload.get('market'),
    'mode': payload.get('mode'),
    'fixture': payload.get('fixture'),
    'universe': payload.get('universe'),
    'coverage': payload.get('coverage'),
}, indent=2))
PY
  exit 0
fi

node "$APP_DIR/scripts/publish-investment-screener-run.mjs" \
  --data-root "$DATA_ROOT" \
  --run-json "$run_json"

node "$APP_DIR/scripts/preflight-investment-screener-artifacts.mjs" \
  --data-root "$DATA_ROOT" \
  --market "$MARKET" \
  --source "$SOURCE" \
  --max-generated-age-hours "$MAX_GENERATED_AGE_HOURS"