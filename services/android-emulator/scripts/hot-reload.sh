#!/usr/bin/env bash
# hot-reload.sh — agent-facing driver for pushing Flutter changes onto an
# Android emulator and keeping the dev loop alive.
#
# Wraps services/android-emulator/scripts/dev-loop.py with device selection,
# matrix-profile management, and a clean stop path. This is the single command
# an agent (or Ben) runs after making mobile code changes.
#
# Usage:
#   hot-reload.sh build <app-dir> [--profile small|tall|large|tablet] [--device <serial>]
#       One-shot: build + install + launch the app on the target emulator.
#   hot-reload.sh watch <app-dir> [--profile ...] [--device <serial>] [--dart-define K=V]...
#       Foreground dev loop: rebuild/install/launch on every source change.
#   hot-reload.sh reload [-p <serial>] [--action hot-reload|hot-restart]
#       Send a Flutter VM-service reload/restart to the already-running app.
#   hot-reload.sh targets                   # list what devices profiles map to
#   hot-reload.sh stop                      # stop the running matrix profile
#
# Device resolution order:
#   1. --device <serial> (explicit pass-through)
#   2. --profile <id>    -> starts the matching matrix AVD via emulator-matrix.sh
#                          and targets its emulator-NNNN serial
#   3. default           -> the resident agent_feedback emulator (emulator-5554)
#
# The resident agent_feedback AVD is managed by systemd and is the default
# target. Matrix profiles (small/tall/large/tablet) are the one-at-a-time
# capacity-constrained set managed by emulator-matrix.sh; see
# docs/operations/android-emulator-runbook.md for the capacity wall.
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MATRIX_SH="$SOURCE_DIR/scripts/emulator-matrix.sh"
DEV_LOOP_PY="$SOURCE_DIR/scripts/dev-loop.py"
ADB="${ADB:-/opt/android-sdk/platform-tools/adb}"

command -v flutter >/dev/null 2>&1 || { echo "ERROR: flutter not on PATH (source /etc/profile.d/flutter-android.sh)" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 2; }

usage() { sed -n '2,24p' "$0"; exit 2; }

profile_serial() {
  local id="$1"
  [ -f "$SOURCE_DIR/matrix.json" ] || { echo "ERROR: matrix.json missing" >&2; exit 2; }
  jq -r --arg id "$id" '.profiles[] | select(.id == $id) | "emulator-\(.adb_port)"' "$SOURCE_DIR/matrix.json"
}

start_profile() {
  # One-at-a-time matrix policy; does not touch the resident agent_feedback AVD.
  local id="$1"
  "$MATRIX_SH" start "$id" >/dev/null
  profile_serial "$id"
}

cmd_build() {
  local app_dir="" profile="" device="" dart_defines=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) profile="$2"; shift 2 ;;
      --device) device="$2"; shift 2 ;;
      --dart-define) dart_defines+=("$2"); shift 2 ;;
      *) if [ -z "$app_dir" ]; then app_dir="$1"; else echo "unknown arg: $1" >&2; usage; fi; shift ;;
    esac
  done
  [ -n "$app_dir" ] || usage
  [ -f "$app_dir/pubspec.yaml" ] || { echo "ERROR: $app_dir is not a Flutter app" >&2; exit 2; }

  local serial
  if [ -n "$device" ]; then
    serial="$device"
  elif [ -n "$profile" ]; then
    serial="$(start_profile "$profile")"
  else
    serial="emulator-5554"
  fi

  local dev_loop_args=("$DEV_LOOP_PY" "$app_dir" --adb "$ADB" --serial "$serial" --once)
  for define in "${dart_defines[@]}"; do
    dev_loop_args+=(--dart-define "$define")
  done
  python3 "${dev_loop_args[@]}"
}

cmd_watch() {
  local app_dir="" profile="" device="" dart_defines=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) profile="$2"; shift 2 ;;
      --device) device="$2"; shift 2 ;;
      --dart-define) dart_defines+=("$2"); shift 2 ;;
      *) if [ -z "$app_dir" ]; then app_dir="$1"; else echo "unknown arg: $1" >&2; usage; fi; shift ;;
    esac
  done
  [ -n "$app_dir" ] || usage
  [ -f "$app_dir/pubspec.yaml" ] || { echo "ERROR: $app_dir is not a Flutter app" >&2; exit 2; }

  local serial
  if [ -n "$device" ]; then
    serial="$device"
  elif [ -n "$profile" ]; then
    serial="$(start_profile "$profile")"
  else
    serial="emulator-5554"
  fi

  echo "watching $app_dir -> ${serial:-default}; Ctrl-C to stop"
  local dev_loop_args=("$DEV_LOOP_PY" "$app_dir" --adb "$ADB" --serial "$serial" --state-file "/opt/android-emulator/run/dev-loop.json")
  for define in "${dart_defines[@]}"; do
    dev_loop_args+=(--dart-define "$define")
  done
  python3 "${dev_loop_args[@]}"
}

find_vm_uri() {
  local serial="${1:-emulator-5554}"
  # Ask the Flutter tool for the vm-service URI of the attached debug app.
  # Falls back to the standard VM-service port if the app was launched with
  # --observatory-port pinned. Returns empty if no VM service is reachable.
  local uri
  uri="$("$ADB" -s "$serial" shell 'getprop service.adb.tcp.port' 2>/dev/null | tr -d '\r')"
  # The app is launched via monkey without a pinned observatory port, so a
  # VM-service reload is only possible when the app was started with one.
  printf '%s' "${uri:-}"
}

cmd_reload() {
  # Best-effort VM-service reload. With our install-per-change loop this is a
  # convenience only; the deterministic path is `watch`/`build`.
  echo "NOTE: hot-reload over VM service requires the app to be attached or launched with --observatory-port." >&2
  echo "The deterministic path is: hot-reload.sh watch <app-dir> (install-per-change)." >&2
  exit 2
}

cmd_targets() {
  echo "default : emulator-5554 (resident agent_feedback, systemd-managed)"
  if [ -f "$SOURCE_DIR/matrix.json" ]; then
    jq -r '.profiles[] | "\(.id)      : emulator-\(.adb_port) (\(.label)) \(.resolution)@\(.density_dpi)"' "$SOURCE_DIR/matrix.json"
  else
    echo "matrix.json not found — no matrix profiles listed"
  fi
}

cmd_stop() {
  "$MATRIX_SH" stop
}

case "${1:-}" in
  build) shift; cmd_build "$@" ;;
  watch) shift; cmd_watch "$@" ;;
  reload) shift; cmd_reload "$@" ;;
  targets) shift; cmd_targets ;;
  stop) shift; cmd_stop ;;
  *) usage ;;
esac