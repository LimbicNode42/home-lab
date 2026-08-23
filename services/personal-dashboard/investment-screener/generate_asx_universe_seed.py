#!/usr/bin/env python3
"""Generate a reviewed ASX universe seed from the ASX company-directory CSV."""
from __future__ import annotations

import argparse
import csv
import datetime
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

from screener import ASX_DIRECTORY_SOURCE_URL, normalise_asx_directory_rows


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Generate normalized ASX listed-company universe seed JSON.")
    parser.add_argument("--output", required=True, help="Seed JSON output path.")
    parser.add_argument("--source-url", default=ASX_DIRECTORY_SOURCE_URL, help="ASX company-directory CSV URL.")
    parser.add_argument("--input-csv", default=None, help="Optional local CSV input for offline/regression generation.")
    parser.add_argument("--retrieved-at", default=None, help="Override retrieved_at timestamp for reproducible tests.")
    return parser.parse_args(argv)


def read_csv_bytes(args) -> bytes:
    if args.input_csv:
        return Path(args.input_csv).read_bytes()
    request = urllib.request.Request(args.source_url, headers={"User-Agent": "personal-dashboard-asx-seed-generator/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        content_type = response.headers.get("content-type", "")
        body = response.read()
    if b"<html" in body[:512].lower() or "text/html" in content_type.lower():
        raise RuntimeError(f"ASX directory source returned HTML/content-type={content_type!r}, not CSV")
    return body


def main(argv=None) -> int:
    args = parse_args(argv)
    body = read_csv_bytes(args)
    decoded = body.decode("utf-8-sig")
    rows = list(csv.DictReader(decoded.splitlines()))
    retrieved_at = args.retrieved_at or datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    csv_sha256 = hashlib.sha256(body).hexdigest()
    entries, metadata = normalise_asx_directory_rows(
        rows,
        source_url=args.source_url,
        retrieved_at=retrieved_at,
        csv_sha256=csv_sha256,
    )
    output = {
        "schema_version": "investment-screener-asx-universe-seed/v1",
        "metadata": metadata,
        "entries": entries,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf8")
    print(json.dumps({"output": str(output_path), "entries": len(entries), "row_count": len(rows), "sha256": csv_sha256}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
