#!/usr/bin/env python3
"""Generate the reviewed FULL NYSE listed-equity universe seed JSON.

Ingests NASDAQ Trader otherlisted.txt, filters Exchange=N as the NYSE
denominator, and writes a fail-closed security-type-filtered seed.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import urllib.request
from pathlib import Path

from screener import (
    NYSE_SOURCE_URL,
    NYSE_UNIVERSE_SEED_SCHEMA_VERSION,
    normalise_nyse_universe_rows,
    parse_nyse_otherlisted_file,
)

DEFAULT_USER_AGENT = "personal-dashboard-nyse-seed-generator/1.0"


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Generate normalized full NYSE listed-equity universe seed JSON.")
    parser.add_argument("--output", required=True, help="Seed JSON output path.")
    parser.add_argument("--source-url", default=NYSE_SOURCE_URL, help="NASDAQ Trader otherlisted.txt URL.")
    parser.add_argument("--input-file", default=None, help="Optional local otherlisted.txt for offline/regression generation.")
    parser.add_argument("--retrieved-at", default=None, help="Override retrieved_at timestamp for reproducible tests.")
    return parser.parse_args(argv)


def fetch_source(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": DEFAULT_USER_AGENT, "Accept": "text/plain"})
    with urllib.request.urlopen(request, timeout=60) as response:
        content_type = response.headers.get("content-type", "")
        body = response.read()
    if b"<html" in body[:512].lower() or "text/html" in content_type.lower():
        raise RuntimeError(f"NASDAQ Trader otherlisted returned HTML/content-type={content_type!r}, not pipe-delimited text")
    return body


def main(argv=None) -> int:
    args = parse_args(argv)
    body = Path(args.input_file).read_bytes() if args.input_file else fetch_source(args.source_url)
    source_sha256 = hashlib.sha256(body).hexdigest()
    rows, file_meta = parse_nyse_otherlisted_file(body)
    file_creation_time = file_meta.get("file_creation_time")
    retrieved_at = args.retrieved_at or datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    entries, metadata = normalise_nyse_universe_rows(
        rows,
        source_url=args.source_url,
        retrieved_at=retrieved_at,
        source_sha256=source_sha256,
        file_creation_time=file_creation_time,
    )
    output = {
        "schema_version": NYSE_UNIVERSE_SEED_SCHEMA_VERSION,
        "metadata": metadata,
        "entries": entries,
        "excluded": metadata.get("excluded", []),
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf8")
    print(json.dumps({
        "output": str(output_path),
        "entries": len(entries),
        "row_count": len(rows),
        "nyse_source_row_count": metadata.get("nyse_source_row_count"),
        "sha256": source_sha256,
        "file_creation_time": file_creation_time,
        "denominator_status": metadata.get("denominator_status"),
        "denominator_label": metadata.get("denominator_label"),
        "excluded_count": metadata.get("excluded_count"),
        "unaccounted_source_row_count": metadata.get("unaccounted_source_row_count"),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
