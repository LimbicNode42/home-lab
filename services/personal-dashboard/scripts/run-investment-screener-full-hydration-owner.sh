#!/usr/bin/env bash
set -euo pipefail

# Investment screener hydration — monthly FULL-UNIVERSE owner wrapper.
#
# Iterates every enabled market in the recurring-markets registry, resolves each
# market's full seed count dynamically, and runs the canonical owner wrapper at
# BATCH_OFFSET=0 / BATCH_SIZE=<full seed count> so each market's latest pointer
# carries its honest denominator_status (complete_exchange_listing for ASX,
# complete_security_type_filtered_listing for NASDAQ) and does NOT regress to a
# bounded top-N slice. No magic count, no hard-coded ASX: adding a market is a
# registry + seed add, not an edit to this loop.
#
# stdout is one sanitized SCREENER summary line per enabled market, plus a
# single FULL_SCREENER status line. No secrets are emitted.
#
# Environment overrides (all optional):
#   INVESTMENT_SCREENER_DATA_ROOT   canonical data root (defaults to the NAS)
#   RECURRING_MARKETS_REGISTRY      explicit registry path (defaults to repo path)

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

REGISTRY=${RECURRING_MARKETS_REGISTRY:-$APP_DIR/investment-screener/universe/recurring-markets.json}
DRY_RUN=${DRY_RUN:-0}

# Resolve enabled markets once in Python (fail-closed full-count + field validation).
# Output: id \t market \t source \t mode \t seed_arg \t seed_path \t full_count \t
#         smoke_batch_size \t sleep_seconds \t max_generated_age_hours \t
#         denominator_label \t denominator_status \t credential_env
if ! RESOLVED=$(python3 "$APP_DIR/investment-screener/recurring_markets.py" \
      --app-dir "$APP_DIR" --registry "$REGISTRY" 2>/dev/null); then
  echo "FULL_SCREENER status=failed reason=registry_resolution_failed no_publish=true" >&2
  python3 "$APP_DIR/investment-screener/recurring_markets.py" --app-dir "$APP_DIR" --registry "$REGISTRY" >&2
  exit 1
fi

any_failed=0
if [[ -z "$RESOLVED" ]]; then
  echo "[full-owner] no enabled markets in registry (fail-closed)" >&2
  echo "FULL_SCREENER status=failed reason=no_enabled_markets no_publish=true"
  exit 1
fi

while IFS=$'\t' read -r id market source mode seed_arg seed_path full_count \
    smoke_size sleep_seconds max_age_hours denom_label denom_status credential_env; do
  [[ -n "$id" ]] || continue

  # A missing/empty seed is already fail-closed in Python resolution; guard
  # defensively here too so a pathological registry cannot scrape with a null.
  if [[ ! -f "$seed_path" ]]; then
    echo "[full-owner] $market seed missing: $seed_path (fail-closed)" >&2
    any_failed=1
    continue
  fi

  echo "[full-owner] $market: full_count=$full_count denom=$denom_status dry_run=$DRY_RUN" >&2

  export MARKET="$market"
  export SOURCE="$source"
  export MODE="$mode"
  export SEED_ARG="$seed_arg"
  export SEED_PATH="$seed_path"
  export BATCH_OFFSET=0
  export BATCH_SIZE="$full_count"
  export SLEEP_SECONDS="$sleep_seconds"
  export CREDENTIAL_ENV="$credential_env"
  export MAX_GENERATED_AGE_HOURS="$max_age_hours"

  if ! bash "$SCRIPT_DIR/run-investment-screener-hydration-owner.sh"; then
    any_failed=1
  fi
done <<< "$RESOLVED"

if [[ "$any_failed" != "0" ]]; then
  echo "FULL_SCREENER status=failed no_publish=$([[ "$DRY_RUN" = "1" ]] && echo true || echo false)" >&2
  exit 1
fi

echo "FULL_SCREENER status=ok markets_resolved=$(printf '%s\n' "$RESOLVED" | wc -l) dry_run=$DRY_RUN"