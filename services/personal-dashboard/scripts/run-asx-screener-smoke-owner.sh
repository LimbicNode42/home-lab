#!/usr/bin/env bash
set -euo pipefail

# ASX screener hydration — weekly NO-PUBLISH provider smoke (non-fixture).
#
# This is the approved weekly smoke/freshness check. It runs the canonical
# workflow in dry-run mode against a tiny bounded slice so it exercises real
# Yahoo provider connectivity (429s / SSL failures / shape changes surface here)
# WITHOUT publishing latest.json — the dashboard denominator is never touched.
#
# stdout is exactly one sanitized line; the summary shape is stable so no-agent
# cron delivery stays clean. No secrets are emitted.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

BATCH_SIZE=${ASX_BATCH_SIZE:-4}

export ASX_BATCH_OFFSET=0
export ASX_BATCH_SIZE="$BATCH_SIZE"
export ASX_SLEEP_SECONDS=${ASX_SLEEP_SECONDS:-0.75}
export DRY_RUN=1

if ! OUTPUT=$(bash "$SCRIPT_DIR/run-asx-screener-hydration.sh" 2>&1); then
  # Preserve the underlying failure for operator eyes (canonical script prints no secrets).
  echo "ASX_SCREENER_SMOKE status=failed batch=$BATCH_SIZE no_publish=true" 
  echo "[asx-screener-smoke] FAILED:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

printf 'ASX_SCREENER_SMOKE status=ok batch=%s dry_run=1 no_publish=true\n' "$BATCH_SIZE"