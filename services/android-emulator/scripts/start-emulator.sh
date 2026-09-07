#!/usr/bin/env bash
# Start the headless Android emulator stack on tori (192.168.0.20).
# Managed by systemd unit android-emulator.service; not meant to be run by hand
# except for troubleshooting. See docs/operations/android-emulator-runbook.md.
set -euo pipefail

export ANDROID_SDK_ROOT=/opt/android-sdk
export ANDROID_HOME=/opt/android-sdk
export PATH="$PATH:/opt/android-sdk/emulator:/opt/android-sdk/platform-tools"

AVD_NAME="agent_feedback"
DISPLAY_NUM=":99"
DISPLAY_W="1080"
DISPLAY_H="1920"
LOG_DIR="/opt/android-emulator/logs"
EMULATOR_PORT="5554"

mkdir -p "$LOG_DIR"

# 1) Virtual display (the emulator needs an X display even when headless).
if ! pgrep -f "Xvfb ${DISPLAY_NUM}" >/dev/null 2>&1; then
  Xvfb "${DISPLAY_NUM}" -screen 0 "${DISPLAY_W}x${DISPLAY_H}x24" -nolisten tcp \
    >"$LOG_DIR/xvfb.log" 2>&1 &
  sleep 1
fi
export DISPLAY="${DISPLAY_NUM}"

# 2) Emulator (KVM-accelerated; swiftshader software GPU, no snapshots on boot
#    so state always reflects the last clean shutdown's persisted userdata).
if ! pgrep -f "qemu-system-x86_64 -avd ${AVD_NAME}" >/dev/null 2>&1; then
  /opt/android-sdk/emulator/emulator \
    -avd "${AVD_NAME}" \
    -gpu swiftshader_indirect \
    -no-audio \
    -no-boot-anim \
    -no-snapshot-load \
    -port "${EMULATOR_PORT}" \
    >"$LOG_DIR/emulator.log" 2>&1 &
fi

# Wait for the device to be reachable over adb and fully booted.
echo "Waiting for emulator boot (adb)..." >&2
for i in $(seq 1 120); do
  if adb -s "emulator-${EMULATOR_PORT}" get-state 2>/dev/null | grep -q device; then
    boot=$(adb -s "emulator-${EMULATOR_PORT}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
    if [ "$boot" = "1" ]; then
      echo "Emulator booted." >&2
      exit 0
    fi
  fi
  sleep 2
done
echo "Timed out waiting for emulator boot" >&2
exit 1