#!/usr/bin/env bash
set -euo pipefail

# ASX screener hydration — scheduled owner wrapper (non-fixture).
#
# This is the named, enabled, audit-sanitized entry point for recurring
# non-fixture ASX hydration. It wraps the canonical workflow
#   scripts/run-asx-screener-hydration.sh
# (dry-run-aware, file-first publish + preflight) and reduces its output to a
# single sanitized summary line containing exactly:
#
#   run_id | mode | universe_hash | usable/failed/excluded | pointer_path
#
# No secrets, provider payloads, local absolute paths, or task ids are emitted.
#
# Placement note: critical (192.168.0.50) is Alpine with no bash/node/systemd,
# so this bash+node workflow runs on tori instead, and reaches the same NAS
# store via tori's NFS mount point (see docs/runbooks/asx-screener-hydration.md).
#
# Environment overrides (all optional):
#   INVESTMENT_SCREENER_DATA_ROOT   canonical data root (defaults to the NAS)
#   ASX_UNIVERSE_SEED_PATH          reviewed universe seed JSON
#   ASX_BATCH_OFFSET                resumable batch offset (default 0)
#   ASX_BATCH_SIZE                  bounded universe slice (default 50)
#   ASX_SLEEP_SECONDS               provider request throttle (default 0.75)

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

# On tori the NAS NFS mount is /mnt/pve/NAS; keep the /mnt/nas default for
# hosts (like critical) that mount the export there directly.
if [[ -d /mnt/pve/NAS/services/personal-dashboard ]]; then
  DATA_ROOT_DEFAULT=/mnt/pve/NAS/services/personal-dashboard
elif [[ -d /mnt/nas/services/personal-dashboard ]]; then
  DATA_ROOT_DEFAULT=/mnt/nas/services/personal-dashboard
else
  DATA_ROOT_DEFAULT=/mnt/nas/services/personal-dashboard
fi

DATA_ROOT=${INVESTMENT_SCREENER_DATA_ROOT:-$DATA_ROOT_DEFAULT}
SEED_PATH=${ASX_UNIVERSE_SEED_PATH:-$APP_DIR/investment-screener/universe/asx-listed-companies.seed.json}
BATCH_OFFSET=${ASX_BATCH_OFFSET:-0}
BATCH_SIZE=${ASX_BATCH_SIZE:-50}
SLEEP_SECONDS=${ASX_SLEEP_SECONDS:-0.75}

# Universe hash: short sha256 of the seed file (same provenance the manifest records).
if [[ -f "$SEED_PATH" ]]; then
  UNIVERSE_HASH=$(sha256sum "$SEED_PATH" | cut -c1-12)
else
  UNIVERSE_HASH=missing
fi

echo "[asx-screener-owner] start mode=non-fixture seed_hash=$UNIVERSE_HASH offset=$BATCH_OFFSET size=$BATCH_SIZE data_root=$DATA_ROOT" >&2

export INVESTMENT_SCREENER_DATA_ROOT="$DATA_ROOT"
export ASX_UNIVERSE_SEED_PATH="$SEED_PATH"
export ASX_BATCH_OFFSET="$BATCH_OFFSET"
export ASX_BATCH_SIZE="$BATCH_SIZE"
export ASX_SLEEP_SECONDS="$SLEEP_SECONDS"
export DRY_RUN=${DRY_RUN:-0}

# Run the canonical workflow, capturing combined output for summary extraction.
CANONICAL_OUTPUT=$(
  "$SCRIPT_DIR/run-asx-screener-hydration.sh" 2>&1
) || {
  # Preserve the underlying failure for operator eyes, emitted sanitized-ish
  # (the canonical script already prints no secrets).
  echo "[asx-screener-owner] FAILED:" >&2
  echo "$CANONICAL_OUTPUT" >&2
  exit 1
}

# Resolve the latest pointer for this market/source.
POINTER_PATH="$DATA_ROOT/investment-screener/manifests/market=ASX/source=yahoo-finance/latest.json"
RUN_ID=""
MODE=""
USABLE=""
FAILED=""
EXCLUDED=""
if [[ -f "$POINTER_PATH" ]]; then
  RUN_ID=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("run_id") or "")' "$POINTER_PATH" 2>/dev/null || true)
  MODE=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("mode") or "")' "$POINTER_PATH" 2>/dev/null || true)
  # Coverage is in the run manifest, not the pointer; the pointer carries
  # usable/denominator only. Failed/excluded come from the run manifest.
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

# Single sanitized summary line — stable shape, no secrets.
printf 'ASX_SCREENER run_id=%s mode=%s universe_hash=%s usable=%s failed=%s excluded=%s pointer=%s\n' \
  "${RUN_ID:-n/a}" "${MODE:-n/a}" "$UNIVERSE_HASH" \
  "${USABLE:-n/a}" "${FAILED:-n/a}" "${EXCLUDED:-n/a}" \
  "$POINTER_PATH"

echo "[asx-screener-owner] done" >&2