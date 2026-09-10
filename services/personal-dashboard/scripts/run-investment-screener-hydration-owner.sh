#!/usr/bin/env bash
set -euo pipefail

# Investment-screener hydration — shared scheduled owner wrapper (non-fixture).
#
# This is the market-parameterized generalization of the old ASX-only shared
# owner wrapper. It is driven by the recurring full-hydration / smoke owners,
# which source the market registry (universe/recurring-markets.json) and set a
# single market's environment, then invoke this wrapper to run the canonical
# workflow (DRY_RUN-aware, file-first publish + preflight) and reduce output to
# one sanitized summary line per market:
#
#   SCREENER market=<MARKET> run_id=... mode=... denom=... usable=... failed=... excluded=...
#
# No secrets, provider payloads, local absolute run-manifest paths, or task ids
# are emitted (the pointer path is market/source-relative, not host-local).
#
# Required environment (set by full-hydration / smoke owner drivers):
#   INVESTMENT_SCREENER_DATA_ROOT   canonical data root (defaults to the NAS)
#   MARKET                          market key (ASX / NASDAQ / US)
#   SOURCE                          source identity (yahoo-finance / eodhd)
#   MODE                            canonical hydration mode (asx-yahoo-timeseries / nasdaq-eodhd-fundamentals / us-eodhd-fundamentals)
#   SEED_ARG                        screener.py seed flag (--asx-universe-seed / --nasdaq-universe-seed / --us-universe-seed)
#   SEED_PATH                       reviewed universe seed (absolute)
#   BATCH_OFFSET / BATCH_SIZE       hydrated slice
#   SLEEP_SECONDS                   provider throttle
# Optional:
#   DENOMINATOR_LABEL               honest denominator label
#   CREDENTIAL_ENV                  provider credential env var name (eodhd) or empty
#   DRY_RUN                         0/1

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

# On tori the NAS NFS mount is /mnt/pve/NAS; keep /mnt/nas as the fallback for
# hosts (like critical) that mount the export there directly.
if [[ -d /mnt/pve/NAS/services/personal-dashboard ]]; then
  DATA_ROOT_DEFAULT=/mnt/pve/NAS/services/personal-dashboard
elif [[ -d /mnt/nas/services/personal-dashboard ]]; then
  DATA_ROOT_DEFAULT=/mnt/nas/services/personal-dashboard
else
  DATA_ROOT_DEFAULT=/mnt/nas/services/personal-dashboard
fi

: "${MARKET:?MARKET is required (set by the recurring owner driver)}"
: "${SOURCE:?SOURCE is required}"
: "${MODE:?MODE is required}"
: "${SEED_PATH:?SEED_PATH is required}"
: "${SEED_ARG:?SEED_ARG is required}"

MARKET=$(printf '%s' "$MARKET" | tr '[:lower:]' '[:upper:]')
DATA_ROOT=${INVESTMENT_SCREENER_DATA_ROOT:-$DATA_ROOT_DEFAULT}
BATCH_OFFSET=${BATCH_OFFSET:-0}
BATCH_SIZE=${BATCH_SIZE:-50}
SLEEP_SECONDS=${SLEEP_SECONDS:-0.75}
DRY_RUN=${DRY_RUN:-0}
DENOMINATOR_LABEL=${DENOMINATOR_LABEL:-}
CREDENTIAL_ENV=${CREDENTIAL_ENV:-}
MAX_GENERATED_AGE_HOURS=${MAX_GENERATED_AGE_HOURS:-26}

# Resolve the market's run payload scratch dir + cache under the market key so
# two markets never collide. Smoke runs pass their own scratch root via
# INVESTMENT_SCREENER_DATA_ROOT; these dirs only hold transient run JSON.
CACHE_DIR=${CACHE_DIR:-/var/lib/personal-dashboard/investment-screener-${MARKET}-cache}
WORK_DIR=${WORK_DIR:-/tmp/personal-dashboard-investment-screener-${MARKET}}

# Universe hash: short sha256 of the seed file (same provenance the manifest records).
if [[ -f "$SEED_PATH" ]]; then
  UNIVERSE_HASH=$(sha256sum "$SEED_PATH" | cut -c1-12)
else
  UNIVERSE_HASH=missing
fi

# Fail closed on a missing recipient-provider credential for credentialed markets.
if [[ -n "$CREDENTIAL_ENV" ]]; then
  if [[ -z "${!CREDENTIAL_ENV:-}" ]]; then
    echo "[screener-owner $MARKET] FAILED: required credential env '$CREDENTIAL_ENV' is unset (fail-closed); no network call made" >&2
    exit 1
  fi
fi

echo "[screener-owner $MARKET] start mode=$MODE source=$SOURCE seed_hash=$UNIVERSE_HASH offset=$BATCH_OFFSET size=$BATCH_SIZE dry_run=$DRY_RUN" >&2

