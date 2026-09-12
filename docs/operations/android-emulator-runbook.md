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

1. Preferred: open the Home Dashboard Overview tile and use `/mobile-viewer/`.
   The dashboard requires its existing reverse-proxy auth header, then proxies the
   noVNC client and WebSocket without exposing backend tokens to the browser.
2. The Overview tile now marks the viewer as `authenticated_interactive` and
   exposes bounded controls for tap, swipe, type, Back, Home, rotate, screenshot,
   and stream/screenshot refresh. These controls go through the dashboard and a
   token-gated `android-control.service` on `tori`; ADB remains loopback-only on
   `tori`.
3. Operator fallback from trusted LAN only: open
   `http://192.168.0.20:6080/vnc.html?token=<TOKEN>`. The token is the shared
   secret in `/opt/android-emulator/novnc/vnc_tokens` (mode 0600) on `tori`.
4. Once the noVNC canvas loads, the AVD is interactive: tap to click, drag to
   scroll, keyboard passes through. Open the Unified Inbox app (launcher icon)
   to review messages.

No VNC port is exposed to the LAN — x11vnc binds `127.0.0.1:5900` only, and the
token-gated websockify is the sole non-dashboard ingress. This is trusted-LAN only;
there is no Cloudflare Tunnel route, public hostname, VNC exposure, or ADB exposure
for this service.

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

## Device matrix (multi-profile testing)

Beyond the persistent `agent_feedback` AVD, `tori` hosts a declarative Android
device matrix for realistic multi-screen mobile testing. Profiles are defined in
`services/android-emulator/matrix.json` (Git) and managed by
`services/android-emulator/scripts/emulator-matrix.sh` (deployed to
`/opt/android-emulator/`).

| id | AVD | Device | Resolution | Density | Ratio | Orientation | RAM | adb port | display |
|---|---|---|---|---|---|---|---|---|---|
| `small` | `matrix_small` | Nexus 5 | 1080x1920 | 480 | 16:9 | portrait | 1536M | 5564 | :98 |
| `tall` | `matrix_tall` | pixel_6 | 1080x2400 | 420 | 20:9 | portrait | 1536M | 5574 | :97 |
| `large` | `matrix_large` | pixel_6_pro | 1440x3120 | 560 | 19.5:9 | portrait | 2048M | 5584 | :96 |
| `tablet` | `matrix_tablet` | Nexus 10 | 2560x1600 | 320 | 16:10 | landscape | 2048M | 5594 | :95 |

All profiles use `system-images;android-36;google_apis;x86_64` (Android 16 / API
36), software GPU (`swiftshader_indirect`), and a 2048M data partition. `tall` is
the default profile.

### Capacity constraint (one-at-a-time)

`tori` has 4 vCPU / ~7.7 GiB RAM. A single software-GL emulator already peaks at
~4.7 GiB, so **only one matrix profile runs at a time** — and it must not run
concurrently with the resident `agent_feedback` AVD. A concurrent boot of two
software-GL emulators OOMs the node and crashes both (observed 2026-09-12). The
manager script enforces this by stopping any other matrix profile before starting
a new one; the operator must additionally stop `agent_feedback` (or accept the
risk) before running a matrix profile. `large` and `tablet` are the most
RAM-hungry and are the first to defer under memory pressure.

### Commands

```bash
# On tori, as root:
cd /opt/android-emulator
./scripts/emulator-matrix.sh create            # create missing AVDs (idempotent)
./scripts/emulator-matrix.sh status            # table of profiles + running state
./scripts/emulator-matrix.sh start tall        # start a profile (stops other matrix profiles)
./scripts/emulator-matrix.sh stop              # stop the running matrix profile
./scripts/emulator-matrix.sh install tall <apk>
./scripts/emulator-matrix.sh smoke tall <apk>  # boot-if-needed + install + launch + screenshot
```

The active profile is written to `/opt/android-emulator/run/matrix-active.json`
and surfaced in the Home Dashboard mobile-workflow status (`matrix` +
`deviceMatrix` fields) via `publish-dashboard-status.sh`.

### Verification receipts (2026-09-12)

- `small`: boot=1, 1080x1920@480, `com.limbicnode.unified_inbox_mobile` installed,
  smoke screenshot `logs/smoke-small.png` (valid 1080x1920 PNG).
- `tall`: boot=1, 1080x2400@420, app installed + launched, smoke screenshot
  `logs/smoke-tall.png` (valid 1080x2400 PNG).
- `large` / `tablet`: AVDs created and config-validated, but **not boot-verified**
  — deferred due the 4 vCPU / ~7.7 GiB single-emulator capacity wall. They boot
  one-at-a-time via the same manager script when capacity allows.

