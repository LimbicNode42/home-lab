#!/usr/bin/env python3
"""Generate the reviewed FULL NASDAQ listed-equity universe seed JSON.

This ingests NASDAQ Trader's nightly pipe-delimited ``nasdaqlisted.txt``
(https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt) — the reviewed
authoritative full NASDAQ listed-securities source from the research/spec task
t_e4b82658 — and emits a security-type-filtered equity universe mirroring the
existing ASX full-universe seed shape.

Unlike the prior bounded NASDAQ-100/QQQ-class seed, this enumerates the whole
active listing and labels the denominator honestly as
``complete_security_type_filtered_listing``. ETFs, exchange test/simulator
symbols, and non-equity instruments (warrants/rights/units/preferred/notes/ETNs)
are excluded; legitimate operating MLP/partnership Common Units are kept as
listed equity. Sector/industry are deferred to EODHD ``General`` at hydration.

Provenance is path-free: the seed carries a content sha256 of the raw upstream
file and the parsed ``File Creation Time`` footer as the refresh-date signal.
No secrets, tokens, or host paths are written into the seed.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import urllib.request
from pathlib import Path

from screener import (
    NASDAQ_SOURCE_URL,
    NASDAQ_UNIVERSE_SEED_SCHEMA_VERSION,
    normalise_nasdaq_universe_rows,
    parse_nasdaq_listed_file,
)

DEFAULT_USER_AGENT = "personal-dashboard-nasdaq-seed-generator/1.0"


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Generate normalized full NASDAQ listed-equity universe seed JSON.")
    parser.add_argument("--output", required=True, help="Seed JSON output path.")
    parser.add_argument("--source-url", default=NASDAQ_SOURCE_URL, help="NASDAQ Trader nasdaqlisted.txt URL.")
    parser.add_argument("--input-file", default=None, help="Optional local nasdaqlisted.txt for offline/regression generation.")
    parser.add_argument("--retrieved-at", default=None, help="Override retrieved_at timestamp for reproducible tests.")
    return parser.parse_args(argv)


def fetch_source(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": DEFAULT_USER_AGENT, "Accept": "text/plain"})
    with urllib.request.urlopen(request, timeout=60) as response:
        content_type = response.headers.get("content-type", "")
        body = response.read()
    if b"<html" in body[:512].lower() or "text/html" in content_type.lower():
        raise RuntimeError(f"NASDAQ Trader listing returned HTML/content-type={content_type!r}, not pipe-delimited text")
    return body


def main(argv=None) -> int:
    args = parse_args(argv)
    body = Path(args.input_file).read_bytes() if args.input_file else fetch_source(args.source_url)
    source_sha256 = hashlib.sha256(body).hexdigest()
    rows, file_meta = parse_nasdaq_listed_file(body)
    file_creation_time = file_meta.get("file_creation_time")
    retrieved_at = args.retrieved_at or datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    entries, metadata = normalise_nasdaq_universe_rows(
        rows,
        source_url=args.source_url,
        retrieved_at=retrieved_at,
        source_sha256=source_sha256,
        file_creation_time=file_creation_time,
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
        "file_creation_time": file_creation_time,
        "denominator_status": metadata.get("denominator_status"),
        "denominator_label": metadata.get("denominator_label"),
        "excluded_count": metadata.get("excluded_count"),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())