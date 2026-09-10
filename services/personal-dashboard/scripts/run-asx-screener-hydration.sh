#!/usr/bin/env bash
set -euo pipefail

# Backward-compatible ASX-only canonical workflow shim -> generalized canonical.
#
# Historical entry point that ran the ASX screener hydration + publish +
# preflight. It now delegates to the market-parameterized canonical workflow
# with ASX identity fixed, preserving the old ASX_UNIVERSE_SEED_PATH /
# ASX_BATCH_* / ASX_SLEEP_SECONDS / ASX_CACHE_DIR / ASX_WORK_DIR / DRY_RUN env
# contract for any script or operator that still invokes this filename.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

export MARKET=ASX
export SOURCE=yahoo-finance
export MODE=asx-yahoo-timeseries
export SEED_ARG=--asx-universe-seed
export SEED_PATH=${ASX_UNIVERSE_SEED_PATH:-$APP_DIR/investment-screener/universe/asx-listed-companies.seed.json}
export BATCH_OFFSET=${ASX_BATCH_OFFSET:-0}
export BATCH_SIZE=${ASX_BATCH_SIZE:-10}
export SLEEP_SECONDS=${ASX_SLEEP_SECONDS:-0.75}
export DRY_RUN=${DRY_RUN:-0}
export CACHE_DIR=${ASX_CACHE_DIR:-/var/lib/personal-dashboard/asx-provider-cache}
export WORK_DIR=${ASX_WORK_DIR:-/tmp/personal-dashboard-asx-screener}
export MAX_GENERATED_AGE_HOURS=${ASX_MAX_GENERATED_AGE_HOURS:-26}

exec bash "$SCRIPT_DIR/run-investment-screener-hydration.sh"