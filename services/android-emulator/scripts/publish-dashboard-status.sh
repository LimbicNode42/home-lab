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
DEV_LOOP=${DEV_LOOP:-/opt/android-emulator/run/dev-loop.json}
SESSION_LOCK=${SESSION_LOCK:-/opt/android-emulator/run/session-lock.json}
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

python3 - "$TMP" "$state" "$adb_device_id" "$boot_completed" "$detail" "$MATRIX_ACTIVE" "$DEV_LOOP" "$SESSION_LOCK" <<'PY'
import json, sys, os
from datetime import datetime, timezone
out, state, device, boot, detail, matrix_active, dev_loop_file, session_lock = sys.argv[1:]
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
dev_loop = None
if os.path.exists(dev_loop_file):
    try:
        with open(dev_loop_file, encoding="utf-8") as fh:
            raw = json.load(fh)
        dev_loop = {
            "status": raw.get("status"),
            "branch": raw.get("branch"),
            "targetDevice": raw.get("targetDevice"),
            "buildId": raw.get("buildId"),
            "lastReloadAt": raw.get("lastReloadAt"),
            "lastError": raw.get("lastError"),
        }
    except (ValueError, OSError):
        dev_loop = None
session = {"active": False, "device": device or None}
if os.path.exists(session_lock):
    try:
        with open(session_lock, encoding="utf-8") as fh:
            raw = json.load(fh)
        expires = raw.get("expiresAt")
        expires_dt = datetime.fromisoformat(expires.replace("Z", "+00:00")) if isinstance(expires, str) else None
        active = bool(raw.get("owner")) and expires_dt is not None and expires_dt > datetime.now(timezone.utc)
        session = {
            "active": active,
            "expired": bool(raw.get("owner")) and not active,
            "owner": raw.get("owner"),
            "purpose": raw.get("purpose"),
            "device": raw.get("device") or device or None,
            "createdAt": raw.get("createdAt"),
            "updatedAt": raw.get("updatedAt"),
            "expiresAt": raw.get("expiresAt"),
        }
    except (ValueError, OSError):
        session = {"active": False, "device": device or None, "error": "unreadable_lock"}
payload = {
    "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "runtime": {
        "state": state,
        "adbDeviceId": device or None,
        "bootCompleted": boot == "true",
        "detail": detail,
    },
    "matrix": matrix,
    "devLoop": dev_loop,
    "session": session,
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