### Verification receipts (2026-09-13 — large/tablet smoke complete)

- `large`: boot=1, 1440x3120@560, app installed + launched, smoke screenshot
  `logs/smoke-large.png` (valid 1440x3120 PNG). Boot took ~4.5 min cold; the
  first `install` attempt hit a transient `system_server` watchdog restart
  (`DeadSystemException` / `Service package: not found`) that self-recovered in
  ~1 min — a retry after the package service returned succeeded. This is the
  known software-GL + 2 vCPU cold-boot fragility, not an app defect.
- `tablet`: boot=1, 2560x1600@320, app installed + launched, smoke screenshot
  `logs/smoke-tablet.png` (valid 2560x1600 PNG). Boot ~5 min cold.

All four matrix profiles are now boot/install/smoke verified. The resident
`agent_feedback` AVD was stopped for the smoke window and restored afterwards
(boot=1, app present, all five systemd units active, ports loopback-only).

## ADB/screencap stall remediation (2026-09-13)

The intermittent dashboard screenshot 502 was root-caused to `adb exec-out
screencap -p` exceeding the 20s `ANDROID_CONTROL_TIMEOUT` under node load
(loadavg 4–6 on 4 vCPU while the resident emulator idles at ~45% CPU). Control
verbs (`input tap`, `keyevent`, etc.) are lightweight and returned in <1s, so
only the screenshot path stalled. The fix, applied to
`android-control.service` on tori:

- Serialize screencap calls behind a process lock so concurrent dashboard
  refreshes cannot wedge adb.
- Retry up to `ANDROID_SCREENSHOT_ATTEMPTS` (3) with linear backoff
  (`ANDROID_SCREENSHOT_BACKOFF` 0.75s) before returning 502.
- Emit sanitized health diagnostics (`adbState`, `bootCompleted`, `display`)
  on failure and as response headers (`x-android-screenshot-attempts`,
  `x-android-screenshot-elapsed-ms`).
- Dashboard side: a dedicated `MOBILE_SCREENSHOT_TIMEOUT_MS` (default 30000)
  decouples the screenshot fetch timeout from the 20s control timeout.

Verified live: 6 sequential + 8 concurrent screenshot requests through the
bridge all returned 200 with valid PNGs; no stalls. ADB, x11vnc, and control
ports remain loopback/token-gated as before.

## Open items / follow-ups

- Move the noVNC token into Vaultwarden (folder `homelab`, item
  `android-emulator/novnc-token`) and render the token file from a ref instead of a
  hand-written local secret. Low urgency — the file is already 0600 root-only.
- Optionally stand up a token-gated network-adb endpoint if Ben wants direct
  `adb install`/`adb logcat` from his workstation without SSH.
- Consider a dashboard status-checks entry so the Home Dashboard shows emulator
  liveness/freshness (see the `mobileWorkflow` note added to
  `dashboard.public.json`).

## Authenticated interactive dashboard viewer

The safe browser path is the Home Dashboard proxy, not the raw tori noVNC URL:

- Dashboard href: `/mobile-viewer/`
- Upstream noVNC: `http://192.168.0.20:6080`
- Backend token file on tori: `/opt/android-emulator/novnc/vnc_tokens` (not exposed to browsers)
- Dashboard secret mount on critical: `/var/lib/personal-dashboard/secrets/mobile-viewer-novnc-token` -> `/run/secrets/mobile-viewer-novnc-token`
- Control transport: Home Dashboard `/api/mobile-workflow/control` -> token-gated `android-control.service` on `http://192.168.0.20:6081` -> `/opt/android-sdk/platform-tools/adb -s emulator-5554 ...`
- Screenshot transport: Home Dashboard `/api/mobile-workflow/screenshot` -> token-gated `android-control.service` -> `adb exec-out screencap -p`

The dashboard requires its existing reverse-proxy auth header before serving `/mobile-viewer/`, accepting the WebSocket upgrade, accepting control POSTs, or returning screenshots. It injects the noVNC token only on the server-side upstream WebSocket request. `x11vnc` stays bound to loopback, but now runs without `-viewonly`; the dashboard controls and noVNC canvas are intentionally interactive after authentication. ADB stays loopback-only on `tori` and is not exposed as a network service.

Rollback: restore `-viewonly` in `/opt/android-emulator/scripts/start-vnc.sh`, restart only `android-vnc.service`, and revert the dashboard `mobileWorkflow.viewer.mode` to `authenticated_novnc`/read-only. If dashboard controls misbehave, unset the `MOBILE_CONTROL_*` env vars or roll back the dashboard container image/config without touching Hermes gateway.
