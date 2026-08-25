#!/usr/bin/env bash
set -euo pipefail

# Canonical ASX screener hydration workflow.
# Publishes immutable file-first artifacts, then validates the latest pointer.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
DATA_ROOT=${INVESTMENT_SCREENER_DATA_ROOT:-/mnt/nas/services/personal-dashboard}
SEED_PATH=${ASX_UNIVERSE_SEED_PATH:-$APP_DIR/investment-screener/universe/asx-listed-companies.seed.json}
BATCH_OFFSET=${ASX_BATCH_OFFSET:-0}
BATCH_SIZE=${ASX_BATCH_SIZE:-10}
SLEEP_SECONDS=${ASX_SLEEP_SECONDS:-0.75}
CACHE_DIR=${ASX_CACHE_DIR:-/var/lib/personal-dashboard/asx-provider-cache}
WORK_DIR=${ASX_WORK_DIR:-/tmp/personal-dashboard-asx-screener}
DRY_RUN=${DRY_RUN:-0}
MAX_GENERATED_AGE_HOURS=${ASX_MAX_GENERATED_AGE_HOURS:-26}

mkdir -p "$WORK_DIR" "$CACHE_DIR"
run_json="$WORK_DIR/asx-screener-run.$(date -u +%Y%m%dT%H%M%SZ).json"

printf 'ASX screener hydration: seed=%s offset=%s size=%s data_root=%s dry_run=%s\n' \
  "$SEED_PATH" "$BATCH_OFFSET" "$BATCH_SIZE" "$DATA_ROOT" "$DRY_RUN" >&2

python3 "$APP_DIR/investment-screener/screener.py" \
  --asx-universe-seed "$SEED_PATH" \
  --batch-offset "$BATCH_OFFSET" \
  --batch-size "$BATCH_SIZE" \
  --sleep-seconds "$SLEEP_SECONDS" \
  --cache-dir "$CACHE_DIR" \
  --file-first-run-json "$run_json"

if [ "$DRY_RUN" = "1" ]; then
  printf 'ASX screener dry run wrote canonical payload: %s\n' "$run_json" >&2
  python3 - <<'PY' "$run_json"
import json, sys
with open(sys.argv[1], encoding='utf8') as fh:
    payload = json.load(fh)
print(json.dumps({
    'ok': True,
    'dry_run': True,
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
  --market ASX \
  --source yahoo-finance \
  --max-generated-age-hours "$MAX_GENERATED_AGE_HOURS"
