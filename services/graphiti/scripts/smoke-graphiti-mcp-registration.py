#!/usr/bin/env python3
"""Smoke the Graphiti read-only MCP server with a real MCP client.

This script is intentionally secret-free and read-only. It uses uv-isolated
mcp on both the client and server side so system Python does not need mcp.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SAFE_TOOLS = {
    "graphiti_status",
    "graphiti_search_facts",
    "graphiti_lookup_provenance",
    "graphiti_validate_curated_episode",
}
DESTRUCTIVE_TERMS = ("clear", "delete", "drop", "remove", "truncate", "cypher", "admin", "write")
ROOT = Path(__file__).resolve().parents[3]
SERVER_SCRIPT = "services/graphiti/scripts/graphiti-mcp-server.py"
RECEIPT = ROOT / "services/graphiti/receipts/2026-10-04-mcp-registration-smoke.json"


def _jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    return repr(value)


def _extract_payload(call_result: Any) -> Any:
    dumped = _jsonable(call_result)
    if isinstance(dumped, dict):
        structured = dumped.get("structuredContent") or dumped.get("structured_content")
        if structured is not None:
            return structured
        content = dumped.get("content")
        if isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict):
                text = first.get("text")
                if isinstance(text, str):
                    try:
                        return json.loads(text)
                    except json.JSONDecodeError:
                        return {"text": text[:500]}
    return dumped


async def main() -> int:
    env = dict(os.environ)
    env.update(
        {
            "GRAPHITI_API_URL": "http://127.0.0.1:8000",
            "GRAPHITI_SEARCH_PATH": "/search",
            "GRAPHITI_HEALTH_PATH": "/healthcheck",
            "GRAPHITI_INGEST_PATH": "/episodes",
            "GRAPHITI_TIMEOUT_SECONDS": "20",
        }
    )
    params = StdioServerParameters(
        command="uv",
        args=["run", "--with", "mcp", "python", SERVER_SCRIPT],
        env=env,
        cwd=str(ROOT),
    )
    started = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await asyncio.wait_for(session.initialize(), timeout=30)
            tools_result = await asyncio.wait_for(session.list_tools(), timeout=30)
            tools = sorted(tool.name for tool in tools_result.tools)
            unexpected = sorted(set(tools) - SAFE_TOOLS)
            missing = sorted(SAFE_TOOLS - set(tools))
            destructive = [t for t in tools if any(term in t.lower() for term in DESTRUCTIVE_TERMS)]
            status_result = await asyncio.wait_for(session.call_tool("graphiti_status", {}), timeout=30)
            search_result = await asyncio.wait_for(
                session.call_tool(
                    "graphiti_search_facts",
                    {"query": "Graphiti operational provenance", "limit": 3},
                ),
                timeout=30,
            )

    status_payload = _extract_payload(status_result)
    search_payload = _extract_payload(search_result)
    search_status = search_payload.get("status") if isinstance(search_payload, dict) else None
    normalized_or_degraded = False
    if isinstance(search_payload, dict):
        if search_status == "ok" and isinstance(search_payload.get("results"), list):
            normalized_or_degraded = all(isinstance(item, dict) and "fact" in item for item in search_payload.get("results", []))
        elif search_status == "graph_unavailable":
            normalized_or_degraded = True

    receipt = {
        "schema": "graphiti-mcp-registration-smoke.v1",
        "created_at_utc": started.isoformat().replace("+00:00", "Z"),
        "client": "Python mcp ClientSession over stdio via uv run --with mcp",
        "server_command_shape": "uv run --with mcp python services/graphiti/scripts/graphiti-mcp-server.py",
        "graphiti_api_url": "http://127.0.0.1:8000",
        "tool_names": tools,
        "tool_count": len(tools),
        "expected_tool_count": 4,
        "missing_tools": missing,
        "unexpected_tools": unexpected,
        "destructive_tools_exposed": bool(destructive),
        "status_call_is_error": bool(getattr(status_result, "isError", False) or getattr(status_result, "is_error", False)),
        "search_call_is_error": bool(getattr(search_result, "isError", False) or getattr(search_result, "is_error", False)),
        "status_tool_status": status_payload.get("status") if isinstance(status_payload, dict) else None,
        "search_tool_status": search_status,
        "search_result_count": len(search_payload.get("results", [])) if isinstance(search_payload, dict) and isinstance(search_payload.get("results"), list) else None,
        "search_returns_normalized_facts_or_safe_degradation": normalized_or_degraded,
        "safety": {
            "secrets_included": False,
            "config_mutated": False,
            "gateway_or_worker_restarted": False,
            "public_route_created": False,
        },
    }
    ok = (
        set(tools) == SAFE_TOOLS
        and not destructive
        and not receipt["status_call_is_error"]
        and not receipt["search_call_is_error"]
        and receipt["status_tool_status"] in {"ok", "degraded"}
        and normalized_or_degraded
    )
    receipt["status"] = "pass" if ok else "fail"
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
