#!/usr/bin/env bash
# Start x11vnc against the emulator's Xvfb display :99, bound to localhost only.
# Managed by systemd unit android-vnc.service. noVNC bridges this over
# WebSocket with token auth; nothing reaches 5900 directly from the LAN.
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