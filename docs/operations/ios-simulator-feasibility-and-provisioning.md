# iOS Simulator Lane — Feasibility and Provisioning Path

Status: BLOCKED — no macOS/Xcode host available in the homelab.
Task: t_cf3b7630 (mobile emulator matrix: iOS simulator feasibility and provisioning path)
Author: scribe
Date: 2026-09-12

## Verdict

There is **no macOS/Xcode-capable host** in the homelab, and none is present on
the local network. A real Apple iOS Simulator cannot be stood up on the current
inventory, and no Linux host can be made to run one (the iOS Simulator is
macOS/Xcode-only — there is no legitimate Linux equivalent). The correct action
is to **block** this lane until Ben either provisions macOS hardware or approves
a cloud macOS/device-farm option.

This is not a matter of "got close and needs polish": the prerequisite host
class is simply absent.

## Discovery evidence

Sources checked (all read-only, 2026-09-12):

1. **Committed host inventory** — `infrastructure/hosts/inventory.yml` lists the
   full node set: `emperor`, `shogun`, `jester`, `tori`, `toyota` (Proxmox nodes),
   plus LXC guests `critical`, `dev`, `staging`, `prod`. Every host is Linux
   (Debian 12/13, Ubuntu 24.04, Alpine 3.18). No macOS, no Darwin.

2. **Nmap key-host scan** — `inventory/nmap-key-hosts-summary.json` fingerprints
   vendor by OUI. Hardware vendors present: Raspberry Pi Trading, ASRock,
   Gigabyte, TP-Link, TCL, Proxmox Server Solutions (QEMU virtual NICs). **Zero
   Apple MAC OUI prefixes.** Notably `192.168.0.100` (Gigabyte) is a Windows host
   (RPC/NetBIOS/WinRM), not a Mac.

3. **Live ARP table on `tori`** (this host) — `ip neigh show` at task time shows
   live neighbours: Raspberry Pi, Proxmox, TP-Link, TCL, Gigabyte OUIs and
   randomized/privacy MACs for client devices. Still **no Apple OUI**.

4. **`flutter-mobile-workflow` skill** (verified install on `tori`) already
   records the constraint in its constraint matrix — iOS: "No — macOS + Xcode +
   signing; not feasible on Linux; route to macOS CI / physical device."

Conclusion: the iOS lane's blocker is a **missing prerequisite asset**, not a
config or effort gap. Nothing I can do on this inventory changes that.

## Constraint (why this is a hard block, not fudgeable)

- iOS Simulator ships only inside Xcode, which runs only on macOS.
- Simulators render through macOS WindowServer/CoreSimulator; there is no
  headless-in-the-CLI-only mode and no Linux build of `simctl`/CoreSimulator.
- Browser/device farms (BrowserStack, Sauce Labs, AWS Device Farm, LambdaTest)
  expose real devices/simulators over the network, but they are **cloud
  services**, not a local simulator lane — "not the same thing" per the task
  constraint. They are an acceptable *alternative* if Ben prefers cloud, but they
  do not satisfy "add an iOS simulator lane to the homelab."

## Options and recommendation

### Option A — Local Mac mini (recommended if self-hosted, always-on)

Recommended for a vendorable, always-on simulator service that integrates with
the existing dashboard the same way the Android matrix does.

- **Hardware**: Apple Silicon Mac mini (M1/M2/M4, 16 GB RAM minimum for
  comfortably running 2–4 concurrent simulators; 8 GB is workable but tight).
- **OS**: current macOS (15/26) with Xcode + Command Line Tools from the App
  Store / developer site. A **free/tier** Apple ID is sufficient to download
  Xcode and run *simulator-only* builds — no paid Developer Program membership
  is required unless Ben needs on-device signing or App Store distribution.
- **Placement**: rack it like any other homelab host. Apple provides no official
  headless mode, so it needs an always-logged-in local admin (auto-login) and a
  real or virtual display for the simulator GUI; use built-in Screen Sharing /
  Apple Remote Desktop / SSH for control.
- **Network/auth shape**: LAN-only. SSH (key-only) + Screen Sharing, surfaced to
  Ben through the existing dashboard reverse-proxy auth boundary. **No** WAN /
  Cloudflare Tunnel route for the simulator control or VNC surface — same
  posture as the Android emulator lane.
- **Estimated setup steps**: (1) provision Mac, (2) install Xcode + CLT, (3)
  enable SSH/auto-login/Screen Sharing, (4) `xcrun simctl` create the device
  matrix (see below), (5) install Flutter, (6) wire a status/control bridge into
  the dashboard (reuse the token-gated pattern from the Android
  `android-control.service`), (7) verify build/install/launch/screenshot loop.

### Option B — Cloud macOS CI (recommended if zero local Apple hardware)

- **GitHub Actions macOS runner** (hosted or self-hosted), or a macOS CI vendor
  (Codemagic, Bitrise) run `flutter build ios --simulator` and the `simctl`
  install/launch/log/screenshot steps in the cloud.
