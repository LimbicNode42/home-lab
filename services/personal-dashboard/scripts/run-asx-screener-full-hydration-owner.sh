#!/usr/bin/env bash
set -euo pipefail

# ASX screener hydration — monthly FULL-UNIVERSE owner wrapper (non-fixture).
#
# This is the approved recurring full-universe fundamentals refresh entry point.
# It resolves the reviewed seed's full entry count and runs the canonical owner
# wrapper with ASX_BATCH_OFFSET=0 / ASX_BATCH_SIZE=<full seed count>, so the
# dashboard's latest pointer carries denominator_status=complete_exchange_listing
# and does NOT regress to a bounded top-N slice.
#
# The heavy lifting (sanitized summary line, fail-closed regression guard,
# atomic publish + preflight) lives in the shared owner wrapper
#   scripts/run-asx-screener-hydration-owner.sh
# which this script wraps and execs.
#
# Environment overrides (all optional):
#   ASX_UNIVERSE_SEED_PATH          reviewed universe seed JSON
#   ASX_SLEEP_SECONDS               provider request throttle (default 0.75)
#   INVESTMENT_SCREENER_DATA_ROOT   canonical data root (defaults to the NAS)
#
# No secrets are emitted; stdout is exactly one sanitized ASX_SCREENER summary line.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

SEED_PATH=${ASX_UNIVERSE_SEED_PATH:-$APP_DIR/investment-screener/universe/asx-listed-companies.seed.json}

# Full seed count is the reviewed denominator; compute it dynamically so a
# reviewed seed growth is picked up without a hard-coded magic number.
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

export ASX_BATCH_OFFSET=0
export ASX_BATCH_SIZE="$FULL_COUNT"
export ASX_SLEEP_SECONDS=${ASX_SLEEP_SECONDS:-0.75}
export ASX_UNIVERSE_SEED_PATH="$SEED_PATH"

exec "$SCRIPT_DIR/run-asx-screener-hydration-owner.sh"