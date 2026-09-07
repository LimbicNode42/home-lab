#!/usr/bin/env bash
# Publish sanitized Flutter/mobile emulator runtime status for personal-dashboard.
set -euo pipefail

OUT=${MOBILE_WORKFLOW_STATUS_HOST_PATH:-/mnt/nas/services/personal-dashboard/mobile-workflow/status.json}
ADB=${ADB:-/opt/android-sdk/platform-tools/adb}
DEVICE=${MOBILE_WORKFLOW_ADB_DEVICE:-emulator-5554}
TMP="${OUT}.tmp.$$"

mkdir -p "$(dirname "$OUT")"

state="not_running"
adb_device_id=""
boot_completed="false"
detail="No adb device is attached for the persistent emulator."

if [ -x "$ADB" ]; then
  if "$ADB" -s "$DEVICE" get-state 2>/dev/null | grep -qx 'device'; then
    state="booting"
    adb_device_id="$DEVICE"
    boot=$("$ADB" -s "$DEVICE" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
    if [ "$boot" = "1" ]; then
      state="running"
      boot_completed="true"
      detail="Persistent Android emulator is attached over adb and reports boot completed."
    else
      detail="Persistent Android emulator is attached over adb but has not reported boot completed yet."
    fi
  fi
else
  state="unknown"
  detail="adb binary is unavailable on the dashboard status publisher host."
fi

python3 - "$OUT" "$state" "$adb_device_id" "$boot_completed" "$detail" <<'PY'
import json, os, sys
out, state, device, boot, detail = sys.argv[1:]
payload = {
    "generatedAt": __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z'),
    "runtime": {
        "state": state,
        "adbDeviceId": device or None,
        "bootCompleted": boot == "true",
        "detail": detail,
    },
    "lastSuccessfulCycleAt": os.environ.get("MOBILE_WORKFLOW_LAST_SUCCESSFUL_CYCLE_AT") or None,
}
with open(out + f".tmp.{os.getpid()}", "w", encoding="utf-8") as fh:
    json.dump(payload, fh, sort_keys=True)
    fh.write("\n")
os.replace(out + f".tmp.{os.getpid()}", out)
PY

chmod 0644 "$OUT"
printf 'Published mobile workflow status to %s\n' "$OUT"
