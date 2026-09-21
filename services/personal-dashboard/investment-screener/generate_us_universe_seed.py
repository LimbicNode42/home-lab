#!/usr/bin/env python3
"""Generate a reviewed US curated universe seed (S&P 500 constituents) JSON.

This is the US analogue of generate_asx_universe_seed.py: it does NOT enumerate
the full NYSE/NASDAQ (~7000 ordinary shares). It ingests a bounded, reviewed
curated list (S&P 500-class, ~500 liquid names) and emits an
`investment-screener-us-universe-seed/v1` artifact with an HONEST
denominator label ("S&P 500 constituents"), never "full US exchange".

The default input is a local, reviewed CSV (offline by default, since a stable
open S&P 500 constituent feed is a licensing/format mess); pass --input-csv.
The normalized entries are typed `unknown_from_eodhd_general` because the
authoritative name/sector/industry/currency arrive from EODHD `General` at
hydration time, not from this curated list.
"""
from __future__ import annotations

import argparse
import csv
import datetime
import hashlib
import json
from pathlib import Path

from screener import US_UNIVERSE_SEED_SCHEMA_VERSION, normalise_us_universe_rows


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Generate normalized US curated universe seed JSON.")
    parser.add_argument("--output", required=True, help="Seed JSON output path.")
    parser.add_argument("--input-csv", required=True, help="CSV of S&P 500 constituents (columns: Code/Symbol, Name, Sector, Industry).")
    parser.add_argument("--source-url", default="https://example.com/sp500-constituents.csv", help="Provenance source label.")
    parser.add_argument("--retrieved-at", default=None, help="Override retrieved_at timestamp.")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    body = Path(args.input_csv).read_bytes()
    decoded = body.decode("utf-8-sig")
    rows = list(csv.DictReader(decoded.splitlines()))
    retrieved_at = args.retrieved_at or datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    source_sha256 = hashlib.sha256(body).hexdigest()
    entries, metadata = normalise_us_universe_rows(
        rows,
        source_url=args.source_url,
        retrieved_at=retrieved_at,
        source_sha256=source_sha256,
    )
    output = {
        "schema_version": US_UNIVERSE_SEED_SCHEMA_VERSION,
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