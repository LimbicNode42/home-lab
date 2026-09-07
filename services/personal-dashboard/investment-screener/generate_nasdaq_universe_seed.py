#!/usr/bin/env python3
"""Generate a bounded NASDAQ-100/QQQ-class universe seed JSON.

This is deliberately NOT a full NASDAQ exchange directory. The default source is
Nasdaq's public NASDAQ-100 quote-list endpoint, normalized into explicit
market/exchange=NASDAQ identities while preserving the EODHD `.US` provider
symbol contract used by the existing US fundamentals adapter.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import urllib.request
from pathlib import Path

from screener import NASDAQ_UNIVERSE_SEED_SCHEMA_VERSION, normalise_nasdaq_universe_rows

DEFAULT_SOURCE_URL = "https://api.nasdaq.com/api/quote/list-type/nasdaq100"


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Generate normalized NASDAQ-100 universe seed JSON.")
    parser.add_argument("--output", required=True, help="Seed JSON output path.")
    parser.add_argument("--source-url", default=DEFAULT_SOURCE_URL, help="Nasdaq API source URL.")
    parser.add_argument("--input-json", default=None, help="Optional saved Nasdaq API JSON response; skips network fetch.")
    parser.add_argument("--retrieved-at", default=None, help="Override retrieved_at timestamp.")
    return parser.parse_args(argv)


def fetch_source(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def extract_rows(payload: dict) -> list[dict]:
    rows = payload.get("data", {}).get("data", {}).get("rows")
    if not isinstance(rows, list):
        raise ValueError("Nasdaq API response did not contain data.data.rows")
    return rows


def main(argv=None) -> int:
    args = parse_args(argv)
    body = Path(args.input_json).read_bytes() if args.input_json else fetch_source(args.source_url)
    payload = json.loads(body.decode("utf8"))
    rows = extract_rows(payload)
    retrieved_at = args.retrieved_at or datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    source_sha256 = hashlib.sha256(body).hexdigest()
    entries, metadata = normalise_nasdaq_universe_rows(
        rows,
        source_url=args.source_url,
        retrieved_at=retrieved_at,
        source_sha256=source_sha256,
    )
    output = {
        "schema_version": NASDAQ_UNIVERSE_SEED_SCHEMA_VERSION,
        "metadata": metadata,
        "entries": entries,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf8")
    print(json.dumps({
        "output": str(output_path),
        "entries": len(entries),
        "row_count": len(rows),
        "sha256": source_sha256,
        "denominator_label": metadata.get("denominator_label"),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
