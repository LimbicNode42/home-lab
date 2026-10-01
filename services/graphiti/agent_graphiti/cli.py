#!/usr/bin/env python3
"""CLI for safe Graphiti agent query and curated ingest operations."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .client import GraphitiReadOnlyClient
from .episode import validate_episode

DEFAULT_BASE_URL = "http://127.0.0.1:8000"


def _client(args: argparse.Namespace) -> GraphitiReadOnlyClient:
    return GraphitiReadOnlyClient(
        args.base_url,
        search_path=args.search_path,
        health_path=args.health_path,
        ingest_path=args.ingest_path,
        timeout_seconds=args.timeout,
    )


def _emit(payload: dict[str, Any]) -> int:
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    return _emit(_client(args).status())


def cmd_query(args: argparse.Namespace) -> int:
    result = _client(args).search_facts(args.query, group_id=args.group_id, limit=args.limit)
    return _emit(result)


def _load_episodes(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "episodes" in data:
        data = data["episodes"]
    if not isinstance(data, list):
        raise ValueError("episode file must be a list or {'episodes': [...]} object")
    if len(data) > 25:
        raise ValueError("batch exceeds the 25 episode policy limit")
    if not all(isinstance(item, dict) for item in data):
        raise ValueError("every episode entry must be an object")
    return data


def cmd_validate(args: argparse.Namespace) -> int:
    episodes = []
    redaction_total = 0
    for raw in _load_episodes(Path(args.file)):
        episode, report = validate_episode(raw, sanitize=True)
        redaction_total += report["total"]
        episodes.append({"episode_id": episode.episode_id, "group_id": episode.group_id, "facts": len(episode.facts)})
    return _emit({"status": "ok", "episodes": episodes, "redaction_replacements": redaction_total})


def cmd_ingest(args: argparse.Namespace) -> int:
    client = _client(args)
    receipts = []
    for raw in _load_episodes(Path(args.file)):
        episode, report = validate_episode(raw, sanitize=True)
        payload = episode.to_graphiti_payload()
        if args.dry_run:
            receipts.append({"episode_id": episode.episode_id, "group_id": episode.group_id, "dry_run": True, "redaction_replacements": report["total"]})
            continue
        upstream = client.ingest_episode(payload)
        receipts.append({"episode_id": episode.episode_id, "group_id": episode.group_id, "dry_run": False, "upstream_status": upstream})
    return _emit({"status": "ok", "ingested": receipts})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Safe Graphiti agent wrapper: read-only query plus curated ingest validation.")
    parser.add_argument("--base-url", default=os.environ.get("GRAPHITI_API_URL", DEFAULT_BASE_URL), help="Raw Graphiti API base URL; default loopback only")
    parser.add_argument("--search-path", default=os.environ.get("GRAPHITI_SEARCH_PATH", "/search"))
    parser.add_argument("--health-path", default=os.environ.get("GRAPHITI_HEALTH_PATH", "/healthcheck"))
    parser.add_argument("--ingest-path", default=os.environ.get("GRAPHITI_INGEST_PATH", "/episodes"))
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("GRAPHITI_TIMEOUT_SECONDS", "8")))
    sub = parser.add_subparsers(required=True)

    status = sub.add_parser("status", help="Return sanitized availability status")
    status.set_defaults(func=cmd_status)

    query = sub.add_parser("query", help="Search facts through the read-only wrapper")
    query.add_argument("query")
    query.add_argument("--group-id")
    query.add_argument("--limit", type=int, default=5)
    query.set_defaults(func=cmd_query)

    validate = sub.add_parser("validate-ingest", help="Validate curated episode JSON without contacting Graphiti")
    validate.add_argument("file")
    validate.set_defaults(func=cmd_validate)

    ingest = sub.add_parser("ingest", help="Ingest validated curated episodes; defaults to dry-run")
    ingest.add_argument("file")
    ingest.add_argument("--apply", action="store_false", dest="dry_run", help="Actually call the configured Graphiti ingest endpoint")
    ingest.set_defaults(func=cmd_ingest, dry_run=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001 - CLI should return a safe, sanitized error
        print(json.dumps({"status": "error", "error": exc.__class__.__name__, "message": str(exc)}, indent=2, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
