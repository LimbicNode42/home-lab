#!/usr/bin/env python3
"""Probe OpenRouter workspace guardrails for the exact Graphiti models.

Output is intentionally non-secret JSON. The API key is read from OPENROUTER_API_KEY
or a dotenv-style file passed with --env-file. Secret values are never printed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
COMPLETION_MODEL = "openai/gpt-4o-mini"
EMBEDDING_MODEL = "openai/text-embedding-3-small"


def load_env_file(path: str) -> None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except FileNotFoundError:
        return


def post_json(url: str, api_key: str, payload: dict, timeout: int) -> dict:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/LimbicNode42/home-lab",
            "X-Title": "home-lab graphiti guardrail preflight",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            parsed = json.loads(body) if body else {}
            return {"ok": 200 <= response.status < 300, "status": response.status, "body": parsed}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            parsed = {"error": body[:500]}
        return {"ok": False, "status": exc.code, "body": parsed}
    except Exception as exc:  # network/timeout/etc; non-secret
        return {"ok": False, "status": None, "body": {"error": type(exc).__name__, "message": str(exc)}}


def summarize_error(body: dict) -> str | None:
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        message = error.get("message") or error.get("code") or json.dumps(error, sort_keys=True)[:300]
    elif isinstance(error, str):
        message = error
    else:
        message = None
    if not message:
        return None
    lowered = message.lower()
    if any(term in lowered for term in ["moderation", "guardrail", "not allowed", "disallowed", "forbidden", "workspace"]):
        return "possible_workspace_guardrail_or_allowlist_block"
    if "no endpoints found" in lowered or "not found" in lowered:
        return "model_unavailable_or_not_allowlisted"
    if "insufficient" in lowered or "credit" in lowered:
        return "billing_or_credit_block"
    if "auth" in lowered or "api key" in lowered or "unauthorized" in lowered:
        return "credential_block"
    return "provider_error"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", action="append", default=[], help="dotenv-style file to read if present")
    parser.add_argument("--base-url", default=os.environ.get("OPENROUTER_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()

    for env_file in args.env_file:
        load_env_file(env_file)

    api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY")
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    result = {
        "checked_at": started,
        "base_url": args.base_url.rstrip("/"),
        "completion_model": COMPLETION_MODEL,
        "embedding_model": EMBEDDING_MODEL,
        "embedding_dim_expected": 1536,
        "credential_present": bool(api_key),
        "results": {},
    }
    if not api_key:
        result["overall"] = "not_run_missing_openrouter_api_key"
        print(json.dumps(result, indent=2, sort_keys=True))
        return 2

    chat = post_json(
        f"{args.base_url.rstrip('/')}/chat/completions",
        api_key,
        {"model": COMPLETION_MODEL, "messages": [{"role": "user", "content": "Reply with: graphiti-ok"}], "max_tokens": 8},
        args.timeout,
    )
    result["results"]["chat_completion"] = {
        "ok": chat["ok"],
        "status": chat["status"],
        "model": COMPLETION_MODEL,
        "classification": None if chat["ok"] else summarize_error(chat["body"]),
    }
    if chat["ok"]:
        usage = chat["body"].get("usage", {}) if isinstance(chat["body"], dict) else {}
        result["results"]["chat_completion"]["usage"] = {k: usage.get(k) for k in ["prompt_tokens", "completion_tokens", "total_tokens"] if k in usage}

    emb = post_json(
        f"{args.base_url.rstrip('/')}/embeddings",
        api_key,
        {"model": EMBEDDING_MODEL, "input": "graphiti guardrail preflight"},
        args.timeout,
    )
    emb_dim = None
    if emb["ok"]:
        try:
            emb_dim = len(emb["body"]["data"][0]["embedding"])
        except Exception:
            emb_dim = None
    result["results"]["embedding"] = {
        "ok": emb["ok"] and emb_dim == 1536,
        "status": emb["status"],
        "model": EMBEDDING_MODEL,
        "embedding_dim_observed": emb_dim,
        "classification": None if emb["ok"] else summarize_error(emb["body"]),
    }

    if result["results"]["chat_completion"]["ok"] and result["results"]["embedding"]["ok"]:
        result["overall"] = "passed_exact_models_available"
        code = 0
    else:
        result["overall"] = "failed_model_access_or_guardrail_preflight"
        code = 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
