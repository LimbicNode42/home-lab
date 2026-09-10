#!/usr/bin/env bash
set -euo pipefail

# Backward-compatible ASX-only shim -> generalized shared owner wrapper.
#
# The live scheduler (and older docs) reference the ASX-named entry point. This
# shim preserves that contract by fixing the market to ASX (matching the
# historical ASX defaults) and delegating to the market-parameterized shared
# owner wrapper. New/other markets go through the registry-driven full/smoke
# owners, not this shim.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

SEED_PATH=${ASX_UNIVERSE_SEED_PATH:-$APP_DIR/investment-screener/universe/asx-listed-companies.seed.json}
BATCH_OFFSET=${ASX_BATCH_OFFSET:-0}
BATCH_SIZE=${ASX_BATCH_SIZE:-50}
SLEEP_SECONDS=${ASX_SLEEP_SECONDS:-0.75}

export MARKET=ASX
export SOURCE=yahoo-finance
export MODE=asx-yahoo-timeseries
export SEED_ARG=--asx-universe-seed
export SEED_PATH="$SEED_PATH"
export BATCH_OFFSET="$BATCH_OFFSET"
export BATCH_SIZE="$BATCH_SIZE"
export SLEEP_SECONDS="$SLEEP_SECONDS"
export CREDENTIAL_ENV=""
export DENOMINATOR_LABEL=""

exec bash "$SCRIPT_DIR/run-investment-screener-hydration-owner.sh"