export INVESTMENT_SCREENER_DATA_ROOT="$DATA_ROOT"
export MARKET="$MARKET"
export SOURCE="$SOURCE"
export MODE="$MODE"
export SEED_ARG="$SEED_ARG"
export SEED_PATH="$SEED_PATH"
export BATCH_OFFSET="$BATCH_OFFSET"
export BATCH_SIZE="$BATCH_SIZE"
export SLEEP_SECONDS="$SLEEP_SECONDS"
export DRY_RUN="$DRY_RUN"
export DENOMINATOR_LABEL="$DENOMINATOR_LABEL"
export MAX_GENERATED_AGE_HOURS="$MAX_GENERATED_AGE_HOURS"
export CACHE_DIR="$CACHE_DIR"
export WORK_DIR="$WORK_DIR"

POINTER_PATH="$DATA_ROOT/investment-screener/manifests/market=$MARKET/source=$SOURCE/latest.json"

# Safety guard (non-dry-run only): do not let an approved bounded recurring run
# silently replace a full-universe latest pointer. Any cadence/batch-size
# migration needs an explicit scheduler approval and should leave the dashboard
# denominator stable.
if [[ "$DRY_RUN" != "1" ]]; then
  python3 - "$POINTER_PATH" "$SEED_PATH" "$BATCH_OFFSET" "$BATCH_SIZE" "$MARKET" <<'PY'
import json
import sys
from pathlib import Path

pointer_path = Path(sys.argv[1])
seed_path = Path(sys.argv[2])
batch_offset_raw = sys.argv[3]
batch_size_raw = sys.argv[4]
market = sys.argv[5]

def to_int(raw, default=None):
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return default

batch_offset = to_int(batch_offset_raw, 0)
batch_size = to_int(batch_size_raw)
if batch_size is None or not pointer_path.exists():
    raise SystemExit(0)

try:
    pointer = json.loads(pointer_path.read_text(encoding="utf8"))
except Exception:
    raise SystemExit(0)

current_denominator = to_int((pointer.get("coverage") or {}).get("denominator"))
manifest_rel = pointer.get("run_manifest")
complete_pointer = False
if manifest_rel:
    manifest_path = pointer_path.parents[3] / manifest_rel
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf8"))
        universe = manifest.get("universe") or {}
        complete_pointer = bool(
            universe.get("complete_exchange_listing")
            or universe.get("complete_security_type_filtered_listing")
        )
        current_denominator = to_int(universe.get("full_count"), current_denominator)
    except Exception:
        pass

seed_count = None
try:
    seed = json.loads(seed_path.read_text(encoding="utf8"))
    entries = seed.get("entries") if isinstance(seed, dict) else seed
    if isinstance(entries, list):
        seed_count = len(entries)
except Exception:
    pass

full_count = current_denominator or seed_count
would_publish_bounded = full_count and (batch_offset != 0 or batch_size < full_count)
if complete_pointer and would_publish_bounded:
    print(
        f"[screener-owner {market}] REFUSING bounded publish: "
        f"current latest pointer is full-universe denominator={full_count}, "
        f"requested offset={batch_offset} size={batch_size}. "
        "Approval required for a scheduler/cadence migration before replacing latest.json.",
        file=sys.stderr,
    )
    raise SystemExit(42)
PY
fi

# Run the canonical market workflow, capturing combined output for summary extraction.
CANONICAL_OUTPUT=$(
  bash "$SCRIPT_DIR/run-investment-screener-hydration.sh" 2>&1
) || {
  echo "[screener-owner $MARKET] FAILED:" >&2
  echo "$CANONICAL_OUTPUT" >&2
  exit 1
}

# Resolve the latest pointer for this market/source and emit one sanitized line.
RUN_ID=""
USABLE=""
FAILED=""
EXCLUDED=""
if [[ -f "$POINTER_PATH" ]]; then
  RUN_ID=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("run_id") or "")' "$POINTER_PATH" 2>/dev/null || true)
  MANIFEST_REL=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("run_manifest",""))' "$POINTER_PATH" 2>/dev/null || true)
  if [[ -n "$MANIFEST_REL" && -f "$DATA_ROOT/investment-screener/$MANIFEST_REL" ]]; then
    read -r USABLE FAILED EXCLUDED < <(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
c=d.get("coverage",{})
print(c.get("usable",""), c.get("failed",""), c.get("excluded",""))
' "$DATA_ROOT/investment-screener/$MANIFEST_REL" 2>/dev/null || printf '\\n\\n\\n')
  fi
fi

# Sanitized summary line — stable shape, no secrets, no host-local run paths.
printf 'SCREENER market=%s mode=%s universe_hash=%s usable=%s failed=%s excluded=%s\n' \
  "$MARKET" "$MODE" "$UNIVERSE_HASH" \
  "${USABLE:-n/a}" "${FAILED:-n/a}" "${EXCLUDED:-n/a}"

echo "[screener-owner $MARKET] done" >&2