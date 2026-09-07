#!/usr/bin/env bash
# Start the LAN-facing noVNC proxy for the headless Android emulator on tori.
# Managed by systemd unit android-novnc.service.
# Serves noVNC (HTML5 VNC client) on http://0.0.0.0:6080 and bridges each
# client's WebSocket to x11vnc on 127.0.0.1:5900. Access requires a token:
#   http://192.168.0.20:6080/vnc.html?token=<TOKEN>
# The token file lives at /opt/android-emulator/novnc/vnc_tokens (mode 0600).
set -euo pipefail

TOKEN_FILE="/opt/android-emulator/novnc/vnc_tokens"
NOVNC_WEB="/usr/share/novnc"

# x11vnc on 127.0.0.1:5900 must already be running (see android-vnc.service).
# With --token-plugin, the target is read from the token file
# (token: host:port), so no explicit target arg is passed.
exec /usr/bin/websockify \
  --token-plugin=TokenFile \
  --token-source="$TOKEN_FILE" \
  --web="$NOVNC_WEB" \
  6080