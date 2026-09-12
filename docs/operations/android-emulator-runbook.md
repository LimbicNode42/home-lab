# Android Emulator (agent_feedback) — Runbook

Status: LIVE. This is the persistent, network-accessible Android surface Ben uses to
review unified-inbox output and give the agents feedback from any LAN host, without
touching his physical Android device.

## What it is

A headless Android 16 (API 36) AVD named `agent_feedback`, running under the Android
emulator (KVM-accelerated, `swiftshader_indirect` software GPU) on Proxmox node
`tori` (192.168.0.20). The display is an Xvfb framebuffer (`:99`) exported via
x11vnc (localhost-only) and bridged to the LAN by a token-gated noVNC HTML5 client.

- Host: `tori` (192.168.0.20)
- AVD: `agent_feedback` (x86_64, 2 vCPU, 1536 MB RAM, 4 GB userdata, Google APIs)
- Android release: 16 (SDK 36)
- Installed app: `com.limbicnode.unified_inbox_mobile` (Unified Inbox mobile client)
- Backend the app targets: `http://192.168.0.50:8766` (unified-inbox on `critical`)

## Why this shape (research / tradeoff decision)

Three options were weighed for a persistent Android surface:

| Option | Resource cost | Notes | Verdict |
|---|---|---|---|
| Android-x86 VM under Proxmox (QEMU VM) | 1 full VM: 2 vCPU + 2–4 GB RAM, dedicated qcow2, boot time 30–60s | Heaviest; a full VM duplicated the node's QEMU path and added Proxmox guest management for a single display surface | Chose NOT |
| Headless AVD (Android emulator) | 1 process, shared node QEMU/KVM, 1536 MB RAM, ~5 min cold boot once | Lightest persistent option; reuses the node's existing Android SDK toolchain Ben already uses for Flutter builds; KVM-accelerated on bare metal | **Chosen** |
| Containerized AVD (redroid / docker-android) | ~1 container, similar RAM | Cleaner isolation but adds a privileged/binder-kernel dependency and a second Android toolchain; weaker fit vs the already-present SDK + KVM path | Rejected for now |

The AVD wins on lightness and lowest new moving parts: it lives on the node Ben
already builds the Flutter app on, uses the same SDK, and persists userdata across
restarts with no Proxmox guest to babysit. If Ben later wants multi-tenant or
isolated Android surfaces, redroid is the documented fall-forward.

## Connect procedure

1. From any trusted-LAN host, open:
   `http://192.168.0.20:6080/vnc.html?token=<TOKEN>`
2. The token is the shared secret in `/opt/android-emulator/novnc/vnc_tokens`
   (mode 0600) on `tori`. Retrieve it with:
   `sudo cat /opt/android-emulator/novnc/vnc_tokens | cut -d: -f1`
   (format is `token:host:port`; only the token part is needed in the URL).
3. Once the noVNC canvas loads, the AVD is interactive: tap to click, drag to
   scroll, keyboard passes through.
4. Open the Unified Inbox app (launcher icon) to review messages.

No VNC port is exposed to the LAN — x11vnc binds `127.0.0.1:5900` only, and the
token-gated websockify is the sole ingress. This is trusted-LAN only; there is no
Cloudflare Tunnel route and no public hostname for this service.

## adb access (operator)

From `tori` (or any host with `adb` and reachability to the node):

```
adb devices          # expect: emulator-5554  device
adb -s emulator-5554 shell getprop sys.boot_completed   # expect: 1
adb -s emulator-5554 shell pm list packages -3          # expect: com.limbicnode.unified_inbox_mobile
adb -s emulator-5554 shell monkey -p com.limbicnode.unified_inbox_mobile -c android.intent.category.LAUNCHER 1
adb -s emulator-5554 exec-out screencap -p > screen.png  # read-only screenshot
```

Note: adb is bound to loopback (`127.0.0.1:5554/5555`) on the node by default —
not network-exposed. This is deliberate (least privilege). An adb-over-network
endpoint was not stood up; use SSH + adb, or noVNC, for remote drive. If network
adb is ever required, it must be token/auth-gated and LAN-only.

## Start / stop / restart

All four components are systemd services on `tori`, enabled at boot:

| Unit | Role |
|---|---|
| `android-xvfb.service` | Xvfb framebuffer `:99` |
| `android-emulator.service` | The emulator process (agent_feedback AVD) |
| `android-vnc.service` | x11vnc on `127.0.0.1:5900` (localhost only) |
| `android-novnc.service` | websockify noVNC on `0.0.0.0:6080`, token-gated |

```
sudo systemctl status android-emulator android-xvfb android-vnc android-novnc

sudo systemctl stop android-novnc    # brings web ingress down
sudo systemctl stop android-vnc android-emulator android-xvfb   # full stop, reverse order
sudo systemctl start android-xvfb android-emulator android-vnc android-novnc
```

`android-emulator.service` runs with `-no-snapshot-load`, so every start reflects
the last clean shutdown's persisted userdata (AVD is stored under
`/root/.android/avd/agent_feedback.avd/`). Graceful shutdown (`adb -s emulator-5554
emu kill` or `systemctl stop`) persists state; a hard node reboot re-launches
cleanly via the enabled units.

## Persistence / reboot survival

- AVD data: `/root/.android/avd/agent_feedback.avd/` (userdata survives reboots).
- Scripts: `/opt/android-emulator/scripts/` (start-emulator.sh, start-vnc.sh,
  start-novnc.sh).
- Logs: `/opt/android-emulator/logs/`.
- All four units are `enabled` (WantedBy=multi-user.target), verified
  `systemctl is-enabled` = enabled on 2026-09-05.

## Post-deploy verification checklist

- [x] `systemctl is-active` for all four units = active
- [x] `adb -s emulator-5554 shell getprop sys.boot_completed` = 1
- [x] 3rd-party package list includes `com.limbicnode.unified_inbox_mobile`
- [x] App launches to `.../.MainActivity` via monkey
- [x] Backend reachable from inside emulator (ping 192.168.0.50 OK; host curl to
      `/api/unified-inbox/status` returns `status: ok`)
- [x] noVNC answers HTTP 200 on http://192.168.0.20:6080/vnc.html
- [x] x11vnc bound to loopback only (no LAN 5900 exposure)

## Open items / follow-ups

- Move the noVNC token into Vaultwarden (folder `homelab`, item
  `android-emulator/novnc-token`) and render the token file from a ref instead of a
  hand-written local secret. Low urgency — the file is already 0600 root-only.
- Optionally stand up a token-gated network-adb endpoint if Ben wants direct
  `adb install`/`adb logcat` from his workstation without SSH.
- Consider a dashboard status-checks entry so the Home Dashboard shows emulator
  liveness/freshness (see the `mobileWorkflow` note added to
  `dashboard.public.json`).

## Authenticated read-only dashboard viewer

The safe browser path is the Home Dashboard proxy, not the raw tori noVNC URL:

- Dashboard href: `/mobile-viewer/`
- Upstream noVNC: `http://192.168.0.20:6080`
- Backend token file on tori: `/opt/android-emulator/novnc/vnc_tokens` (not exposed to browsers)
- Dashboard secret mount on critical: `/var/lib/personal-dashboard/secrets/mobile-viewer-novnc-token` -> `/run/secrets/mobile-viewer-novnc-token`

The dashboard requires its existing reverse-proxy auth header before serving `/mobile-viewer/` or accepting the WebSocket upgrade. It injects the noVNC token only on the server-side upstream WebSocket request. `x11vnc` runs with `-viewonly`, so the exposed surface is for review/screenshot/stream feedback, not input control.