- Simulator-only (unsigned) builds are effectively free on the hosted runners;
  signing for device/App Store adds a paid Apple Developer Program and
  secrets-in-CI considerations.
- **Network/auth shape**: ephemeral runner, results returned as workflow
  artifacts (screenshots, logs, .app bundle). No persistent "viewer on the
  dashboard" — interaction is artifact-based, not live.
- **Setup steps**: add a `.github/workflows/ios-sim.yml`, enable macOS runner,
  link an Apple ID/apple-provider credentials if signing is ever needed.

### Option C — Device-farm cloud (real devices, not a local simulator)

BrowserStack / Sauce Labs / AWS Device Farm / LambdaTest give real iOS devices
and simulators over a network API. Best for cross-device regression, not for an
always-on local lane. Requires a subscription and API-key secret management.

**Recommendation**: Option A (Apple Silicon Mac mini) is the correct fit for a
self-hosted, dashboard-integrated iOS lane. Option B is the correct fit if Ben
would rather pay for CI latency than own Apple hardware. Option C is a
complement for broad device coverage, not a replacement.

## What Ben must approve / provide

To unblock, Ben must choose and provide one of:

1. **Option A**: the Mac mini hardware (or confirm an existing Mac is available
   to be connected to the homelab), plus an Apple ID (free tier fine) for Xcode
   download. I can then do the full provisioning.
2. **Option B**: approval to add a GitHub Actions macOS runner workflow (and,
   if signing is ever needed, an Apple Developer Program membership).
3. **Option C**: a device-farm account and API key.

Until one is chosen, the iOS lane remains `not_available` on the dashboard with
the reason surfaced honestly (see feedback contract below).

## Flutter-on-iOS-Simulator mechanics (for when the host exists)

Install and launch (the iOS analog of the Android `flutter drive`/`adb install`
loop):

```sh
# build the simulator bundle (no signing needed)
flutter build ios --simulator --debug

# boot a specific simulator
xcrun simctl boot <udid>

# install and launch
xcrun simctl install <udid> build/ios/iphonesimulator/Runner.app
xcrun simctl launch <udid> <bundle-id>

# logs
xcrun simctl spawn <udid> log stream --predicate 'processImagePath contains "Runner"'
# or, for a running Flutter app: flutter logs

# screenshot
xcrun simctl io <udid> screenshot /tmp/smoke-iphone.png
```

Device matrix to create (`xcrun simctl create`):

| Label | Device type | Rationale |
|---|---|---|
| Small iPhone | iPhone SE (3rd gen) | compact legacy handset, smallest layout budget |
| Modern iPhone | iPhone 16 Pro | mainstream tall form factor |
| Plus/Max | iPhone 16 Pro Max | largest phone layout |
| iPad | iPad Pro 13-inch | tablet-class multi-pane layout |

`xcrun simctl list devices` is the source of truth for UDIDs; UDIDs are stable
across `simctl` invocations and are the identifier to key the control/status
bridge on (the iOS analog of Android `emulator-5554`).

## Home Dashboard feedback contract

The iOS lane must surface honestly rather than be silently absent. Proposed
shape under the existing `mobileWorkflow` config object (spec — to be implemented
as an additive change once the dashboard config file settles after the sibling
Android matrix/control tasks land):

```json
{
  "iosLane": {
    "available": false,
    "reason": "no_macos_xcode_host",
    "detail": "iOS Simulator requires macOS + Xcode. No macOS/Xcode host is present on the homelab network. See docs/operations/ios-simulator-feasibility-and-provisioning.md.",
    "recommendedPath": "mac_mini_or_github_actions_macos_runner",
    "configuredDevices": [],
    "activeDevice": null,
    "viewerHref": null,
    "freshness": "2026-09-12T00:00:00.000Z"
  }
}
```

Field meanings (matched to the reviewer acceptance criteria):

- `available` — whether a real macOS/Xcode host is provisioned.
- `reason` — machine-readable why-not (`no_macos_xcode_host`,
  `awaiting_signing`, `host_offline`, ...).
- `detail` — one-line human explanation + pointer to this doc.
- `recommendedPath` — the unblock path so the tile isn't a dead end.
- `configuredDevices` / `activeDevice` — empty/null pending provisioning; these
  mirror the Android matrix `profiles` / `activeProfile` fields for parity.
- `viewerHref` — null (no viewer until a host exists); when provisioned, this is
  a dashboard-proxied, auth-gated route exactly like `/mobile-viewer/`.
- `freshness` — last discovery/state-check timestamp so staleness is visible.

The reverse-proxy auth boundary and "no WAN/CF route for control surfaces" rule
from the Android lane (tasks t_73360e8e / t_7daf1260) apply unchanged to any
future iOS control bridge.

## Non-goals / explicit honesty

- No fake "Linux iOS simulator" theater. Nothing here pretends a Linux host can
  run CoreSimulator.
- Browser/device farms are called out as cloud alternatives, not as a local iOS
  simulator lane.
- This doc is a **feasibility + provisioning spec**, not an applied change. The
  lane cannot be applied until Ben supplies a host or approves a cloud path.