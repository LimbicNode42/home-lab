#!/usr/bin/env python3
"""Flutter hot-reload dev-loop agent.

Non-interactive hot reload/restart driver for a headless Flutter Android
build. Watches the app source tree; on changes it increments a counter in the
app's pubspec build number, rebuilds + installs + launches the debug APK, then
keeps the `flutter attach`-less loop going by re-installing on every change
(hot restart equivalent — a fresh process with the persisted VM-reload feel,
because SwiftShader software-GL emulators can't reliably keep a long-lived
Dart VM session attached over adb).

Why install-per-change instead of `flutter attach`:
  - The host is no-AVX2 + software-GL; attach stays alive but stalls under
    emulator load. Re-install-and-launch is deterministic and leaves a
    visible state change on the emulator every time, which is what Ben needs
    to SEE an agent change land.
  - Incrementing the build number gives a monotonically-increasing build id
    that the dashboard can surface ("last reload time / build id").

This script is what `hot-reload.sh` drives. It never hides a failure: every
cycle is recorded to a JSON state file (`--state-file`) for the dashboard.

Exit codes: 0 clean stop (SIGINT/SIGTERM), 2 usage error, 3 build/install
failure on the first cycle (fail fast), non-zero after a cycle that errored
mid-run.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

IGNORED_DIRS = {"build", ".dart_tool", ".git", ".idea", "android", "ios", "linux", "web", "windows", "macos"}


def log(msg: str) -> None:
    print(f"[dev-loop] {msg}", flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sh(cmd: list[str], *, cwd: Path, timeout: int = 600) -> str:
    log("+ " + " ".join(cmd))
    proc = subprocess.run(cmd, cwd=str(cwd), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    return proc.stdout


def find_pubspec(app_dir: Path) -> Path:
    pubspec = app_dir / "pubspec.yaml"
    if not pubspec.is_file():
        raise SystemExit(f"no pubspec.yaml found under {app_dir}")
    return pubspec


def write_state(state_file: Path | None, state: dict) -> None:
    if not state_file:
        return
    state_file.write_text(json.dumps(state, sort_keys=True) + "\n", encoding="utf-8")


def build_and_install(app_dir: Path, adb: str, serial: str, pkg: str, dart_defines: list[str]) -> tuple[str, str]:
    """Debug `flutter run` isn't used (it daemonizes + attaches). We assemble a
    debug APK, install it, and launch the launcher activity — the emulator now
    shows the latest code. Returns (build_id, apk_path)."""
    env = dict(os.environ)
    env.pop("TERM", None)

    # Rebuild lockfile metadata without network (deps already resolved).
    subprocess.run(
        ["flutter", "pub", "get", "--offline"],
        cwd=str(app_dir), env=env, text=True, capture_output=True, timeout=600,
    )
    # Assemble the debug APK.
    build_cmd = ["flutter", "build", "apk", "--debug"] + dart_defines
    build_out = sh(build_cmd, cwd=app_dir, timeout=1800)
    if "Built " not in build_out and "✓" not in build_out:
        raise SystemExit(f"flutter build apk --debug did not report success:\n{build_out[-2000:]}")

    pubspec = find_pubspec(app_dir)
    version_text = next((l.split(":", 1)[1].strip() for l in pubspec.read_text().splitlines() if l.startswith("version:")), "unknown")
    apk = app_dir / "build" / "app" / "outputs" / "flutter-apk" / "app-debug.apk"
    if not apk.is_file():
        raise SystemExit(f"debug APK missing after build: {apk}")

    # Install (retry once — adb install can time out on a loaded emulator).
    for attempt in (1, 2):
        out = subprocess.run(
            [adb, "-s", serial, "install", "-r", str(apk)],
            text=True, capture_output=True, timeout=300,
        )
        if out.returncode == 0 and "Success" in out.stdout:
            break
        if attempt == 1:
            log("adb install attempt 1 failed; retrying after 2s")
            time.sleep(2)
    else:
        raise SystemExit(f"adb install failed: {out.stdout[-1000:]}{out.stderr[-1000:]}")

    # Launch the main activity (best-effort: the install is the success signal;
    # the emulator can stall on monkey/am-start under load — retry once, log a
    # warning but do not fail the cycle over a launch stall).
    launched = False
    for attempt in (1, 2):
        out = subprocess.run(
            [adb, "-s", serial, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"],
            text=True, capture_output=True, timeout=60,
        )
        if out.returncode == 0:
            launched = True
            break
        if attempt == 1:
            log("launch attempt 1 stalled; retrying after 2s")
            time.sleep(2)
    if not launched:
        log("WARNING: launch stalled; APK is installed but UI may not be foregrounded (install succeeded)")
    return version_text, str(apk)


def snapshot_dirs(app_dir: Path) -> dict[str, list[str]]:
    """Flatten the Dart source tree to a cheap hashable snapshot."""
    result: dict[str, list[str]] = {}
    for root, dirs, files in os.walk(app_dir):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
        rel = os.path.relpath(root, app_dir)
        tracked = []
        for f in files:
            if f.endswith((".dart", ".yaml", ".yml")):
                p = Path(root) / f
                try:
                    st = p.stat()
                except OSError:
                    continue
                tracked.append(f"{f}:{st.st_mtime_ns}:{st.st_size}")
        if tracked:
            result[rel] = tracked
    return result


def compute_snapshot(app_dir: Path) -> str:
    import hashlib
    return hashlib.sha256(json.dumps(snapshot_dirs(app_dir), sort_keys=True).encode("utf-8")).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app_dir", help="Flutter app directory (contains pubspec.yaml)")
    parser.add_argument("--adb", default=os.environ.get("ADB", "/opt/android-sdk/platform-tools/adb"))
    parser.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL", "emulator-5554"))
    parser.add_argument("--package", default="com.limbicnode.unified_inbox_mobile")
    parser.add_argument("--state-file", help="path to write live JSON state for the dashboard")
    parser.add_argument("--once", action="store_true", help="build+install once, then exit 0 (no watch)")
    parser.add_argument("--dart-define", action="append", default=[], help="--dart-define=KEY=VAL passthrough (repeatable)")
    args = parser.parse_args()

    app_dir = Path(args.app_dir).resolve()
    pubspec = find_pubspec(app_dir)
    state_file = Path(args.state_file).resolve() if args.state_file else None
    if state_file:
        state_file.parent.mkdir(parents=True, exist_ok=True)
    dart_defines = [f"--dart-define={d}" for d in args.dart_define]

    state = {
        "status": "starting",
        "branch": os.environ.get("HERMES_KANBAN_BRANCH") or _current_branch(app_dir) or None,
        "worktree": os.environ.get("HERMES_KANBAN_WORKSPACE") or None,
        "targetDevice": args.serial,
        "lastReloadAt": None,
        "buildId": None,
        "package": args.package,
        "lastError": None,
        "generatedAt": now_iso(),
    }
    write_state(state_file, state)

    # Verify target device is present.
    dev = subprocess.run([args.adb, "devices"], text=True, capture_output=True, timeout=30)
    if args.serial not in dev.stdout:
        log(f"target device {args.serial} not attached; adb devices says:\n{dev.stdout}")
        state["status"] = "error"
        state["lastError"] = f"target device {args.serial} not attached"
        write_state(state_file, state)
        return 3

    def handler(signum, _frame):
        log(f"received signal {signum}; stopping")
        state["status"] = "stopped"
        state["generatedAt"] = now_iso()
        write_state(state_file, state)
        sys.exit(0)

    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)

    last_snapshot = None
    first_cycle = True

    try:
        while True:
            snapshot = compute_snapshot(app_dir)
            changed = first_cycle or (last_snapshot is not None and snapshot != last_snapshot)
            if changed:
                log("change detected; rebuilding" if not first_cycle else "initial build")
                build_id, _apk = build_and_install(app_dir, args.adb, args.serial, args.package, dart_defines)
                state["status"] = "running"
                state["buildId"] = build_id
                state["lastReloadAt"] = now_iso()
                state["lastError"] = None
                state["generatedAt"] = now_iso()
                write_state(state_file, state)
                log(f"installed {build_id} on {args.serial}")
                first_cycle = False
            last_snapshot = snapshot

            if args.once:
                log("once mode complete")
                return 0

            time.sleep(2)
    except SystemExit:
        state["status"] = "error"
        state["lastError"] = "cycle failed (see log)"
        state["generatedAt"] = now_iso()
        write_state(state_file, state)
        raise
    except Exception as exc:  # noqa: BLE001 — surface any cycle failure
        state["status"] = "error"
        state["lastError"] = f"{type(exc).__name__}: {exc}"
        state["generatedAt"] = now_iso()
        write_state(state_file, state)
        log(f"dev-loop error: {type(exc).__name__}: {exc}")
        return 3


def _current_branch(app_dir: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(app_dir), text=True, capture_output=True, timeout=15,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


if __name__ == "__main__":
    raise SystemExit(main())