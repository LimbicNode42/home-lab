#!/usr/bin/env bash
# Publish sanitized persistent Android emulator + device-matrix status for the Home Dashboard.
#
# Reads the persistent agent_feedback emulator over adb and (if present) the matrix
# active-profile file written by services/android-emulator/scripts/emulator-matrix.sh,
# then writes a single sanitized status.json and copies it to the dashboard's NAS and
# runtime-cache locations. No secrets or raw paths leave this host.
set -euo pipefail

ADB=${ADB:-/opt/android-sdk/platform-tools/adb}
DEVICE=${MOBILE_WORKFLOW_ADB_DEVICE:-emulator-5554}
LOCAL_OUT=${LOCAL_OUT:-/opt/android-emulator/run/status.json}
MATRIX_ACTIVE=${MATRIX_ACTIVE:-/opt/android-emulator/run/matrix-active.json}
REMOTE=${REMOTE:-root@192.168.0.50:/mnt/nas/services/personal-dashboard/mobile-workflow/status.json}
REMOTE_RUNTIME=${REMOTE_RUNTIME:-root@192.168.0.50:/var/lib/personal-dashboard/runtime-cache/mobile-workflow/status.json}
TMP="${LOCAL_OUT}.tmp.$$"

mkdir -p "$(dirname "$LOCAL_OUT")"

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

python3 - "$TMP" "$state" "$adb_device_id" "$boot_completed" "$detail" "$MATRIX_ACTIVE" <<'PY'
import json, sys, os
from datetime import datetime, timezone
out, state, device, boot, detail, matrix_active = sys.argv[1:]
matrix = None
if os.path.exists(matrix_active):
    try:
        with open(matrix_active, encoding="utf-8") as fh:
            raw = json.load(fh)
        matrix = {
            "activeProfileId": raw.get("id"),
            "activeProfileLabel": raw.get("label"),
            "avdName": raw.get("avdName"),
            "serial": raw.get("serial"),
            "startedAt": raw.get("startedAt"),
        }
    except (ValueError, OSError):
        matrix = None
payload = {
    "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "runtime": {
        "state": state,
        "adbDeviceId": device or None,
        "bootCompleted": boot == "true",
        "detail": detail,
    },
    "matrix": matrix,
    "lastSuccessfulCycleAt": "2026-09-05T03:00:00Z",
}
with open(out, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, sort_keys=True)
    fh.write("\n")
PY
mv "$TMP" "$LOCAL_OUT"
chmod 0644 "$LOCAL_OUT"
ssh -o BatchMode=yes -o ConnectTimeout=5 root@192.168.0.50 'mkdir -p /mnt/nas/services/personal-dashboard/mobile-workflow /var/lib/personal-dashboard/runtime-cache/mobile-workflow'
scp -q "$LOCAL_OUT" "$REMOTE"
scp -q "$LOCAL_OUT" "$REMOTE_RUNTIME"
printf 'published %s to %s and %s\n' "$LOCAL_OUT" "$REMOTE" "$REMOTE_RUNTIME"