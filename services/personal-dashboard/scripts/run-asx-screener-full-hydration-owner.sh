#!/usr/bin/env bash
set -euo pipefail

# Backward-compatible ASX-only shim -> generalized monthly FULL-UNIVERSE owner.
#
# The live scheduler currently points the monthly full-hydration job at this
# ASX-named file. The deploy step will re-point it at the generalized owner;
# until then (and for any operator who still calls the ASX name), this shim
# preserves ASX-only full-universe behavior by driving JUST the ASX market
# (full seed count) through the shared owner wrapper.
#
# Environment overrides (all optional, ASX-only):
#   ASX_UNIVERSE_SEED_PATH          reviewed ASX universe seed (defaults to repo path)
#   ASX_SLEEP_SECONDS               provider throttle (default 0.75)
#   INVESTMENT_SCREENER_DATA_ROOT   canonical data root

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

SEED_PATH=${ASX_UNIVERSE_SEED_PATH:-$APP_DIR/investment-screener/universe/asx-listed-companies.seed.json}

# Resolve full seed count dynamically (fail-closed, no magic number).
FULL_COUNT=$(python3 - "$SEED_PATH" <<'PY'
import json, sys
from pathlib import Path
seed = json.loads(Path(sys.argv[1]).read_text(encoding="utf8"))
entries = seed.get("entries") if isinstance(seed, dict) else seed
print(len(entries) if isinstance(entries, list) else 0)
PY
)

if [[ -z "${FULL_COUNT:-}" || "$FULL_COUNT" == "0" ]]; then
  echo "[asx-screener-full-owner] seed missing/empty: $SEED_PATH" >&2
  exit 1
fi

export MARKET=ASX
export SOURCE=yahoo-finance
export MODE=asx-yahoo-timeseries
export SEED_ARG=--asx-universe-seed
export SEED_PATH="$SEED_PATH"
export BATCH_OFFSET=0
export BATCH_SIZE="$FULL_COUNT"
export SLEEP_SECONDS=${ASX_SLEEP_SECONDS:-0.75}
export CREDENTIAL_ENV=""
export DENOMINATOR_LABEL=""

exec bash "$SCRIPT_DIR/run-investment-screener-hydration-owner.sh"