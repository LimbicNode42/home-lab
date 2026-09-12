#!/usr/bin/env python3
"""Token-gated Android emulator control bridge for Home Dashboard.

Binds on the trusted LAN and accepts only a bearer token matching the existing
noVNC token file. It exposes bounded control verbs, not raw adb.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BIND_HOST = os.environ.get("ANDROID_CONTROL_BIND", "192.168.0.20")
PORT = int(os.environ.get("ANDROID_CONTROL_PORT", "6081"))
TOKEN_FILE = Path(os.environ.get("ANDROID_NOVNC_TOKEN_FILE", "/opt/android-emulator/novnc/vnc_tokens"))
ADB = os.environ.get("ANDROID_ADB", "/opt/android-sdk/platform-tools/adb")
DEVICE = os.environ.get("ANDROID_DEVICE_ID", "emulator-5554")
TIMEOUT = float(os.environ.get("ANDROID_CONTROL_TIMEOUT", "20"))
TEXT_RE = re.compile(r"^[A-Za-z0-9 .,@:_+\-/]+$")
ROTATIONS = {
    "portrait": "0",
    "landscape": "1",
    "reverse-portrait": "2",
    "reverse-landscape": "3",
}


def read_token() -> str:
    raw = TOKEN_FILE.read_text(encoding="utf-8").strip().splitlines()[0]
    return raw.split(":", 1)[0].strip()


def bounded_int(value, name: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or value < minimum or value > maximum:
        raise ValueError(f"{name} must be an integer between {minimum} and {maximum}")
    return value


def safe_text(value) -> str:
    if not isinstance(value, str) or not value[:160]:
        raise ValueError("text must be a non-empty string")
    value = value[:160]
    if not TEXT_RE.fullmatch(value):
        raise ValueError("text contains unsupported characters for safe adb input")
    return value.replace(" ", "%s")


def adb(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [ADB, "-s", DEVICE, *args],
        check=True,
        timeout=TIMEOUT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def handle_control(payload: dict) -> dict:
    action = str(payload.get("action", "")).strip().lower()
    if action == "tap":
        adb("shell", "input", "tap", str(bounded_int(payload.get("x"), "x", 0, 5000)), str(bounded_int(payload.get("y"), "y", 0, 5000)))
    elif action == "swipe":
        adb(
            "shell", "input", "swipe",
            str(bounded_int(payload.get("x1"), "x1", 0, 5000)),
            str(bounded_int(payload.get("y1"), "y1", 0, 5000)),
            str(bounded_int(payload.get("x2"), "x2", 0, 5000)),
            str(bounded_int(payload.get("y2"), "y2", 0, 5000)),
            str(bounded_int(payload.get("durationMs", 300), "durationMs", 50, 5000)),
        )
    elif action == "type":
        adb("shell", "input", "text", safe_text(payload.get("text")))
    elif action == "back":
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
    elif action == "home":
        adb("shell", "input", "keyevent", "KEYCODE_HOME")
    elif action == "rotate":
        rotation = str(payload.get("rotation", "")).strip().lower()
        if rotation not in ROTATIONS:
            raise ValueError("rotation must be portrait, landscape, reverse-portrait, or reverse-landscape")
        adb("shell", "settings", "put", "system", "accelerometer_rotation", "0")
        adb("shell", "settings", "put", "system", "user_rotation", ROTATIONS[rotation])
    else:
        raise ValueError("unsupported mobile control action")
    return {"ok": True, "action": action, "deviceId": DEVICE}


class Handler(BaseHTTPRequestHandler):
    server_version = "android-control/1"

    def log_message(self, format, *args):  # keep auth/token material out of logs
        print(f"{self.address_string()} {self.command} {self.path} {format % args}")

    def authorized(self) -> bool:
        expected = read_token()
        supplied = self.headers.get("authorization", "")
        return supplied == f"Bearer {expected}"

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        if self.path != "/screenshot":
            return self.send_json(404, {"error": "not_found"})
        try:
            png = subprocess.run(
                [ADB, "-s", DEVICE, "exec-out", "screencap", "-p"],
                check=True,
                timeout=TIMEOUT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            ).stdout
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(png)))
            self.end_headers()
            self.wfile.write(png)
        except Exception as exc:
            print(f"screenshot_failed: {type(exc).__name__}: {exc}", flush=True)
            self.send_json(502, {"error": "screenshot_failed", "message": "Unable to capture emulator screenshot"})

    def do_POST(self):
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        if self.path != "/control":
            return self.send_json(404, {"error": "not_found"})
        try:
            length = int(self.headers.get("content-length", "0"))
            if length < 1 or length > 2048:
                raise ValueError("request body must be 1..2048 bytes")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("request body must be a JSON object")
            self.send_json(200, handle_control(payload))
        except ValueError as exc:
            self.send_json(400, {"error": "invalid_control_payload", "message": str(exc)})
        except Exception as exc:
            print(f"control_failed: {type(exc).__name__}: {exc}", flush=True)
            self.send_json(502, {"error": "control_failed", "message": "Unable to apply emulator control command"})


if __name__ == "__main__":
    httpd = ThreadingHTTPServer((BIND_HOST, PORT), Handler)
    print(f"android-control listening on {BIND_HOST}:{PORT} for device {DEVICE}")
    httpd.serve_forever()
