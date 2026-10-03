"""Read-only MCP server for safe Graphiti agent access.

This module intentionally exposes a smaller surface than the Python wrapper CLI:
read/status/search/provenance lookup plus curated-ingest validation only. It does
not expose ingest apply, clear, delete, Cypher, or raw graph dump tools.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .client import GraphitiReadOnlyClient
from .episode import validate_episode

DEFAULT_BASE_URL = "http://127.0.0.1:8000"
SAFE_TOOL_NAMES = (
    "graphiti_status",
    "graphiti_search_facts",
    "graphiti_lookup_provenance",
    "graphiti_validate_curated_episode",
)
DESTRUCTIVE_TERMS = ("clear", "delete", "drop", "remove", "truncate", "cypher", "admin", "write")


def client_from_env() -> GraphitiReadOnlyClient:
    """Build the bounded wrapper client from non-secret environment config."""

    return GraphitiReadOnlyClient(
        os.environ.get("GRAPHITI_API_URL", DEFAULT_BASE_URL),
        search_path=os.environ.get("GRAPHITI_SEARCH_PATH", "/search"),
        health_path=os.environ.get("GRAPHITI_HEALTH_PATH", "/healthcheck"),
        ingest_path=os.environ.get("GRAPHITI_INGEST_PATH", "/episodes"),
        timeout_seconds=float(os.environ.get("GRAPHITI_TIMEOUT_SECONDS", "8")),
    )


def tool_contract() -> dict[str, Any]:
    """Return the public MCP contract without requiring the MCP SDK."""

    return {
        "status": "ok",
        "placement": "separate stdio MCP server registered through MetaMCP/Hermes native MCP; raw Graphiti remains loopback-only",
        "tools": list(SAFE_TOOL_NAMES),
        "destructive_tools_exposed": False,
        "prohibited_terms": list(DESTRUCTIVE_TERMS),
        "curated_ingest": "validation-only from MCP; live ingest remains operator CLI policy-gated",
        "memory_boundary": "Graphiti is advisory operational/provenance context; mem0 remains the personal/preference memory provider",
    }


def _tool_names_without_destructive_surface(server: Any) -> list[str]:
    names = list(SAFE_TOOL_NAMES)
    lowered = " ".join(names).lower()
    if any(term in lowered for term in DESTRUCTIVE_TERMS):
        raise RuntimeError("unsafe MCP tool name configured")
    return names


def build_server() -> Any:
    """Create the FastMCP server.

    Importing MCP is delayed so unit tests and wrapper use do not require the SDK.
    Runtime deployment installs `mcp` in the supervised environment.
    """

    try:
        # mcp<2
        from mcp.server.fastmcp import FastMCP as ServerClass
    except ModuleNotFoundError:
        try:
            # mcp>=2 renamed FastMCP to MCPServer.
            from mcp.server.mcpserver import MCPServer as ServerClass
        except ModuleNotFoundError as exc:  # pragma: no cover - exercised by runtime preflight
            raise RuntimeError("mcp Python package is required to run the Graphiti MCP server") from exc

    mcp = ServerClass("graphiti-readonly")

    @mcp.tool()
    def graphiti_status() -> dict[str, Any]:
        """Return sanitized Graphiti wrapper and MCP contract health."""

        status = client_from_env().status()
        return {
            "status": "ok" if status.get("available") else "degraded",
            "graphiti": status,
            "contract": tool_contract(),
        }

    @mcp.tool()
    def graphiti_search_facts(query: str, group_id: str | None = None, limit: int = 5) -> dict[str, Any]:
        """Search curated operational/provenance facts with normalized citations."""

        return client_from_env().search_facts(query, group_id=group_id, limit=limit)

    @mcp.tool()
    def graphiti_lookup_provenance(query: str, group_id: str | None = None, limit: int = 5) -> dict[str, Any]:
        """Search facts and return only provenance/caveat fields useful for source checks."""

        result = client_from_env().search_facts(query, group_id=group_id, limit=limit)
        if result.get("status") != "ok":
            return result
        provenance = []
        for item in result.get("results", []):
            if not isinstance(item, dict):
                continue
            provenance.append({
                "fact": item.get("fact"),
                "source_episode": item.get("source_episode"),
                "source_ref": item.get("source_ref"),
                "source_timestamp": item.get("source_timestamp"),
                "valid_at": item.get("valid_at"),
                "invalid_at": item.get("invalid_at"),
                "confidence": item.get("confidence"),
                "caveat": item.get("caveat"),
                "group": item.get("group"),
                "domain": item.get("domain"),
            })
        return {"status": "ok", "provenance": provenance}

    @mcp.tool()
    def graphiti_validate_curated_episode(episode_json: str) -> dict[str, Any]:
        """Validate one curated episode JSON string without ingesting it."""

        raw = json.loads(episode_json)
        episode, report = validate_episode(raw, sanitize=True)
        return {
            "status": "ok",
            "episode_id": episode.episode_id,
            "group_id": episode.group_id,
            "facts": len(episode.facts),
            "redaction_replacements": report["total"],
            "ingested": False,
        }

    _tool_names_without_destructive_surface(mcp)
    return mcp


def main() -> int:
    server = build_server()
    server.run(transport="stdio")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
