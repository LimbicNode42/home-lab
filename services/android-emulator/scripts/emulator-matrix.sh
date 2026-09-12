#!/usr/bin/env bash
# Android emulator device-matrix manager for tori (192.168.0.20).
#
# Runs ONE matrix profile at a time (host RAM constraint: 4 vCPU / ~7.7 GiB),
# each on its own Xvfb display and adb console port. The persistent
# agent_feedback AVD (display :99, adb 5554) is managed by systemd and is NOT
# touched here. Profile definitions live in matrix.json next to this script.
#
# Usage:
#   emulator-matrix.sh create    # create any missing AVDs (idempotent)
#   emulator-matrix.sh start <id>       # start a profile (stops any other matrix profile)
#   emulator-matrix.sh stop             # stop the running matrix profile (soft)
#   emulator-matrix.sh status           # table of matrix profiles + running state
#   emulator-matrix.sh install <id> <apk>
#   emulator-matrix.sh smoke <id> <apk>  # boot-if-needed + install + launch + screenshot
#
# Env overrides: MATRIX_JSON, ANDROID_SDK_ROOT, MATRIX_ACTIVE_FILE
set -euo pipefail

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
export ANDROID_SDK_ROOT ANDROID_HOME="$ANDROID_SDK_ROOT"
SDK="$ANDROID_SDK_ROOT"
export PATH="$SDK/platform-tools:$SDK/emulator:$SDK/cmdline-tools/latest/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MATRIX_JSON="${MATRIX_JSON:-$HERE/matrix.json}"
ACTIVE_FILE="${MATRIX_ACTIVE_FILE:-/opt/android-emulator/run/matrix-active.json}"
LOG_DIR="${MATRIX_LOG_DIR:-/opt/android-emulator/logs}"
LOCK_DIR="${MATRIX_LOCK_DIR:-/opt/android-emulator/run}"
mkdir -p "$LOG_DIR" "$LOCK_DIR"

json_require() { command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 1; }; }
json_require

profiles() { jq -c '.profiles[]' "$MATRIX_JSON"; }
profile_ids() { jq -r '.profiles[].id' "$MATRIX_JSON"; }
profile_by_id() {
  local id="$1" p
  p="$(profiles | jq -e --arg id "$id" 'select(.id == $id)')" || {
    echo "ERROR: unknown profile '$id'. Known ids:" >&2
    profiles | jq -r '.id' >&2
    exit 2
  }
  printf '%s\n' "$p"
}
pval() { jq -r "$2" <<<"$1"; }

is_pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

run_avd_pid() {
  local avd="$1"
  pgrep -f "qemu-system-x86_64 -avd ${avd} " 2>/dev/null | head -1 || true
}

adb_serial() { echo "emulator-$(pval "$1" '.adb_port')"; }

