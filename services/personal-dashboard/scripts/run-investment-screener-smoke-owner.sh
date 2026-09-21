#!/usr/bin/env bash
set -euo pipefail

# Investment screener hydration — weekly NO-PUBLISH provider smoke owner wrapper.
#
# Iterates every enabled market in the recurring-markets registry and runs each
# in DRY_RUN against a tiny bounded slice (per-market smoke_batch_size) so it
# exercises real provider connectivity (429s / SSL failures / shape changes)
# WITHOUT publishing latest.json — no smoke touches the dashboard denominator
# or moves a latest pointer.
#
# stdout is one sanitized SCREENER_SMOKE line per enabled market plus a single
# SMOKE_SCREENER status line. No secrets are emitted.
#
# Environment overrides (all optional):
#   INVESTMENT_SCREENER_DATA_ROOT   canonical data root (defaults to a scratch dir)
#   RECURRING_MARKETS_REGISTRY      explicit registry path (defaults to repo path)

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

REGISTRY=${RECURRING_MARKETS_REGISTRY:-$APP_DIR/investment-screener/universe/recurring-markets.json}

# Smoke is always no-publish; force DRY_RUN=1 regardless of caller.
export DRY_RUN=1

# Never let smoke write to the NAS: default to a scratch data root. An operator
# override (INVESTMENT_SCREENER_DATA_ROOT) is honored for sandboxed verification.
DATA_ROOT=${INVESTMENT_SCREENER_DATA_ROOT:-/tmp/investment-screener-smoke-scratch}

if ! RESOLVED=$(python3 "$APP_DIR/investment-screener/recurring_markets.py" \
      --app-dir "$APP_DIR" --registry "$REGISTRY" 2>/dev/null); then
  echo "SMOKE_SCREENER status=failed reason=registry_resolution_failed no_publish=true" >&2
  python3 "$APP_DIR/investment-screener/recurring_markets.py" --app-dir "$APP_DIR" --registry "$REGISTRY" >&2
  exit 1
fi

any_failed=0
if [[ -z "$RESOLVED" ]]; then
  echo "[smoke-owner] no enabled markets in registry (fail-closed)" >&2
  echo "SMOKE_SCREENER status=failed reason=no_enabled_markets no_publish=true"
  exit 1
fi

while IFS=$'\t' read -r id market source mode seed_arg seed_path full_count \
    smoke_size sleep_seconds max_age_hours denom_label denom_status credential_env; do
  [[ -n "$id" ]] || continue

  if [[ ! -f "$seed_path" ]]; then
    echo "[smoke-owner] $market seed missing: $seed_path (fail-closed)" >&2
    echo "SCREENER_SMOKE market=$market status=failed reason=seed_missing no_publish=true"
    any_failed=1
    continue
  fi

  # Credential-gated markets: a smoke that cannot reach the provider without a
  # credential is reported honestly, not faked. Fail closed without a network call.
  if [[ -n "$credential_env" && -z "${!credential_env:-}" ]]; then
    echo "[smoke-owner] $market: credential '$credential_env' unset — marked not applicable (fail-closed)" >&2
    echo "SCREENER_SMOKE market=$market status=n/a reason=missing_credential_${credential_env} no_publish=true"
    continue
  fi

  echo "[smoke-owner] $market: smoke batch=$smoke_size dry_run=1 no_publish=true" >&2

  if ! OUTPUT=$( \
      MARKET="$market" \
      SOURCE="$source" \
      MODE="$mode" \
      SEED_ARG="$seed_arg" \
      SEED_PATH="$seed_path" \
      INVESTMENT_SCREENER_DATA_ROOT="$DATA_ROOT" \
      BATCH_OFFSET=0 \
      BATCH_SIZE="$smoke_size" \
      SLEEP_SECONDS="$sleep_seconds" \
      CREDENTIAL_ENV="$credential_env" \
      CACHE_DIR="/tmp/investment-screener-smoke-cache-${id}" \
      WORK_DIR="/tmp/investment-screener-smoke-work-${id}" \
      bash "$SCRIPT_DIR/run-investment-screener-hydration.sh" 2>&1); then
    echo "SCREENER_SMOKE market=$market status=failed no_publish=true"
    echo "[smoke-owner $market] FAILED:" >&2
    echo "$OUTPUT" >&2
    any_failed=1
  else
    echo "SCREENER_SMOKE market=$market status=ok batch=$smoke_size dry_run=1 no_publish=true"
  fi
done <<< "$RESOLVED"

if [[ "$any_failed" != "0" ]]; then
  echo "SMOKE_SCREENER status=failed no_publish=true" >&2
  exit 1
fi

echo "SMOKE_SCREENER status=ok markets=$(printf '%s\n' "$RESOLVED" | wc -l) no_publish=true"