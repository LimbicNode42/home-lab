#!/usr/bin/env bash
# Start an interactive x11vnc session against the emulator's Xvfb display :99.
# x11vnc stays localhost-only; noVNC/websockify is the only network bridge.
set -euo pipefail

LOG_DIR="/opt/android-emulator/logs"
mkdir -p "$LOG_DIR"

exec /usr/bin/x11vnc \
  -display :99 \
  -forever \
  -shared \
  -localhost \
  -nopw \
  -rfbport 5900 \
  -quiet \
  -logfile "$LOG_DIR/x11vnc.log" \
  -noxdamage \
  -wait 20 \
  -repeat