wait_boot() {
  local serial="$1" i
  for i in $(seq 1 120); do
    if adb -s "$serial" get-state 2>/dev/null | grep -qx device; then
      if [ "$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

stop_profile() {
  local avd="$1" serial="$2" disp="$3" pid
  pid="$(run_avd_pid "$avd")"
  if [ -n "$pid" ]; then
    # Soft shutdown via adb (persists userdata), fall back to SIGTERM.
    adb -s "$serial" emu kill >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do is_pid_alive "$pid" || break; sleep 1; done
    is_pid_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
  fi
  # Release the Xvfb display for this profile.
  [ -n "${disp:-}" ] && pkill -f "Xvfb ${disp} " 2>/dev/null || true
}

cmd_create() {
  local p avd dev id
  local -a missing=()
  for id in $(profile_ids); do
    p="$(profile_by_id "$id")"
    avd="$(pval "$p" '.avd_name')"
    if [ -d "/root/.android/avd/${avd}.avd" ]; then
      echo "present: $avd"
    else
      missing+=("$p")
    fi
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    echo "all matrix AVDs present"
    return 0
  fi
  for p in "${missing[@]}"; do
    avd="$(pval "$p" '.avd_name')"
    dev="$(pval "$p" '.device_definition')"
    img="$(jq -r '.system_image' "$MATRIX_JSON")"
    echo "creating $avd (device=$dev)..."
    echo "no" | avdmanager create avd -n "$avd" -k "$img" -d "$dev" --force >/dev/null 2>&1
    # Bump data partition for debug-APK headroom.
    sed -i 's/^disk.dataPartition.size=.*/disk.dataPartition.size=2048M/' \
      "/root/.android/avd/${avd}.avd/config.ini"
    echo "created: $avd"
  done
}

cmd_start() {
  local id="${1:-}" p avd port disp serial pid
  [ -n "$id" ] || { echo "usage: $0 start <id>" >&2; exit 2; }
  p="$(profile_by_id "$id")"
  avd="$(pval "$p" '.avd_name')"
  port="$(pval "$p" '.adb_port')"
  disp="$(pval "$p" '.display')"
  serial="$(adb_serial "$p")"

  # Ensure a running emulator instance on this profile's port.
  if adb -s "$serial" get-state 2>/dev/null | grep -qx device; then
    echo "already running: $id ($serial, $disp)"
  else
    # Stop any other matrix profile first (one-at-a-time policy).
    local other oid oavd
    for oid in $(profile_ids); do
      [ "$oid" = "$id" ] && continue
      other="$(profile_by_id "$oid")"
      oavd="$(pval "$other" '.avd_name')"
      pid="$(run_avd_pid "$oavd")"
      if [ -n "$pid" ]; then
        echo "stopping other profile: $oid"
        stop_profile "$oavd" "$(adb_serial "$other")" "$(pval "$other" '.display')"
      fi
    done

    if ! pgrep -f "Xvfb ${disp} " >/dev/null 2>&1; then
      Xvfb "$disp" -screen 0 1300x2600x24 -nolisten tcp >"$LOG_DIR/xvfb-${id}.log" 2>&1 &
      sleep 1
    fi
    export DISPLAY="$disp"
    nohup emulator -avd "$avd" -gpu swiftshader_indirect -no-audio -no-boot-anim \
      -no-snapshot-load -port "$port" >"$LOG_DIR/emulator-${id}.log" 2>&1 &
    echo "starting $id ($serial, $disp)..."
  fi

  echo -n "waiting for boot "
  if wait_boot "$serial"; then
    echo "ok"
    write_active "$p" "$serial"
    echo "active: $id"
  else
    echo "TIMEOUT"
    return 1
  fi
}

write_active() {
  local p="$1" serial="$2" now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jq -n --arg id "$(pval "$p" '.id')" --arg avd "$(pval "$p" '.avd_name')" \
    --arg label "$(pval "$p" '.label')" --arg serial "$serial" \
    --arg startedAt "$now" --arg json "$MATRIX_JSON" \
    '{id:$id, avdName:$avd, label:$label, serial:$serial, startedAt:$startedAt}' \
    >"$ACTIVE_FILE"
}

cmd_stop() {
  for id in $(profile_ids); do
    local p avd; p="$(profile_by_id "$id")"; avd="$(pval "$p" '.avd_name')"
    pid="$(run_avd_pid "$avd")"
    if [ -n "$pid" ]; then
      echo "stopping $id..."
      stop_profile "$avd" "$(adb_serial "$p")" "$(pval "$p" '.display')"
    fi
  done
  rm -f "$ACTIVE_FILE"
  echo "matrix stopped"
}

cmd_status() {
  printf '%-8s %-14s %-9s %-12s %-9s %s\n' "PROFILE" "AVD" "PORT" "RESOLUTION" "RATIO" "STATE"
  for id in $(profile_ids); do
    local p avd port res ratio serial pid state="-"
    p="$(profile_by_id "$id")"; avd="$(pval "$p" '.avd_name')"
    port="$(pval "$p" '.adb_port')"; res="$(pval "$p" '.resolution')"
    ratio="$(pval "$p" '.aspect_ratio')"; serial="$(adb_serial "$p")"
    if adb -s "$serial" get-state 2>/dev/null | grep -qx device; then
      if [ "$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
        state="running"
      else
        state="booting"
      fi
    else
      state="stopped"
    fi
    printf '%-8s %-14s %-9s %-12s %-9s %s\n' "$id" "$avd" "$port" "$res" "$ratio" "$state"
  done
  if [ -f "$ACTIVE_FILE" ]; then
    echo
    echo "active: $(jq -r '.id + \" (\" + .serial + \", started \" + .startedAt + \")\"' "$ACTIVE_FILE")"
  fi
}

cmd_install() {
  local id="${1:-}" apk="${2:-}" p serial
  [ -n "$id" ] && [ -n "$apk" ] || { echo "usage: $0 install <id> <apk>" >&2; exit 2; }
  [ -f "$apk" ] || { echo "ERROR: apk not found: $apk" >&2; exit 2; }
  p="$(profile_by_id "$id")"; serial="$(adb_serial "$p")"
  if ! adb -s "$serial" get-state 2>/dev/null | grep -qx device; then
    echo "not running; starting $id..." >&2
    cmd_start "$id"
  fi
  adb -s "$serial" install -r "$apk"
  echo "installed to $id"
}

cmd_smoke() {
  local id="${1:-}" apk="${2:-}" p serial pkg
  [ -n "$id" ] && [ -n "$apk" ] || { echo "usage: $0 smoke <id> <apk>" >&2; exit 2; }
  p="$(profile_by_id "$id")"; serial="$(adb_serial "$p")"
  if ! adb -s "$serial" get-state 2>/dev/null | grep -qx device; then
    cmd_start "$id"
  fi
  adb -s "$serial" install -r "$apk" >/dev/null 2>&1 || { echo "install FAILED" >&2; return 1; }
  pkg="$(aapt dump badging "$apk" 2>/dev/null | grep -oP "package: name='\K[^']+")"
  [ -n "$pkg" ] || pkg="com.limbicnode.unified_inbox_mobile"
  adb -s "$serial" shell monkey -p "$pkg" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 3
  local shot="$LOG_DIR/smoke-${id}.png"
  adb -s "$serial" exec-out screencap -p >"$shot"
  local pkg_ok; pkg_ok="$(adb -s "$serial" shell pm list packages -3 2>/dev/null | grep -c "$pkg" || true)"
  echo "smoke $id: package_present=$pkg_ok screenshot=$shot bytes=$(stat -c%s "$shot" 2>/dev/null || echo 0)"
  [ "$pkg_ok" -ge 1 ] || return 1
}

case "${1:-}" in
  create)  cmd_create ;;
  start)   cmd_start "${2:-}" ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  install) cmd_install "${2:-}" "${3:-}" ;;
  smoke)   cmd_smoke "${2:-}" "${3:-}" ;;
  *) echo "usage: $0 {create|start <id>|stop|status|install <id> <apk>|smoke <id> <apk>}" >&2; exit 2 ;;
esac