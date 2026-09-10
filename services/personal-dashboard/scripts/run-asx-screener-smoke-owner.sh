#!/usr/bin/env bash
set -euo pipefail

# Backward-compatible ASX-only shim -> generalized weekly NO-PUBLISH smoke owner.
#
# The live scheduler currently points the weekly smoke job at this ASX-named
# file. Until the deploy step re-points it at the generalized owner, this shim
# preserves ASX-only smoke behavior: a DRY_RUN against a tiny bounded slice
# WITHOUT publishing latest.json.
#
# Environment overrides (all optional):
#   ASX_BATCH_SIZE   smoke slice size (default 4)

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

BATCH_SIZE=${ASX_BATCH_SIZE:-4}
DATA_ROOT=${INVESTMENT_SCREENER_DATA_ROOT:-/tmp/investment-screener-smoke-scratch}

export MARKET=ASX
export SOURCE=yahoo-finance
export MODE=asx-yahoo-timeseries
export SEED_ARG=--asx-universe-seed
export SEED_PATH=${ASX_UNIVERSE_SEED_PATH:-$APP_DIR/investment-screener/universe/asx-listed-companies.seed.json}
export BATCH_OFFSET=0
export BATCH_SIZE="$BATCH_SIZE"
export SLEEP_SECONDS=${ASX_SLEEP_SECONDS:-0.75}
export CREDENTIAL_ENV=""
export DENOMINATOR_LABEL=""
export DRY_RUN=1
export INVESTMENT_SCREENER_DATA_ROOT="$DATA_ROOT"
export CACHE_DIR="/tmp/investment-screener-smoke-cache-asx"
export WORK_DIR="/tmp/investment-screener-smoke-work-asx"

if ! OUTPUT=$(bash "$SCRIPT_DIR/run-investment-screener-hydration.sh" 2>&1); then
  echo "ASX_SCREENER_SMOKE status=failed batch=$BATCH_SIZE no_publish=true"
  echo "[asx-screener-smoke] FAILED:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

printf 'ASX_SCREENER_SMOKE status=ok batch=%s dry_run=1 no_publish=true\n' "$BATCH_SIZE"