#!/usr/bin/env python3
"""Manage the shared persistent Android emulator lease file.

This is intentionally local-file based. It coordinates humans/agents before they
send bounded controls to the shared agent_feedback AVD; it does not expose ADB.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

LOCK_FILE = Path(os.environ.get("ANDROID_SESSION_LOCK_FILE", "/opt/android-emulator/run/session-lock.json"))
DEVICE = os.environ.get("ANDROID_DEVICE_ID", "emulator-5554")
DEFAULT_TTL = int(os.environ.get("ANDROID_SESSION_DEFAULT_TTL_SECONDS", "1800"))
MAX_TTL = int(os.environ.get("ANDROID_SESSION_MAX_TTL_SECONDS", "7200"))


def now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def read_state():
    checked = now()
    try:
        raw = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"active": False, "device": DEVICE, "checkedAt": iso(checked)}
    except (OSError, ValueError):
        return {"active": False, "device": DEVICE, "checkedAt": iso(checked), "error": "unreadable_lock"}
    expires = parse_time(raw.get("expiresAt"))
    active = bool(raw.get("owner")) and expires is not None and expires > checked
    return {
        "active": active,
        "expired": bool(raw.get("owner")) and not active,
        "owner": raw.get("owner"),
        "purpose": raw.get("purpose"),
        "device": raw.get("device", DEVICE),
        "createdAt": raw.get("createdAt"),
        "updatedAt": raw.get("updatedAt"),
        "expiresAt": raw.get("expiresAt"),
        "checkedAt": iso(checked),
    }


def write_state(owner, purpose, ttl, existing=None):
    if ttl < 60 or ttl > MAX_TTL:
        raise SystemExit(f"ttl must be between 60 and {MAX_TTL} seconds")
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    n = now()
    payload = {
        "owner": owner,
        "purpose": purpose,
        "device": DEVICE,
        "createdAt": existing.get("createdAt") if existing and existing.get("owner") == owner and existing.get("createdAt") else iso(n),
        "updatedAt": iso(n),
        "expiresAt": iso(n + timedelta(seconds=ttl)),
        "ttlSeconds": ttl,
    }
    tmp = LOCK_FILE.with_suffix(f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, LOCK_FILE)
    return read_state()


def acquire(args):
    state = read_state()
    if state.get("active") and state.get("owner") != args.owner and not args.override:
        raise SystemExit(f"busy: leased by {state.get('owner')} until {state.get('expiresAt')}")
    print(json.dumps(write_state(args.owner, args.purpose, args.ttl, state), sort_keys=True))


def release(args):
    state = read_state()
    if state.get("active") and state.get("owner") != args.owner and not args.force:
        raise SystemExit(f"busy: leased by {state.get('owner')} until {state.get('expiresAt')}")
    try:
        LOCK_FILE.unlink()
    except FileNotFoundError:
        pass
    print(json.dumps(read_state(), sort_keys=True))


def status(_args):
    print(json.dumps(read_state(), sort_keys=True))


def run_with_lease(args):
    state = read_state()
    if state.get("active") and state.get("owner") != args.owner and not args.override:
        raise SystemExit(f"busy: leased by {state.get('owner')} until {state.get('expiresAt')}")
    write_state(args.owner, args.purpose, args.ttl, state)
    try:
        return subprocess.call(args.command)
    finally:
        current = read_state()
        if current.get("owner") == args.owner:
            try:
                LOCK_FILE.unlink()
            except FileNotFoundError:
                pass


def main(argv=None):
    parser = argparse.ArgumentParser(description="Manage the shared Android emulator session lease")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("status")
    p.set_defaults(func=status)
    p = sub.add_parser("acquire")
    p.add_argument("--owner", required=True)
    p.add_argument("--purpose", default="mobile emulator session")
    p.add_argument("--ttl", type=int, default=DEFAULT_TTL)
    p.add_argument("--override", action="store_true")
    p.set_defaults(func=acquire)
    p = sub.add_parser("release")
    p.add_argument("--owner", required=True)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=release)
    p = sub.add_parser("run")
    p.add_argument("--owner", required=True)
    p.add_argument("--purpose", default="mobile emulator command")
    p.add_argument("--ttl", type=int, default=DEFAULT_TTL)
    p.add_argument("--override", action="store_true")
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(func=run_with_lease)
    args = parser.parse_args(argv)
    if args.cmd == "run" and (not args.command or args.command[0] != "--"):
        raise SystemExit("run requires: mobile-session.py run --owner OWNER -- command ...")
    if args.cmd == "run":
        args.command = args.command[1:]
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
